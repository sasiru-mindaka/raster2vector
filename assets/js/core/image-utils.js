export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_SOURCE_PIXELS = 12_000_000;
const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif']);

export function validateImageFile(file) {
  if (!file) throw new Error('Choose an image first.');
  const extensionOkay = /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name || '');
  if (!ACCEPTED_TYPES.has(file.type) && !extensionOkay) {
    throw new Error('Unsupported file. Choose PNG, JPG, WEBP, GIF, BMP or AVIF.');
  }
  if (!Number.isFinite(file.size) || file.size <= 0) throw new Error('The selected file is empty or invalid.');
  if (file.size > MAX_FILE_BYTES) throw new Error('This file is larger than 25 MB.');
}

async function validateImageSignature(file) {
  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const ascii = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
  const png = bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 3) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const gif = bytes.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a');
  const webp = bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
  const bmp = bytes.length >= 2 && ascii(0, 2) === 'BM';
  const avif = bytes.length >= 12 && ascii(4, 4) === 'ftyp' && /avif|avis/.test(ascii(8, 24));
  if (!(png || jpeg || gif || webp || bmp || avif)) throw new Error('The selected file does not contain a supported image format.');
}

export async function decodeImageFile(file) {
  validateImageFile(file);
  await validateImageSignature(file);
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

export function drawSourcePreview(bitmap) {
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
      resolve({ size: blob.size, url });
    }, 'image/png');
  });
}
