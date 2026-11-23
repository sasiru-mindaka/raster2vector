import { inspectSvg } from './svg-utils.js';

const SVG_OPEN_RE = /<svg\b[^>]*>/i;
const SVG_CLOSE_RE = /<\/svg\s*>/i;
const PATH_RE = /<path\b[^>]*>/gi;
const FILL_RE = /\bfill\s*=\s*(["'])(.*?)\1/i;
const STYLE_RE = /\bstyle\s*=\s*(["'])(.*?)\1/i;
const STYLE_FILL_RE = /(?:^|;)\s*fill\s*:\s*([^;]+)/i;

/**
 * Convert the raw VTracer output into a complete SVG without flattening its
 * per-region colours.
 *
 * IMPORTANT: @buzz-dee/vtrace@2.0.0-0's public getSVG() method is monochrome:
 * it extracts all d attributes from the raw result and puts them into one
 * <path> using a single fill (black by default). The underlying WASM output is
 * held in the instance's normal runtime `_pathData` property and contains the
 * original colour-specific SVG paths. TypeScript's `private` modifier does not
 * make this property a JavaScript #private field.
 */
export function buildColourPreservingSvg(tracer, width, height, sourceImageData) {
  if (!tracer || typeof tracer.getSVG !== 'function') {
    throw new TypeError('Invalid VTracer instance.');
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new TypeError('Invalid SVG dimensions.');
  }

  // Run VTracer. Discard the returned monochrome wrapper SVG deliberately.
  tracer.getSVG();
  const raw = tracer._pathData;
  if (typeof raw !== 'string' || raw.trim().length < 20) {
    throw new Error('VTracer did not expose its raw colour SVG output.');
  }
  if (/<(?:script|foreignObject)\b/i.test(raw) || /\bon\w+\s*=/i.test(raw)) {
    throw new Error('VTracer returned unsupported active SVG content.');
  }

  let svg = raw.trim();
  const rootMatch = svg.match(SVG_OPEN_RE);
  if (rootMatch) {
    if (!SVG_CLOSE_RE.test(svg)) {
      throw new Error('VTracer returned an incomplete SVG document.');
    }
    // Keep the complete WASM-generated SVG body and every path attribute.
    const root = rootMatch[0];
    let updatedRoot = root;
    if (!/\bwidth\s*=/.test(root)) updatedRoot = updatedRoot.replace(/>$/, ` width="${width}">`);
    if (!/\bheight\s*=/.test(updatedRoot)) updatedRoot = updatedRoot.replace(/>$/, ` height="${height}">`);
    if (!/\bviewBox\s*=/.test(updatedRoot)) updatedRoot = updatedRoot.replace(/>$/, ` viewBox="0 0 ${width} ${height}">`);
    if (updatedRoot !== root) svg = svg.replace(root, updatedRoot);
  } else {
    // Defensive support for a build that returns path fragments only.
    const tags = svg.match(PATH_RE) || [];
    if (!tags.length) throw new Error('VTracer output contains no vector paths.');
    svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${svg}</svg>`;
  }

  const stats = inspectSvg(svg);
  if (!stats.pathCount || !stats.colorCount) {
    throw new Error('VTracer output does not contain coloured vector paths.');
  }

  // A multi-colour source must not silently become a black silhouette.
  if (sourceImageData && hasMultipleOpaqueRgbColours(sourceImageData) && stats.colorCount < 2) {
    throw new Error('VTracer collapsed a multi-colour image to one SVG fill. The monochrome result was rejected.');
  }

  // Explicitly check raw path fills too, since the SVG may inherit a fill from a group.
  const pathTags = svg.match(PATH_RE) || [];
  const pathFills = new Set(pathTags.map((tag) => {
    const match = tag.match(FILL_RE);
    if (match) return match[2].trim().toLowerCase();
    const style = tag.match(STYLE_RE)?.[2] || '';
    return style.match(STYLE_FILL_RE)?.[1]?.trim().toLowerCase() || '';
  }).filter((fill) => fill && fill !== 'none'));
  if (!pathFills.size) {
    throw new Error('VTracer output paths have no explicit fill colours.');
  }

  return { svg, ...stats };
}

export function hasMultipleOpaqueRgbColours(imageData, stopAfter = 2) {
  if (!imageData?.data || imageData.data.length < 8) return false;
  const colours = new Set();
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    colours.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    if (colours.size >= stopAfter) return true;
  }
  return false;
}
