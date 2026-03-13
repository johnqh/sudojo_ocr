/**
 * Cell classification algorithms for distinguishing large digits from pencilmarks
 * Platform-agnostic - operates on raw pixel data
 */

import type { ImageDataLike } from '../types.js';
import { OCR_PENCILMARK_MIN_INK_RATIO } from '../types.js';

/** Bounding box and pixel count for a connected component */
export interface ConnectedComponent {
  pixelCount: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Cell content classification */
export type CellContentType = 'digit' | 'pencilmarks' | 'empty';

/**
 * Find connected components of dark pixels using flood-fill.
 * Components with fewer than 4 pixels are filtered out as noise.
 * @param imageData - Binarized RGBA image data
 * @returns Array of connected components with bounding boxes
 */
export function findConnectedComponents(imageData: ImageDataLike): ConnectedComponent[] {
  const { data, width, height } = imageData;
  const visited = new Uint8Array(width * height);
  const components: ConnectedComponent[] = [];

  function isDark(x: number, y: number): boolean {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    const idx = (y * width + x) * 4;
    return (data[idx] ?? 255) < 128;
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIdx = y * width + x;
      if (visited[pixelIdx] || !isDark(x, y)) continue;

      // Flood-fill to find this component
      const component: ConnectedComponent = {
        pixelCount: 0,
        minX: x,
        minY: y,
        maxX: x,
        maxY: y,
      };

      const stack: [number, number][] = [[x, y]];
      visited[pixelIdx] = 1;

      while (stack.length > 0) {
        const [cx, cy] = stack.pop()!;
        component.pixelCount++;
        if (cx < component.minX) component.minX = cx;
        if (cy < component.minY) component.minY = cy;
        if (cx > component.maxX) component.maxX = cx;
        if (cy > component.maxY) component.maxY = cy;

        // 4-connected neighbors
        for (const [nx, ny] of [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ] as [number, number][]) {
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (visited[nIdx] || !isDark(nx, ny)) continue;
          visited[nIdx] = 1;
          stack.push([nx, ny]);
        }
      }

      // Filter noise: components with fewer than 4 pixels
      if (component.pixelCount >= 4) {
        components.push(component);
      }
    }
  }

  return components;
}

/**
 * Classify cell content as a large digit, pencilmarks, or empty.
 *
 * Strategy:
 * 1. Find connected components of dark pixels
 * 2. If no significant components -> empty
 * 3. If largest component height > 40% of cell height -> digit
 * 4. If 2+ components -> pencilmarks
 * 5. Single small component -> digit (fallback)
 *
 * @param imageData - Binarized RGBA image data for a single cell
 * @returns Classification of the cell content
 */
export function classifyCellContent(imageData: ImageDataLike): CellContentType {
  const components = findConnectedComponents(imageData);

  if (components.length === 0) {
    return 'empty';
  }

  // Find the largest component by pixel count
  let largest = components[0]!;
  for (let i = 1; i < components.length; i++) {
    if (components[i]!.pixelCount > largest.pixelCount) {
      largest = components[i]!;
    }
  }

  const largestHeight = largest.maxY - largest.minY + 1;
  const cellHeight = imageData.height;

  // Large digits span >40% of cell height
  if (largestHeight > cellHeight * 0.4) {
    return 'digit';
  }

  // Multiple small components suggest pencilmarks
  if (components.length >= 2) {
    return 'pencilmarks';
  }

  // Single small component - default to digit
  return 'digit';
}

/**
 * Check if a pencilmark is present in a sub-cell region by measuring ink density.
 * @param imageData - Binarized RGBA image data for a sub-cell region
 * @returns true if dark pixel ratio exceeds the minimum ink threshold
 */
export function isPencilmarkPresent(imageData: ImageDataLike): boolean {
  const { data, width, height } = imageData;
  const totalPixels = width * height;
  let darkCount = 0;

  for (let i = 0; i < data.length; i += 4) {
    if ((data[i] ?? 255) < 128) {
      darkCount++;
    }
  }

  return darkCount / totalPixels > OCR_PENCILMARK_MIN_INK_RATIO;
}
