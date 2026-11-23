export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_SOURCE_PIXELS = 12_000_000;
const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif']);

export function validateImageFile(file) {
  if (!file) throw new Error('Choose an image first.');
  const extensionOkay = /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name || '');
  if (!ACCEPTED_TYPES.has(file.type) && !extensionOkay) {
    throw new Error('Unsupported file. Choose PNG, JPG, WEBP, GIF, BMP or AVIF.');
  }
  if (file.size > MAX_FILE_BYTES) throw new Error('This file is larger than 25 MB.');
}

export async function decodeImageFile(file) {
  validateImageFile(file);
  if (typeof createImageBitmap !== 'function') throw new Error('This browser does not support safe image decoding. Please use a recent Firefox, Chrome or Edge version.');
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  if (!bitmap.width || !bitmap.height) {
    bitmap.close?.();
    throw new Error('The selected image has invalid dimensions.');
  }
  const pixels = bitmap.width * bitmap.height;
  if (pixels > MAX_SOURCE_PIXELS) {
    bitmap.close?.();
    throw new Error('This image exceeds the 12-megapixel safety limit. Resize it before importing.');
  }
  return bitmap;
}

export function getTargetDimensions(width, height, maxDimension, exact = false) {
  if (exact) return { width, height };
  const longest = Math.max(width, height);
  if (longest <= maxDimension) return { width, height };
  const ratio = maxDimension / longest;
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

export function createImageDataForTrace(bitmap, maxDimension, exact = false) {
  const { width, height } = getTargetDimensions(bitmap.width, bitmap.height, maxDimension, exact);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  if (!context) throw new Error('Could not create a working canvas in this browser.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.clearRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  return { imageData, width, height };
}

export function drawSourcePreview(bitmap, imageElement) {
  const canvas = document.createElement('canvas');
  const maxDimension = 1400;
  const size = getTargetDimensions(bitmap.width, bitmap.height, maxDimension, false);
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('Could not prepare the preview image.'));
      const url = URL.createObjectURL(blob);
      imageElement.src = url;
      resolve({ size: blob.size, url });
    }, 'image/png');
  });
}
