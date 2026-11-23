let worker;
let nextRequestId = 1;
const pending = new Map();

function rejectAll(error) {
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
}

function getWorker() {
  if (worker) return worker;
  try {
    worker = new Worker(new URL('../workers/trace-worker.js', import.meta.url), { type: 'module', name: 'vector-studio-tracer' });
  } catch (error) {
    throw new Error(`Could not start the background tracing worker. Open this project through a local web server (see README). ${error.message}`);
  }
  worker.addEventListener('message', (event) => {
    const data = event.data || {};
    const entry = pending.get(data.requestId);
    if (!entry) return;
    if (data.type === 'stage') {
      entry.onStage?.(data.message, data.percent);
      return;
    }
    if (data.type === 'result') {
      pending.delete(data.requestId);
      if (data.ok) entry.resolve(data.result);
      else entry.reject(new Error(data.error || 'Vectorization failed.'));
    }
  });
  worker.addEventListener('error', (event) => {
    const message = event.message || 'The background worker stopped unexpectedly.';
    rejectAll(new Error(`${message} Please reload the page and try again.`));
    worker?.terminate();
    worker = undefined;
  });
  return worker;
}

export function traceImage(imageData, settings, onStage = () => {}) {
  const currentWorker = getWorker();
  const requestId = nextRequestId++;
  const buffer = imageData.data.buffer;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject, onStage });
    try {
      currentWorker.postMessage({
        requestId,
        buffer,
        width: imageData.width,
        height: imageData.height,
        settings
      }, [buffer]);
    } catch (error) {
      pending.delete(requestId);
      reject(error);
    }
  });
}

export function stopTracingWorker() {
  worker?.terminate();
  worker = undefined;
  rejectAll(new Error('Tracing was cancelled.'));
}
