import { describe, it, expect } from 'vitest';
import {
  detectBoardRectangle,
  squarifyRectangle,
  findRectangleDarkPixels,
} from './boardDetection.js';
import type { ImageDataLike, Rectangle } from '../types.js';

/**
 * Create a test ImageDataLike with specified dimensions
 */
function createTestImageData(
  width: number,
  height: number,
  fillValue: number = 255
): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fillValue;
    data[i + 1] = fillValue;
    data[i + 2] = fillValue;
    data[i + 3] = 255;
  }
  return { data, width, height };
}

/**
 * Draw a rectangle on the image data
 */
function drawRectangle(
  imageData: ImageDataLike,
  rect: Rectangle,
  color: number = 0,
  lineWidth: number = 2
): void {
  const { data, width } = imageData;
  const { left, top, right, bottom } = rect;

  // Draw horizontal lines
  for (let x = left; x <= right; x++) {
    for (let lw = 0; lw < lineWidth; lw++) {
      // Top line
      if (top + lw < imageData.height) {
        const idx = ((top + lw) * width + x) * 4;
        data[idx] = color;
        data[idx + 1] = color;
        data[idx + 2] = color;
      }
      // Bottom line
      if (bottom - lw >= 0) {
        const idx = ((bottom - lw) * width + x) * 4;
        data[idx] = color;
        data[idx + 1] = color;
        data[idx + 2] = color;
      }
    }
  }

  // Draw vertical lines
  for (let y = top; y <= bottom; y++) {
    for (let lw = 0; lw < lineWidth; lw++) {
      // Left line
      if (left + lw < width) {
        const idx = (y * width + (left + lw)) * 4;
        data[idx] = color;
        data[idx + 1] = color;
        data[idx + 2] = color;
      }
      // Right line
      if (right - lw >= 0) {
        const idx = (y * width + (right - lw)) * 4;
        data[idx] = color;
        data[idx + 1] = color;
        data[idx + 2] = color;
      }
    }
  }
}

describe('squarifyRectangle', () => {
  it('should return same size for already square rectangle', () => {
    const rect: Rectangle = { left: 10, top: 10, right: 110, bottom: 110 };
    const result = squarifyRectangle(rect);
    expect(result.size).toBe(100);
    expect(result.x).toBe(10);
    expect(result.y).toBe(10);
  });

  it('should center a wide rectangle', () => {
    const rect: Rectangle = { left: 0, top: 0, right: 200, bottom: 100 };
    const result = squarifyRectangle(rect);
    expect(result.size).toBe(100);
    expect(result.x).toBe(50); // Centered horizontally
    expect(result.y).toBe(0);
  });

  it('should center a tall rectangle', () => {
    const rect: Rectangle = { left: 0, top: 0, right: 100, bottom: 200 };
    const result = squarifyRectangle(rect);
    expect(result.size).toBe(100);
    expect(result.x).toBe(0);
    expect(result.y).toBe(50); // Centered vertically
  });

  it('should handle offset rectangle', () => {
    const rect: Rectangle = { left: 50, top: 30, right: 250, bottom: 130 };
    const result = squarifyRectangle(rect);
    expect(result.size).toBe(100);
    expect(result.x).toBe(100); // 50 + (200-100)/2 = 100
    expect(result.y).toBe(30);
  });
});

describe('findRectangleDarkPixels', () => {
  it('should find dark rectangle in white background', () => {
    const width = 100;
    const height = 100;
    const gray = new Uint8Array(width * height).fill(255);

    // Create dark square in center (30,30) to (70,70)
    for (let y = 30; y <= 70; y++) {
      for (let x = 30; x <= 70; x++) {
        gray[y * width + x] = 0;
      }
    }

    const rect = findRectangleDarkPixels(gray, width, height);
    expect(rect.left).toBeLessThanOrEqual(30);
    expect(rect.top).toBeLessThanOrEqual(30);
    expect(rect.right).toBeGreaterThanOrEqual(70);
    expect(rect.bottom).toBeGreaterThanOrEqual(70);
  });

  it('should handle all-white image', () => {
    const width = 50;
    const height = 50;
    const gray = new Uint8Array(width * height).fill(255);

    const rect = findRectangleDarkPixels(gray, width, height);
    // Should return full image bounds
    expect(rect.left).toBe(0);
    expect(rect.top).toBe(0);
    expect(rect.right).toBe(width - 1);
    expect(rect.bottom).toBe(height - 1);
  });
});

describe('detectBoardRectangle', () => {
  it('should return a rectangle for image with dark border', () => {
    const imageData = createTestImageData(200, 200, 255);

    // Draw a dark square border
    drawRectangle(imageData, { left: 30, top: 30, right: 170, bottom: 170 }, 0, 5);

    const result = detectBoardRectangle(imageData);
    expect(result).not.toBeNull();
    if (result) {
      // Should approximately find the rectangle
      expect(result.left).toBeLessThan(50);
      expect(result.top).toBeLessThan(50);
      expect(result.right).toBeGreaterThan(150);
      expect(result.bottom).toBeGreaterThan(150);
    }
  });

  it('should return rectangle for uniform image (fallback)', () => {
    const imageData = createTestImageData(100, 100, 200);

    const result = detectBoardRectangle(imageData);
    // Should return some rectangle (fallback behavior)
    expect(result).not.toBeNull();
  });

  it('should handle small images', () => {
    const imageData = createTestImageData(20, 20, 128);

    const result = detectBoardRectangle(imageData);
    expect(result).not.toBeNull();
  });
});
