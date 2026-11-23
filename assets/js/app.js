import { createImageDataForTrace, decodeImageFile, drawSourcePreview } from './core/image-utils.js';
import { traceImage, stopTracingWorker } from './core/trace-client.js';
import { formatBytes, hasUnsafeSvgAttributeValue, isAllowedSvgAttribute } from './core/svg-utils.js';
import { initializeTheme } from './ui/theme.js';

const $ = (id) => document.getElementById(id);
const elements = {
  fileInput: $('fileInput'), dropZone: $('dropZone'), loadedFile: $('loadedFile'), fileName: $('fileName'),
  fileDimensions: $('fileDimensions'), fileThumb: $('fileThumb'), removeFile: $('removeFile'),
  sourcePreview: $('sourcePreview'), sourceEmpty: $('sourceEmpty'), sourceBadge: $('sourceBadge'), sourceInfo: $('sourceInfo'),
  resultPreview: $('resultPreview'), resultEmpty: $('resultEmpty'), resultBadge: $('resultBadge'), resultInfo: $('resultInfo'),
  traceButton: $('traceButton'), cancelButton: $('cancelButton'), downloadButton: $('downloadButton'),
  modeHint: $('modeHint'), exactNote: $('exactNote'), photoNote: $('photoNote'), presetSelect: $('presetSelect'),
  formatPill: $('formatPill'),
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
let resultMode = null;
let sourcePreviewUrl = null;
let isTracing = false;
let fileSelectionId = 0;
let traceRunId = 0;

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
  return document.querySelector('input[name="mode"]:checked')?.value || 'photo';
}

function syncModeControls() {
  const mode = getMode();
  const exact = mode === 'exact';
  const purePhoto = mode === 'photo';
  document.querySelectorAll('.mode-card').forEach((card) => {
    card.classList.toggle('selected', card.querySelector('input')?.checked === true);
  });
  document.querySelectorAll('[data-hybrid-control]').forEach((group) => {
    const disabled = exact || (purePhoto && group.hasAttribute('data-photo-inapplicable'));
    group.classList.toggle('is-disabled', disabled);
    group.querySelectorAll('input,select').forEach((control) => { control.disabled = disabled; });
  });
  elements.modeHint.textContent = exact
    ? 'Every decoded pixel is encoded as vector geometry. The original pixel grid is preserved, but the SVG can become very large and will not invent extra detail.'
    : purePhoto
      ? 'Bitmap-free SVG: visible artwork is rebuilt from editable paths and gradients, so edges stay sharp when enlarged. Fine photographic texture is approximated.'
      : 'Hybrid embeds a masked PNG for texture and protected details. That raster portion can look soft when enlarged; choose Pure Vector Photo for sharp scaling.';
  elements.exactNote.hidden = !exact;
  elements.photoNote.hidden = !purePhoto;
  elements.formatPill.textContent = `SVG · ${exact ? 'PIXEL-EXACT' : purePhoto ? 'PURE VECTOR' : 'HYBRID'}`;
  elements.traceButton.querySelector('span').textContent = exact
    ? 'Generate pixel-exact SVG'
    : purePhoto ? 'Generate pure-vector photo SVG' : 'Generate hybrid SVG';
}

function clearResult() {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
  resultBlob = null;
  resultMode = null;
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
  if (typeof svgText !== 'string' || svgText.length > 200 * 1024 * 1024) throw new Error('The SVG output exceeds the safe validation limit.');
  if (/<!DOCTYPE|<!ENTITY|<\s*!\[CDATA\[/i.test(svgText)) throw new Error('The SVG contains unsupported XML declarations.');
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('Generated output is not valid SVG/XML. Download was blocked.');
  const root = doc.documentElement;
  if (root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg') throw new Error('The generated file has no valid SVG root element.');
  const allowedElements = new Set(['svg', 'defs', 'linearGradient', 'stop', 'path', 'image']);
  const gradientIds = new Set([...doc.querySelectorAll('linearGradient[id]')].map((item) => item.id));
  for (const element of doc.querySelectorAll('*')) {
    if (!allowedElements.has(element.localName)) throw new Error(`The generated SVG contains unsupported element: ${element.localName}.`);
    for (const attribute of [...element.attributes]) {
      if (!isAllowedSvgAttribute(element.localName, attribute.name)) throw new Error(`The generated SVG contains an unsupported ${attribute.name} attribute.`);
      if (hasUnsafeSvgAttributeValue(element, attribute, root)) throw new Error(`The SVG contains an unsafe attribute value in <${element.localName}>.${attribute.name}.`);
    }
    if (element.localName === 'image') {
      const href = element.getAttribute('href') || '';
      if (!/^data:image\/png;base64,[a-z0-9+/=]+$/i.test(href)) throw new Error('The SVG contains an external or unsupported image reference.');
    }
    if (element.localName === 'path') {
      const pathData = element.getAttribute('d') || '';
      if (!/^[MmLlHhVvCcQqSsTtAaZz0-9.,+\-\seE]*$/.test(pathData)) throw new Error('The SVG contains malformed vector path data.');
      if (element.hasAttribute('fill-opacity')) {
        const opacity = Number(element.getAttribute('fill-opacity'));
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
          throw new Error('The SVG contains an invalid fill-opacity value.');
        }
      }
      for (const paint of [element.getAttribute('fill') || '', element.getAttribute('stroke') || '']) {
        const match = paint.match(/^url\(#(g\d+)\)$/);
        if (match && !gradientIds.has(match[1])) throw new Error('The SVG references an unknown gradient.');
        if (paint && paint !== 'none' && !/^#[0-9a-f]{3,8}$/i.test(paint) && !match) throw new Error('The SVG contains an unsupported paint value.');
      }
    }
  }
  const width = Number(root.getAttribute('width'));
  const height = Number(root.getAttribute('height'));
  if (width !== expectedWidth || height !== expectedHeight) throw new Error('SVG canvas dimensions do not match the working image.');
  const images = [...doc.querySelectorAll('image')];
  if (!doc.querySelector('path') && !images.length) throw new Error('The generated SVG contains neither vector paths nor a raster fallback.');
  return { pathCount: doc.querySelectorAll('path').length, imageCount: images.length };
}

async function selectFile(file) {
  const selectionId = ++fileSelectionId;
  if (isTracing) {
    stopTracingWorker();
    isTracing = false;
    traceRunId += 1;
    elements.cancelButton.hidden = true;
  }
  if (!file) return;

  let candidateBitmap = null;
  let candidatePreview = null;
  try {
    setStatus('Loading image…', 'Decoding the image locally and checking its dimensions.', 'working');
    elements.traceButton.disabled = true;
    candidateBitmap = await decodeImageFile(file);
    if (selectionId !== fileSelectionId) {
      candidateBitmap.close?.();
      return;
    }

    candidatePreview = await drawSourcePreview(candidateBitmap);
    if (selectionId !== fileSelectionId) {
      candidateBitmap.close?.();
      URL.revokeObjectURL(candidatePreview.url);
      return;
    }

    clearResult();
    sourceBitmap?.close?.();
    sourceBitmap = candidateBitmap;
    candidateBitmap = null;
    sourceFile = file;
    if (sourcePreviewUrl) URL.revokeObjectURL(sourcePreviewUrl);
    sourcePreviewUrl = candidatePreview.url;
    elements.sourcePreview.src = sourcePreviewUrl;
    candidatePreview = null;
    elements.sourcePreview.hidden = false;
    elements.sourceEmpty.hidden = true;
    elements.loadedFile.hidden = false;
    elements.fileName.textContent = file.name;
    elements.fileDimensions.textContent = `${sourceBitmap.width.toLocaleString()} × ${sourceBitmap.height.toLocaleString()} px · ${formatBytes(file.size)}`;
    elements.fileThumb.textContent = (file.name.split('.').pop() || 'IMG').slice(0, 3).toUpperCase();
    elements.sourceBadge.textContent = 'Image loaded';
    elements.sourceInfo.textContent = `${sourceBitmap.width.toLocaleString()} × ${sourceBitmap.height.toLocaleString()} px`;
    elements.traceButton.disabled = false;
    setStatus('Image ready to analyse', 'Choose an output mode and quality settings, then start the conversion.');
  } catch (error) {
    candidateBitmap?.close?.();
    if (candidatePreview?.url) URL.revokeObjectURL(candidatePreview.url);
    if (selectionId !== fileSelectionId) return;
    elements.traceButton.disabled = !sourceBitmap;
    setStatus('Could not load image', error.message, 'error');
  }
}

function removeImage() {
  fileSelectionId += 1;
  traceRunId += 1;
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
  setStatus('Ready when you are', 'Upload an image, then generate your pure-vector SVG for sharp scaling.');
}

async function runTrace() {
  if (!sourceBitmap || !sourceFile || isTracing) return;
  const runId = ++traceRunId;
  const bitmap = sourceBitmap;
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
    maxDimension: Number(elements.maxDimension.value),
    underlay: document.getElementById('underlayMode').value,
    curve: document.getElementById('curveMode').value,
    gradients: document.getElementById('useGradients').checked,
    tileSize: document.getElementById('tileSize').value,
    gpuBackend: document.getElementById('gpuBackend').value,
    edgeProtection: true
  };
  try {
    setStatus('Preparing image data…', 'Building a high-quality working image. Larger images can take longer.', 'working');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (runId !== traceRunId) return;
    const prepared = createImageDataForTrace(bitmap, settings.maxDimension, mode === 'exact');
    const traced = await traceImage(prepared.imageData, settings, (message, percent) => {
      setStatus('Vectorization in progress', message, 'working');
      if (percent !== undefined) setProgress(percent);
    });
    if (runId !== traceRunId) return;
    validateSvgInBrowser(traced.svg, traced.width || prepared.width, traced.height || prepared.height);
    resultBlob = new Blob([traced.svg], { type: 'image/svg+xml;charset=utf-8' });
    resultMode = traced.mode;
    resultUrl = URL.createObjectURL(resultBlob);
    elements.resultPreview.src = resultUrl;
    elements.resultPreview.hidden = false;
    elements.resultEmpty.hidden = true;
    elements.resultBadge.textContent = traced.mode === 'exact' ? 'Pixel-exact' : traced.mode === 'pure-vector' ? 'Pure vector' : traced.mode === 'hybrid-raster-fallback' ? 'Raster fallback' : 'Hybrid SVG';
    elements.resultBadge.classList.add('is-ready');
    elements.resultInfo.textContent = `${(traced.width || prepared.width).toLocaleString()} × ${(traced.height || prepared.height).toLocaleString()} px`;
    elements.metricPaths.textContent = (traced.pathCount || 0).toLocaleString();
    elements.metricColors.textContent = (traced.colorCount || 0).toLocaleString();
    elements.metricVector.textContent = traced.mode === 'exact' || traced.mode === 'pure-vector' ? '100%' : `${(traced.vectorPercent ?? 0).toFixed(1)}%`;
    elements.metricRaster.textContent = traced.mode === 'exact' || traced.mode === 'pure-vector' ? '0%' : `${(traced.rasterPercent ?? 100).toFixed(1)}%`;
    elements.metricSize.textContent = formatBytes(traced.svgBytes || resultBlob.size);
    elements.metricTime.textContent = `${((traced.elapsedMs || 0) / 1000).toFixed(2)}s`;
    elements.downloadButton.disabled = false;
    setProgress(100);
    const description = traced.mode === 'exact'
      ? `Created ${traced.regionCount.toLocaleString()} exact pixel regions across ${traced.colorCount.toLocaleString()} decoded colours.`
      : traced.mode === 'pure-vector'
        ? `All visible source pixels are represented by editable SVG paths and gradients. No PNG or other raster image is embedded. ${traced.notice || ''}`
        : traced.mode === 'hybrid-raster-fallback'
          ? traced.notice
          : `Vector paths cover ${traced.vectorPercent.toFixed(1)}% of visible source pixels; the masked PNG fallback retains ${traced.rasterPercent.toFixed(1)}% of the source area. ${traced.notice || ''}`;
    setStatus('SVG created and validated', description, 'success');
  } catch (error) {
    if (runId !== traceRunId) return;
    const message = error?.message || 'Vectorization failed.';
    if (/cancelled/i.test(message)) setStatus('Conversion cancelled', 'The worker was stopped. Your original image is unchanged.');
    else setStatus('Vectorization failed', message, 'error');
    setProgress(0);
  } finally {
    if (runId === traceRunId) {
      isTracing = false;
      elements.traceButton.disabled = !sourceBitmap;
      elements.cancelButton.hidden = true;
    }
  }
}

function cancelTrace() {
  if (!isTracing) return;
  traceRunId += 1;
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
  const suffix = resultMode === 'pure-vector' ? 'pure-vector' : resultMode === 'exact' ? 'pixel-exact' : 'hybrid';
  link.download = `${baseName}-${suffix}.svg`;
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
  const settingsChanged = () => {
    if (isTracing) cancelTrace();
    clearResult();
    if (sourceBitmap) setStatus('Settings updated', 'Run the conversion again to apply the new settings.');
  };
  document.querySelectorAll('input[name="mode"]').forEach((radio) => radio.addEventListener('change', () => {
    syncModeControls();
    settingsChanged();
  }));
  [elements.colorCount, elements.curveSmoothness, elements.speckleSize, elements.detailProtection,
    elements.minVectorArea, elements.edgeOverlap, elements.maxDimension].forEach((input) => {
    input.addEventListener('input', () => {
      updateRangeLabels();
      settingsChanged();
    });
  });
  ['presetSelect', 'underlayMode', 'curveMode', 'useGradients', 'tileSize', 'gpuBackend'].forEach((id) => {
    $(id).addEventListener('change', settingsChanged);
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
