/**
 * @sudobility/sudojo_ocr - OCR library for Sudoku puzzle scanning
 *
 * Runs in Node.js. Board detection happens in-process; digit recognition is a
 * single HTTP call to the paddle_ocr service.
 *
 * Usage:
 * ```typescript
 * import { extractSudokuFromImage } from '@sudobility/sudojo_ocr';
 * import { createNodeAdapter } from '@sudobility/sudojo_ocr/node';
 *
 * const adapter = await createNodeAdapter();
 * const result = await extractSudokuFromImage(adapter, imageBuffer, {
 *   url: 'http://ocr.sudobility.com',
 * });
 * ```
 */

// Types
export type {
  OCRProgress,
  OCRResult,
  OCRConfig,
  Rectangle,
  CanvasAdapter,
  CanvasLike,
  ImageLike,
  ImageDataLike,
  CellRecognition,
  PaddleConfig,
} from './types.js';

export type { PaddleBlock, BoardRecognition } from './paddle.js';
export { mapBlocksToBoard, recognizeBoard } from './paddle.js';

export { DEFAULT_OCR_CONFIG } from './types.js';

// Main OCR functions
export {
  extractSudokuFromImage,
  detectAndCropBoard,
  extractCellImages,
} from './ocr.js';

// Algorithms (for advanced usage)
export {
  toGrayscale,
  gaussianBlur,
  cannyEdgeDetection,
  enhanceContrast,
  binarize,
  adaptiveBinarize,
  preprocessForOCR,
  isCellEmpty,
  detectBoardRectangle,
  findRectangleDarkPixels,
  squarifyRectangle,
  parseDigitFromText,
  findConnectedComponents,
  classifyCellContent,
  isPencilmarkPresent,
  removeGridLines,
} from './algorithms/index.js';
export type {
  ConnectedComponent,
  CellContentType,
} from './algorithms/index.js';
