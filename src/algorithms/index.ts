/**
 * Algorithm exports
 */

export {
  toGrayscale,
  gaussianBlur,
  cannyEdgeDetection,
  enhanceContrast,
  binarize,
  dilate,
  preprocessForOCR,
  isCellEmpty,
} from './imageProcessing.js';

export {
  detectBoardRectangle,
  findRectangleDarkPixels,
  squarifyRectangle,
} from './boardDetection.js';

export { parseDigitFromText } from './digitParsing.js';

export {
  findConnectedComponents,
  classifyCellContent,
  isPencilmarkPresent,
} from './cellClassification.js';
export type { ConnectedComponent, CellContentType } from './cellClassification.js';
