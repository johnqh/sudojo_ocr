/**
 * Main OCR module for Sudoku puzzle extraction
 */

import type {
  CanvasAdapter,
  CanvasLike,
  ImageDataLike,
  OCRConfig,
  OCRResult,
  OCRProgress,
  TesseractModule,
  TesseractSymbol,
} from './types.js';
import {
  DEFAULT_OCR_CONFIG,
  OCR_TARGET_CELL_SIZE,
  OCR_CELL_PADDING,
  OCR_CONTRAST_FACTOR,
  OCR_PENCILMARK_CELL_MARGIN,
  OCR_PENCILMARK_TARGET_CELL_SIZE,
} from './types.js';
import {
  detectBoardRectangle,
  squarifyRectangle,
  preprocessForOCR,
  enhanceContrast,
  binarize,
  adaptiveBinarize,
  dilate,
  isCellEmpty,
  parseDigitFromText,
  removeGridLines,
  findConnectedComponents,
  isPencilmarkPresent,
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

      const scale = Math.max(
        1,
        OCR_TARGET_CELL_SIZE / Math.min(srcWidth, srcHeight)
      );
      const cellCanvas = adapter.createCanvas(
        Math.round(srcWidth * scale),
        Math.round(srcHeight * scale)
      );

      adapter.fillRect(
        cellCanvas,
        'white',
        0,
        0,
        cellCanvas.width,
        cellCanvas.height
      );
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
  adapter.fillRect(
    paddedCanvas,
    'white',
    0,
    0,
    paddedCanvas.width,
    paddedCanvas.height
  );
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
  // Enhance contrast then binarize for clean Tesseract input
  const imageData = adapter.getImageData(
    cellCanvas,
    0,
    0,
    cellCanvas.width,
    cellCanvas.height
  );
  const enhanced = enhanceContrast(imageData, OCR_CONTRAST_FACTOR);
  let processed = binarize(enhanced, 0.3);

  // Optionally apply dilation to thicken thin strokes
  if (useDilation) {
    processed = dilate(processed);
  }

  // Create new canvas with processed data
  const processedCanvas = adapter.createCanvas(
    cellCanvas.width,
    cellCanvas.height
  );
  adapter.putImageData(processedCanvas, processed, 0, 0);

  // Add padding
  return addPadding(adapter, processedCanvas, OCR_CELL_PADDING);
}

/** Minimum dark pixel ratio to consider a binarized cell non-empty */
const BINARIZED_EMPTY_THRESHOLD = 0.005;

/** Minimum OCR confidence to accept a sub-cell pencilmark detection */
const PENCILMARK_SUBCELL_MIN_CONFIDENCE = 10;

/** Height ratio threshold: symbols taller than this fraction of cell height are given digits */
const GIVEN_DIGIT_HEIGHT_RATIO = 0.4;

/**
 * Upscale a cell for pencilmark processing.
 * Returns both the raw upscaled canvas (for sub-cell OCR) and the
 * binarized+cleaned data (for SPARSE_TEXT classification and empty detection).
 */
function preprocessPencilmarkCell(
  adapter: CanvasAdapter,
  cellCanvas: CanvasLike
): {
  rawCanvas: CanvasLike;
  binarizedCanvas: CanvasLike;
  binarizedData: ImageDataLike;
  width: number;
  height: number;
} {
  const scale = Math.max(
    1,
    OCR_PENCILMARK_TARGET_CELL_SIZE /
      Math.min(cellCanvas.width, cellCanvas.height)
  );
  const w = Math.round(cellCanvas.width * scale);
  const h = Math.round(cellCanvas.height * scale);

  const rawCanvas = adapter.createCanvas(w, h);
  adapter.fillRect(rawCanvas, 'white', 0, 0, w, h);
  adapter.drawImage(
    rawCanvas, cellCanvas,
    0, 0, cellCanvas.width, cellCanvas.height,
    0, 0, w, h
  );

  // Binarize for SPARSE_TEXT and classification
  let imageData = adapter.getImageData(rawCanvas, 0, 0, w, h);
  imageData = adaptiveBinarize(imageData);
  const gridLineDepth = Math.max(3, Math.floor(w * 0.03));
  imageData = removeGridLines(imageData, gridLineDepth, 3);

  const binarizedCanvas = adapter.createCanvas(w, h);
  adapter.putImageData(binarizedCanvas, imageData, 0, 0);

  return { rawCanvas, binarizedCanvas, binarizedData: imageData, width: w, height: h };
}

/**
 * Check if a binarized cell is empty by counting dark pixels.
 * More robust than stdDev-based isCellEmpty for colored images.
 */
function isBinarizedCellEmpty(imageData: ImageDataLike): boolean {
  const { data, width, height } = imageData;
  const total = width * height;
  let darkCount = 0;
  for (let i = 0; i < total; i++) {
    if ((data[i * 4] ?? 255) < 128) darkCount++;
  }
  return darkCount / total < BINARIZED_EMPTY_THRESHOLD;
}

/**
 * Check if a sub-cell region has enough dark pixels to warrant OCR.
 */
function subCellHasInk(
  imageData: ImageDataLike,
  sx: number, sy: number, sw: number, sh: number
): boolean {
  const { data, width } = imageData;
  let darkCount = 0;
  const total = sw * sh;
  for (let y = sy; y < sy + sh; y++) {
    for (let x = sx; x < sx + sw; x++) {
      if ((data[(y * width + x) * 4] ?? 255) < 128) darkCount++;
    }
  }
  return darkCount / total > 0.01;
}

/**
 * OCR each of the 9 sub-cells individually using SINGLE_CHAR mode.
 * Uses the RAW (non-binarized) upscaled image so Tesseract gets full
 * image quality. The binarized image pre-filters empty sub-cells.
 *
 * @returns Sorted array of detected pencilmark digit positions (e.g., [1, 3, 7])
 */
async function recognizeSubCellPencilmarks(
  adapter: CanvasAdapter,
  rawCanvas: CanvasLike,
  binarizedData: ImageDataLike,
  cellWidth: number,
  cellHeight: number,
  worker: { setParameters: (p: any) => Promise<void>; recognize: (image: any) => Promise<{ data: { text: string; confidence?: number } }> },
  tesseractPSM: { SINGLE_CHAR: number },
  toTesseractInput: (canvas: CanvasLike) => unknown
): Promise<number[]> {
  const subW = Math.floor(cellWidth / 3);
  const subH = Math.floor(cellHeight / 3);
  const digits: number[] = [];

  // Ensure SINGLE_CHAR mode for sub-cell OCR
  await worker.setParameters({
    tessedit_pageseg_mode: tesseractPSM.SINGLE_CHAR,
    tessedit_char_whitelist: '123456789',
  });

  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const digit = row * 3 + col + 1;
      const sx = col * subW;
      const sy = row * subH;

      // Skip sub-cells with no ink (using binarized data which has grid lines removed)
      if (!subCellHasInk(binarizedData, sx, sy, subW, subH)) {
        continue;
      }

      // Extract sub-cell and upscale aggressively (pencilmarks are small)
      const targetSubSize = 150;
      const subScale = Math.max(1, targetSubSize / Math.min(subW, subH));
      const scaledW = Math.round(subW * subScale);
      const scaledH = Math.round(subH * subScale);

      const subCanvas = adapter.createCanvas(scaledW, scaledH);
      adapter.fillRect(subCanvas, 'white', 0, 0, scaledW, scaledH);
      adapter.drawImage(
        subCanvas, rawCanvas,
        sx, sy, subW, subH,
        0, 0, scaledW, scaledH
      );

      // Smaller padding so the digit fills more of the image
      const paddedCanvas = addPadding(adapter, subCanvas, 10);

      try {
        const input = toTesseractInput(paddedCanvas);
        const { data } = await worker.recognize(input as any);
        const text = data.text.trim();
        const conf = data.confidence || 0;

        if (/^[1-9]$/.test(text) && conf >= PENCILMARK_SUBCELL_MIN_CONFIDENCE) {
          digits.push(digit);
        }
      } catch {
        // Skip failed sub-cell
      }

      // Supplement: connected component ink detection on binarized sub-cell.
      // Catches pencilmarks that OCR missed (especially thin strokes like "1", "7").
      if (!digits.includes(digit)) {
        const subData = new Uint8ClampedArray(subW * subH * 4);
        for (let y = 0; y < subH; y++) {
          for (let x = 0; x < subW; x++) {
            const srcIdx = ((sy + y) * cellWidth + (sx + x)) * 4;
            const dstIdx = (y * subW + x) * 4;
            subData[dstIdx] = binarizedData.data[srcIdx] ?? 255;
            subData[dstIdx + 1] = binarizedData.data[srcIdx + 1] ?? 255;
            subData[dstIdx + 2] = binarizedData.data[srcIdx + 2] ?? 255;
            subData[dstIdx + 3] = binarizedData.data[srcIdx + 3] ?? 255;
          }
        }
        // Connected component check with size filtering.
        // Don't filter by border-touching (pencilmarks near sub-cell edges are
        // legitimate), but require minimum pixel count and dimensions to exclude
        // noise artifacts and grid line remnants.
        const components = findConnectedComponents(
          { data: subData, width: subW, height: subH },
          50
        );
        const hasPencilmark = components.some((c) => {
          const compH = c.maxY - c.minY + 1;
          const compW = c.maxX - c.minX + 1;
          return compH >= subH * 0.25 && compW >= subW * 0.12;
        });
        if (hasPencilmark) {
          digits.push(digit);
        }
      }
    }
  }

  return digits.sort((a, b) => a - b);
}

/**
 * Recognize cells in pencilmark mode.
 *
 * Pipeline:
 * 1. SPARSE_TEXT pass for classification (digit vs pencilmark) via bbox size
 * 2. For digit cells: use the SPARSE_TEXT-recognized digit
 * 3. For pencilmark cells: SINGLE_CHAR OCR on each of the 9 sub-cells
 * 4. For fallback cells (SPARSE_TEXT found nothing): try SINGLE_CHAR whole-cell,
 *    then sub-cell OCR if no digit found
 */
async function recognizeCellsPencilmark(
  adapter: CanvasAdapter,
  cells: CanvasLike[],
  tesseract: TesseractModule,
  onProgress?: (progress: number) => void
): Promise<{ cells: CellRecognition[]; pencilmarkDigits: string[] }> {
  const results: CellRecognition[] = new Array(cells.length);
  const pencilmarkDigits: string[] = new Array(cells.length).fill('');
  const needsFallback: number[] = [];
  const needsSubCellOCR: number[] = [];
  let sparseTextFoundPencilmarks = false;

  // Cache preprocessed data so we don't reprocess in later passes
  const preprocessed: Array<{
    rawCanvas: CanvasLike;
    binarizedCanvas: CanvasLike;
    binarizedData: ImageDataLike;
    width: number;
    height: number;
  }> = new Array(cells.length);

  const worker = await tesseract.createWorker('eng', 1, {
    logger: () => {},
  });

  // === Pass 1: SPARSE_TEXT classification ===
  await worker.setParameters({
    tessedit_pageseg_mode: tesseract.PSM.SPARSE_TEXT,
    tessedit_char_whitelist: '123456789',
  });

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (!cell) continue;

    const pp = preprocessPencilmarkCell(adapter, cell);
    preprocessed[i] = pp;

    // Empty check
    if (isBinarizedCellEmpty(pp.binarizedData)) {
      results[i] = { digit: null, confidence: 100 };
      onProgress?.(((i + 1) / cells.length) * 50);
      continue;
    }

    // Run SPARSE_TEXT on binarized+padded cell
    const paddedCanvas = addPadding(adapter, pp.binarizedCanvas, OCR_CELL_PADDING);
    const tesseractInput = adapter.toTesseractInput(paddedCanvas);
    const { data } = await worker.recognize(tesseractInput as any);
    const symbols: TesseractSymbol[] = (
      (data.symbols as TesseractSymbol[] | undefined) ?? []
    ).filter(
      (s: TesseractSymbol) => s.text.length === 1 && /^[1-9]$/.test(s.text)
    );

    if (symbols.length === 0) {
      needsFallback.push(i);
      onProgress?.(((i + 1) / cells.length) * 50);
      continue;
    }

    // Classify by bbox height
    const largeSymbols = symbols.filter((s) => {
      const symbolHeight = s.bbox.y1 - s.bbox.y0;
      return symbolHeight > pp.height * GIVEN_DIGIT_HEIGHT_RATIO;
    });

    if (largeSymbols.length > 0) {
      // Given digit
      const best = largeSymbols.reduce((a, b) =>
        a.confidence > b.confidence ? a : b
      );
      results[i] = { digit: parseInt(best.text, 10), confidence: best.confidence };
    } else {
      // Pencilmarks — queue for sub-cell OCR
      sparseTextFoundPencilmarks = true;
      needsSubCellOCR.push(i);
    }

    onProgress?.(((i + 1) / cells.length) * 50);
  }

  // === Pass 2: SINGLE_CHAR fallback for cells SPARSE_TEXT missed ===
  if (needsFallback.length > 0) {
    await worker.setParameters({
      tessedit_pageseg_mode: tesseract.PSM.SINGLE_CHAR,
      tessedit_char_whitelist: '123456789',
    });

    for (const i of needsFallback) {
      const cell = cells[i];
      if (!cell) continue;

      let digit: number | null = null;
      let confidence = 0;

      // Attempt 1: processForOCR
      try {
        const processedCell = processForOCR(adapter, cell);
        const input = adapter.toTesseractInput(processedCell);
        const { data } = await worker.recognize(input as any);
        const text = data.text.trim();
        confidence = data.confidence || 0;
        const parsed = parseDigitFromText(text);
        if (parsed !== null && confidence >= 1) digit = parsed;

        if (digit === null) {
          const dilated = processForOCR(adapter, cell, true);
          const dilInput = adapter.toTesseractInput(dilated);
          const dilResult = await worker.recognize(dilInput as any);
          const dilText = dilResult.data.text.trim();
          const dilConf = dilResult.data.confidence || 0;
          const dilDigit = parseDigitFromText(dilText);
          if (dilDigit !== null && dilConf >= 1) {
            digit = dilDigit;
            confidence = dilConf;
          }
        }
      } catch { /* failed */ }

      // Attempt 2: adaptive binarize
      if (digit === null) {
        const pp = preprocessed[i];
        if (pp) {
          try {
            const paddedCanvas = addPadding(adapter, pp.binarizedCanvas, OCR_CELL_PADDING);
            const input = adapter.toTesseractInput(paddedCanvas);
            const { data } = await worker.recognize(input as any);
            const text = data.text.trim();
            const conf = data.confidence || 0;
            if (/^[1-9]$/.test(text) && conf >= 50) {
              digit = parseInt(text, 10);
              confidence = conf;
            }
          } catch { /* failed */ }
        }
      }

      if (digit !== null) {
        results[i] = { digit, confidence };
      } else if (sparseTextFoundPencilmarks) {
        // No digit found, and the board has pencilmarks — try sub-cell OCR.
        // Only enabled when SPARSE_TEXT found pencilmarks elsewhere, preventing
        // false pencilmarks on digit-only boards.
        needsSubCellOCR.push(i);
      } else {
        results[i] = { digit: null, confidence: 0 };
      }
    }
  }

  // === Pass 3: Sub-cell SINGLE_CHAR OCR for pencilmark cells ===
  for (const i of needsSubCellOCR) {
    const pp = preprocessed[i];
    if (!pp) {
      results[i] = { digit: null, confidence: 0 };
      continue;
    }

    const digits = await recognizeSubCellPencilmarks(
      adapter,
      pp.rawCanvas,
      pp.binarizedData,
      pp.width,
      pp.height,
      worker,
      tesseract.PSM,
      (c) => adapter.toTesseractInput(c)
    );

    pencilmarkDigits[i] = digits.join('');
    results[i] = { digit: null, confidence: 0 };
  }

  // Fill unprocessed cells
  for (let i = 0; i < cells.length; i++) {
    if (!results[i]) {
      results[i] = { digit: null, confidence: 100 };
    }
  }

  await worker.terminate();
  return { cells: results as CellRecognition[], pencilmarkDigits };
}

/** Per-cell recognition result (internal only) */
interface CellRecognition {
  digit: number | null;
  confidence: number;
}

/**
 * Run OCR on all cells.
 * Returns per-cell digits/confidence and pencilmark digits (when enabled).
 * When recognizePencilmarks is true, uses SPARSE_TEXT mode with bounding
 * box analysis. Otherwise uses the original SINGLE_CHAR pipeline.
 */
async function recognizeCells(
  adapter: CanvasAdapter,
  cells: CanvasLike[],
  minConfidence: number,
  tesseract: TesseractModule,
  recognizePencilmarks: boolean = false,
  onProgress?: (progress: number) => void
): Promise<{ cells: CellRecognition[]; pencilmarkDigits: string[] }> {
  // Pencilmark mode: use SPARSE_TEXT with bounding box classification
  if (recognizePencilmarks) {
    return recognizeCellsPencilmark(adapter, cells, tesseract, onProgress);
  }

  // Standard mode: SINGLE_CHAR per cell (existing logic)
  const results: CellRecognition[] = [];
  const pencilmarkDigits: string[] = new Array(cells.length).fill('');

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

    const cellImageData = adapter.getImageData(
      cell,
      0,
      0,
      cell.width,
      cell.height
    );

    if (isCellEmpty(cellImageData)) {
      results.push({ digit: null, confidence: 100 });
      onProgress?.(((i + 1) / cells.length) * 100);
      continue;
    }

    // Process cell for OCR
    const processedCell = processForOCR(adapter, cell);

    let digit: number | null = null;
    let confidence = 0;

    try {
      const tesseractInput = adapter.toTesseractInput(processedCell);

      const { data } = await worker.recognize(tesseractInput as any);
      const text = data.text.trim();
      confidence = data.confidence || 0;

      const parsedDigit = parseDigitFromText(text);
      if (parsedDigit !== null && confidence >= minConfidence) {
        digit = parsedDigit;
      }

      // If OCR failed to recognize a valid digit, retry with dilation
      if (digit === null) {
        const dilatedCell = processForOCR(adapter, cell, true);
        const dilatedInput = adapter.toTesseractInput(dilatedCell);

        const dilatedResult = await worker.recognize(dilatedInput as any);
        const dilatedText = dilatedResult.data.text.trim();
        const dilatedConfidence = dilatedResult.data.confidence || 0;

        const dilatedDigit = parseDigitFromText(dilatedText);
        if (dilatedDigit !== null && dilatedConfidence >= minConfidence) {
          digit = dilatedDigit;
          confidence = dilatedConfidence;
        }
      }
    } catch (error) {
      console.warn(`OCR failed for cell ${i} (row ${row}, col ${col}):`, error);
    }

    results.push({ digit, confidence });
    onProgress?.(((i + 1) / cells.length) * 100);
  }

  await worker.terminate();

  return { cells: results, pencilmarkDigits };
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
  adapter.drawImage(
    sourceCanvas,
    image,
    0,
    0,
    width,
    height,
    0,
    0,
    width,
    height
  );

  // Detect and crop board
  let croppedCanvas: CanvasLike;
  if (cfg.skipBoardDetection) {
    croppedCanvas = sourceCanvas;
    onProgress?.({
      status: 'processing',
      progress: 15,
      message: 'Processing image...',
    });
  } else {
    onProgress?.({
      status: 'processing',
      progress: 5,
      message: 'Detecting board...',
    });

    const imageData = adapter.getImageData(sourceCanvas, 0, 0, width, height);
    const rectangle = detectBoardRectangle(imageData);

    if (rectangle) {
      const { x, y, size } = squarifyRectangle(rectangle);
      croppedCanvas = adapter.createCanvas(size, size);
      adapter.drawImage(
        croppedCanvas,
        sourceCanvas,
        x,
        y,
        size,
        size,
        0,
        0,
        size,
        size
      );
    } else {
      croppedCanvas = sourceCanvas;
    }

    onProgress?.({
      status: 'processing',
      progress: 15,
      message: 'Processing image...',
    });
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
    processedCanvas = adapter.createCanvas(
      croppedCanvas.width,
      croppedCanvas.height
    );
    adapter.putImageData(processedCanvas, processed, 0, 0);
  } else {
    processedCanvas = croppedCanvas;
  }

  // Extract cells — minimal margin for pencilmark mode; removeGridLines handles the rest
  const cellMargin = cfg.recognizePencilmarks
    ? Math.min(cfg.cellMargin, OCR_PENCILMARK_CELL_MARGIN)
    : cfg.cellMargin;
  const cells = extractCells(adapter, processedCanvas, cellMargin);

  onProgress?.({
    status: 'recognizing',
    progress: 20,
    message: 'Recognizing digits...',
  });

  // Run OCR
  const { cells: cellResults, pencilmarkDigits } = await recognizeCells(
    adapter,
    cells,
    cfg.minConfidence,
    tesseract,
    cfg.recognizePencilmarks,
    (cellProgress) => {
      const overallProgress = 20 + cellProgress * 0.75;
      const action = cfg.recognizePencilmarks ? 'Analyzing' : 'Recognizing';
      onProgress?.({
        status: 'recognizing',
        progress: overallProgress,
        message: `${action} cell ${Math.floor((cellProgress * 81) / 100) + 1}/81...`,
      });
    }
  );

  onProgress?.({
    status: 'processing',
    progress: 95,
    message: 'Finalizing...',
  });

  // Build result
  const puzzle = cellResults.map((r) => r.digit ?? 0).join('');
  const recognized = cellResults.filter((r) => r.digit !== null);
  const avgConfidence =
    recognized.length > 0
      ? recognized.reduce((sum, r) => sum + r.confidence, 0) / recognized.length
      : 0;

  const hasPencilmarks = pencilmarkDigits.some((d) => d.length > 0);

  onProgress?.({ status: 'complete', progress: 100, message: 'Complete' });

  return {
    board: {
      original: puzzle,
      user: puzzle,
      pencilmark: {
        autopencil: hasPencilmarks,
        numbers: pencilmarkDigits.join(','),
      },
    },
    confidence: avgConfidence,
    digitCount: recognized.length,
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
  adapter.drawImage(
    sourceCanvas,
    image,
    0,
    0,
    width,
    height,
    0,
    0,
    width,
    height
  );

  const imageData = adapter.getImageData(sourceCanvas, 0, 0, width, height);
  const rectangle = detectBoardRectangle(imageData);

  if (rectangle) {
    const { x, y, size } = squarifyRectangle(rectangle);
    const croppedCanvas = adapter.createCanvas(size, size);
    adapter.drawImage(
      croppedCanvas,
      sourceCanvas,
      x,
      y,
      size,
      size,
      0,
      0,
      size,
      size
    );
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
  adapter.drawImage(
    sourceCanvas,
    image,
    0,
    0,
    width,
    height,
    0,
    0,
    width,
    height
  );

  const cells = extractCells(adapter, sourceCanvas, marginRatio);
  return cells.map((cell) => adapter.toDataURL(cell));
}
