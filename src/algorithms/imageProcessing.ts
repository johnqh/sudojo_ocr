/**
 * Image processing algorithms for OCR
 * Platform-agnostic - operates on raw pixel data
 */

import type { ImageDataLike } from '../types.js';

/**
 * Safe array access helper - returns 0 if index is out of bounds
 */
function safeGet(arr: Uint8Array | Uint8ClampedArray, index: number): number {
  return arr[index] ?? 0;
}

/**
 * Convert image data to grayscale array
 */
export function toGrayscale(imageData: ImageDataLike): Uint8Array {
  const { data, width, height } = imageData;
  const gray = new Uint8Array(width * height);

  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    gray[i] = Math.floor(
      0.299 * safeGet(data, idx) +
        0.587 * safeGet(data, idx + 1) +
        0.114 * safeGet(data, idx + 2)
    );
  }

  return gray;
}

/**
 * Apply 3x3 Gaussian blur
 */
export function gaussianBlur(
  gray: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const result = new Uint8Array(width * height);
  const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  const kernelSum = 16;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let sum = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const idx = (y + ky) * width + (x + kx);
          const kernelIdx = (ky + 1) * 3 + (kx + 1);
          sum += safeGet(gray, idx) * (kernel[kernelIdx] ?? 0);
        }
      }
      result[y * width + x] = Math.floor(sum / kernelSum);
    }
  }

  return result;
}

/**
 * Canny-like edge detection using Sobel operators
 */
export function cannyEdgeDetection(
  gray: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const edges = new Uint8Array(width * height);
  const sobelX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const sobelY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

  const magnitude = new Float32Array(width * height);
  let maxMag = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let gx = 0,
        gy = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const idx = (y + ky) * width + (x + kx);
          const kernelIdx = (ky + 1) * 3 + (kx + 1);
          const grayVal = safeGet(gray, idx);
          gx += grayVal * (sobelX[kernelIdx] ?? 0);
          gy += grayVal * (sobelY[kernelIdx] ?? 0);
        }
      }
      const mag = Math.sqrt(gx * gx + gy * gy);
      magnitude[y * width + x] = mag;
      if (mag > maxMag) maxMag = mag;
    }
  }

  const threshold = maxMag * 0.2;
  for (let i = 0; i < magnitude.length; i++) {
    const mag = magnitude[i] ?? 0;
    edges[i] = mag > threshold ? 255 : 0;
  }

  return edges;
}

/**
 * Enhance contrast for better OCR
 */
export function enhanceContrast(
  imageData: ImageDataLike,
  factor: number = 1.5
): ImageDataLike {
  const { data, width, height } = imageData;
  const newData = new Uint8ClampedArray(data.length);

  // Calculate average brightness
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum +=
      0.299 * safeGet(data, i) +
      0.587 * safeGet(data, i + 1) +
      0.114 * safeGet(data, i + 2);
  }
  const avgBrightness = sum / (data.length / 4);

  // Enhance contrast around the average
  for (let i = 0; i < data.length; i += 4) {
    for (let j = 0; j < 3; j++) {
      const val = safeGet(data, i + j);
      const newVal = avgBrightness + (val - avgBrightness) * factor;
      newData[i + j] = Math.max(0, Math.min(255, Math.round(newVal)));
    }
    newData[i + 3] = safeGet(data, i + 3); // Alpha
  }

  return { data: newData, width, height };
}

/**
 * Binarize image (convert to black and white)
 */
export function binarize(
  imageData: ImageDataLike,
  threshold: number = 160
): ImageDataLike {
  const { data, width, height } = imageData;
  const newData = new Uint8ClampedArray(data.length);

  for (let i = 0; i < data.length; i += 4) {
    const gray =
      0.299 * safeGet(data, i) +
      0.587 * safeGet(data, i + 1) +
      0.114 * safeGet(data, i + 2);
    const val = gray < threshold ? 0 : 255;
    newData[i] = val;
    newData[i + 1] = val;
    newData[i + 2] = val;
    newData[i + 3] = safeGet(data, i + 3); // Alpha
  }

  return { data: newData, width, height };
}

/**
 * Preprocess image for OCR - contrast stretching with gamma correction
 */
export function preprocessForOCR(imageData: ImageDataLike): ImageDataLike {
  const { data, width, height } = imageData;
  const newData = new Uint8ClampedArray(data.length);
  const numPixels = width * height;

  // Find min/max for contrast stretching
  let minGray = 255;
  let maxGray = 0;

  for (let i = 0; i < numPixels; i++) {
    const idx = i * 4;
    const gray = Math.floor(
      0.299 * safeGet(data, idx) +
        0.587 * safeGet(data, idx + 1) +
        0.114 * safeGet(data, idx + 2)
    );
    if (gray < minGray) minGray = gray;
    if (gray > maxGray) maxGray = gray;
  }

  const range = maxGray - minGray || 1;

  for (let i = 0; i < numPixels; i++) {
    const idx = i * 4;
    const gray = Math.floor(
      0.299 * safeGet(data, idx) +
        0.587 * safeGet(data, idx + 1) +
        0.114 * safeGet(data, idx + 2)
    );

    // Stretch contrast and apply gamma correction
    let stretched = Math.floor(((gray - minGray) / range) * 255);
    stretched = Math.floor(255 * Math.pow(stretched / 255, 0.8));

    newData[idx] = stretched;
    newData[idx + 1] = stretched;
    newData[idx + 2] = stretched;
    newData[idx + 3] = safeGet(data, idx + 3); // Alpha
  }

  return { data: newData, width, height };
}

/**
 * Check if a cell is empty based on standard deviation
 */
export function isCellEmpty(imageData: ImageDataLike): boolean {
  const { data, width, height } = imageData;
  const totalPixels = width * height;

  // Calculate mean brightness
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const gray =
      0.299 * safeGet(data, i) +
      0.587 * safeGet(data, i + 1) +
      0.114 * safeGet(data, i + 2);
    sum += gray;
  }
  const mean = sum / totalPixels;

  // Calculate standard deviation
  let variance = 0;
  for (let i = 0; i < data.length; i += 4) {
    const gray =
      0.299 * safeGet(data, i) +
      0.587 * safeGet(data, i + 1) +
      0.114 * safeGet(data, i + 2);
    const diff = gray - mean;
    variance += diff * diff;
  }
  const stdDev = Math.sqrt(variance / totalPixels);

  // Empty cells have low standard deviation (uniform color)
  return stdDev < 8;
}
