import { buildLosslessSvg, ComplexityLimitError } from '../core/lossless.js';
import { inspectSvg } from '../core/svg-utils.js';
import { composeHybridSvg } from '../core/hybrid-composer.js';
import { prepareHybridPalette, resolveHybridProfile, traceHybridPure } from '../core/engine.js';
import { classifyPaletteOnGpu } from '../generated/gpu/accelerator.js';
import { validateWorkerPayload } from '../generated/security/validation.js';

self.addEventListener('message', async (event) => {
  const raw = event.data;
  const requestId = raw && typeof raw === 'object' ? raw.requestId : undefined;
  if (!Number.isSafeInteger(requestId) || requestId < 1) return;
  const startedAt = performance.now();
  const stage = (percent, message) => self.postMessage({ requestId, type: 'stage', percent, message });
  try {
    const payload = validateWorkerPayload(raw);
    const { buffer, width, height, settings } = payload;
    const imageData = new ImageData(new Uint8ClampedArray(buffer), width, height);
    let result;
    if (settings.mode === 'photo') {
      for (let i = 3; i < imageData.data.length; i += 4) {
        const alpha = imageData.data[i];
        if (alpha > 0 && alpha < 255) {
          throw new Error('Pure Vector Photo cannot preserve semi-transparent pixels yet. Use Hybrid Vector or Pixel-Exact mode for this image.');
        }
      }
    }
    if (settings.mode === 'exact') {
      stage(10, 'Building pixel-exact SVG geometry…');
      try { result = buildLosslessSvg(imageData); }
      catch (error) {
        if (!(error instanceof ComplexityLimitError)) throw error;
        throw new Error('Pixel-Exact mode exceeded the safe complexity limit. Use Hybrid mode.');
      }
    } else {
      const palette = prepareHybridPalette(
        imageData,
        settings,
        (message) => stage(14, message)
      );
      stage(16, 'Running GPU palette assignment and Sobel edge detection…');
      const gpu = await classifyPaletteOnGpu(imageData, palette.labelLut, palette.pal.length, settings.gpuBackend);
      if (gpu.backend === 'cpu') {
        stage(18, gpu.fallbackReason
          ? 'GPU acceleration is unavailable; continuing with the CPU-safe palette path…'
          : 'CPU processing selected; preserving the original fallback engine…');
      } else {
        stage(20, `${gpu.backend.toUpperCase()} completed palette assignment and edge detection…`);
      }
      const prepared = {
        ...palette,
        assignments: gpu.assignments,
        edgeMask: gpu.edgeMask,
        gpuBackend: gpu.backend,
        gpuEdgePixels: gpu.edgePixels
      };
      const purePhoto = settings.mode === 'photo';
      const tracingSettings = purePhoto
        ? {
            ...settings,
            pureVector: true,
            tol: 4,
            minVectorArea: Math.max(1, settings.minVectorArea),
            edgeOverlap: 0,
            underlay: 'masked',
            speckle: 0,
            edgeProtection: false,
            gradNoise: 5,
            gradTol: 10
          }
        : resolveHybridProfile({
            ...settings,
            tol: Math.max(1, Math.round(10 - settings.detailProtection * 0.08))
          });
      const traced = traceHybridPure(imageData, tracingSettings, stage, prepared);
      const backendNotice = gpu.backend === 'cpu'
        ? `GPU: CPU fallback${gpu.fallbackReason ? ` (${gpu.fallbackReason})` : ''}.`
        : `GPU: ${gpu.backend.toUpperCase()} · ${gpu.edgePixels.toLocaleString()} edges analysed.`;
      if (purePhoto) {
        stage(94, 'Validating the pure-vector SVG (no embedded raster images)…');
        const info = inspectSvg(traced.svg);
        if (/<image\b|data:image\//i.test(traced.svg)) throw new Error('Pure-vector mode generated an embedded raster resource; export was stopped.');
        result = {
          ...info,
          svg: traced.svg,
          width,
          height,
          mode: 'pure-vector',
          vectorPercent: traced.vectorPercent,
          rasterPercent: 0,
          colorCount: traced.colorCount,
          gradientPieces: traced.gradientPieces,
          rasterFallbackEmbedded: false,
          gpuBackend: gpu.backend,
          gpuEdgePixels: gpu.edgePixels,
          gpuElapsedMs: gpu.elapsedMs,
          notice: `Pure vector · ${traced.colorCount} palette colours · ${traced.gradientPieces} SVG gradient pieces · ${traced.pathCount} paths · no embedded raster image. ${backendNotice}`
        };
      } else {
        stage(94, 'Encoding the raster underlay and composing the SVG…');
        const composed = await composeHybridSvg({
          vectorSvg: traced.svg,
          sourceImageData: imageData,
          rasterMask: traced.rasterMask,
          segmentation: traced
        });
        const info = inspectSvg(composed.svg);
        result = {
          ...info,
          svg: composed.svg,
          width,
          height,
          mode: 'hybrid',
          vectorPercent: traced.vectorPercent,
          rasterPercent: traced.rasterPercent,
          rasterFallbackEmbedded: true,
          gpuBackend: gpu.backend,
          gpuEdgePixels: gpu.edgePixels,
          gpuElapsedMs: gpu.elapsedMs,
          notice: `Palette: ${traced.colorCount} colours · ${traced.gradientPieces} gradient pieces · ${traced.tiles} tile(s) · ${(settings.curve || 'bezier')} curves. ${backendNotice}`
        };
      }
    }
    result.elapsedMs = Math.round(performance.now() - startedAt);
    result.svgBytes = new TextEncoder().encode(result.svg).byteLength;
    stage(100, 'SVG validated and ready to preview.');
    self.postMessage({ requestId, type: 'result', ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Vectorization failed.';
    self.postMessage({ requestId, type: 'result', ok: false, error: message });
  }
});
