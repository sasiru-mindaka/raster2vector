import { buildLosslessSvg, ComplexityLimitError } from '../core/lossless.js';
import { inspectSvg } from '../core/svg-utils.js';
import { composeHybridSvg } from '../core/hybrid-composer.js';
import { traceHybridPure } from '../core/engine.js';

self.addEventListener('message', async (event) => {
  const { requestId, buffer, width, height, settings } = event.data || {};
  if (!requestId || !(buffer instanceof ArrayBuffer) || !width || !height) return;
  const startedAt = performance.now();
  const stage = (percent, message) => self.postMessage({ requestId, type: 'stage', percent, message });
  try {
    const imageData = new ImageData(new Uint8ClampedArray(buffer), width, height);
    let result;
    if (settings.mode === 'exact') {
      stage(10, 'Building pixel-exact SVG geometry…');
      try { result = buildLosslessSvg(imageData); }
      catch (e) { if (!(e instanceof ComplexityLimitError)) throw e; throw new Error('Pixel-Exact mode exceeded the safe complexity limit. Use Hybrid mode.'); }
    } else {
      const t = traceHybridPure(imageData, { ...settings, tol: Math.max(1, Math.round(10 - settings.detailProtection * 0.08)) }, stage);
      stage(94, 'Encoding the masked raster underlay and composing the SVG…');
      const c = await composeHybridSvg({ vectorSvg: t.svg, sourceImageData: imageData, rasterMask: t.rasterMask, segmentation: t });
      const info = inspectSvg(c.svg);
      result = { ...info, svg: c.svg, width, height, mode: 'hybrid', vectorPercent: t.vectorPercent, rasterPercent: t.rasterPercent,
        notice: `Palette: ${t.colorCount} colours.` };
    }
    result.elapsedMs = Math.round(performance.now() - startedAt);
    result.svgBytes = new TextEncoder().encode(result.svg).byteLength;
    stage(100, 'SVG validated and ready to preview.');
    self.postMessage({ requestId, type: 'result', ok: true, result });
  } catch (error) {
    self.postMessage({ requestId, type: 'result', ok: false, error: error?.message || 'Vectorization failed.' });
  }
});
