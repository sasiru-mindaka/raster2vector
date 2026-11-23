import fs from 'node:fs';
import path from 'node:path';

const workDir = path.resolve(process.argv[2] || '');
if (!workDir || !fs.existsSync(path.join(workDir, 'manifest.json'))) {
  throw new Error('Pass the temporary fixture directory created by pure-vector-regression.py.');
}

// Run the real application Worker message handler in Node with a minimal Worker/ImageData shim.
// This exercises request validation, palette preparation, GPU-to-CPU fallback selection,
// pure-photo tracing, SVG inspection, and the actual result payload without a browser UI.
let messageHandler;
let messages = [];
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
if (typeof messageHandler !== 'function') throw new Error('The application Worker did not register its message handler.');

const manifest = JSON.parse(fs.readFileSync(path.join(workDir, 'manifest.json'), 'utf8'));
const outputDir = path.join(workDir, 'svg');
fs.mkdirSync(outputDir, { recursive: true });
const results = [];

for (let index = 0; index < manifest.length; index++) {
  const item = manifest[index];
  const bytes = fs.readFileSync(path.join(workDir, item.raw));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  messages = [];
  const settings = {
    mode: 'photo',
    profile: 'photo',
    colors: 512,
    smoothness: 0.65,
    speckle: 0,
    detailProtection: 90,
    minVectorArea: 48,
    edgeOverlap: 0,
    maxDimension: 6000,
    underlay: 'masked',
    curve: 'bezier',
    gradients: true,
    tileSize: 'auto',
    gpuBackend: 'cpu',
    edgeProtection: false
  };
  const started = performance.now();
  await messageHandler({ data: {
    requestId: index + 100,
    buffer,
    width: item.width,
    height: item.height,
    settings
  } });
  const resultMessage = messages.find((message) => message.type === 'result');
  if (!resultMessage || resultMessage.ok !== true) {
    throw new Error(`${item.name}: application worker failed: ${resultMessage?.error || 'no result message'}`);
  }
  const result = resultMessage.result;
  if (result.mode !== 'pure-vector') throw new Error(`${item.name}: worker returned ${result.mode}, not pure-vector.`);
  if (result.vectorPercent < 99.999 || result.rasterPercent !== 0 || result.rasterFallbackEmbedded !== false) {
    throw new Error(`${item.name}: incomplete vector coverage (${result.vectorPercent}% vector, ${result.rasterPercent}% raster).`);
  }
  if (/<image\b|data:image\//i.test(result.svg)) throw new Error(`${item.name}: embedded raster image detected.`);
  if (!result.pathCount) throw new Error(`${item.name}: no vector paths were emitted.`);
  const svgPath = path.join(outputDir, `${item.name}.svg`);
  fs.writeFileSync(svgPath, result.svg);
  results.push({
    image: item.name,
    dimensions: `${item.width}x${item.height}`,
    paletteColours: result.colorCount,
    pathCount: result.pathCount,
    gradientPieces: result.gradientPieces,
    vectorPercent: Number(result.vectorPercent.toFixed(3)),
    rasterPercent: Number(result.rasterPercent.toFixed(3)),
    embeddedRasterImages: 0,
    svgBytes: Buffer.byteLength(result.svg),
    traceSeconds: Number(((performance.now() - started) / 1000).toFixed(2)),
    gpuBackend: result.gpuBackend,
    notice: result.notice,
    svgPath
  });
}

console.log(JSON.stringify(results, null, 2));
