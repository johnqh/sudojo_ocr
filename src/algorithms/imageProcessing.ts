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
 * Convert RGBA image data to a grayscale intensity array.
 * Uses luminance formula: 0.299*R + 0.587*G + 0.114*B
 * @param imageData - Source RGBA image data
 * @returns Uint8Array of grayscale values (0-255), one per pixel
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
 * Apply a 3x3 Gaussian blur kernel to reduce noise in grayscale data.
 * Uses kernel [1,2,1; 2,4,2; 1,2,1] with sum 16.
 * @param gray - Grayscale pixel array
 * @param width - Image width in pixels
 * @param height - Image height in pixels
 * @returns Blurred grayscale array (border pixels are zeroed)
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
 * Canny-like edge detection using Sobel gradient operators.
 * Computes gradient magnitude from horizontal and vertical Sobel filters,
 * then thresholds at 20% of the maximum magnitude.
 * @param gray - Grayscale pixel array
 * @param width - Image width in pixels
 * @param height - Image height in pixels
 * @returns Binary edge map (0 or 255 per pixel)
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
 * Enhance image contrast by stretching pixel values around the average brightness.
 * Formula: newVal = avgBrightness + (val - avgBrightness) * factor
 * @param imageData - Source RGBA image data
 * @param factor - Contrast multiplier (default: 1.5). Values > 1 increase contrast.
 * @returns New ImageDataLike with enhanced contrast (alpha preserved)
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
 * Binarize image to black and white using adaptive luminance thresholding.
 * Converts RGB to Y (luminance), finds the min/max Y range, then treats
 * pixels within topPercent of the highest Y as white, everything else as black.
 * @param imageData - Source RGBA image data
 * @param topPercent - Fraction of the Y range considered "white" (default: 0.10 = 10%)
 * @returns New ImageDataLike with only black or white pixels (alpha preserved)
 */
export function binarize(
  imageData: ImageDataLike,
  topPercent: number = 0.10
): ImageDataLike {
  const { data, width, height } = imageData;
  const numPixels = width * height;
  const newData = new Uint8ClampedArray(data.length);

  // First pass: compute Y (luminance) per pixel, find min/max
  const yValues = new Float32Array(numPixels);
  let minY = 255;
  let maxY = 0;

  for (let i = 0; i < numPixels; i++) {
    const idx = i * 4;
    const y =
      0.299 * safeGet(data, idx) +
      0.587 * safeGet(data, idx + 1) +
      0.114 * safeGet(data, idx + 2);
    yValues[i] = y;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  // If the brightness range is too narrow, the image is near-uniform — treat as all white
  const range = maxY - minY;
  if (range < 50) {
    for (let i = 0; i < numPixels; i++) {
      const idx = i * 4;
      newData[idx] = 255;
      newData[idx + 1] = 255;
      newData[idx + 2] = 255;
      newData[idx + 3] = safeGet(data, idx + 3);
    }
    return { data: newData, width, height };
  }

  // Threshold: only pixels within topPercent of the highest Y → white
  const threshold = maxY - topPercent * range;

  // Second pass: binarize
  for (let i = 0; i < numPixels; i++) {
    const idx = i * 4;
    const val = yValues[i] >= threshold ? 255 : 0;
    newData[idx] = val;
    newData[idx + 1] = val;
    newData[idx + 2] = val;
    newData[idx + 3] = safeGet(data, idx + 3); // Alpha
  }

  return { data: newData, width, height };
}

/**
 * Preprocess image for OCR using contrast stretching with gamma correction.
 * Stretches pixel range to full 0-255, then applies gamma correction (gamma=0.8)
 * to brighten midtones while preserving dark digits.
 * @param imageData - Source RGBA image data
 * @returns Preprocessed ImageDataLike optimized for OCR recognition
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
 * Morphological dilation to thicken dark regions (digits).
 * Uses a 3x3 structuring element: if any neighbor is black, the pixel becomes black.
 * Useful for thin strokes (8s, 9s) that OCR struggles to recognize.
 * @param imageData - Source RGBA image data (should be binarized first)
 * @returns New ImageDataLike with expanded black regions
 */
export function dilate(imageData: ImageDataLike): ImageDataLike {
  const { data, width, height } = imageData;
  const newData = new Uint8ClampedArray(data.length);

  // Copy original data first
  for (let i = 0; i < data.length; i++) {
    newData[i] = safeGet(data, i);
  }

  // For each pixel, if any neighbor is black (0), make this pixel black
  // This expands black regions (the digits)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let hasBlackNeighbor = false;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const idx = ((y + dy) * width + (x + dx)) * 4;
          if (safeGet(data, idx) < 128) {
            hasBlackNeighbor = true;
            break;
          }
        }
        if (hasBlackNeighbor) break;
      }
      if (hasBlackNeighbor) {
        const idx = (y * width + x) * 4;
        newData[idx] = 0;
        newData[idx + 1] = 0;
        newData[idx + 2] = 0;
      }
    }
  }

  return { data: newData, width, height };
}

/**
 * Remove grid lines from a binarized cell image.
 * Grid lines are dark pixel components that touch the cell border.
 * Pencilmarks and digits are interior and don't touch edges.
 *
 * Algorithm: BFS flood-fill from all dark border pixels, setting
 * connected dark pixels to white. When maxDepth is specified, only
 * removes pixels within that many pixels of the border. When
 * minBorderRun is specified, only seeds from consecutive dark border
 * pixel runs of that length or longer (grid lines span the cell edge,
 * while a pencilmark stroke touching the border is only 1-2px wide).
 *
 * @param imageData - Binarized RGBA image data
 * @param maxDepth - Maximum flood-fill depth from border (undefined = unlimited)
 * @param minBorderRun - Minimum consecutive dark pixels on a border edge to seed from (default: 1)
 * @returns New ImageDataLike with grid lines removed
 */
export function removeGridLines(
  imageData: ImageDataLike,
  maxDepth?: number,
  minBorderRun: number = 1,
): ImageDataLike {
  const { data, width, height } = imageData;
  const newData = new Uint8ClampedArray(data.length);

  for (let i = 0; i < data.length; i++) {
    newData[i] = safeGet(data, i);
  }

  const toRemove = new Uint8Array(width * height);

  function isDark(x: number, y: number): boolean {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    const idx = (y * width + x) * 4;
    return (newData[idx] ?? 255) < 128;
  }

  // BFS queue: [x, y, depth]
  const queue: [number, number, number][] = [];

  /**
   * Find runs of consecutive dark pixels along a border edge and only
   * seed from runs >= minBorderRun length.
   */
  function seedBorderEdge(
    coords: [number, number][],
  ): void {
    let runStart = -1;
    for (let i = 0; i <= coords.length; i++) {
      const coord = coords[i];
      const dark = coord ? isDark(coord[0], coord[1]) : false;
      if (dark) {
        if (runStart < 0) runStart = i;
      } else {
        if (runStart >= 0) {
          const runLen = i - runStart;
          if (runLen >= minBorderRun) {
            for (let j = runStart; j < i; j++) {
              const c = coords[j] as [number, number];
              const idx = c[1] * width + c[0];
              if (!toRemove[idx]) {
                toRemove[idx] = 1;
                queue.push([c[0], c[1], 0]);
              }
            }
          }
          runStart = -1;
        }
      }
    }
  }

  // Top and bottom border edges (horizontal runs)
  const topEdge: [number, number][] = [];
  const bottomEdge: [number, number][] = [];
  for (let x = 0; x < width; x++) {
    topEdge.push([x, 0]);
    bottomEdge.push([x, height - 1]);
  }
  seedBorderEdge(topEdge);
  seedBorderEdge(bottomEdge);

  // Left and right border edges (vertical runs)
  const leftEdge: [number, number][] = [];
  const rightEdge: [number, number][] = [];
  for (let y = 0; y < height; y++) {
    leftEdge.push([0, y]);
    rightEdge.push([width - 1, y]);
  }
  seedBorderEdge(leftEdge);
  seedBorderEdge(rightEdge);

  // BFS flood-fill from border dark pixels using 4-connectivity
  let head = 0;
  while (head < queue.length) {
    const entry = queue[head++];
    if (!entry) break;
    const [cx, cy, depth] = entry;

    // Stop expanding if at max depth
    if (maxDepth !== undefined && depth >= maxDepth) continue;

    for (const [nx, ny] of [
      [cx - 1, cy],
      [cx + 1, cy],
      [cx, cy - 1],
      [cx, cy + 1],
    ] as [number, number][]) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (toRemove[nIdx] || !isDark(nx, ny)) continue;
      toRemove[nIdx] = 1;
      queue.push([nx, ny, depth + 1]);
    }
  }

  // Set border-connected dark pixels to white
  for (let i = 0; i < width * height; i++) {
    if (toRemove[i]) {
      const idx = i * 4;
      newData[idx] = 255;
      newData[idx + 1] = 255;
      newData[idx + 2] = 255;
    }
  }

  return { data: newData, width, height };
}

/**
 * Determine if a cell is empty based on pixel standard deviation.
 * Empty cells have uniform color (low stdDev < 8), while cells with
 * digits have significant brightness variation.
 * @param imageData - Cell image data to analyze
 * @returns true if the cell appears empty (no digit present)
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
