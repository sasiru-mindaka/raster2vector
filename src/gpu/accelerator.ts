export type GpuBackend = 'webgpu' | 'webgl2' | 'cpu';
export type GpuPreference = 'auto' | GpuBackend;

export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface GpuClassification {
  backend: GpuBackend;
  assignments: Uint16Array | null;
  edgeMask: Uint8Array | null;
  edgePixels: number;
  elapsedMs: number;
  fallbackReason?: string;
}

interface WebGpuBufferLike {
  destroy(): void;
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
}

interface WebGpuPassLike {
  setPipeline(pipeline: unknown): void;
  setBindGroup(index: number, bindGroup: unknown): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  end(): void;
}

interface WebGpuEncoderLike {
  beginComputePass(): WebGpuPassLike;
  copyBufferToBuffer(source: WebGpuBufferLike, sourceOffset: number, target: WebGpuBufferLike, targetOffset: number, size: number): void;
  finish(): unknown;
}

interface WebGpuDeviceLike {
  limits: { maxStorageBufferBindingSize: number; maxBufferSize: number };
  queue: {
    writeBuffer(buffer: WebGpuBufferLike, offset: number, data: ArrayBufferView): void;
    submit(commands: unknown[]): void;
  };
  createBuffer(descriptor: Record<string, unknown>): WebGpuBufferLike;
  createShaderModule(descriptor: Record<string, unknown>): unknown;
  createComputePipeline(descriptor: Record<string, unknown>): { getBindGroupLayout(index: number): unknown };
  createBindGroup(descriptor: Record<string, unknown>): unknown;
  createCommandEncoder(): WebGpuEncoderLike;
  destroy(): void;
}

interface WebGpuAdapterLike {
  requestDevice(): Promise<WebGpuDeviceLike>;
}

interface WebGpuApiLike {
  requestAdapter(): Promise<WebGpuAdapterLike | null>;
}

const PIXEL_LIMIT = 12_000_000;
const LUT_LENGTH = 64 * 64 * 64;
const LUT_WIDTH = 512;
const LUT_HEIGHT = 512;
const EDGE_THRESHOLD = 180;
const WEBGPU_SHADER = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  groupsX: u32,
  edgeThreshold: f32,
};
@group(0) @binding(0) var<storage, read> sourcePixels: array<u32>;
@group(0) @binding(1) var<storage, read> paletteLut: array<u32>;
@group(0) @binding(2) var<storage, read_write> outputPixels: array<u32>;
@group(0) @binding(3) var<uniform> params: Params;

fn rgbAt(x: i32, y: i32) -> vec3<f32> {
  let sx = clamp(x, 0, i32(params.width) - 1);
  let sy = clamp(y, 0, i32(params.height) - 1);
  let packed = sourcePixels[u32(sy) * params.width + u32(sx)];
  return vec3<f32>(
    f32(packed & 255u),
    f32((packed >> 8u) & 255u),
    f32((packed >> 16u) & 255u)
  );
}
fn luminanceAt(x: i32, y: i32) -> f32 {
  return dot(rgbAt(x, y), vec3<f32>(0.299, 0.587, 0.114));
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let index = gid.x + gid.y * params.groupsX * 64u;
  let total = params.width * params.height;
  if (index >= total) { return; }

  let packed = sourcePixels[index];
  let r = packed & 255u;
  let g = (packed >> 8u) & 255u;
  let b = (packed >> 16u) & 255u;
  let bin = (r >> 2u) * 4096u + (g >> 2u) * 64u + (b >> 2u);
  let label = paletteLut[bin] & 65535u;

  let x = i32(index % params.width);
  let y = i32(index / params.width);
  let tl = luminanceAt(x - 1, y - 1);
  let tc = luminanceAt(x, y - 1);
  let tr = luminanceAt(x + 1, y - 1);
  let ml = luminanceAt(x - 1, y);
  let mr = luminanceAt(x + 1, y);
  let bl = luminanceAt(x - 1, y + 1);
  let bc = luminanceAt(x, y + 1);
  let br = luminanceAt(x + 1, y + 1);
  let gx = -tl + tr - 2.0 * ml + 2.0 * mr - bl + br;
  let gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
  let edge = (gx * gx + gy * gy) >= (params.edgeThreshold * params.edgeThreshold);
  outputPixels[index] = label | select(0u, 0x80000000u, edge);
}
`;

const WEBGL_VERTEX_SHADER = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const WEBGL_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform sampler2D uImage;
uniform highp usampler2D uLookup;
uniform ivec2 uSize;
uniform float uEdgeThreshold;
out vec4 outputColor;
float lumAt(ivec2 p) {
  ivec2 q = clamp(p, ivec2(0), uSize - ivec2(1));
  vec3 c = texelFetch(uImage, q, 0).rgb * 255.0;
  return dot(c, vec3(0.299, 0.587, 0.114));
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 rgb = texelFetch(uImage, p, 0).rgb * 255.0;
  // Convert normalized RGBA8 samples back to exact byte values before binning.
  // Rounding first avoids floating-point underflow at 4-value palette boundaries.
  uvec3 bytes = uvec3(clamp(floor(rgb + vec3(0.5)), vec3(0.0), vec3(255.0)));
  uvec3 q = bytes >> 2u;
  uint bin = q.r * 4096u + q.g * 64u + q.b;
  uint label = texelFetch(uLookup, ivec2(int(bin & 511u), int(bin >> 9u)), 0).r;
  float tl = lumAt(p + ivec2(-1, -1));
  float tc = lumAt(p + ivec2(0, -1));
  float tr = lumAt(p + ivec2(1, -1));
  float ml = lumAt(p + ivec2(-1, 0));
  float mr = lumAt(p + ivec2(1, 0));
  float bl = lumAt(p + ivec2(-1, 1));
  float bc = lumAt(p + ivec2(0, 1));
  float br = lumAt(p + ivec2(1, 1));
  float gx = -tl + tr - 2.0 * ml + 2.0 * mr - bl + br;
  float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
  bool edge = (gx * gx + gy * gy) >= (uEdgeThreshold * uEdgeThreshold);
  outputColor = vec4(float(label & 255u) / 255.0, float((label >> 8u) & 255u) / 255.0, edge ? 1.0 : 0.0, 1.0);
}`;

function validateGpuInput(image: PixelImage, labelLut: Int32Array, paletteCount: number): number {
  if (!image || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1 || image.width > 12000 || image.height > 12000) {
    throw new Error('GPU image dimensions are invalid.');
  }
  const pixels = image.width * image.height;
  if (!Number.isSafeInteger(pixels) || pixels > PIXEL_LIMIT || image.data.length !== pixels * 4) {
    throw new Error('GPU image buffer is outside the supported size.');
  }
  if (!(labelLut instanceof Int32Array) || labelLut.length !== LUT_LENGTH) throw new Error('GPU palette lookup table is malformed.');
  if (!Number.isInteger(paletteCount) || paletteCount < 1 || paletteCount > 512) throw new Error('GPU palette size is invalid.');
  for (let i = 0; i < LUT_LENGTH; i++) {
    const label = labelLut[i];
    if (label < 0 || label >= paletteCount) throw new Error('GPU palette lookup contains an invalid label.');
  }
  return pixels;
}

function makeLookup16(lut: Int32Array): Uint16Array {
  const result = new Uint16Array(lut.length);
  for (let i = 0; i < lut.length; i++) result[i] = lut[i];
  return result;
}

function collectOutput(words: Uint32Array, pixels: number, paletteCount: number): { assignments: Uint16Array; edgeMask: Uint8Array; edgePixels: number } {
  if (words.length !== pixels) throw new Error('GPU returned an incomplete pixel buffer.');
  const assignments = new Uint16Array(pixels);
  const edgeMask = new Uint8Array(pixels);
  let edgePixels = 0;
  for (let i = 0; i < pixels; i++) {
    const word = words[i];
    const label = word & 0xffff;
    if (label >= paletteCount) throw new Error('GPU returned a palette label outside the selected palette.');
    const edge = (word & 0x80000000) !== 0;
    assignments[i] = label;
    edgeMask[i] = edge ? 1 : 0;
    if (edge) edgePixels++;
  }
  return { assignments, edgeMask, edgePixels };
}

async function classifyWebGpu(image: PixelImage, lookup: Uint16Array, paletteCount: number, pixels: number): Promise<ReturnType<typeof collectOutput>> {
  const gpuApi = (globalThis.navigator as Navigator & { gpu?: WebGpuApiLike }).gpu;
  if (!gpuApi || typeof gpuApi.requestAdapter !== 'function') throw new Error('WebGPU is not available in this browser context.');
  const adapter = await gpuApi.requestAdapter();
  if (!adapter) throw new Error('No compatible WebGPU adapter was found.');
  const device = await adapter.requestDevice();
  const outputBytes = pixels * Uint32Array.BYTES_PER_ELEMENT;
  const lookupWords = Uint32Array.from(lookup);
  if (outputBytes > device.limits.maxStorageBufferBindingSize || outputBytes > device.limits.maxBufferSize) {
    device.destroy();
    throw new Error('The image is larger than this GPU device can process in one pass.');
  }

  const storage = 0x80;
  const copyDst = 0x08;
  const copySrc = 0x04;
  const mapRead = 0x01;
  const uniform = 0x40;
  const created: WebGpuBufferLike[] = [];
  try {
    const source = device.createBuffer({ size: outputBytes, usage: storage | copyDst }); created.push(source);
    const lutBuffer = device.createBuffer({ size: lookupWords.byteLength, usage: storage | copyDst }); created.push(lutBuffer);
    const output = device.createBuffer({ size: outputBytes, usage: storage | copySrc }); created.push(output);
    const readback = device.createBuffer({ size: outputBytes, usage: mapRead | copyDst }); created.push(readback);
    const params = device.createBuffer({ size: 16, usage: uniform | copyDst }); created.push(params);

    const sourceWords = new Uint32Array(image.data.buffer, image.data.byteOffset, pixels);
    device.queue.writeBuffer(source, 0, sourceWords);
    device.queue.writeBuffer(lutBuffer, 0, lookupWords);
    const workgroups = Math.ceil(pixels / 64);
    const groupsX = Math.min(workgroups, 65535);
    const groupsY = Math.ceil(workgroups / groupsX);
    const uniformBytes = new ArrayBuffer(16);
    const uniformView = new DataView(uniformBytes);
    uniformView.setUint32(0, image.width, true);
    uniformView.setUint32(4, image.height, true);
    uniformView.setUint32(8, groupsX, true);
    uniformView.setFloat32(12, EDGE_THRESHOLD, true);
    device.queue.writeBuffer(params, 0, new Uint32Array(uniformBytes));

    const module = device.createShaderModule({ code: WEBGPU_SHADER });
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: source } },
        { binding: 1, resource: { buffer: lutBuffer } },
        { binding: 2, resource: { buffer: output } },
        { binding: 3, resource: { buffer: params } }
      ]
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(groupsX, groupsY, 1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, outputBytes);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(mapRead);
    const words = new Uint32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    return collectOutput(words, pixels, paletteCount);
  } finally {
    for (const buffer of created) {
      try { buffer.destroy(); } catch { /* GPU resources may already be lost. */ }
    }
    device.destroy();
  }
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('WebGL2 could not allocate a shader.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'Unknown GLSL compiler error.';
    gl.deleteShader(shader);
    throw new Error(`WebGL2 shader compilation failed: ${message}`);
  }
  return shader;
}

function configureTexture(gl: WebGL2RenderingContext, texture: WebGLTexture): void {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

async function classifyWebGl2(image: PixelImage, lookup: Uint16Array, paletteCount: number, pixels: number): Promise<ReturnType<typeof collectOutput>> {
  if (typeof OffscreenCanvas !== 'function') throw new Error('OffscreenCanvas is not available for WebGL2 worker processing.');
  const canvas = new OffscreenCanvas(image.width, image.height);
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
  if (!gl) throw new Error('A WebGL2 rendering context could not be created.');

  let imageTexture: WebGLTexture | null = null;
  let lookupTexture: WebGLTexture | null = null;
  let outputTexture: WebGLTexture | null = null;
  let framebuffer: WebGLFramebuffer | null = null;
  let program: WebGLProgram | null = null;
  let vertexShader: WebGLShader | null = null;
  let fragmentShader: WebGLShader | null = null;
  try {
    if (image.width > gl.getParameter(gl.MAX_TEXTURE_SIZE) || image.height > gl.getParameter(gl.MAX_TEXTURE_SIZE)) {
      throw new Error('Image dimensions exceed this WebGL2 device texture limit.');
    }
    imageTexture = gl.createTexture();
    lookupTexture = gl.createTexture();
    outputTexture = gl.createTexture();
    framebuffer = gl.createFramebuffer();
    if (!imageTexture || !lookupTexture || !outputTexture || !framebuffer) throw new Error('WebGL2 could not allocate processing resources.');

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    configureTexture(gl, imageTexture);
    const sourceBytes = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, image.width, image.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, sourceBytes);
    configureTexture(gl, lookupTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, LUT_WIDTH, LUT_HEIGHT, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, lookup);
    configureTexture(gl, outputTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, image.width, image.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    vertexShader = compileShader(gl, gl.VERTEX_SHADER, WEBGL_VERTEX_SHADER);
    fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, WEBGL_FRAGMENT_SHADER);
    program = gl.createProgram();
    if (!program) throw new Error('WebGL2 could not create a shader program.');
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`WebGL2 program link failed: ${gl.getProgramInfoLog(program) || 'Unknown link error.'}`);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outputTexture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('WebGL2 output framebuffer is incomplete.');
    gl.viewport(0, 0, image.width, image.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DITHER);
    gl.useProgram(program);

    const imageLocation = gl.getUniformLocation(program, 'uImage');
    const lookupLocation = gl.getUniformLocation(program, 'uLookup');
    const sizeLocation = gl.getUniformLocation(program, 'uSize');
    const edgeLocation = gl.getUniformLocation(program, 'uEdgeThreshold');
    if (!imageLocation || !lookupLocation || !sizeLocation || !edgeLocation) throw new Error('WebGL2 shader uniforms were not initialized.');
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, imageTexture);
    gl.uniform1i(imageLocation, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lookupTexture);
    gl.uniform1i(lookupLocation, 1);
    gl.uniform2i(sizeLocation, image.width, image.height);
    gl.uniform1f(edgeLocation, EDGE_THRESHOLD);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL2 reported an error while processing the image.');

    const raw = new Uint8Array(pixels * 4);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(0, 0, image.width, image.height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL2 failed to read the processed pixels back from the GPU.');
    const assignments = new Uint16Array(pixels);
    const edgeMask = new Uint8Array(pixels);
    let edgePixels = 0;
    for (let i = 0; i < pixels; i++) {
      const offset = i * 4;
      const label = raw[offset] | (raw[offset + 1] << 8);
      if (label >= paletteCount) throw new Error('WebGL2 returned a palette label outside the selected palette.');
      assignments[i] = label;
      const edge = raw[offset + 2] > 127;
      edgeMask[i] = edge ? 1 : 0;
      if (edge) edgePixels++;
    }
    return { assignments, edgeMask, edgePixels };
  } finally {
    if (program) gl.deleteProgram(program);
    if (vertexShader) gl.deleteShader(vertexShader);
    if (fragmentShader) gl.deleteShader(fragmentShader);
    if (imageTexture) gl.deleteTexture(imageTexture);
    if (lookupTexture) gl.deleteTexture(lookupTexture);
    if (outputTexture) gl.deleteTexture(outputTexture);
    if (framebuffer) gl.deleteFramebuffer(framebuffer);
  }
}

export async function classifyPaletteOnGpu(
  image: PixelImage,
  labelLut: Int32Array,
  paletteCount: number,
  preference: GpuPreference = 'auto'
): Promise<GpuClassification> {
  const started = performance.now();
  const pixels = validateGpuInput(image, labelLut, paletteCount);
  if (preference === 'cpu') {
    return { backend: 'cpu', assignments: null, edgeMask: null, edgePixels: 0, elapsedMs: Math.round(performance.now() - started) };
  }
  const lookup = makeLookup16(labelLut);
  const attempts: Array<'webgpu' | 'webgl2'> = preference === 'webgpu'
    ? ['webgpu']
    : preference === 'webgl2'
      ? ['webgl2']
      : ['webgpu', 'webgl2'];
  const failures: string[] = [];
  for (const backend of attempts) {
    try {
      const result = backend === 'webgpu'
        ? await classifyWebGpu(image, lookup, paletteCount, pixels)
        : await classifyWebGl2(image, lookup, paletteCount, pixels);
      return { backend, ...result, elapsedMs: Math.round(performance.now() - started) };
    } catch (error) {
      failures.push(`${backend}: ${error instanceof Error ? error.message : 'GPU processing failed'}`);
    }
  }
  return {
    backend: 'cpu', assignments: null, edgeMask: null, edgePixels: 0,
    elapsedMs: Math.round(performance.now() - started),
    fallbackReason: failures.join(' · ')
  };
}
