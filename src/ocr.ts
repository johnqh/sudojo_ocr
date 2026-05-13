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

/** Minimum dark pixel ratio in a sub-cell to detect a pencilmark via ink */
const PENCILMARK_INK_THRESHOLD = 0.02;

/**
 * Preprocess a cell for pencilmark OCR.
 * Upscales, enhances contrast, binarizes adaptively (Otsu), removes grid lines,
 * and adds padding. Returns the processed canvas plus inner dimensions
 * (before padding) needed for bounding box coordinate mapping, and the
 * binarized inner image data for ink detection.
 */
function preprocessPencilmarkCell(
  adapter: CanvasAdapter,
  cellCanvas: CanvasLike
): {
  canvas: CanvasLike;
  innerWidth: number;
  innerHeight: number;
  padding: number;
  innerImageData: ImageDataLike;
} {
  // Upscale so shortest dimension >= OCR_PENCILMARK_TARGET_CELL_SIZE
  const scale = Math.max(
    1,
    OCR_PENCILMARK_TARGET_CELL_SIZE /
      Math.min(cellCanvas.width, cellCanvas.height)
  );
  const scaledWidth = Math.round(cellCanvas.width * scale);
  const scaledHeight = Math.round(cellCanvas.height * scale);

  const scaledCanvas = adapter.createCanvas(scaledWidth, scaledHeight);
  adapter.fillRect(scaledCanvas, 'white', 0, 0, scaledWidth, scaledHeight);
  adapter.drawImage(
    scaledCanvas,
    cellCanvas,
    0,
    0,
    cellCanvas.width,
    cellCanvas.height,
    0,
    0,
    scaledWidth,
    scaledHeight
  );

  // Adaptive binarize (Otsu finds optimal threshold) -> remove grid lines
  // No contrast enhancement: Otsu handles varying contrast natively,
  // and enhanceContrast can create artifacts that cause false pencilmark detections.
  let imageData = adapter.getImageData(
    scaledCanvas,
    0,
    0,
    scaledWidth,
    scaledHeight
  );
  imageData = adaptiveBinarize(imageData);
  // Scale grid line removal depth with cell size (3px at 100px, ~6px at 200px)
  const gridLineDepth = Math.max(3, Math.floor(scaledWidth * 0.03));
  imageData = removeGridLines(imageData, gridLineDepth, 3);

  const processedCanvas = adapter.createCanvas(scaledWidth, scaledHeight);
  adapter.putImageData(processedCanvas, imageData, 0, 0);

  // Add padding for Tesseract
  const padding = OCR_CELL_PADDING;
  const paddedCanvas = addPadding(adapter, processedCanvas, padding);

  return {
    canvas: paddedCanvas,
    innerWidth: scaledWidth,
    innerHeight: scaledHeight,
    padding,
    innerImageData: imageData,
  };
}

/**
 * Check if a binarized cell is empty by counting dark pixels.
 * More robust than stdDev-based isCellEmpty for colored images
 * (e.g., blue digits on blue-tinted backgrounds).
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
 * Detect pencilmark positions by scanning each 3x3 sub-cell for connected
 * dark components. More robust than pixel-ratio ink detection: requires
 * a coherent shape (3+ connected pixels) that doesn't touch the sub-cell
 * border (filtering grid line remnants and margin artifacts).
 * @returns Sorted array of detected digit numbers (e.g., [1, 3, 7])
 */
function detectPencilmarksByInk(imageData: ImageDataLike): number[] {
  const { data, width, height } = imageData;
  const subW = Math.floor(width / 3);
  const subH = Math.floor(height / 3);
  const digits: number[] = [];

  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const digit = row * 3 + col + 1;

      // Extract sub-cell image data
      const sx = col * subW;
      const sy = row * subH;
      const subData = new Uint8ClampedArray(subW * subH * 4);

      for (let y = 0; y < subH; y++) {
        for (let x = 0; x < subW; x++) {
          const srcIdx = ((sy + y) * width + (sx + x)) * 4;
          const dstIdx = (y * subW + x) * 4;
          subData[dstIdx] = data[srcIdx] ?? 255;
          subData[dstIdx + 1] = data[srcIdx + 1] ?? 255;
          subData[dstIdx + 2] = data[srcIdx + 2] ?? 255;
          subData[dstIdx + 3] = data[srcIdx + 3] ?? 255;
        }
      }

      const subImage: ImageDataLike = {
        data: subData,
        width: subW,
        height: subH,
      };

      if (isPencilmarkPresent(subImage)) {
        digits.push(digit);
      }
    }
  }

  return digits;
}

/**
 * Map Tesseract symbols to 3x3 pencilmark grid positions.
 * Each symbol's bounding box center determines its grid slot (1-9).
 * The digit value is inferred from position, not OCR text, since
 * pencilmarks are always at fixed positions in the 3x3 grid.
 * @returns Sorted array of detected digit numbers (e.g., [1, 3, 7])
 */
function mapSymbolsToGridPositions(
  symbols: TesseractSymbol[],
  innerWidth: number,
  innerHeight: number,
  padding: number
): number[] {
  const seen = new Set<number>();
  const slotWidth = innerWidth / 3;
  const slotHeight = innerHeight / 3;

  for (const sym of symbols) {
    // Subtract padding to get coordinates relative to inner cell
    const cx = (sym.bbox.x0 + sym.bbox.x1) / 2 - padding;
    const cy = (sym.bbox.y0 + sym.bbox.y1) / 2 - padding;

    // Clamp to grid bounds then compute slot
    const gridCol = Math.min(2, Math.max(0, Math.floor(cx / slotWidth)));
    const gridRow = Math.min(2, Math.max(0, Math.floor(cy / slotHeight)));
    const positionDigit = gridRow * 3 + gridCol + 1;

    seen.add(positionDigit);
  }

  return [...seen].sort((a, b) => a - b);
}

/** Height ratio threshold: symbols taller than this fraction of cell height are given digits */
const GIVEN_DIGIT_HEIGHT_RATIO = 0.4;

/**
 * Recognize cells using Tesseract SPARSE_TEXT mode with bounding box analysis.
 * Classifies each cell as empty, given digit, or pencilmarks based on
 * recognized symbol bounding box sizes.
 *
 * Uses two-pass strategy: SPARSE_TEXT first (good for pencilmarks),
 * then SINGLE_CHAR fallback for non-empty cells where SPARSE_TEXT
 * found no large digit (SINGLE_CHAR is better for isolated large digits).
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

  const worker = await tesseract.createWorker('eng', 1, {
    logger: () => {},
  });

  // Pass 1: SPARSE_TEXT — good for pencilmarks and scattered digits
  await worker.setParameters({
    tessedit_pageseg_mode: tesseract.PSM.SPARSE_TEXT,
    tessedit_char_whitelist: '123456789',
  });

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (!cell) continue;

    // Preprocess cell (adaptive binarize handles colored images)
    const { canvas, innerWidth, innerHeight, padding, innerImageData } =
      preprocessPencilmarkCell(adapter, cell);

    // Empty check on binarized image (robust to colored backgrounds)
    if (isBinarizedCellEmpty(innerImageData)) {
      results[i] = { digit: null, confidence: 100 };
      onProgress?.(((i + 1) / cells.length) * 100);
      continue;
    }

    const tesseractInput = adapter.toTesseractInput(canvas);
    const { data } = await worker.recognize(tesseractInput as any);
    const symbols: TesseractSymbol[] = (
      (data.symbols as TesseractSymbol[] | undefined) ?? []
    ).filter(
      (s: TesseractSymbol) => s.text.length === 1 && /^[1-9]$/.test(s.text)
    );

    if (symbols.length === 0) {
      // Non-empty cell but SPARSE_TEXT found nothing — needs SINGLE_CHAR fallback
      needsFallback.push(i);
      onProgress?.(((i + 1) / cells.length) * 100);
      continue;
    }

    // Classify by bounding box height relative to inner cell height
    const largeSymbols = symbols.filter((s) => {
      const symbolHeight = s.bbox.y1 - s.bbox.y0;
      return symbolHeight > innerHeight * GIVEN_DIGIT_HEIGHT_RATIO;
    });

    if (largeSymbols.length > 0) {
      // Given digit — take highest confidence large symbol
      const best = largeSymbols.reduce((a, b) =>
        a.confidence > b.confidence ? a : b
      );
      const digit = parseInt(best.text, 10);
      results[i] = { digit, confidence: best.confidence };
    } else {
      // Pencilmarks — merge SPARSE_TEXT positions with ink detection
      const ocrPositions = mapSymbolsToGridPositions(
        symbols,
        innerWidth,
        innerHeight,
        padding
      );
      const inkPositions = detectPencilmarksByInk(innerImageData);

      // Union of both detection methods
      const merged = new Set([...ocrPositions, ...inkPositions]);
      const digits = [...merged].sort((a, b) => a - b);

      pencilmarkDigits[i] = digits.join('');
      results[i] = { digit: null, confidence: 0 };
    }

    onProgress?.(((i + 1) / cells.length) * 100);
  }

  // Pass 2: SINGLE_CHAR fallback for cells SPARSE_TEXT missed
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

      // Attempt 1: processForOCR (standard binarize) — good for clear digits
      try {
        const processedCell = processForOCR(adapter, cell);
        const tesseractInput = adapter.toTesseractInput(processedCell);
        const { data } = await worker.recognize(tesseractInput as any);
        const text = data.text.trim();
        confidence = data.confidence || 0;
        const parsedDigit = parseDigitFromText(text);
        if (parsedDigit !== null && confidence >= 1) {
          digit = parsedDigit;
        }

        // Retry with dilation for thin strokes
        if (digit === null) {
          const dilatedCell = processForOCR(adapter, cell, true);
          const dilatedInput = adapter.toTesseractInput(dilatedCell);
          const dilatedResult = await worker.recognize(dilatedInput as any);
          const dilatedText = dilatedResult.data.text.trim();
          const dilatedConfidence = dilatedResult.data.confidence || 0;
          const dilatedDigit = parseDigitFromText(dilatedText);
          if (dilatedDigit !== null && dilatedConfidence >= 1) {
            digit = dilatedDigit;
            confidence = dilatedConfidence;
          }
        }
      } catch {
        // Standard preprocessing failed
      }

      // Attempt 2: adaptive binarize — handles colored/tinted images
      // Higher confidence threshold to avoid misreading pencilmarks as digits
      if (digit === null) {
        try {
          const { canvas: adaptiveCanvas } = preprocessPencilmarkCell(
            adapter,
            cell
          );
          const adaptiveInput = adapter.toTesseractInput(adaptiveCanvas);
          const { data } = await worker.recognize(adaptiveInput as any);
          const text = data.text.trim();
          const conf = data.confidence || 0;
          if (/^[1-9]$/.test(text) && conf >= 50) {
            digit = parseInt(text, 10);
            confidence = conf;
          }
        } catch {
          // Adaptive preprocessing also failed
        }
      }

      if (digit !== null) {
        results[i] = { digit, confidence };
      } else {
        // No digit found — try ink detection for pencilmarks.
        // First verify the cell looks like pencilmarks, not a large digit
        // that both OCR passes failed to read.
        const { innerImageData: fallbackImageData } =
          preprocessPencilmarkCell(adapter, cell);
        const components = findConnectedComponents(fallbackImageData);
        const hasLargeComponent = components.some(
          (c) =>
            c.maxY - c.minY + 1 >
            fallbackImageData.height * GIVEN_DIGIT_HEIGHT_RATIO
        );

        if (!hasLargeComponent && components.length >= 2) {
          // Multiple small components → likely pencilmarks
          const inkDigits = detectPencilmarksByInk(fallbackImageData);
          if (inkDigits.length >= 2) {
            pencilmarkDigits[i] = inkDigits.join('');
          }
        }
        results[i] = { digit: null, confidence: 0 };
      }
    }
  }

  // Fill any remaining unprocessed cells
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
