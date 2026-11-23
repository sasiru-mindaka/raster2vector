import assert from 'node:assert/strict';
import { buildLosslessSvg, ComplexityLimitError, MAX_LOSSLESS_REGIONS } from '../assets/js/core/lossless.js';
import { inspectSvg, formatBytes, hasUnsafeSvgAttributeValue, isAllowedSvgAttribute } from '../assets/js/core/svg-utils.js';
import { composeHybridSvg } from '../assets/js/core/hybrid-composer.js';
import { prepareHybridPalette, resolveHybridProfile, traceHybridPure } from '../assets/js/core/engine.js';
import { sanitizeTraceSettings, validateWorkerPayload } from '../assets/js/generated/security/validation.js';
import { classifyPaletteOnGpu } from '../assets/js/generated/gpu/accelerator.js';

function imageData(width, height, pixels) {
  return { width, height, data: new Uint8ClampedArray(pixels) };
}

function rgbaFixture(width, height, pixelAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.set(pixelAt(x, y), (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('trace client handles Worker message errors and ignores stale Worker failures', async () => {
  const previousWorker = globalThis.Worker;
  const workers = [];
  class WorkerMock {
    constructor() { this.listeners = new Map(); this.terminated = false; workers.push(this); }
    addEventListener(type, callback) {
      const list = this.listeners.get(type) || [];
      list.push(callback);
      this.listeners.set(type, list);
    }
    postMessage() {}
    terminate() { this.terminated = true; }
    dispatch(type, event = {}) {
      for (const callback of this.listeners.get(type) || []) callback(event);
    }
  }
  globalThis.Worker = WorkerMock;
  try {
    const client = await import('../assets/js/core/trace-client.js?worker-lifecycle-test');
    const pixels = { width: 1, height: 1, data: new Uint8ClampedArray([10, 20, 30, 255]) };
    const firstRequest = client.traceImage(pixels, { mode: 'hybrid' });
    const firstRejected = assert.rejects(firstRequest, /cancelled/i);
    client.stopTracingWorker();
    await firstRejected;
    const secondRequest = client.traceImage(pixels, { mode: 'hybrid' });
    const firstWorker = workers[0], secondWorker = workers[1];
    firstWorker.dispatch('error', { message: 'late stale worker error' });
    assert.equal(secondWorker.terminated, false, 'a stale Worker error must not terminate the current Worker');
    const secondRejected = assert.rejects(secondRequest, /could not be decoded/i);
    secondWorker.dispatch('messageerror');
    await secondRejected;
    assert.equal(secondWorker.terminated, true, 'messageerror should terminate the broken Worker');
  } finally {
    if (previousWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = previousWorker;
  }
});

test('pixel-exact SVG encodes distinct RGBA colours and alpha', () => {
  const fixture = imageData(3, 2, [
    255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 128,
    0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 0, 255
  ]);
  const result = buildLosslessSvg(fixture);
  assert.equal(result.width, 3);
  assert.equal(result.height, 2);
  assert.equal(result.colorCount, 4);
  assert.match(result.svg, /fill="#ff0000"/);
  assert.match(result.svg, /fill="#0000ff" fill-opacity=/);
  assert.equal(result.mode, 'exact');
});

test('identical adjacent pixels are merged into one rectangle region', () => {
  const pixels = new Uint8ClampedArray(8 * 5 * 4);
  for (let i = 0; i < 8 * 5; i += 1) pixels.set([17, 33, 65, 255], i * 4);
  const result = buildLosslessSvg(imageData(8, 5, pixels));
  assert.equal(result.regionCount, 1);
  assert.equal(result.pathCount, 1);
  assert.match(result.svg, /M0 0h8v5h-8Z/);
});

test('different row runs keep their exact geometry', () => {
  const pixels = new Uint8ClampedArray([
    1, 2, 3, 255, 1, 2, 3, 255,
    1, 2, 3, 255, 8, 9, 10, 255
  ]);
  const result = buildLosslessSvg(imageData(2, 2, pixels));
  assert.equal(result.regionCount, 3);
  assert.equal(result.colorCount, 2);
  assert.match(result.svg, /M0 0h2v1h-2Z/);
  assert.match(result.svg, /M0 1h1v1h-1Z/);
});

test('complex exact output trips the safety limit', () => {
  const pixels = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < 16; i += 1) pixels.set([i, i, i, 255], i * 4);
  assert.throws(() => buildLosslessSvg(imageData(4, 4, pixels), 2), ComplexityLimitError);
  assert.equal(MAX_LOSSLESS_REGIONS, 250000);
});

test('SVG metadata parser counts paths and fill colours', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><path fill="#000" d="M0 0Z"/><path fill="#fff" d="M1 1Z"/></svg>';
  const result = inspectSvg(svg);
  assert.equal(result.pathCount, 2);
  assert.equal(result.colorCount, 2);
  assert.equal(result.width, 20);
  assert.equal(result.height, 10);
});

test('SVG parser rejects active content', () => {
  assert.throws(() => inspectSvg('<svg><script>alert(1)</script></svg>'), /active content/);
  assert.throws(() => inspectSvg('<svg><path style="fill:url(https://evil.test)"/></svg>'), /active content/);
  assert.throws(() => inspectSvg('<?xml-stylesheet href="evil.css"?><svg/>'), /active content|valid SVG/i);
});

test('browser SVG validator trusts only exact root XML namespace declarations', () => {
  const root = { localName: 'svg', namespaceURI: 'http://www.w3.org/2000/svg' };
  const xmlns = { name: 'xmlns', localName: 'xmlns', value: 'http://www.w3.org/2000/svg', namespaceURI: 'http://www.w3.org/2000/xmlns/' };
  const xlink = { name: 'xmlns:xlink', prefix: 'xmlns', localName: 'xlink', value: 'http://www.w3.org/1999/xlink', namespaceURI: 'http://www.w3.org/2000/xmlns/' };
  assert.equal(hasUnsafeSvgAttributeValue(root, xmlns, root), false);
  assert.equal(hasUnsafeSvgAttributeValue(root, xlink, root), false);
  assert.equal(hasUnsafeSvgAttributeValue(root, { ...xmlns, value: 'https://evil.example/ns' }, root), true);
  assert.equal(hasUnsafeSvgAttributeValue(root, { ...xlink, value: 'https://evil.example/ns' }, root), true);
  assert.equal(hasUnsafeSvgAttributeValue({ localName: 'path' }, xmlns, root), true);
  assert.equal(hasUnsafeSvgAttributeValue({ localName: 'path' }, { name: 'fill', value: 'url(https://evil.example/x)' }, root), true);
  assert.equal(hasUnsafeSvgAttributeValue({ localName: 'path' }, { name: 'href', value: 'javascript:alert(1)' }, root), true);
  assert.equal(hasUnsafeSvgAttributeValue({ localName: 'path' }, { name: 'fill', value: '#ffcc00' }, root), false);
  assert.equal(hasUnsafeSvgAttributeValue({ localName: 'path' }, { name: 'onload', value: 'alert(1)' }, root), true);
});

test('SVG attribute allowlist permits Pixel-Exact alpha while keeping the rest restrictive', () => {
  const exact = buildLosslessSvg(imageData(2, 1, [255, 0, 0, 255, 0, 0, 255, 128]));
  assert.match(exact.svg, /fill-opacity=/);
  assert.equal(isAllowedSvgAttribute('path', 'fill-opacity'), true);
  assert.equal(isAllowedSvgAttribute('path', 'onload'), false);
  assert.equal(isAllowedSvgAttribute('image', 'href'), true);
  assert.equal(isAllowedSvgAttribute('image', 'style'), false);
});

test('byte formatter uses readable units', () => {
  assert.equal(formatBytes(20), '20 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(1048576), '1.00 MB');
});

test('SVG parser allows only embedded PNG resources and rejects remote references', () => {
  const safe = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><image href="data:image/png;base64,AA=="/></svg>';
  assert.equal(inspectSvg(safe).width, 1);
  assert.throws(() => inspectSvg('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>'), /external|unsupported/i);
  assert.throws(() => inspectSvg('<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.com">x</a></svg>'), /active|unsupported/i);
});

test('TypeScript settings validation clamps numeric settings and rejects invalid enums', () => {
  const settings = sanitizeTraceSettings({ colors: 900, smoothness: -4, gpuBackend: 'auto' });
  assert.equal(settings.colors, 512);
  assert.equal(settings.smoothness, 0);
  assert.equal(settings.gpuBackend, 'auto');
  assert.throws(() => sanitizeTraceSettings({ gpuBackend: 'remote-gpu' }), /gpuBackend/i);
});

test('worker settings accept the pure-vector photo output mode', () => {
  const settings = sanitizeTraceSettings({ mode: 'photo', colors: 512, gpuBackend: 'cpu' });
  assert.equal(settings.mode, 'photo');
  assert.equal(settings.colors, 512);
});

test('worker payload validation rejects oversized and mismatched pixel buffers', () => {
  const buffer = new ArrayBuffer(4 * 4);
  const valid = validateWorkerPayload({ requestId: 1, buffer, width: 2, height: 2, settings: { mode: 'hybrid' } });
  assert.equal(valid.width, 2);
  assert.equal(valid.settings.mode, 'hybrid');
  assert.throws(() => validateWorkerPayload({ requestId: 1, buffer, width: 3, height: 2, settings: {} }), /length/);
  assert.throws(() => validateWorkerPayload({ requestId: 1, buffer: new ArrayBuffer(1), width: 12000, height: 12000, settings: {} }), /12-megapixel/);
});

test('GPU classifier explicitly supports a safe CPU-only fallback', async () => {
  const lut = new Int32Array(64 * 64 * 64);
  const image = imageData(2, 1, [255, 0, 0, 255, 0, 255, 0, 255]);
  const result = await classifyPaletteOnGpu(image, lut, 1, 'cpu');
  assert.equal(result.backend, 'cpu');
  assert.equal(result.assignments, null);
  assert.equal(result.edgeMask, null);
});

test('unavailable explicit GPU APIs degrade to the CPU path without losing the request', async () => {
  const lut = new Int32Array(64 * 64 * 64);
  const image = imageData(2, 1, [255, 0, 0, 255, 0, 255, 0, 255]);
  const webgpu = await classifyPaletteOnGpu(image, lut, 1, 'webgpu');
  const webgl2 = await classifyPaletteOnGpu(image, lut, 1, 'webgl2');
  assert.equal(webgpu.backend, 'cpu');
  assert.match(webgpu.fallbackReason, /WebGPU/i);
  assert.equal(webgl2.backend, 'cpu');
  assert.match(webgl2.fallbackReason, /WebGL2/i);
});

test('GPU classifier rejects corrupted lookup entries before allocating GPU resources', async () => {
  const lut = new Int32Array(64 * 64 * 64);
  lut[4095] = 999;
  const image = imageData(2, 1, [255, 0, 0, 255, 0, 255, 0, 255]);
  await assert.rejects(() => classifyPaletteOnGpu(image, lut, 1, 'auto'), /invalid label/i);
});

test('GPU classifier enforces per-axis image dimension limits', async () => {
  const lut = new Int32Array(64 * 64 * 64);
  const image = imageData(12001, 1, new Array(12001 * 4).fill(255));
  await assert.rejects(() => classifyPaletteOnGpu(image, lut, 1, 'auto'), /dimensions are invalid/i);
});

test('prepared palette lookup and GPU-equivalent labels preserve CPU region output', () => {
  const source = rgbaFixture(48, 32, (x) => x < 24 ? [240, 24, 40, 255] : [20, 90, 230, 255]);
  const settings = { ...base, colors: 16, gradients: false, tileSize: 0 };
  const palette = prepareHybridPalette(source, settings);
  const assignments = new Uint16Array(source.width * source.height);
  for (let i = 0; i < assignments.length; i++) {
    const r = source.data[i * 4] >> 2;
    const g = source.data[i * 4 + 1] >> 2;
    const b = source.data[i * 4 + 2] >> 2;
    assignments[i] = palette.labelLut[r * 4096 + g * 64 + b];
  }
  const cpu = traceHybridPure(source, settings);
  const lutResult = traceHybridPure(source, settings, () => {}, { ...palette, assignments, gpuBackend: 'test-gpu' });
  assert.equal(lutResult.vectorPixels, cpu.vectorPixels);
  assert.equal(lutResult.colorCount, cpu.colorCount);
  assert.equal(lutResult.gpuBackend, 'test-gpu');
});

test('GPU Sobel mask protects edge pixels from vector simplification', () => {
  const source = rgbaFixture(40, 24, (x) => x < 20 ? [245, 20, 30, 255] : [20, 50, 240, 255]);
  const settings = { ...base, colors: 16, gradients: false, tileSize: 0, underlay: 'full' };
  const palette = prepareHybridPalette(source, settings);
  const assignments = new Uint16Array(source.width * source.height);
  for (let i = 0; i < assignments.length; i++) {
    const r = source.data[i * 4] >> 2;
    const g = source.data[i * 4 + 1] >> 2;
    const b = source.data[i * 4 + 2] >> 2;
    assignments[i] = palette.labelLut[r * 4096 + g * 64 + b];
  }
  const edgeMask = new Uint8Array(assignments.length);
  for (let y = 0; y < source.height; y++) edgeMask[y * source.width + 19] = 1;
  const baseline = traceHybridPure(source, settings);
  const protectedEdges = traceHybridPure(source, settings, () => {}, {
    ...palette, assignments, edgeMask, gpuBackend: 'webgl2', gpuEdgePixels: source.height
  });
  assert.ok(protectedEdges.vectorPixels < baseline.vectorPixels);
  assert.equal(protectedEdges.gpuEdgePixels, source.height);
  assert.equal(protectedEdges.gpuBackend, 'webgl2');
});

test('hybrid composer creates one SVG containing masked PNG fallback and coloured vector paths', async () => {
  const previousCanvas = globalThis.OffscreenCanvas;
  const previousImageData = globalThis.ImageData;
  const pngBytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6ioAAAAASUVORK5CYII=', 'base64'));
  globalThis.ImageData = class MockImageData { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
  globalThis.OffscreenCanvas = class MockOffscreenCanvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return { putImageData() {} }; }
    async convertToBlob() { return new Blob([pngBytes], { type: 'image/png' }); }
  };
  try {
    const fixture = rgbaFixture(2, 1, (x) => x === 0 ? [255, 0, 0, 255] : [0, 255, 0, 255]);
    const result = await composeHybridSvg({
      vectorSvg: '<svg xmlns="http://www.w3.org/2000/svg"><path fill="#ff0000" d="M0 0h1v1z"/></svg>',
      sourceImageData: fixture,
      rasterMask: new Uint8Array([0, 1]),
      segmentation: { vectorPercent: 50, rasterPercent: 50, rasterUnderlayPercent: 50, vectorPixels: 1, rasterPixels: 1 }
    });
    const stats = inspectSvg(result.svg);
    assert.equal(stats.pathCount, 1);
    assert.equal(stats.colorCount, 1);
    assert.match(result.svg, /<image[^>]+href="data:image\/png;base64,/);
    assert.match(result.svg, /<path fill="#ff0000"/);
    assert.doesNotMatch(result.svg, /xmlns:xlink=/, 'Hybrid SVG does not declare the unused XLink namespace');
    const root = { localName: 'svg', namespaceURI: 'http://www.w3.org/2000/svg' };
    const tags = [...result.svg.matchAll(/<([A-Za-z][\w:-]*)\b([^>]*)>/g)];
    for (let index = 0; index < tags.length; index += 1) {
      const [, tag, sourceAttributes] = tags[index];
      const element = index === 0 ? root : { localName: tag, namespaceURI: 'http://www.w3.org/2000/svg' };
      for (const match of sourceAttributes.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) {
        const [, name, , value] = match;
        assert.equal(isAllowedSvgAttribute(tag, name), true, `unsupported generated attribute ${tag}.${name}`);
        assert.equal(hasUnsafeSvgAttributeValue(element, { name, value }, root), false, `unsafe generated attribute ${tag}.${name}`);
      }
    }
    assert.equal(result.vectorPercent, 50);
  } finally {
    if (previousCanvas === undefined) delete globalThis.OffscreenCanvas; else globalThis.OffscreenCanvas = previousCanvas;
    if (previousImageData === undefined) delete globalThis.ImageData; else globalThis.ImageData = previousImageData;
  }
});


test('artwork profiles apply distinct hybrid tracing thresholds', () => {
  const base = { profile: 'auto', tol: 4, minVectorArea: 100 };
  const automatic = resolveHybridProfile(base);
  const photo = resolveHybridProfile({ ...base, profile: 'photo' });
  const illustration = resolveHybridProfile({ ...base, profile: 'illustration' });
  const poster = resolveHybridProfile({ ...base, profile: 'poster' });
  const logo = resolveHybridProfile({ ...base, profile: 'logo' });
  assert.ok(photo.tol < automatic.tol && photo.minVectorArea > automatic.minVectorArea);
  assert.ok(illustration.tol <= automatic.tol && illustration.minVectorArea < automatic.minVectorArea);
  assert.ok(poster.tol > automatic.tol && poster.minVectorArea < automatic.minVectorArea);
  assert.ok(logo.tol > poster.tol && logo.minVectorArea < poster.minVectorArea);
  assert.equal(base.tol, 4, 'profile resolution must not mutate caller settings');
});

test('hybrid mode keeps semi-transparent pixels in the PNG fallback even when gradients are enabled', () => {
  const fixture = rgbaFixture(40, 40, (x, y) => x === 20 && y === 20 ? [220, 40, 30, 96] : [220, 40, 30, 255]);
  const settings = { colors: 16, tol: 4, minVectorArea: 1, edgeOverlap: 0, smoothness: 0.5, gradients: true, tileSize: 0, underlay: 'masked' };
  const palette = prepareHybridPalette(fixture, settings);
  const result = traceHybridPure(fixture, settings, () => {}, palette);
  const partialPixel = 20 * fixture.width + 20;
  assert.equal(result.rasterMask[partialPixel], 1, 'semi-transparent pixels must be retained by the raster mask');
  assert.equal(result.rasterMask[partialPixel - 1], 0, 'the gradient path must not force neighbouring opaque pixels into the fallback');
  assert.ok(result.rasterPercent > 0, 'semi-transparent pixels must count as visible raster area');
});

test('pure-vector mode rejects partial transparency instead of silently changing alpha', () => {
  const fixture = rgbaFixture(4, 2, (x) => [40 + x * 20, 90, 140, x === 2 ? 128 : 255]);
  const settings = { colors: 16, tol: 4, minVectorArea: 1, edgeOverlap: 0, smoothness: 0.5, gradients: false, tileSize: 0, pureVector: true };
  const palette = prepareHybridPalette(fixture, settings);
  assert.throws(() => traceHybridPure(fixture, settings, () => {}, palette), /semi-transparent pixels/i);
});

// ---- engine feature tests (each feature isolated by its own flag) ----
function synth(W, H, fn) { const d = new Uint8ClampedArray(W * H * 4); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = fn(x, y), i = (y * W + x) * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; } return { width: W, height: H, data: d }; }
const circle = synth(120, 120, (x, y) => ((x - 60) ** 2 + (y - 60) ** 2 < 1600 ? [220, 30, 40] : [250, 250, 250]));
const smooth = synth(160, 120, (x, y) => [40 + x * 0.8, 80 + y * 0.5, 200 - x * 0.3]);
const base = { colors: 64, tol: 4, minVectorArea: 16, edgeOverlap: 1, smoothness: 1 };

test('engine curve=bezier emits cubic curves; curve=quad emits quadratic curves', () => {
  const b = traceHybridPure(circle, { ...base, curve: 'bezier', gradients: false, tileSize: 0 });
  const q = traceHybridPure(circle, { ...base, curve: 'quad', gradients: false, tileSize: 0 });
  assert.match(b.svg, / d="M[^"]*C/); assert.ok(!/ d="[^"]*Q/.test(b.svg));
  assert.match(q.svg, / d="M[^"]*Q/); assert.ok(!/ d="[^"]*C/.test(q.svg));
});

test('engine gradients flag fits a real linearGradient to a smooth area and keeps colours close', () => {
  const off = traceHybridPure(smooth, { ...base, gradients: false, tileSize: 0 });
  const on = traceHybridPure(smooth, { ...base, gradients: true, tileSize: 0 });
  assert.equal(off.gradientPieces, 0);
  assert.ok(on.gradientPieces >= 1, 'expected at least one gradient piece');
  assert.match(on.svg, /<linearGradient id="g0"[^>]*gradientUnits="userSpaceOnUse"/);
  assert.ok(on.vectorPercent > off.vectorPercent, `vector share should grow (${off.vectorPercent} -> ${on.vectorPercent})`);
});

test('engine tiling gives the same coverage as no tiling and reports tile count', () => {
  const one = traceHybridPure(circle, { ...base, tileSize: 0 });
  const many = traceHybridPure(circle, { ...base, tileSize: 40 });
  assert.equal(one.tiles, 1);
  assert.equal(many.tiles, 9);
  assert.equal(one.vectorPixels, many.vectorPixels);
  assert.match(many.svg, /<svg[^>]*width="120"/);
});

test('pure-vector photo tracing covers every opaque pixel with no embedded raster image', () => {
  const fixture = rgbaFixture(64, 48, (x, y) => {
    const shade = Math.round(40 + x * 2.5 + y * 0.6);
    const texture = (x * 17 + y * 31) % 11;
    return [Math.min(255, shade + texture), Math.min(255, shade + 12), Math.min(255, shade + 24), 255];
  });
  const settings = { ...base, colors: 64, pureVector: true, tol: 4, minVectorArea: 1, gradients: true,
    gradNoise: 5, gradTol: 10, edgeProtection: false, edgeOverlap: 0, underlay: 'masked', speckle: 0, tileSize: 0 };
  const palette = prepareHybridPalette(fixture, settings);
  const result = traceHybridPure(fixture, settings, () => {}, palette);
  assert.equal(result.vectorPercent, 100);
  assert.equal(result.rasterPercent, 0);
  assert.ok(result.pathCount > 0);
  assert.doesNotMatch(result.svg, /<image\b|data:image\//i);
  assert.equal(inspectSvg(result.svg).width, fixture.width);
});

test('pure-vector photo mode can emit SVG gradient fills without raster fallback', () => {
  const fixture = rgbaFixture(64, 64, (x, y) => {
    const shade = Math.round(35 + x * 2.2 + y * 0.5);
    return [shade, Math.min(255, shade + 18), Math.min(255, shade + 36), 255];
  });
  const settings = { ...base, colors: 32, pureVector: true, tol: 4, minVectorArea: 1, gradients: true,
    gradNoise: 5, gradTol: 10, edgeProtection: false, edgeOverlap: 0, underlay: 'masked', speckle: 0, tileSize: 0 };
  const palette = prepareHybridPalette(fixture, settings);
  const result = traceHybridPure(fixture, settings, () => {}, palette);
  assert.equal(result.vectorPercent, 100);
  assert.equal(result.rasterPercent, 0);
  assert.ok(result.gradientPieces > 0, 'expected at least one fitted SVG gradient');
  assert.match(result.svg, /<linearGradient/);
  assert.doesNotMatch(result.svg, /<image\b|data:image\//i);
});

test('engine full underlay mask covers every opaque pixel, masked underlay only the non-vector ones', () => {
  const full = traceHybridPure(circle, { ...base, underlay: 'full' });
  const masked = traceHybridPure(circle, { ...base, underlay: 'masked' });
  assert.equal(full.rasterMask.reduce((a, v) => a + v, 0), 120 * 120);
  assert.ok(masked.rasterMask.reduce((a, v) => a + v, 0) < 120 * 120);
});

let failed = 0;
for (const item of tests) {
  try {
    await item.fn();
    process.stdout.write(`PASS ${item.name}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`FAIL ${item.name}\n${error.stack}\n`);
  }
}
process.stdout.write(`\n${tests.length - failed}/${tests.length} tests passed.\n`);
if (failed) process.exitCode = 1;

