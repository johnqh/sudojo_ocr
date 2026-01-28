import { describe, it, expect } from 'vitest';
import {
  toGrayscale,
  gaussianBlur,
  cannyEdgeDetection,
  enhanceContrast,
  binarize,
  preprocessForOCR,
  isCellEmpty,
} from './imageProcessing.js';
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
  }
  return { data, width, height };
}

describe('toGrayscale', () => {
  it('should convert white image to grayscale 255', () => {
    const imageData = createTestImageData(2, 2, { r: 255, g: 255, b: 255, a: 255 });
    const gray = toGrayscale(imageData);
    expect(gray.length).toBe(4);
    expect(gray[0]).toBe(255);
    expect(gray[1]).toBe(255);
    expect(gray[2]).toBe(255);
    expect(gray[3]).toBe(255);
  });

  it('should convert black image to grayscale 0', () => {
    const imageData = createTestImageData(2, 2, { r: 0, g: 0, b: 0, a: 255 });
    const gray = toGrayscale(imageData);
    expect(gray.length).toBe(4);
    expect(gray[0]).toBe(0);
    expect(gray[1]).toBe(0);
    expect(gray[2]).toBe(0);
    expect(gray[3]).toBe(0);
  });

  it('should convert red to proper grayscale value', () => {
    const imageData = createTestImageData(1, 1, { r: 255, g: 0, b: 0, a: 255 });
    const gray = toGrayscale(imageData);
    // 0.299 * 255 ≈ 76
    expect(gray[0]).toBe(76);
  });
});

describe('gaussianBlur', () => {
  it('should return array of same size', () => {
    const gray = new Uint8Array(9).fill(128);
    const blurred = gaussianBlur(gray, 3, 3);
    expect(blurred.length).toBe(9);
  });

  it('should blur edges', () => {
    // 3x3 image with center pixel different
    const gray = new Uint8Array([0, 0, 0, 0, 255, 0, 0, 0, 0]);
    const blurred = gaussianBlur(gray, 3, 3);
    // Center pixel should be blurred (kernel weighted average)
    // 255 * 4 / 16 = 63.75
    expect(blurred[4]).toBe(63);
  });
});

describe('cannyEdgeDetection', () => {
  it('should return array of same size', () => {
    const gray = new Uint8Array(9).fill(128);
    const edges = cannyEdgeDetection(gray, 3, 3);
    expect(edges.length).toBe(9);
  });

  it('should detect edges at brightness transitions', () => {
    // 5x5 image with vertical edge in middle
    const gray = new Uint8Array(25);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        gray[y * 5 + x] = x < 2 ? 0 : 255;
      }
    }
    const edges = cannyEdgeDetection(gray, 5, 5);
    // Should have non-zero values around the edge
    expect(edges.some((v) => v > 0)).toBe(true);
  });
});

describe('enhanceContrast', () => {
  it('should return ImageDataLike with same dimensions', () => {
    const imageData = createTestImageData(3, 3, { r: 128, g: 128, b: 128, a: 255 });
    const enhanced = enhanceContrast(imageData, 1.5);
    expect(enhanced.width).toBe(3);
    expect(enhanced.height).toBe(3);
    expect(enhanced.data.length).toBe(36);
  });

  it('should preserve alpha channel', () => {
    const imageData = createTestImageData(1, 1, { r: 128, g: 128, b: 128, a: 200 });
    const enhanced = enhanceContrast(imageData, 1.5);
    expect(enhanced.data[3]).toBe(200);
  });

  it('should enhance contrast around average', () => {
    // Create image with two pixels: one dark, one light
    const data = new Uint8ClampedArray([
      64, 64, 64, 255,  // dark pixel
      192, 192, 192, 255, // light pixel
    ]);
    const imageData: ImageDataLike = { data, width: 2, height: 1 };
    const enhanced = enhanceContrast(imageData, 2.0);
    // Dark should get darker, light should get lighter
    expect(enhanced.data[0]).toBeLessThan(64);
    expect(enhanced.data[4]).toBeGreaterThan(192);
  });
});

describe('binarize', () => {
  it('should convert values below threshold to 0', () => {
    const imageData = createTestImageData(1, 1, { r: 100, g: 100, b: 100, a: 255 });
    const binarized = binarize(imageData, 160);
    expect(binarized.data[0]).toBe(0);
    expect(binarized.data[1]).toBe(0);
    expect(binarized.data[2]).toBe(0);
  });

  it('should convert values at/above threshold to 255', () => {
    const imageData = createTestImageData(1, 1, { r: 200, g: 200, b: 200, a: 255 });
    const binarized = binarize(imageData, 160);
    expect(binarized.data[0]).toBe(255);
    expect(binarized.data[1]).toBe(255);
    expect(binarized.data[2]).toBe(255);
  });

  it('should preserve alpha channel', () => {
    const imageData = createTestImageData(1, 1, { r: 100, g: 100, b: 100, a: 128 });
    const binarized = binarize(imageData, 160);
    expect(binarized.data[3]).toBe(128);
  });
});

describe('preprocessForOCR', () => {
  it('should return ImageDataLike with same dimensions', () => {
    const imageData = createTestImageData(3, 3, { r: 128, g: 128, b: 128, a: 255 });
    const processed = preprocessForOCR(imageData);
    expect(processed.width).toBe(3);
    expect(processed.height).toBe(3);
    expect(processed.data.length).toBe(36);
  });

  it('should stretch contrast', () => {
    // Create image with limited range (100-150)
    const data = new Uint8ClampedArray([
      100, 100, 100, 255,
      150, 150, 150, 255,
    ]);
    const imageData: ImageDataLike = { data, width: 2, height: 1 };
    const processed = preprocessForOCR(imageData);
    // After stretching, range should be wider (closer to 0-255)
    expect(processed.data[0]).toBeLessThan(100);
    expect(processed.data[4]).toBeGreaterThan(150);
  });
});

describe('isCellEmpty', () => {
  it('should return true for uniform white image', () => {
    const imageData = createTestImageData(10, 10, { r: 255, g: 255, b: 255, a: 255 });
    expect(isCellEmpty(imageData)).toBe(true);
  });

  it('should return true for uniform black image', () => {
    const imageData = createTestImageData(10, 10, { r: 0, g: 0, b: 0, a: 255 });
    expect(isCellEmpty(imageData)).toBe(true);
  });

  it('should return true for uniform gray image', () => {
    const imageData = createTestImageData(10, 10, { r: 128, g: 128, b: 128, a: 255 });
    expect(isCellEmpty(imageData)).toBe(true);
  });

  it('should return false for image with high variance', () => {
    // Create checkerboard pattern
    const data = new Uint8ClampedArray(10 * 10 * 4);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        const idx = (y * 10 + x) * 4;
        const val = (x + y) % 2 === 0 ? 255 : 0;
        data[idx] = val;
        data[idx + 1] = val;
        data[idx + 2] = val;
        data[idx + 3] = 255;
      }
    }
    const imageData: ImageDataLike = { data, width: 10, height: 10 };
    expect(isCellEmpty(imageData)).toBe(false);
  });
});
