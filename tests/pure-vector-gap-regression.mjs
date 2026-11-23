import assert from 'node:assert/strict';
import { prepareHybridPalette, traceHybridPure } from '../assets/js/core/engine.js';

function makeImage(width, height, transparentCorner = false) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const bright = x >= 10 && x < width - 10 && y >= 8 && y < height - 8;
      data[i] = bright ? 245 : 1;
      data[i + 1] = bright ? 196 : 6;
      data[i + 2] = bright ? 2 : 16;
      data[i + 3] = 255;
    }
  }
  if (transparentCorner) data[(width * height - 1) * 4 + 3] = 0;
  return { width, height, data };
}

function trace(image, curve = 'bezier') {
  const settings = {
    colors: 32,
    targetPsnr: 44,
    minVectorArea: 1,
    smoothness: 1,
    curve,
    gradients: false,
    speckle: 0,
    tileSize: 'auto',
    pureVector: true,
    edgeProtection: false,
    edgeOverlap: 0,
    underlay: 'masked'
  };
  const prepared = prepareHybridPalette(image, settings, () => {});
  return traceHybridPure(image, settings, () => {}, prepared);
}

const opaque = trace(makeImage(48, 36));
assert.match(opaque.svg, /<path fill="#[0-9a-f]{6}" d="M0 0H48V36H0Z"\/>/i,
  'Fully opaque Pure Vector output must include a vector-only seam underlay.');
assert.doesNotMatch(opaque.svg, /<image\b|data:image\//i,
  'Pure Vector output must never embed a raster image.');
assert.equal(opaque.vectorPercent, 100);
assert.equal(opaque.rasterPercent, 0);
assert.ok(opaque.pathCount >= 2, 'Expected the underlay path and traced vector paths.');
assert.match(opaque.svg, /stroke-width="0\.55"/,
  'Pure-vector contours must use the seam-protection stroke.');

const quadratic = trace(makeImage(48, 36), 'quad');
assert.match(quadratic.svg, /<path fill="#[0-9a-f]{6}" d="M0 0H48V36H0Z"\/>/i);
assert.match(quadratic.svg, /stroke-width="0\.55"/);
assert.doesNotMatch(quadratic.svg, /<image\b|data:image\//i);

const transparent = trace(makeImage(48, 36, true));
assert.doesNotMatch(transparent.svg, /d="M0 0H48V36H0Z"/,
  'Transparent source pixels must not be covered by an opaque full-canvas underlay.');
assert.doesNotMatch(transparent.svg, /<image\b|data:image\//i);

console.log('Pure-vector contour-gap regression: opaque underlay and transparent-source checks passed.');
