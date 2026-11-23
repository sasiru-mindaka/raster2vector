/** Compose local masked raster fallback underneath genuine coloured SVG paths. */

async function imageDataToPngDataUrl(imageData, mask) {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('This browser does not support OffscreenCanvas in workers, which is required for masked PNG fallback.');
  }
  const { width, height, data } = imageData;
  const fallback = new Uint8ClampedArray(data.length);
  for (let p = 0; p < mask.length; p++) {
    const i = p * 4;
    const alpha = mask[p] ? data[i + 3] : 0;
    fallback[i] = data[i];
    fallback[i + 1] = data[i + 1];
    fallback[i + 2] = data[i + 2];
    fallback[i + 3] = alpha;
  }
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { alpha: true, colorSpace: 'srgb' });
  if (!context) throw new Error('Could not create the masked raster fallback canvas.');
  context.putImageData(new ImageData(fallback, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  if (!blob || !blob.size) throw new Error('The masked raster fallback could not be encoded as PNG.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

function extractSvgBody(svg) {
  const open = svg.match(/<svg\b[^>]*>/i);
  const closeIndex = svg.toLowerCase().lastIndexOf('</svg>');
  if (!open || closeIndex < 0) throw new Error('The vector tracer returned an incomplete SVG document.');
  return svg.slice(open.index + open[0].length, closeIndex);
}

export async function composeHybridSvg({ vectorSvg, sourceImageData, rasterMask, segmentation }) {
  const width = sourceImageData.width;
  const height = sourceImageData.height;
  const body = extractSvgBody(vectorSvg);
  const rasterDataUrl = await imageDataToPngDataUrl(sourceImageData, rasterMask);
  const fallbackImage = `<image x="0" y="0" width="${width}" height="${height}" href="${rasterDataUrl}" preserveAspectRatio="none"/>`;
  // Raster fallback is drawn first; vector paths then cover the overlap band.
  // The PNG alpha is generated from the same segmentation grid as the vector input.
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    fallbackImage + body + '</svg>';
  return {
    svg,
    rasterFallbackEmbedded: true,
    vectorPercent: segmentation.vectorPercent,
    rasterPercent: segmentation.rasterPercent,
    rasterUnderlayPercent: segmentation.rasterUnderlayPercent,
    vectorPixels: segmentation.vectorPixels,
    rasterPixels: segmentation.rasterPixels
  };
}

/** Build an RGBA mask preview PNG as a data URL (for diagnostics only). */
export async function createMaskPreviewDataUrl(width, height, mask) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < mask.length; i++) {
    const j = i * 4;
    if (mask[i]) pixels.set([255, 139, 0, 180], j);
    else pixels.set([0, 0, 0, 0], j);
  }
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  context.putImageData(new ImageData(pixels, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(binary)}`;
}
