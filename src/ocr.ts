/**
 * Main OCR module for Sudoku puzzle extraction
 */

import type {
  CanvasAdapter,
  CanvasLike,
  CellRecognition,
  OCRConfig,
  OCRResult,
  OCRProgress,
  PaddleConfig,
} from './types.js';
import { DEFAULT_OCR_CONFIG, OCR_TARGET_CELL_SIZE } from './types.js';
import { recognizeBoard } from './paddle.js';
import { detectBoardRectangle, squarifyRectangle } from './algorithms/index.js';

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

function shareUnit(a: number, b: number): boolean {
  const rowA = Math.floor(a / 9);
  const colA = a % 9;
  const rowB = Math.floor(b / 9);
  const colB = b % 9;
  return (
    rowA === rowB ||
    colA === colB ||
    (Math.floor(rowA / 3) === Math.floor(rowB / 3) &&
      Math.floor(colA / 3) === Math.floor(colB / 3))
  );
}

function removeConflictingDigits(cells: CellRecognition[]): CellRecognition[] {
  const cleaned = cells.map((cell) => ({ ...cell }));
  let changed = true;

  while (changed) {
    changed = false;
    for (let i = 0; i < cleaned.length; i++) {
      const a = cleaned[i];
      if (!a || a.digit === null) continue;
      for (let j = i + 1; j < cleaned.length; j++) {
        const b = cleaned[j];
        if (!b || b.digit === null || a.digit !== b.digit || !shareUnit(i, j)) {
          continue;
        }

        const removeIndex =
          a.confidence < b.confidence ? i : a.confidence > b.confidence ? j : j;
        cleaned[removeIndex] = { digit: null, confidence: 0 };
        changed = true;
        break;
      }
      if (changed) break;
    }
  }

  return cleaned;
}

function computeLegalPencilmarks(cells: CellRecognition[]): string[] {
  const puzzle = cells.map((cell) => cell.digit ?? 0);
  const pencilmarks = new Array(cells.length).fill('');

  for (let i = 0; i < cells.length; i++) {
    if (puzzle[i] !== 0) continue;

    const row = Math.floor(i / 9);
    const col = i % 9;
    const used = new Set<number>();

    for (let c = 0; c < 9; c++) {
      const digit = puzzle[row * 9 + c];
      if (digit) used.add(digit);
    }
    for (let r = 0; r < 9; r++) {
      const digit = puzzle[r * 9 + col];
      if (digit) used.add(digit);
    }

    const startRow = Math.floor(row / 3) * 3;
    const startCol = Math.floor(col / 3) * 3;
    for (let r = startRow; r < startRow + 3; r++) {
      for (let c = startCol; c < startCol + 3; c++) {
        const digit = puzzle[r * 9 + c];
        if (digit) used.add(digit);
      }
    }

    let digits = '';
    for (let digit = 1; digit <= 9; digit++) {
      if (!used.has(digit)) digits += digit.toString();
    }
    pencilmarks[i] = digits;
  }

  return pencilmarks;
}

/**
 * Extract a Sudoku puzzle from an image
 *
 * @param adapter - Platform-specific canvas adapter
 * @param imageSource - Image source (platform-specific)
 * @param paddle - paddle_ocr service connection settings
 * @param config - OCR configuration options
 * @param onProgress - Progress callback
 * @returns OCR result with puzzle string and confidence
 */
export async function extractSudokuFromImage(
  adapter: CanvasAdapter,
  imageSource: unknown,
  paddle: PaddleConfig,
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

  onProgress?.({
    status: 'recognizing',
    progress: 20,
    message: 'Recognizing digits...',
  });

  // Paddle reads the whole cropped board in one pass. Preprocessing and the 81
  // cell crops existed for Tesseract's per-cell pipeline and are not used here:
  // the 243/243 fixture run went through the raw crop.
  const { cells: rawCellResults, pencilmarkCells } = await recognizeBoard(
    adapter,
    croppedCanvas,
    paddle
  );

  const cellResults = removeConflictingDigits(rawCellResults);
  const hasDetectedPencilmarks = pencilmarkCells.some(Boolean);
  const pencilmarkDigits =
    cfg.recognizePencilmarks && hasDetectedPencilmarks
      ? computeLegalPencilmarks(cellResults)
      : new Array(cellResults.length).fill('');

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
