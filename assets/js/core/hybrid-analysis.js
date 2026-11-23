/**
 * Local hybrid-region classifier.
 *
 * This is deliberately a conservative classifier: regions with high local
 * texture, high-frequency edges, dense colour variation, or photographic
 * detail are kept as masked raster. Flat, stable regions are offered to the
 * vector tracer. The two output masks share the exact same pixel grid.
 */

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function profileThresholds(profile) {
  switch (profile) {
    case 'photo': return { edge: 0.105, unique: 0.11, variance: 17, meanDelta: 10, entropy: 0.28, residual: 11 };
    case 'logo': return { edge: 0.34, unique: 0.46, variance: 58, meanDelta: 24, entropy: 0.60, residual: 27 };
    case 'illustration':
    case 'poster': return { edge: 0.26, unique: 0.34, variance: 43, meanDelta: 19, entropy: 0.48, residual: 21 };
    default: return { edge: 0.20, unique: 0.25, variance: 31, meanDelta: 15, entropy: 0.40, residual: 17 };
  }
}

function maxChannelDelta(data, a, b) {
  return Math.max(Math.abs(data[a] - data[b]), Math.abs(data[a + 1] - data[b + 1]), Math.abs(data[a + 2] - data[b + 2]));
}

function classifyTile(data, width, height, x0, y0, x1, y1, thresholds, protection) {
  let count = 0;
  let sr = 0, sg = 0, sb = 0;
  let sr2 = 0, sg2 = 0, sb2 = 0;
  let edgeCounts = [0, 0, 0];
  let highEdges = [0, 0, 0];
  let deltaSums = [0, 0, 0];
  const histogram = new Map();
  const samples = [];
  const stride = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 1200)));
  const offsets = [1, 2, 4];

  for (let y = y0; y < y1; y += stride) {
    for (let x = x0; x < x1; x += stride) {
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      count++;
      sr += r; sg += g; sb += b;
      sr2 += r * r; sg2 += g * g; sb2 += b * b;
      samples.push([r, g, b, key]);
      const bucket = histogram.get(key) || { count: 0, r: 0, g: 0, b: 0 };
      bucket.count++;
      bucket.r += r; bucket.g += g; bucket.b += b;
      histogram.set(key, bucket);

      // Multi-scale edge evidence: fine texture, medium strokes, and broader
      // tonal changes are measured separately instead of one binary edge test.
      for (let scale = 0; scale < offsets.length; scale++) {
        const offset = offsets[scale];
        if (x - offset >= x0) {
          const j = (y * width + x - offset) * 4;
          const delta = maxChannelDelta(data, i, j);
          deltaSums[scale] += delta;
          edgeCounts[scale]++;
          if (delta > 28) highEdges[scale]++;
        }
        if (y - offset >= y0) {
          const j = ((y - offset) * width + x) * 4;
          const delta = maxChannelDelta(data, i, j);
          deltaSums[scale] += delta;
          edgeCounts[scale]++;
          if (delta > 28) highEdges[scale]++;
        }
      }
    }
  }

  if (!count) return { complex: false, visible: false, edgeRatio: 0, uniqueRatio: 0, deviation: 0, entropy: 0, quantizationResidual: 0 };
  const mr = sr / count, mg = sg / count, mb = sb / count;
  const variance = (sr2 / count - mr * mr + sg2 / count - mg * mg + sb2 / count - mb * mb) / 3;
  const deviation = Math.sqrt(Math.max(0, variance));
  const edgeRatios = edgeCounts.map((n, i) => n ? highEdges[i] / n : 0);
  const meanDeltas = deltaSums.map((n, i) => edgeCounts[i] ? n / edgeCounts[i] : 0);
  const uniqueRatio = histogram.size / count;

  let entropyBits = 0;
  for (const item of histogram.values()) {
    const probability = item.count / count;
    entropyBits -= probability * Math.log2(probability);
  }
  const normalizedEntropy = entropyBits / 12; // 12 bits for the 4-bit-per-channel histogram.

  // Quantisation residual measures variation hidden inside the coarse colour
  // buckets. It helps separate a clean flat palette from noisy photographic detail.
  let residualSquared = 0;
  for (const [r, g, b, key] of samples) {
    const bucket = histogram.get(key);
    const dr = r - bucket.r / bucket.count;
    const dg = g - bucket.g / bucket.count;
    const db = b - bucket.b / bucket.count;
    residualSquared += dr * dr + dg * dg + db * db;
  }
  const quantizationResidual = Math.sqrt(residualSquared / Math.max(1, count * 3));

  // Higher detail protection lowers the thresholds so more complex pixels are
  // retained as raster detail instead of being forced into vector geometry.
  const protectionFactor = 1.25 - protection * 0.005;
  const edgeLimit = thresholds.edge / protectionFactor;
  const uniqueLimit = thresholds.unique / protectionFactor;
  const varianceLimit = thresholds.variance / protectionFactor;
  const meanDeltaLimit = thresholds.meanDelta / protectionFactor;
  const entropyLimit = thresholds.entropy / protectionFactor;
  const residualLimit = thresholds.residual / protectionFactor;

  const fineTexture = edgeRatios[0] > edgeLimit;
  const mediumTexture = edgeRatios[1] > edgeLimit * 1.18 && normalizedEntropy > entropyLimit * 0.6;
  const colourComplexity = uniqueRatio > uniqueLimit && deviation > varianceLimit && normalizedEntropy > entropyLimit;
  const quantizationNoise = quantizationResidual > residualLimit && normalizedEntropy > entropyLimit * 0.65;
  const broadVariation = meanDeltas[2] > meanDeltaLimit && uniqueRatio > uniqueLimit * 0.55;
  const complex = fineTexture || mediumTexture || colourComplexity || quantizationNoise || broadVariation;

  return {
    complex, visible: true,
    edgeRatio: edgeRatios[0], mediumEdgeRatio: edgeRatios[1], coarseEdgeRatio: edgeRatios[2],
    uniqueRatio, deviation, entropy: normalizedEntropy, quantizationResidual
  };
}

function removeTinyVectorComponents(cellVector, columns, rows, tileSize, imageWidth, imageHeight, minArea) {
  if (minArea <= 0) return;
  const seen = new Uint8Array(cellVector.length);
  const queue = new Int32Array(cellVector.length);
  for (let start = 0; start < cellVector.length; start++) {
    if (!cellVector[start] || seen[start]) continue;
    let head = 0, tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const index = queue[head++];
      const x = index % columns, y = Math.floor(index / columns);
      const neighbours = [x > 0 ? index - 1 : -1, x + 1 < columns ? index + 1 : -1,
        y > 0 ? index - columns : -1, y + 1 < rows ? index + columns : -1];
      for (const next of neighbours) {
        if (next >= 0 && cellVector[next] && !seen[next]) {
          seen[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    let area = 0;
    for (let q = 0; q < tail; q++) {
      const index = queue[q];
      const x = index % columns, y = Math.floor(index / columns);
      const w = Math.min(tileSize, imageWidth - x * tileSize);
      const h = Math.min(tileSize, imageHeight - y * tileSize);
      area += w * h;
    }
    if (area < minArea) for (let q = 0; q < tail; q++) cellVector[queue[q]] = 0;
  }
}

function dilateMask(mask, width, height, radius) {
  if (radius <= 0) return mask;
  const horizontal = new Uint8Array(mask.length);
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let active = 0;
    for (let x = 0; x < width; x++) {
      const add = x + radius;
      const remove = x - radius - 1;
      if (add < width && mask[row + add]) active++;
      if (remove >= 0 && mask[row + remove]) active--;
      horizontal[row + x] = active > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < width; x++) {
    let active = 0;
    for (let y = 0; y < height; y++) {
      const add = y + radius;
      const remove = y - radius - 1;
      if (add < height && horizontal[add * width + x]) active++;
      if (remove >= 0 && horizontal[remove * width + x]) active--;
      output[y * width + x] = active > 0 ? 1 : 0;
    }
  }
  return output;
}

/**
 * Returns complementary vector/raster classification masks plus an expanded
 * raster-underlay mask. The underlay is intentionally dilated so vector curve
 * fitting can overlap it slightly; this prevents transparent seams/halos.
 */
export function analyseAndSegment(imageData, settings = {}, onProgress = () => {}) {
  const { width, height, data } = imageData;
  if (!width || !height || data.length !== width * height * 4) throw new TypeError('Invalid image data for hybrid analysis.');
  const tileSize = clamp(Number(settings.analysisTileSize) || 16, 8, 64);
  const columns = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  const thresholds = profileThresholds(settings.profile || 'auto');
  const protection = clamp(Number(settings.detailProtection ?? 65), 0, 100);
  const cellVector = new Uint8Array(columns * rows);
  const tileMetrics = [];

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < columns; cx++) {
      const stats = classifyTile(data, width, height, cx * tileSize, cy * tileSize,
        Math.min(width, (cx + 1) * tileSize), Math.min(height, (cy + 1) * tileSize), thresholds, protection);
      const i = cy * columns + cx;
      cellVector[i] = stats.visible && !stats.complex ? 1 : 0;
      tileMetrics.push(stats);
    }
    if (cy % 16 === 0) onProgress(Math.round((cy / rows) * 60), 'Analysing local colour, texture and edge complexity…');
  }

  removeTinyVectorComponents(cellVector, columns, rows, tileSize, width, height,
    clamp(Number(settings.minVectorArea) || 0, 0, 1_000_000));

  const vectorMask = new Uint8Array(width * height);
  const baseRasterMask = new Uint8Array(width * height);
  let visiblePixels = 0;
  let vectorPixels = 0;
  let baseRasterPixels = 0;
  for (let y = 0; y < height; y++) {
    const cy = Math.floor(y / tileSize);
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      if (data[pixel * 4 + 3] === 0) continue;
      visiblePixels++;
      const vector = cellVector[cy * columns + Math.floor(x / tileSize)] === 1;
      if (vector) { vectorMask[pixel] = 1; vectorPixels++; }
      else { baseRasterMask[pixel] = 1; baseRasterPixels++; }
    }
    if (y % 256 === 0) onProgress(60 + Math.round((y / height) * 15), 'Building aligned region masks…');
  }

  const overlap = clamp(Number(settings.edgeOverlap) || 2, 0, 8);
  const rasterMask = dilateMask(baseRasterMask, width, height, overlap);
  let rasterUnderlayPixels = 0;
  for (let i = 0; i < rasterMask.length; i++) if (rasterMask[i] && data[i * 4 + 3]) rasterUnderlayPixels++;

  const vectorPercent = visiblePixels ? vectorPixels / visiblePixels * 100 : 0;
  const rasterPercent = visiblePixels ? baseRasterPixels / visiblePixels * 100 : 0;
  const underlayPercent = visiblePixels ? rasterUnderlayPixels / visiblePixels * 100 : 0;
  return {
    width, height, vectorMask, rasterMask, baseRasterMask,
    vectorPixels, rasterPixels: baseRasterPixels, rasterUnderlayPixels, visiblePixels,
    vectorPercent, rasterPercent, rasterUnderlayPercent: underlayPercent,
    tileSize, columns, rows, tileMetrics
  };
}

export function createMaskedVectorImageData(imageData, vectorMask) {
  const data = new Uint8ClampedArray(imageData.data.length);
  for (let p = 0; p < vectorMask.length; p++) {
    if (!vectorMask[p]) continue;
    const i = p * 4;
    data[i] = imageData.data[i];
    data[i + 1] = imageData.data[i + 1];
    data[i + 2] = imageData.data[i + 2];
    data[i + 3] = imageData.data[i + 3];
  }
  return { width: imageData.width, height: imageData.height, data };
}
