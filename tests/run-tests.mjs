import assert from 'node:assert/strict';
import { buildLosslessSvg, ComplexityLimitError, MAX_LOSSLESS_REGIONS } from '../assets/js/core/lossless.js';
import { inspectSvg, formatBytes } from '../assets/js/core/svg-utils.js';
import { buildColourPreservingSvg, hasMultipleOpaqueRgbColours } from '../assets/js/core/vtrace-adapter.js';
import { analyseAndSegment, createMaskedVectorImageData } from '../assets/js/core/hybrid-analysis.js';
import { composeHybridSvg } from '../assets/js/core/hybrid-composer.js';

function imageData(width, height, pixels) {
  return { width, height, data: new Uint8ClampedArray(pixels) };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

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
});

test('colour adapter ignores VTrace getSVG monochrome wrapper and preserves raw per-region fills', () => {
  const rawSvg = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="2" height="1" viewBox="0 0 2 1"><path fill="#ef0000" d="M0 0h1v1z"/><path fill="#00c800" d="M1 0h1v1z"/></svg>';
  const tracer = { _pathData: rawSvg, getSVG() { return '<svg><path fill="black" d="M0 0h2v1z"/></svg>'; } };
  const source = imageData(2, 1, [255, 0, 0, 255, 0, 200, 0, 255]);
  const result = buildColourPreservingSvg(tracer, 2, 1, source);
  assert.match(result.svg, /fill="#ef0000"/);
  assert.match(result.svg, /fill="#00c800"/);
  assert.doesNotMatch(result.svg, /fill="black"/);
  assert.equal(result.colorCount, 2);
  assert.equal(result.pathCount, 2);
});

test('colour adapter rejects monochrome output for multicolour source', () => {
  const tracer = { _pathData: '<svg xmlns="http://www.w3.org/2000/svg"><path fill="#000000" d="M0 0z"/></svg>', getSVG() { return ''; } };
  const source = imageData(2, 1, [255, 0, 0, 255, 0, 0, 255, 255]);
  assert.throws(() => buildColourPreservingSvg(tracer, 2, 1, source), /collapsed a multi-colour image/);
});

test('colour detection ignores fully transparent pixels', () => {
  assert.equal(hasMultipleOpaqueRgbColours(imageData(2, 1, [255, 0, 0, 255, 0, 255, 0, 0])), false);
  assert.equal(hasMultipleOpaqueRgbColours(imageData(2, 1, [255, 0, 0, 255, 0, 255, 0, 255])), true);
});

test('colour adapter rejects missing raw VTracer SVG output', () => {
  const tracer = { _pathData: undefined, getSVG() { return '<svg><path fill="black"/></svg>'; } };
  assert.throws(() => buildColourPreservingSvg(tracer, 1, 1), /did not expose its raw colour SVG/);
});

test('byte formatter uses readable units', () => {
  assert.equal(formatBytes(20), '20 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(1048576), '1.00 MB');
});

// Hybrid segmentation and composition prerequisites.

function rgbaFixture(width, height, pixelAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    data.set(pixelAt(x, y), i);
  }
  return { width, height, data };
}

test('hybrid analyser classifies large clean flat colour regions as vector-friendly', () => {
  const fixture = rgbaFixture(64, 32, (x) => x < 32 ? [240, 20, 30, 255] : [20, 80, 240, 255]);
  const result = analyseAndSegment(fixture, { profile: 'logo', analysisTileSize: 8, detailProtection: 35, edgeOverlap: 0, minVectorArea: 0 });
  assert.equal(result.vectorPercent, 100);
  assert.equal(result.rasterPercent, 0);
  assert.equal(result.vectorMask.length, 64 * 32);
});

test('hybrid analyser sends a high-frequency noisy patch to raster fallback', () => {
  let seed = 123456;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed & 255; };
  const fixture = rgbaFixture(64, 32, (x, y) => {
    if (x < 32) return [240, 30, 20, 255];
    return [random(), random(), random(), 255];
  });
  const result = analyseAndSegment(fixture, { profile: 'photo', analysisTileSize: 8, detailProtection: 80, edgeOverlap: 0, minVectorArea: 0 });
  assert.ok(result.rasterPercent > 40, `expected raster fallback > 40%, got ${result.rasterPercent}`);
  assert.ok(result.vectorPercent < 60);
});

test('hybrid raster underlay dilates around fallback regions without changing vector mask', () => {
  const fixture = rgbaFixture(24, 24, (x, y) => x >= 8 && x < 16 && y >= 8 && y < 16 ? [randomNoise(x, y), 90, 90, 255] : [230, 230, 230, 255]);
  const withoutOverlap = analyseAndSegment(fixture, { profile: 'photo', analysisTileSize: 8, detailProtection: 100, edgeOverlap: 0, minVectorArea: 0 });
  const withOverlap = analyseAndSegment(fixture, { profile: 'photo', analysisTileSize: 8, detailProtection: 100, edgeOverlap: 2, minVectorArea: 0 });
  assert.deepEqual(withOverlap.vectorMask, withoutOverlap.vectorMask);
  assert.ok(withOverlap.rasterUnderlayPixels >= withoutOverlap.rasterUnderlayPixels);
});

function randomNoise(x, y) { return (x * 73 + y * 137 + x * y * 11) % 256; }

test('vector-only image data makes all fallback pixels transparent while retaining exact vector RGBA', () => {
  const fixture = rgbaFixture(2, 1, (x) => x === 0 ? [12, 34, 56, 255] : [210, 180, 90, 190]);
  const masked = createMaskedVectorImageData(fixture, new Uint8Array([1, 0]));
  assert.deepEqual([...masked.data], [12, 34, 56, 255, 0, 0, 0, 0]);
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
    assert.equal(result.vectorPercent, 50);
  } finally {
    if (previousCanvas === undefined) delete globalThis.OffscreenCanvas; else globalThis.OffscreenCanvas = previousCanvas;
    if (previousImageData === undefined) delete globalThis.ImageData; else globalThis.ImageData = previousImageData;
  }
});

let failed = 0;
for (const item of tests) {
  try {
    item.fn();
    process.stdout.write(`PASS ${item.name}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`FAIL ${item.name}\n${error.stack}\n`);
  }
}
process.stdout.write(`\n${tests.length - failed}/${tests.length} tests passed.\n`);
if (failed) process.exitCode = 1;

