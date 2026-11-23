import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareHybridPalette, traceHybridPure } from '../assets/js/core/engine.js';

const workDir = path.resolve(process.argv[2] || '');
if (!workDir || !fs.existsSync(path.join(workDir, 'manifest.json'))) {
  throw new Error('Pass the temporary fixture directory created by real-image-regression.py.');
}
const manifest = JSON.parse(fs.readFileSync(path.join(workDir, 'manifest.json'), 'utf8'));
const outputDir = path.join(workDir, 'svg');
fs.mkdirSync(outputDir, { recursive: true });
const results = [];
for (const item of manifest) {
  const bytes = fs.readFileSync(path.join(workDir, item.raw));
  const image = { width: item.width, height: item.height, data: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  const settings = {
    colors: 64,
    tol: 4,
    minVectorArea: 12,
    edgeOverlap: 1,
    smoothness: 0.8,
    curve: 'bezier',
    gradients: false,
    tileSize: 0,
    underlay: 'full',
    edgeProtection: true,
    targetPsnr: 44
  };
  const started = performance.now();
  const palette = prepareHybridPalette(image, settings);
  const cpu = traceHybridPure(image, settings);
  const assignments = new Uint16Array(item.width * item.height);
  for (let index = 0; index < assignments.length; index++) {
    const offset = index * 4;
    const r = image.data[offset] >> 2;
    const g = image.data[offset + 1] >> 2;
    const b = image.data[offset + 2] >> 2;
    assignments[index] = palette.labelLut[r * 4096 + g * 64 + b];
  }
  const lookup = traceHybridPure(image, settings, () => {}, { ...palette, assignments, gpuBackend: 'lut-reference' });
  if (lookup.vectorPixels !== cpu.vectorPixels || lookup.colorCount !== cpu.colorCount || lookup.svg !== cpu.svg) {
    throw new Error(`${item.name}: LUT palette assignment differs from CPU reference output.`);
  }
  const svgPath = path.join(outputDir, `${item.name}.svg`);
  fs.writeFileSync(svgPath, lookup.svg);
  results.push({
    image: item.name,
    dimensions: `${item.width}x${item.height}`,
    colours: lookup.colorCount,
    paths: lookup.pathCount,
    vectorPercent: Number(lookup.vectorPercent.toFixed(2)),
    quantPsnrDb: Number(lookup.quantPsnr.toFixed(2)),
    lutMatchesCpu: true,
    traceSeconds: Number(((performance.now() - started) / 1000).toFixed(2)),
    svgPath
  });
}
console.log(JSON.stringify(results, null, 2));
