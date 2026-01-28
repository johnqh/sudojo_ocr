/**
 * Board detection algorithms for finding the Sudoku grid in an image
 */

import type { Rectangle } from '../types.js';
import { toGrayscale, gaussianBlur, cannyEdgeDetection } from './imageProcessing.js';
import type { ImageDataLike } from '../types.js';

interface Line {
  position: number;
  strength: number;
}

/**
 * Safe array access helper - returns 0 if index is out of bounds
 */
function safeGet(arr: Uint8Array | Float32Array, index: number): number {
  return arr[index] ?? 0;
}

/**
 * Find long continuous horizontal runs of edge pixels
 */
function findHorizontalLines(
  edges: Uint8Array,
  width: number,
  height: number
): Line[] {
  const lines: Line[] = [];
  const minRunLength = width * 0.5;

  for (let y = 0; y < height; y++) {
    let maxRun = 0;
    let currentRun = 0;

    for (let x = 0; x < width; x++) {
      if (safeGet(edges, y * width + x) > 0) {
        currentRun++;
        if (currentRun > maxRun) maxRun = currentRun;
      } else {
        currentRun = 0;
      }
    }

    if (maxRun >= minRunLength) {
      lines.push({ position: y, strength: maxRun / width });
    }
  }

  return lines;
}

/**
 * Find long continuous vertical runs of edge pixels
 */
function findVerticalLines(
  edges: Uint8Array,
  width: number,
  height: number
): Line[] {
  const lines: Line[] = [];
  const minRunLength = height * 0.5;

  for (let x = 0; x < width; x++) {
    let maxRun = 0;
    let currentRun = 0;

    for (let y = 0; y < height; y++) {
      if (safeGet(edges, y * width + x) > 0) {
        currentRun++;
        if (currentRun > maxRun) maxRun = currentRun;
      } else {
        currentRun = 0;
      }
    }

    if (maxRun >= minRunLength) {
      lines.push({ position: x, strength: maxRun / height });
    }
  }

  return lines;
}

/**
 * Group nearby lines and keep the strongest
 */
function groupLines(lines: Line[], margin: number): Line[] {
  const grouped: Line[] = [];

  for (const line of lines) {
    const existing = grouped.find(
      (g) => Math.abs(g.position - line.position) < margin
    );
    if (existing) {
      if (line.strength > existing.strength) {
        existing.position = line.position;
        existing.strength = line.strength;
      }
    } else {
      grouped.push({ ...line });
    }
  }

  return grouped.sort((a, b) => a.position - b.position);
}

/**
 * Find the largest rectangle from grouped lines
 */
function findRectangleFromLines(
  hLines: Line[],
  vLines: Line[],
  width: number,
  height: number
): Rectangle | null {
  if (hLines.length < 2 || vLines.length < 2) {
    return null;
  }

  let bestRect: Rectangle | null = null;
  let bestScore = 0;
  const borderMargin = Math.min(width, height) * 0.02;

  for (let i = 0; i < hLines.length - 1; i++) {
    for (let j = i + 1; j < hLines.length; j++) {
      const hLineI = hLines[i];
      const hLineJ = hLines[j];
      if (!hLineI || !hLineJ) continue;

      const top = hLineI.position;
      const bottom = hLineJ.position;
      const rectHeight = bottom - top;

      if (rectHeight < height * 0.3) continue;

      for (let k = 0; k < vLines.length - 1; k++) {
        for (let l = k + 1; l < vLines.length; l++) {
          const vLineK = vLines[k];
          const vLineL = vLines[l];
          if (!vLineK || !vLineL) continue;

          const left = vLineK.position;
          const right = vLineL.position;
          const rectWidth = right - left;

          if (rectWidth < width * 0.3) continue;

          const area = rectWidth * rectHeight;
          const aspectRatio =
            Math.min(rectWidth, rectHeight) / Math.max(rectWidth, rectHeight);

          // Strong preference for square (sudoku grids are always square)
          const squareBonus =
            aspectRatio > 0.9
              ? 2.5
              : aspectRatio > 0.8
                ? 2.0
                : aspectRatio > 0.7
                  ? 1.5
                  : 1.0;

          // Penalize rectangles that touch image boundaries
          let boundaryPenalty = 1.0;
          if (top < borderMargin) boundaryPenalty *= 0.7;
          if (bottom > height - borderMargin) boundaryPenalty *= 0.7;
          if (left < borderMargin) boundaryPenalty *= 0.8;
          if (right > width - borderMargin) boundaryPenalty *= 0.8;

          const score = area * aspectRatio * squareBonus * boundaryPenalty;

          if (score > bestScore) {
            bestScore = score;
            bestRect = { left, top, right, bottom };
          }
        }
      }
    }
  }

  return bestRect;
}

/**
 * Fallback rectangle detection using edge density
 */
function findRectangleLowThreshold(
  edges: Uint8Array,
  width: number,
  height: number
): Rectangle | null {
  const windowSize = Math.floor(height * 0.05);
  let bestTop = 0,
    bestBottom = height - 1;
  let bestLeft = 0,
    bestRight = width - 1;

  // Horizontal density
  const hDensity = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = 0; x < width; x++) {
      if (safeGet(edges, y * width + x) > 0) count++;
    }
    hDensity[y] = count / width;
  }

  // Find top edge
  for (let y = 0; y < height - windowSize; y++) {
    if (safeGet(hDensity, y) > 0.15) {
      let sustainedCount = 0;
      for (let dy = 0; dy < windowSize; dy++) {
        if (safeGet(hDensity, y + dy) > 0.1) sustainedCount++;
      }
      if (sustainedCount > windowSize * 0.3) {
        bestTop = y;
        break;
      }
    }
  }

  // Find bottom edge
  for (let y = height - 1; y > bestTop + windowSize; y--) {
    if (safeGet(hDensity, y) > 0.15) {
      let sustainedCount = 0;
      for (let dy = 0; dy < windowSize && y - dy > bestTop; dy++) {
        if (safeGet(hDensity, y - dy) > 0.1) sustainedCount++;
      }
      if (sustainedCount > windowSize * 0.3) {
        bestBottom = y;
        break;
      }
    }
  }

  // Vertical density
  const vDensity = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = bestTop; y <= bestBottom; y++) {
      if (safeGet(edges, y * width + x) > 0) count++;
    }
    vDensity[x] = count / (bestBottom - bestTop + 1);
  }

  // Find left edge
  for (let x = 0; x < width - windowSize; x++) {
    if (safeGet(vDensity, x) > 0.15) {
      let sustainedCount = 0;
      for (let dx = 0; dx < windowSize; dx++) {
        if (safeGet(vDensity, x + dx) > 0.1) sustainedCount++;
      }
      if (sustainedCount > windowSize * 0.3) {
        bestLeft = x;
        break;
      }
    }
  }

  // Find right edge
  for (let x = width - 1; x > bestLeft + windowSize; x--) {
    if (safeGet(vDensity, x) > 0.15) {
      let sustainedCount = 0;
      for (let dx = 0; dx < windowSize && x - dx > bestLeft; dx++) {
        if (safeGet(vDensity, x - dx) > 0.1) sustainedCount++;
      }
      if (sustainedCount > windowSize * 0.3) {
        bestRight = x;
        break;
      }
    }
  }

  const rectWidth = bestRight - bestLeft;
  const rectHeight = bestBottom - bestTop;

  if (rectWidth < width * 0.2 || rectHeight < height * 0.2) {
    return null;
  }

  return { left: bestLeft, top: bestTop, right: bestRight, bottom: bestBottom };
}

/**
 * Fallback using dark pixel detection
 */
export function findRectangleDarkPixels(
  gray: Uint8Array,
  width: number,
  height: number
): Rectangle {
  const threshold = 200;
  const minDarkPixelsPercent = 0.1;

  let top = 0;
  for (let y = 0; y < height; y++) {
    let darkCount = 0;
    for (let x = 0; x < width; x++) {
      if (safeGet(gray, y * width + x) < threshold) darkCount++;
    }
    if (darkCount / width > minDarkPixelsPercent) {
      top = y;
      break;
    }
  }

  let bottom = height - 1;
  for (let y = height - 1; y >= 0; y--) {
    let darkCount = 0;
    for (let x = 0; x < width; x++) {
      if (safeGet(gray, y * width + x) < threshold) darkCount++;
    }
    if (darkCount / width > minDarkPixelsPercent) {
      bottom = y;
      break;
    }
  }

  let left = 0;
  for (let x = 0; x < width; x++) {
    let darkCount = 0;
    for (let y = 0; y < height; y++) {
      if (safeGet(gray, y * width + x) < threshold) darkCount++;
    }
    if (darkCount / height > minDarkPixelsPercent) {
      left = x;
      break;
    }
  }

  let right = width - 1;
  for (let x = width - 1; x >= 0; x--) {
    let darkCount = 0;
    for (let y = 0; y < height; y++) {
      if (safeGet(gray, y * width + x) < threshold) darkCount++;
    }
    if (darkCount / height > minDarkPixelsPercent) {
      right = x;
      break;
    }
  }

  return { left, top, right, bottom };
}

/**
 * Detect the Sudoku board rectangle in an image
 * Returns the bounding rectangle or null if detection fails
 */
export function detectBoardRectangle(imageData: ImageDataLike): Rectangle | null {
  const { width, height } = imageData;

  // Convert to grayscale
  const gray = toGrayscale(imageData);

  // Apply Gaussian blur
  const blurred = gaussianBlur(gray, width, height);

  // Edge detection
  const edges = cannyEdgeDetection(blurred, width, height);

  // Find horizontal and vertical lines
  const margin = Math.min(width, height) * 0.03;
  const hLines = groupLines(
    findHorizontalLines(edges, width, height).map((l) => ({
      position: l.position,
      strength: l.strength,
    })),
    margin
  );
  const vLines = groupLines(
    findVerticalLines(edges, width, height).map((l) => ({
      position: l.position,
      strength: l.strength,
    })),
    margin
  );

  // Try to find rectangle from lines
  let rectangle = findRectangleFromLines(hLines, vLines, width, height);

  // Fallback to low threshold method
  if (!rectangle) {
    rectangle = findRectangleLowThreshold(edges, width, height);
  }

  // Final fallback to dark pixel method
  if (!rectangle) {
    rectangle = findRectangleDarkPixels(gray, width, height);
  }

  return rectangle;
}

/**
 * Make a rectangle square by centering
 */
export function squarifyRectangle(rect: Rectangle): {
  x: number;
  y: number;
  size: number;
} {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  const size = Math.min(width, height);

  const extraWidth = width - size;
  const extraHeight = height - size;

  return {
    x: rect.left + Math.floor(extraWidth / 2),
    y: rect.top + Math.floor(extraHeight / 2),
    size,
  };
}
