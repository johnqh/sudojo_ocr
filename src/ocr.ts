/**
 * Main OCR module for Sudoku puzzle extraction
 */

import type {
  CanvasAdapter,
  CanvasLike,
  OCRConfig,
  OCRResult,
  CellOCRResult,
  OCRProgress,
  TesseractModule,
} from './types.js';
import {
  DEFAULT_OCR_CONFIG,
  OCR_TARGET_CELL_SIZE,
  OCR_CELL_PADDING,
  OCR_BINARIZE_THRESHOLD,
  OCR_CONTRAST_FACTOR,
} from './types.js';
import {
  detectBoardRectangle,
  squarifyRectangle,
  preprocessForOCR,
  enhanceContrast,
  binarize,
  dilate,
  isCellEmpty,
  parseDigitFromText,
} from './algorithms/index.js';

/**
 * Extract cells from the cropped board image
 */
function extractCells(
  adapter: CanvasAdapter,
  source: CanvasLike,
  marginRatio: number
): CanvasLike[] {
  const cells: CanvasLike[] = [];
  const cellWidth = source.width / 9;
  const cellHeight = source.height / 9;
  const marginX = cellWidth * marginRatio;
  const marginY = cellHeight * marginRatio;

  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const srcX = col * cellWidth + marginX;
      const srcY = row * cellHeight + marginY;
      const srcWidth = cellWidth - 2 * marginX;
      const srcHeight = cellHeight - 2 * marginY;

      const scale = Math.max(1, OCR_TARGET_CELL_SIZE / Math.min(srcWidth, srcHeight));
      const cellCanvas = adapter.createCanvas(
        Math.round(srcWidth * scale),
        Math.round(srcHeight * scale)
      );

      adapter.fillRect(cellCanvas, 'white', 0, 0, cellCanvas.width, cellCanvas.height);
      adapter.drawImage(
        cellCanvas,
        source,
        srcX,
        srcY,
        srcWidth,
        srcHeight,
        0,
        0,
        cellCanvas.width,
        cellCanvas.height
      );

      cells.push(cellCanvas);
    }
  }

  return cells;
}

/**
 * Add padding around a cell for better OCR
 */
function addPadding(
  adapter: CanvasAdapter,
  cellCanvas: CanvasLike,
  padding: number
): CanvasLike {
  const paddedCanvas = adapter.createCanvas(
    cellCanvas.width + padding * 2,
    cellCanvas.height + padding * 2
  );
  adapter.fillRect(paddedCanvas, 'white', 0, 0, paddedCanvas.width, paddedCanvas.height);
  adapter.drawImage(
    paddedCanvas,
    cellCanvas,
    0,
    0,
    cellCanvas.width,
    cellCanvas.height,
    padding,
    padding,
    cellCanvas.width,
    cellCanvas.height
  );
  return paddedCanvas;
}

/**
 * Process image data through enhancement and binarization
 * @param useDilation - Apply dilation to thicken thin strokes (useful for 8s, 9s)
 */
function processForOCR(
  adapter: CanvasAdapter,
  cellCanvas: CanvasLike,
  useDilation: boolean = false
): CanvasLike {
  // Enhance contrast
  const imageData = adapter.getImageData(cellCanvas, 0, 0, cellCanvas.width, cellCanvas.height);
  const enhanced = enhanceContrast(imageData, OCR_CONTRAST_FACTOR);

  // Binarize
  let processed = binarize(enhanced, OCR_BINARIZE_THRESHOLD);

  // Optionally apply dilation to thicken thin strokes
  if (useDilation) {
    processed = dilate(processed);
  }

  // Create new canvas with processed data
  const processedCanvas = adapter.createCanvas(cellCanvas.width, cellCanvas.height);
  adapter.putImageData(processedCanvas, processed, 0, 0);

  // Add padding
  return addPadding(adapter, processedCanvas, OCR_CELL_PADDING);
}

/**
 * Run OCR on all cells
 */
async function recognizeCells(
  adapter: CanvasAdapter,
  cells: CanvasLike[],
  minConfidence: number,
  tesseract: TesseractModule,
  onProgress?: (progress: number) => void
): Promise<CellOCRResult[]> {
  const results: CellOCRResult[] = [];

  const worker = await tesseract.createWorker('eng', 1, {
    logger: () => {},
  });

  await worker.setParameters({
    tessedit_pageseg_mode: tesseract.PSM.SINGLE_CHAR,
  });

  for (let i = 0; i < cells.length; i++) {
    const row = Math.floor(i / 9);
    const col = i % 9;
    const cell = cells[i];
    if (!cell) continue;

    // Check if cell is empty
    const cellImageData = adapter.getImageData(cell, 0, 0, cell.width, cell.height);
    if (isCellEmpty(cellImageData)) {
      results.push({
        index: i,
        row,
        column: col,
        digit: null,
        confidence: 100,
        text: '',
      });
      onProgress?.(((i + 1) / cells.length) * 100);
      continue;
    }

    // Process cell for OCR
    const processedCell = processForOCR(adapter, cell);

    let digit: number | null = null;
    let finalConfidence = 0;
    let finalText = '';

    try {
      const tesseractInput = adapter.toTesseractInput(processedCell);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await worker.recognize(tesseractInput as any);
      const text = data.text.trim();
      const confidence = data.confidence || 0;

      finalText = text;
      finalConfidence = confidence;

      const parsedDigit = parseDigitFromText(text);
      if (parsedDigit !== null && confidence >= minConfidence) {
        digit = parsedDigit;
      }

      // If OCR failed to recognize a valid digit, retry with dilation
      // Dilation thickens thin strokes which helps with 8s and 9s
      if (digit === null) {
        const dilatedCell = processForOCR(adapter, cell, true);
        const dilatedInput = adapter.toTesseractInput(dilatedCell);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dilatedResult = await worker.recognize(dilatedInput as any);
        const dilatedText = dilatedResult.data.text.trim();
        const dilatedConfidence = dilatedResult.data.confidence || 0;

        const dilatedDigit = parseDigitFromText(dilatedText);
        if (dilatedDigit !== null && dilatedConfidence >= minConfidence) {
          digit = dilatedDigit;
          finalText = dilatedText;
          finalConfidence = dilatedConfidence;
        }
      }
    } catch (error) {
      console.warn(`OCR failed for cell ${i} (row ${row}, col ${col}):`, error);
    }

    results.push({
      index: i,
      row,
      column: col,
      digit,
      confidence: finalConfidence,
      text: finalText,
    });

    onProgress?.(((i + 1) / cells.length) * 100);
  }

  await worker.terminate();

  return results;
}

/**
 * Extract a Sudoku puzzle from an image
 *
 * @param adapter - Platform-specific canvas adapter
 * @param imageSource - Image source (platform-specific)
 * @param tesseract - Tesseract.js module
 * @param config - OCR configuration options
 * @param onProgress - Progress callback
 * @returns OCR result with puzzle string and confidence
 */
export async function extractSudokuFromImage(
  adapter: CanvasAdapter,
  imageSource: unknown,
  tesseract: TesseractModule,
  config: Partial<OCRConfig> = {},
  onProgress?: (progress: OCRProgress) => void
): Promise<OCRResult> {
  const cfg = { ...DEFAULT_OCR_CONFIG, ...config };

  onProgress?.({ status: 'loading', progress: 0, message: 'Loading image...' });

  // Load image
  const { image, width, height } = await adapter.loadImage(imageSource);

  // Create source canvas
  const sourceCanvas = adapter.createCanvas(width, height);
  adapter.drawImage(sourceCanvas, image, 0, 0, width, height, 0, 0, width, height);

  // Detect and crop board
  let croppedCanvas: CanvasLike;
  if (cfg.skipBoardDetection) {
    croppedCanvas = sourceCanvas;
    onProgress?.({ status: 'processing', progress: 15, message: 'Processing image...' });
  } else {
    onProgress?.({ status: 'processing', progress: 5, message: 'Detecting board...' });

    const imageData = adapter.getImageData(sourceCanvas, 0, 0, width, height);
    const rectangle = detectBoardRectangle(imageData);

    if (rectangle) {
      const { x, y, size } = squarifyRectangle(rectangle);
      croppedCanvas = adapter.createCanvas(size, size);
      adapter.drawImage(croppedCanvas, sourceCanvas, x, y, size, size, 0, 0, size, size);
    } else {
      croppedCanvas = sourceCanvas;
    }

    onProgress?.({ status: 'processing', progress: 15, message: 'Processing image...' });
  }

  // Preprocess
  let processedCanvas: CanvasLike;
  if (cfg.preprocess) {
    const imageData = adapter.getImageData(
      croppedCanvas,
      0,
      0,
      croppedCanvas.width,
      croppedCanvas.height
    );
    const processed = preprocessForOCR(imageData);
    processedCanvas = adapter.createCanvas(croppedCanvas.width, croppedCanvas.height);
    adapter.putImageData(processedCanvas, processed, 0, 0);
  } else {
    processedCanvas = croppedCanvas;
  }

  // Extract cells
  const cells = extractCells(adapter, processedCanvas, cfg.cellMargin);

  onProgress?.({
    status: 'recognizing',
    progress: 20,
    message: 'Recognizing digits...',
  });

  // Run OCR
  const cellResults = await recognizeCells(
    adapter,
    cells,
    cfg.minConfidence,
    tesseract,
    (cellProgress) => {
      const overallProgress = 20 + cellProgress * 0.75;
      onProgress?.({
        status: 'recognizing',
        progress: overallProgress,
        message: `Recognizing cell ${Math.floor((cellProgress * 81) / 100) + 1}/81...`,
      });
    }
  );

  onProgress?.({ status: 'processing', progress: 95, message: 'Finalizing...' });

  // Build result
  const puzzle = cellResults.map((r) => r.digit ?? 0).join('');
  const recognizedCells = cellResults.filter((r) => r.digit !== null);
  const avgConfidence =
    recognizedCells.length > 0
      ? recognizedCells.reduce((sum, r) => sum + r.confidence, 0) / recognizedCells.length
      : 0;

  onProgress?.({ status: 'complete', progress: 100, message: 'Complete' });

  return {
    puzzle,
    confidence: avgConfidence,
    digitCount: recognizedCells.length,
    cellResults,
  };
}

/**
 * Detect and crop the Sudoku board from an image
 * Returns a data URL of the cropped board
 */
export async function detectAndCropBoard(
  adapter: CanvasAdapter,
  imageSource: unknown
): Promise<string> {
  const { image, width, height } = await adapter.loadImage(imageSource);

  const sourceCanvas = adapter.createCanvas(width, height);
  adapter.drawImage(sourceCanvas, image, 0, 0, width, height, 0, 0, width, height);

  const imageData = adapter.getImageData(sourceCanvas, 0, 0, width, height);
  const rectangle = detectBoardRectangle(imageData);

  if (rectangle) {
    const { x, y, size } = squarifyRectangle(rectangle);
    const croppedCanvas = adapter.createCanvas(size, size);
    adapter.drawImage(croppedCanvas, sourceCanvas, x, y, size, size, 0, 0, size, size);
    return adapter.toDataURL(croppedCanvas);
  }

  return adapter.toDataURL(sourceCanvas);
}

/**
 * Extract the 81 cell images from a cropped board image
 * Returns array of 81 data URLs (row-major order)
 * Useful for UI previews to show what the OCR will process
 *
 * @param adapter - Platform-specific canvas adapter
 * @param croppedBoardImage - Data URL or image source of the cropped board
 * @param marginRatio - Margin to remove from each cell (0-0.5), default: 0.154
 * @returns Array of 81 data URLs representing each cell
 */
export async function extractCellImages(
  adapter: CanvasAdapter,
  croppedBoardImage: unknown,
  marginRatio: number = 0.154
): Promise<string[]> {
  const { image, width, height } = await adapter.loadImage(croppedBoardImage);

  const sourceCanvas = adapter.createCanvas(width, height);
  adapter.drawImage(sourceCanvas, image, 0, 0, width, height, 0, 0, width, height);

  const cells = extractCells(adapter, sourceCanvas, marginRatio);
  return cells.map((cell) => adapter.toDataURL(cell));
}
