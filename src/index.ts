/**
 * @sudobility/sudojo_ocr - OCR library for Sudoku puzzle scanning
 *
 * Works on Web, React Native, and Node.js.
 *
 * Usage:
 * ```typescript
 * // Web/Browser
 * import { extractSudokuFromImage } from '@sudobility/sudojo_ocr';
 * import { createWebAdapter } from '@sudobility/sudojo_ocr/web';
 * import Tesseract from 'tesseract.js';
 *
 * const adapter = createWebAdapter();
 * const result = await extractSudokuFromImage(adapter, imageFile, Tesseract);
 *
 * // Node.js
 * import { extractSudokuFromImage } from '@sudobility/sudojo_ocr';
 * import { createNodeAdapter } from '@sudobility/sudojo_ocr/node';
 * import Tesseract from 'tesseract.js';
 *
 * const adapter = await createNodeAdapter();
 * const result = await extractSudokuFromImage(adapter, imageBuffer, Tesseract);
 * ```
 */

// Types
export type {
  OCRProgress,
  OCRResult,
  CellOCRResult,
  OCRConfig,
  Rectangle,
  CanvasAdapter,
  CanvasLike,
  ImageLike,
  ImageDataLike,
} from './types.js';

export { DEFAULT_OCR_CONFIG } from './types.js';

// Main OCR functions
export { extractSudokuFromImage, detectAndCropBoard } from './ocr.js';

// Algorithms (for advanced usage)
export {
  toGrayscale,
  gaussianBlur,
  cannyEdgeDetection,
  enhanceContrast,
  binarize,
  preprocessForOCR,
  isCellEmpty,
  detectBoardRectangle,
  findRectangleDarkPixels,
  squarifyRectangle,
  parseDigitFromText,
} from './algorithms/index.js';
