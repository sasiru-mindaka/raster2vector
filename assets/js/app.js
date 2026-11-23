import { createImageDataForTrace, decodeImageFile, drawSourcePreview } from './core/image-utils.js';
import { traceImage, stopTracingWorker } from './core/trace-client.js';
import { formatBytes } from './core/svg-utils.js';
import { initializeTheme } from './ui/theme.js';

const $ = (id) => document.getElementById(id);
const elements = {
  fileInput: $('fileInput'), dropZone: $('dropZone'), loadedFile: $('loadedFile'), fileName: $('fileName'),
  fileDimensions: $('fileDimensions'), fileThumb: $('fileThumb'), removeFile: $('removeFile'),
  sourcePreview: $('sourcePreview'), sourceEmpty: $('sourceEmpty'), sourceBadge: $('sourceBadge'), sourceInfo: $('sourceInfo'),
  resultPreview: $('resultPreview'), resultEmpty: $('resultEmpty'), resultBadge: $('resultBadge'), resultInfo: $('resultInfo'),
  traceButton: $('traceButton'), cancelButton: $('cancelButton'), downloadButton: $('downloadButton'),
  modeHint: $('modeHint'), exactNote: $('exactNote'), presetSelect: $('presetSelect'),
  colorCount: $('colorCount'), colorCountValue: $('colorCountValue'),
  curveSmoothness: $('curveSmoothness'), curveSmoothnessValue: $('curveSmoothnessValue'),
  speckleSize: $('speckleSize'), speckleSizeValue: $('speckleSizeValue'),
  detailProtection: $('detailProtection'), detailProtectionValue: $('detailProtectionValue'),
  minVectorArea: $('minVectorArea'), minVectorAreaValue: $('minVectorAreaValue'),
  edgeOverlap: $('edgeOverlap'), edgeOverlapValue: $('edgeOverlapValue'),
  maxDimension: $('maxDimension'), maxDimensionValue: $('maxDimensionValue'),
  statusIndicator: $('statusIndicator'), statusTitle: $('statusTitle'), statusMessage: $('statusMessage'),
  metricPaths: $('metricPaths'), metricColors: $('metricColors'), metricVector: $('metricVector'),
  metricRaster: $('metricRaster'), metricSize: $('metricSize'), metricTime: $('metricTime'), traceProgress: $('traceProgress')
};

let sourceBitmap = null;
let sourceFile = null;
let resultBlob = null;
let resultUrl = null;
let sourcePreviewUrl = null;
let isTracing = false;

function setStatus(title, message, state = 'idle') {
  elements.statusTitle.textContent = title;
  elements.statusMessage.textContent = message;
  elements.statusIndicator.className = `status-indicator${state === 'idle' ? '' : ` is-${state}`}`;
}

function setProgress(percent) {
  elements.traceProgress.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
}

function updateRangeLabels() {
  elements.colorCountValue.textContent = `${elements.colorCount.value} colours`;
  elements.curveSmoothnessValue.textContent = `${Number(elements.curveSmoothness.value).toFixed(1)} px`;
  elements.speckleSizeValue.textContent = `${elements.speckleSize.value} px`;
  elements.detailProtectionValue.textContent = `${elements.detailProtection.value}%`;
  elements.minVectorAreaValue.textContent = `${Number(elements.minVectorArea.value).toLocaleString()} px²`;
  elements.edgeOverlapValue.textContent = `${elements.edgeOverlap.value} px`;
  elements.maxDimensionValue.textContent = `${elements.maxDimension.value} px`;
}

function getMode() {
  return document.querySelector('input[name="mode"]:checked')?.value || 'hybrid';
}

function syncModeControls() {
  const exact = getMode() === 'exact';
  document.querySelectorAll('.mode-card').forEach((card) => {
    card.classList.toggle('selected', card.querySelector('input')?.checked === true);
  });
  document.querySelectorAll('[data-hybrid-control]').forEach((group) => {
    group.classList.toggle('is-disabled', exact);
    group.querySelectorAll('input,select').forEach((control) => { control.disabled = exact; });
  });
  elements.modeHint.textContent = exact
    ? 'Encodes decoded pixels as vector rectangles. It preserves the pixel grid, not smooth curves, and can create very large files.'
    : 'Stable, flat regions become coloured SVG paths. Texture-heavy regions stay in a transparency-masked PNG layer inside the same SVG.';
  elements.exactNote.hidden = !exact;
  elements.traceButton.querySelector('span').textContent = exact ? 'Generate pixel-exact SVG' : 'Generate hybrid SVG';
}

function clearResult() {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
  resultBlob = null;
  elements.resultPreview.hidden = true;
  elements.resultPreview.removeAttribute('src');
  elements.resultEmpty.hidden = false;
  elements.resultBadge.textContent = 'Not generated';
  elements.resultBadge.classList.remove('is-ready');
  elements.resultInfo.textContent = 'No vector output yet';
  elements.downloadButton.disabled = true;
  elements.metricPaths.textContent = '—';
  elements.metricColors.textContent = '—';
  elements.metricVector.textContent = '—';
  elements.metricRaster.textContent = '—';
  elements.metricSize.textContent = '—';
  elements.metricTime.textContent = '—';
  setProgress(0);
}

function validateSvgInBrowser(svgText, expectedWidth, expectedHeight) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('Generated output is not valid SVG/XML. Download was blocked.');
  const root = doc.documentElement;
  if (root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg') throw new Error('The generated file has no valid SVG root element.');
  if (doc.querySelector('script, foreignObject, iframe, object, embed')) throw new Error('The generated SVG contains unsupported active elements.');
  const images = [...doc.querySelectorAll('image')];
  for (const image of images) {
    const href = image.getAttribute('href') || image.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    if (href && !href.startsWith('data:image/png;base64,')) throw new Error('The SVG contains an external or unsupported image reference.');
  }
  const width = Number(root.getAttribute('width'));
  const height = Number(root.getAttribute('height'));
  if (width !== expectedWidth || height !== expectedHeight) throw new Error('SVG canvas dimensions do not match the working image.');
  if (!doc.querySelector('path') && !images.length) throw new Error('The generated SVG contains neither vector paths nor a raster fallback.');
  return { pathCount: doc.querySelectorAll('path').length, imageCount: images.length };
}

async function selectFile(file) {
  if (isTracing) { stopTracingWorker(); isTracing = false; elements.cancelButton.hidden = true; }
  try {
    if (!file) return;
    setStatus('Loading image…', 'Decoding the image locally and checking its dimensions.', 'working');
    elements.traceButton.disabled = true;
    const bitmap = await decodeImageFile(file);
    clearResult();
    sourceBitmap?.close?.();
    sourceBitmap = bitmap;
    sourceFile = file;
    if (sourcePreviewUrl) URL.revokeObjectURL(sourcePreviewUrl);
    const preview = await drawSourcePreview(bitmap, elements.sourcePreview);
    sourcePreviewUrl = preview.url;
    elements.sourcePreview.hidden = false;
    elements.sourceEmpty.hidden = true;
    elements.loadedFile.hidden = false;
    elements.fileName.textContent = file.name;
    elements.fileDimensions.textContent = `${bitmap.width.toLocaleString()} × ${bitmap.height.toLocaleString()} px · ${formatBytes(file.size)}`;
    elements.fileThumb.textContent = (file.name.split('.').pop() || 'IMG').slice(0, 3).toUpperCase();
    elements.sourceBadge.textContent = 'Image loaded';
    elements.sourceInfo.textContent = `${bitmap.width.toLocaleString()} × ${bitmap.height.toLocaleString()} px`;
    elements.traceButton.disabled = false;
    setStatus('Image ready to analyse', 'Hybrid mode is selected. Choose an artwork profile and detail settings, then start the conversion.');
  } catch (error) {
    elements.traceButton.disabled = !sourceBitmap;
    setStatus('Could not load image', error.message, 'error');
  }
}

function removeImage() {
  if (isTracing) stopTracingWorker();
  sourceBitmap?.close?.();
  sourceBitmap = null;
  sourceFile = null;
  if (sourcePreviewUrl) URL.revokeObjectURL(sourcePreviewUrl);
  sourcePreviewUrl = null;
  elements.fileInput.value = '';
  elements.loadedFile.hidden = true;
  elements.sourcePreview.hidden = true;
  elements.sourcePreview.removeAttribute('src');
  elements.sourceEmpty.hidden = false;
  elements.sourceBadge.textContent = 'Waiting for image';
  elements.sourceInfo.textContent = 'No image loaded';
  elements.traceButton.disabled = true;
  elements.cancelButton.hidden = true;
  isTracing = false;
  clearResult();
  setStatus('Ready when you are', 'Upload an image, then generate your hybrid SVG.');
}

async function runTrace() {
  if (!sourceBitmap || !sourceFile || isTracing) return;
  const mode = getMode();
  isTracing = true;
  elements.traceButton.disabled = true;
  elements.cancelButton.hidden = false;
  elements.downloadButton.disabled = true;
  clearResult();
  const settings = {
    mode,
    profile: elements.presetSelect.value,
    colors: Number(elements.colorCount.value),
    smoothness: Number(elements.curveSmoothness.value),
    speckle: Number(elements.speckleSize.value),
    detailProtection: Number(elements.detailProtection.value),
    minVectorArea: Number(elements.minVectorArea.value),
    edgeOverlap: Number(elements.edgeOverlap.value),
    maxDimension: Number(elements.maxDimension.value)
  };
  try {
    setStatus('Preparing image data…', 'Building a high-quality working image. Larger images can take longer.', 'working');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const prepared = createImageDataForTrace(sourceBitmap, settings.maxDimension, mode === 'exact');
    const traced = await traceImage(prepared.imageData, settings, (message, percent) => {
      setStatus('Vectorization in progress', message, 'working');
      if (percent !== undefined) setProgress(percent);
    });
    validateSvgInBrowser(traced.svg, traced.width || prepared.width, traced.height || prepared.height);
    resultBlob = new Blob([traced.svg], { type: 'image/svg+xml;charset=utf-8' });
    resultUrl = URL.createObjectURL(resultBlob);
    elements.resultPreview.src = resultUrl;
    elements.resultPreview.hidden = false;
    elements.resultEmpty.hidden = true;
    elements.resultBadge.textContent = traced.mode === 'exact' ? 'Pixel-exact' : traced.mode === 'hybrid-raster-fallback' ? 'Raster fallback' : 'Hybrid SVG';
    elements.resultBadge.classList.add('is-ready');
    elements.resultInfo.textContent = `${(traced.width || prepared.width).toLocaleString()} × ${(traced.height || prepared.height).toLocaleString()} px`;
    elements.metricPaths.textContent = (traced.pathCount || 0).toLocaleString();
    elements.metricColors.textContent = (traced.colorCount || 0).toLocaleString();
    elements.metricVector.textContent = traced.mode === 'exact' ? '100%' : `${(traced.vectorPercent ?? 0).toFixed(1)}%`;
    elements.metricRaster.textContent = traced.mode === 'exact' ? '0%' : `${(traced.rasterPercent ?? 100).toFixed(1)}%`;
    elements.metricSize.textContent = formatBytes(traced.svgBytes || resultBlob.size);
    elements.metricTime.textContent = `${((traced.elapsedMs || 0) / 1000).toFixed(2)}s`;
    elements.downloadButton.disabled = false;
    setProgress(100);
    const description = traced.mode === 'exact'
      ? `Created ${traced.regionCount.toLocaleString()} exact pixel regions across ${traced.colorCount.toLocaleString()} decoded colours.`
      : traced.mode === 'hybrid-raster-fallback'
        ? traced.notice
        : `Vector paths cover ${traced.vectorPercent.toFixed(1)}% of visible source pixels; the masked PNG fallback retains ${traced.rasterPercent.toFixed(1)}% of the source area. ${traced.notice || ''}`;
    setStatus('SVG created and validated', description, 'success');
  } catch (error) {
    const message = error?.message || 'Vectorization failed.';
    if (/cancelled/i.test(message)) setStatus('Conversion cancelled', 'The worker was stopped. Your original image is unchanged.');
    else setStatus('Vectorization failed', message, 'error');
    setProgress(0);
  } finally {
    isTracing = false;
    elements.traceButton.disabled = !sourceBitmap;
    elements.cancelButton.hidden = true;
  }
}

function cancelTrace() {
  if (!isTracing) return;
  stopTracingWorker();
  isTracing = false;
  elements.cancelButton.hidden = true;
  elements.traceButton.disabled = !sourceBitmap;
  setStatus('Conversion cancelled', 'The background worker was stopped. No partial SVG was exported.');
  setProgress(0);
}

function downloadResult() {
  if (!resultBlob || !resultUrl) return;
  const link = document.createElement('a');
  const baseName = (sourceFile?.name || 'vector').replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'vector';
  // Reuse the very same Blob URL that is loaded in the preview.
  link.href = resultUrl;
  link.download = `${baseName}-hybrid.svg`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function wireEvents() {
  elements.fileInput.addEventListener('change', (event) => selectFile(event.target.files?.[0]));
  elements.removeFile.addEventListener('click', removeImage);
  elements.traceButton.addEventListener('click', runTrace);
  elements.cancelButton.addEventListener('click', cancelTrace);
  elements.downloadButton.addEventListener('click', downloadResult);
  document.querySelectorAll('input[name="mode"]').forEach((radio) => radio.addEventListener('change', () => {
    syncModeControls();
    clearResult();
  }));
  [elements.colorCount, elements.curveSmoothness, elements.speckleSize, elements.detailProtection,
    elements.minVectorArea, elements.edgeOverlap, elements.maxDimension].forEach((input) => {
    input.addEventListener('input', updateRangeLabels);
  });
  elements.dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    elements.dropZone.classList.add('drag-active');
  });
  elements.dropZone.addEventListener('dragleave', () => elements.dropZone.classList.remove('drag-active'));
  elements.dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove('drag-active');
    selectFile(event.dataTransfer?.files?.[0]);
  });
  elements.dropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      elements.fileInput.click();
    }
  });
}

initializeTheme();
wireEvents();
updateRangeLabels();
syncModeControls();
