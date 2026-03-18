import { describe, it, expect } from 'vitest';
import {
  toGrayscale,
  gaussianBlur,
  cannyEdgeDetection,
  enhanceContrast,
  binarize,
  preprocessForOCR,
  isCellEmpty,
  removeGridLines,
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
    const imageData = createTestImageData(2, 2, {
      r: 255,
      g: 255,
      b: 255,
      a: 255,
    });
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
    const imageData = createTestImageData(3, 3, {
      r: 128,
      g: 128,
      b: 128,
      a: 255,
    });
    const enhanced = enhanceContrast(imageData, 1.5);
    expect(enhanced.width).toBe(3);
    expect(enhanced.height).toBe(3);
    expect(enhanced.data.length).toBe(36);
  });

  it('should preserve alpha channel', () => {
    const imageData = createTestImageData(1, 1, {
      r: 128,
      g: 128,
      b: 128,
      a: 200,
    });
    const enhanced = enhanceContrast(imageData, 1.5);
    expect(enhanced.data[3]).toBe(200);
  });

  it('should enhance contrast around average', () => {
    // Create image with two pixels: one dark, one light
    const data = new Uint8ClampedArray([
      64,
      64,
      64,
      255, // dark pixel
      192,
      192,
      192,
      255, // light pixel
    ]);
    const imageData: ImageDataLike = { data, width: 2, height: 1 };
    const enhanced = enhanceContrast(imageData, 2.0);
    // Dark should get darker, light should get lighter
    expect(enhanced.data[0]).toBeLessThan(64);
    expect(enhanced.data[4]).toBeGreaterThan(192);
  });
});

describe('binarize', () => {
  it('should convert dark pixels to black and near-white to white', () => {
    // Two pixels: dark (Y=50) and light (Y=200). Range=150, threshold=200-15=185
    const data = new Uint8ClampedArray([50, 50, 50, 255, 200, 200, 200, 255]);
    const imageData: ImageDataLike = { data, width: 2, height: 1 };
    const binarized = binarize(imageData);
    expect(binarized.data[0]).toBe(0); // dark → black
    expect(binarized.data[4]).toBe(255); // light → white
  });

  it('should make uniform image all white', () => {
    // All same brightness → range=0, everything at max → white
    const imageData = createTestImageData(2, 2, {
      r: 128,
      g: 128,
      b: 128,
      a: 255,
    });
    const binarized = binarize(imageData);
    expect(binarized.data[0]).toBe(255);
  });

  it('should classify mid-range pixels as black with default 10%', () => {
    // Three pixels: Y=0, Y=128, Y=255. Range=255, threshold=255-25.5=229.5
    const data = new Uint8ClampedArray([
      0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255,
    ]);
    const imageData: ImageDataLike = { data, width: 3, height: 1 };
    const binarized = binarize(imageData);
    expect(binarized.data[0]).toBe(0); // Y=0 → black
    expect(binarized.data[4]).toBe(0); // Y=128 → black
    expect(binarized.data[8]).toBe(255); // Y=255 → white
  });

  it('should preserve alpha channel', () => {
    const data = new Uint8ClampedArray([50, 50, 50, 128, 200, 200, 200, 200]);
    const imageData: ImageDataLike = { data, width: 2, height: 1 };
    const binarized = binarize(imageData);
    expect(binarized.data[3]).toBe(128);
    expect(binarized.data[7]).toBe(200);
  });
});

describe('preprocessForOCR', () => {
  it('should return ImageDataLike with same dimensions', () => {
    const imageData = createTestImageData(3, 3, {
      r: 128,
      g: 128,
      b: 128,
      a: 255,
    });
    const processed = preprocessForOCR(imageData);
    expect(processed.width).toBe(3);
    expect(processed.height).toBe(3);
    expect(processed.data.length).toBe(36);
  });

  it('should stretch contrast', () => {
    // Create image with limited range (100-150)
    const data = new Uint8ClampedArray([
      100, 100, 100, 255, 150, 150, 150, 255,
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
    const imageData = createTestImageData(10, 10, {
      r: 255,
      g: 255,
      b: 255,
      a: 255,
    });
    expect(isCellEmpty(imageData)).toBe(true);
  });

  it('should return true for uniform black image', () => {
    const imageData = createTestImageData(10, 10, { r: 0, g: 0, b: 0, a: 255 });
    expect(isCellEmpty(imageData)).toBe(true);
  });

  it('should return true for uniform gray image', () => {
    const imageData = createTestImageData(10, 10, {
      r: 128,
      g: 128,
      b: 128,
      a: 255,
    });
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

describe('removeGridLines', () => {
  /**
   * Helper to create a binarized image with specific dark pixel positions.
   * All pixels start white; darkPixels specifies [x, y] positions to set black.
   */
  function createBinarizedImage(
    width: number,
    height: number,
    darkPixels: [number, number][]
  ): ImageDataLike {
    const data = new Uint8ClampedArray(width * height * 4);
    // Fill white
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 255;
    }
    // Set dark pixels
    for (const [x, y] of darkPixels) {
      const idx = (y * width + x) * 4;
      data[idx] = 0;
      data[idx + 1] = 0;
      data[idx + 2] = 0;
    }
    return { data, width, height };
  }

  function isDark(imageData: ImageDataLike, x: number, y: number): boolean {
    const idx = (y * imageData.width + x) * 4;
    return (imageData.data[idx] ?? 255) < 128;
  }

  it('should remove dark pixels on the border', () => {
    // Dark pixel at (0, 5) — left border
    const img = createBinarizedImage(10, 10, [[0, 5]]);
    const result = removeGridLines(img);
    expect(isDark(result, 0, 5)).toBe(false);
  });

  it('should remove dark pixels connected to the border', () => {
    // A line of dark pixels from left border inward: (0,5), (1,5), (2,5)
    const img = createBinarizedImage(10, 10, [
      [0, 5],
      [1, 5],
      [2, 5],
    ]);
    const result = removeGridLines(img);
    expect(isDark(result, 0, 5)).toBe(false);
    expect(isDark(result, 1, 5)).toBe(false);
    expect(isDark(result, 2, 5)).toBe(false);
  });

  it('should preserve interior dark pixels not connected to border', () => {
    // Interior blob at center (5,5)
    const img = createBinarizedImage(10, 10, [[5, 5]]);
    const result = removeGridLines(img);
    expect(isDark(result, 5, 5)).toBe(true);
  });

  it('should remove grid line on top border while preserving interior digit', () => {
    // Top border line: y=0, x=0..9
    const borderPixels: [number, number][] = [];
    for (let x = 0; x < 10; x++) {
      borderPixels.push([x, 0]);
    }
    // Interior digit blob
    const interiorPixels: [number, number][] = [
      [4, 4],
      [5, 4],
      [4, 5],
      [5, 5],
    ];
    const img = createBinarizedImage(10, 10, [
      ...borderPixels,
      ...interiorPixels,
    ]);
    const result = removeGridLines(img);

    // Border line should be removed
    for (let x = 0; x < 10; x++) {
      expect(isDark(result, x, 0)).toBe(false);
    }
    // Interior digit should be preserved
    expect(isDark(result, 4, 4)).toBe(true);
    expect(isDark(result, 5, 5)).toBe(true);
  });

  it('should handle all-white image', () => {
    const img = createBinarizedImage(10, 10, []);
    const result = removeGridLines(img);
    // No dark pixels to remove, should be identical
    for (let i = 0; i < result.data.length; i += 4) {
      expect(result.data[i]).toBe(255);
    }
  });

  it('should remove L-shaped grid line touching corner', () => {
    // L-shaped line: left border + bottom border
    const pixels: [number, number][] = [];
    for (let y = 0; y < 10; y++) pixels.push([0, y]); // left border
    for (let x = 0; x < 10; x++) pixels.push([x, 9]); // bottom border
    // Interior pixel
    pixels.push([5, 5]);
    const img = createBinarizedImage(10, 10, pixels);
    const result = removeGridLines(img);

    // L-shaped border lines removed
    expect(isDark(result, 0, 3)).toBe(false);
    expect(isDark(result, 3, 9)).toBe(false);
    // Interior preserved
    expect(isDark(result, 5, 5)).toBe(true);
  });
});
