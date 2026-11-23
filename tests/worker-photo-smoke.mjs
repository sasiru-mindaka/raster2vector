import assert from 'node:assert/strict';

let messageHandler;
const messages = [];
globalThis.self = {
  addEventListener(type, callback) {
    if (type === 'message') messageHandler = callback;
  },
  postMessage(message) {
    messages.push(message);
  }
};
globalThis.ImageData = class ImageDataMock {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

await import('../assets/js/workers/trace-worker.js');
assert.equal(typeof messageHandler, 'function', 'worker should register its message handler');

const width = 80, height = 64;
const pixels = new Uint8ClampedArray(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const offset = (y * width + x) * 4;
  const shade = Math.round(35 + x * 1.9 + y * 0.9);
  const texture = ((x * 17 + y * 31) % 13) - 6;
  pixels.set([
    Math.max(0, Math.min(255, shade + texture)),
    Math.max(0, Math.min(255, shade + 14 + texture)),
    Math.max(0, Math.min(255, shade + 30 + texture)),
    255
  ], offset);
}

await messageHandler({ data: {
  requestId: 7,
  buffer: pixels.buffer,
  width,
  height,
  settings: {
    mode: 'photo',
    profile: 'photo',
    colors: 64,
    smoothness: 0.65,
    speckle: 0,
    detailProtection: 90,
    minVectorArea: 1,
    edgeOverlap: 0,
    maxDimension: 6000,
    underlay: 'masked',
    curve: 'bezier',
    gradients: true,
    tileSize: '0',
    gpuBackend: 'cpu',
    edgeProtection: false
  }
} });

const resultMessage = messages.find((message) => message.type === 'result' && message.requestId === 7);
assert.ok(resultMessage, 'worker should return a final result');
assert.equal(resultMessage.ok, true, resultMessage.error || 'worker conversion should succeed');
const result = resultMessage.result;
assert.equal(result.mode, 'pure-vector');
assert.equal(result.vectorPercent, 100);
assert.equal(result.rasterPercent, 0);
assert.equal(result.rasterFallbackEmbedded, false);
assert.doesNotMatch(result.svg, /<image\b|data:image\//i);
assert.ok(result.pathCount > 0);
console.log(`PASS worker pure-photo mode: ${result.pathCount} paths, ${result.colorCount} colours, ${(result.svgBytes / 1024).toFixed(1)} KB, no raster embeds.`);

const partialAlpha = new Uint8ClampedArray([40, 90, 150, 128]);
await messageHandler({ data: {
  requestId: 8,
  buffer: partialAlpha.buffer,
  width: 1,
  height: 1,
  settings: {
    mode: 'photo',
    profile: 'photo',
    colors: 8,
    smoothness: 0.65,
    speckle: 0,
    detailProtection: 90,
    minVectorArea: 1,
    edgeOverlap: 0,
    maxDimension: 6000,
    underlay: 'masked',
    curve: 'bezier',
    gradients: true,
    tileSize: '0',
    gpuBackend: 'cpu',
    edgeProtection: false
  }
} });
const partialResult = messages.find((message) => message.type === 'result' && message.requestId === 8);
assert.ok(partialResult, 'worker should return a result for partial-alpha input');
assert.equal(partialResult.ok, false, 'pure-photo mode must reject partially transparent pixels');
assert.match(partialResult.error, /semi-transparent pixels/i);
console.log('PASS worker rejects unsupported partial-alpha photo input with a clear error.');

const exactPixels = new Uint8ClampedArray([
  255, 0, 0, 128,
  0, 0, 255, 255
]);
await messageHandler({ data: {
  requestId: 9,
  buffer: exactPixels.buffer,
  width: 2,
  height: 1,
  settings: { mode: 'exact' }
} });
const exactResult = messages.find((message) => message.type === 'result' && message.requestId === 9);
assert.ok(exactResult, 'worker should return a Pixel-Exact result');
assert.equal(exactResult.ok, true, exactResult.error || 'Pixel-Exact should preserve alpha');
assert.match(exactResult.result.svg, /fill-opacity=/, 'Pixel-Exact SVG should encode alpha using fill-opacity');
console.log('PASS worker Pixel-Exact mode emits alpha-preserving SVG paths.');
