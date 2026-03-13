import { describe, it, expect } from 'vitest';
import {
  findConnectedComponents,
  classifyCellContent,
  isPencilmarkPresent,
} from './cellClassification.js';
import type { ImageDataLike } from '../types.js';

/**
 * Create a test ImageDataLike with specified dimensions and optional fill color
 */
function createTestImageData(
  width: number,
  height: number,
  fillColor?: { r: number; g: number; b: number; a: number }
): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4);
  if (fillColor) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = fillColor.r;
      data[i + 1] = fillColor.g;
      data[i + 2] = fillColor.b;
      data[i + 3] = fillColor.a;
    }
  } else {
    // Default to white with full alpha
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

/**
 * Set a pixel to a color in an ImageDataLike
 */
function setPixel(
  imageData: ImageDataLike,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number
): void {
  const idx = (y * imageData.width + x) * 4;
  imageData.data[idx] = r;
  imageData.data[idx + 1] = g;
  imageData.data[idx + 2] = b;
  imageData.data[idx + 3] = 255;
}

/**
 * Draw a filled rectangle of dark pixels
 */
function drawDarkRect(
  imageData: ImageDataLike,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      setPixel(imageData, x + dx, y + dy, 0, 0, 0);
    }
  }
}

describe('findConnectedComponents', () => {
  it('should return empty array for all-white image', () => {
    const img = createTestImageData(10, 10);
    const components = findConnectedComponents(img);
    expect(components).toHaveLength(0);
  });

  it('should find a single connected component', () => {
    const img = createTestImageData(10, 10);
    // Draw a 4x4 dark block
    drawDarkRect(img, 3, 3, 4, 4);
    const components = findConnectedComponents(img);
    expect(components).toHaveLength(1);
    expect(components[0]!.pixelCount).toBe(16);
    expect(components[0]!.minX).toBe(3);
    expect(components[0]!.minY).toBe(3);
    expect(components[0]!.maxX).toBe(6);
    expect(components[0]!.maxY).toBe(6);
  });

  it('should find multiple separate components', () => {
    const img = createTestImageData(20, 10);
    // Two separate dark blocks
    drawDarkRect(img, 1, 1, 3, 3);
    drawDarkRect(img, 15, 1, 3, 3);
    const components = findConnectedComponents(img);
    expect(components).toHaveLength(2);
  });

  it('should filter out noise (components < 4 pixels)', () => {
    const img = createTestImageData(10, 10);
    // Draw 2 isolated dark pixels (too small to be a component)
    setPixel(img, 2, 2, 0, 0, 0);
    setPixel(img, 8, 8, 0, 0, 0);
    const components = findConnectedComponents(img);
    expect(components).toHaveLength(0);
  });

  it('should keep components with exactly 4 pixels', () => {
    const img = createTestImageData(10, 10);
    // Draw an L-shaped 4-pixel component
    drawDarkRect(img, 2, 2, 2, 2);
    const components = findConnectedComponents(img);
    expect(components).toHaveLength(1);
    expect(components[0]!.pixelCount).toBe(4);
  });
});

describe('classifyCellContent', () => {
  it('should classify all-white image as empty', () => {
    const img = createTestImageData(30, 30);
    expect(classifyCellContent(img)).toBe('empty');
  });

  it('should classify a large tall component as digit', () => {
    // 30x30 cell, component spanning >40% height (>12px)
    const img = createTestImageData(30, 30);
    // Draw a tall narrow rectangle (like digit "1") - 3px wide, 20px tall (66% of cell)
    drawDarkRect(img, 13, 5, 3, 20);
    expect(classifyCellContent(img)).toBe('digit');
  });

  it('should classify multiple small components as pencilmarks', () => {
    // 30x30 cell, multiple small marks
    const img = createTestImageData(30, 30);
    // Three small blobs at different positions (each <40% of cell height)
    drawDarkRect(img, 2, 2, 4, 4); // top-left (digit 1 position)
    drawDarkRect(img, 12, 2, 4, 4); // top-center (digit 2 position)
    drawDarkRect(img, 22, 22, 4, 4); // bottom-right (digit 9 position)
    expect(classifyCellContent(img)).toBe('pencilmarks');
  });

  it('should classify a single small component as digit (fallback)', () => {
    const img = createTestImageData(30, 30);
    // One small blob (could be a small digit or artifact)
    drawDarkRect(img, 10, 10, 5, 5);
    expect(classifyCellContent(img)).toBe('digit');
  });

  it('should classify component at exactly 40% height as pencilmarks when multiple exist', () => {
    const img = createTestImageData(30, 30);
    // Component at exactly 40% height (12px) - NOT > 40%, so not digit
    drawDarkRect(img, 5, 5, 5, 12);
    drawDarkRect(img, 20, 20, 5, 5);
    expect(classifyCellContent(img)).toBe('pencilmarks');
  });
});

describe('isPencilmarkPresent', () => {
  it('should return false for all-white image', () => {
    const img = createTestImageData(10, 10);
    expect(isPencilmarkPresent(img)).toBe(false);
  });

  it('should return false when ink ratio is below threshold', () => {
    // 10x10 = 100 pixels, threshold is 3%, so need >3 dark pixels
    const img = createTestImageData(10, 10);
    // Only 2 dark pixels = 2%
    setPixel(img, 5, 5, 0, 0, 0);
    setPixel(img, 6, 5, 0, 0, 0);
    expect(isPencilmarkPresent(img)).toBe(false);
  });

  it('should return true when ink ratio exceeds threshold', () => {
    // 10x10 = 100 pixels, need >3% dark pixels
    const img = createTestImageData(10, 10);
    // 4 dark pixels = 4% (above 3% threshold)
    drawDarkRect(img, 4, 4, 2, 2);
    expect(isPencilmarkPresent(img)).toBe(true);
  });

  it('should return true for all-black image', () => {
    const img = createTestImageData(10, 10, { r: 0, g: 0, b: 0, a: 255 });
    expect(isPencilmarkPresent(img)).toBe(true);
  });
});
