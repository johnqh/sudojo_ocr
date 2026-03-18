/**
 * OCR Types for Sudoku puzzle scanning
 */

import type { SolverBoard } from '@sudobility/sudojo_types';

/** Progress callback data */
export interface OCRProgress {
  status: 'loading' | 'recognizing' | 'processing' | 'complete' | 'error';
  progress: number; // 0-100
  message: string;
}

/** Final OCR result */
export interface OCRResult {
  /** Recognized board with puzzle string and pencilmark data */
  board: SolverBoard;
  /** Average confidence 0-100 */
  confidence: number;
  /** Number of digits recognized */
  digitCount: number;
}

/** OCR configuration */
export interface OCRConfig {
  /** Margin to remove from each cell (percentage, 0-0.5). Default: 0.154 */
  cellMargin: number;
  /** Minimum confidence threshold (0-100). Default: 1 */
  minConfidence: number;
  /** Whether to preprocess the image. Default: true */
  preprocess: boolean;
  /** Skip board detection - use when image is already cropped. Default: false */
  skipBoardDetection: boolean;
  /** Detect pencilmarks (small candidate digits) in cells. Default: false */
  recognizePencilmarks: boolean;
}

/** Default OCR configuration */
export const DEFAULT_OCR_CONFIG: OCRConfig = {
  cellMargin: 0.154,
  minConfidence: 1,
  preprocess: true,
  skipBoardDetection: false,
  recognizePencilmarks: false,
};

/** Target size in pixels for extracted cell images */
export const OCR_TARGET_CELL_SIZE = 100;

/** Padding in pixels added around cells for OCR */
export const OCR_CELL_PADDING = 20;

/** Threshold for binarization (0-255) */
export const OCR_BINARIZE_THRESHOLD = 160;

/** Contrast enhancement factor */
export const OCR_CONTRAST_FACTOR = 1.5;

/** Minimum dark pixel ratio to consider a pencilmark present in a sub-cell */
export const OCR_PENCILMARK_MIN_INK_RATIO = 0.03;

/** Cell margin for pencilmark mode — minimal trim, grid line removal handles the rest */
export const OCR_PENCILMARK_CELL_MARGIN = 0.03;

/** Rectangle bounds */
export interface Rectangle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Canvas adapter interface - abstracts platform-specific canvas operations
 */
export interface CanvasAdapter {
  /** Create a new canvas with given dimensions */
  createCanvas(width: number, height: number): CanvasLike;

  /** Load an image from source (platform-specific) and return dimensions */
  loadImage(source: unknown): Promise<{
    image: ImageLike;
    width: number;
    height: number;
  }>;

  /** Get image data from canvas */
  getImageData(
    canvas: CanvasLike,
    x: number,
    y: number,
    width: number,
    height: number
  ): ImageDataLike;

  /** Put image data to canvas */
  putImageData(
    canvas: CanvasLike,
    imageData: ImageDataLike,
    x: number,
    y: number
  ): void;

  /** Draw image to canvas */
  drawImage(
    canvas: CanvasLike,
    source: CanvasLike | ImageLike,
    sx: number,
    sy: number,
    sWidth: number,
    sHeight: number,
    dx: number,
    dy: number,
    dWidth: number,
    dHeight: number
  ): void;

  /** Fill rectangle with color */
  fillRect(
    canvas: CanvasLike,
    color: string,
    x: number,
    y: number,
    width: number,
    height: number
  ): void;

  /** Convert canvas to format suitable for Tesseract */
  toTesseractInput(canvas: CanvasLike): unknown;

  /** Convert canvas to data URL (for debugging) */
  toDataURL(canvas: CanvasLike): string;
}

/** Platform-agnostic canvas interface */
export interface CanvasLike {
  width: number;
  height: number;
}

/** Platform-agnostic image interface */
export interface ImageLike {
  width: number;
  height: number;
}

/** Platform-agnostic image data interface */
export interface ImageDataLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Minimal Tesseract.js interface that works with both v5 and v7
 * This allows the library to be used with any compatible version
 */
export interface TesseractModule {
  createWorker: (
    lang: string,
    oem?: number,

    options?: any
  ) => Promise<TesseractWorker>;
  PSM: {
    SINGLE_CHAR: number;
  };
}

/** Minimal Tesseract Worker interface */
export interface TesseractWorker {
  setParameters: (params: any) => Promise<void>;

  recognize: (image: any) => Promise<{
    data: {
      text: string;
      confidence?: number;
    };
  }>;
  terminate: () => Promise<void>;
}
