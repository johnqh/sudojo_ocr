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
  medianFilter,
  dilate,
  isCellEmpty,
  parseDigitFromText,
  removeGridLines,
  removeEdgeSpanningLines,
  findConnectedComponents,
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
const GIVEN_DIGIT_HEIGHT_RATIO = 0.45;
/** Minimum confidence for a strong whole-cell OCR digit read in fallback */
const WHOLE_CELL_STRONG_MIN_CONFIDENCE = 50;

/**
 * Whole-cell OCR fallback should be stricter than generic text parsing.
 * Multi-character strings like "79" are evidence of pencilmarks, not a given digit.
 */
function parseSingleDigitCandidate(text: string): number | null {
  const cleanText = text.trim();
  if (cleanText.length !== 1) {
    return null;
  }
  return parseDigitFromText(cleanText);
}

interface WholeCellDigitEvidence {
  digit: number | null;
  confidence: number;
  votes: number;
  observedDigit: number | null;
  observedConfidence: number;
  observedVotes: number;
}

async function collectWholeCellDigitEvidence(
  adapter: CanvasAdapter,
  cell: CanvasLike,
  pp:
    | {
        binarizedCanvas: CanvasLike;
        binarizedData: ImageDataLike;
      }
    | undefined,
  worker: {
    recognize: (
      image: any
    ) => Promise<{ data: { text: string; confidence?: number } }>;
  },
  toTesseractInput: (canvas: CanvasLike) => unknown
): Promise<WholeCellDigitEvidence> {
  const digitVotes = new Map<number, number>();
  const bestConfidenceByDigit = new Map<number, number>();

  const recordDigitVote = (candidate: number | null, conf: number): void => {
    if (candidate === null) return;
    digitVotes.set(candidate, (digitVotes.get(candidate) ?? 0) + 1);
    bestConfidenceByDigit.set(
      candidate,
      Math.max(bestConfidenceByDigit.get(candidate) ?? 0, conf)
    );
  };

  // Attempt 1: raw whole-cell OCR
  try {
    const rawInput = toTesseractInput(addPadding(adapter, cell, 20));
    const { data } = await worker.recognize(rawInput as any);
    recordDigitVote(
      parseSingleDigitCandidate(data.text.trim()),
      data.confidence || 0
    );
  } catch {
    /* failed */
  }

  // Attempt 2: standard binarize
  try {
    const processedCell = processForOCR(adapter, cell);
    const input = toTesseractInput(processedCell);
    const { data } = await worker.recognize(input as any);
    recordDigitVote(
      parseSingleDigitCandidate(data.text.trim()),
      data.confidence || 0
    );

    const dilated = processForOCR(adapter, cell, true);
    const dilInput = toTesseractInput(dilated);
    const dilResult = await worker.recognize(dilInput as any);
    recordDigitVote(
      parseSingleDigitCandidate(dilResult.data.text.trim()),
      dilResult.data.confidence || 0
    );
  } catch {
    /* failed */
  }

  // Attempt 3: adaptive binarize
  if (pp) {
    try {
      const paddedCanvas = addPadding(
        adapter,
        pp.binarizedCanvas,
        OCR_CELL_PADDING
      );
      const input = toTesseractInput(paddedCanvas);
      const { data } = await worker.recognize(input as any);
      recordDigitVote(
        parseSingleDigitCandidate(data.text.trim()),
        data.confidence || 0
      );
    } catch {
      /* failed */
    }
  }

  let bestDigit: number | null = null;
  let bestConfidence = 0;
  let bestVotes = 0;
  let observedDigit: number | null = null;
  let observedConfidence = 0;
  let observedVotes = 0;

  for (const [candidate, votes] of digitVotes.entries()) {
    const candidateConfidence = bestConfidenceByDigit.get(candidate) ?? 0;
    if (
      votes > observedVotes ||
      (votes === observedVotes && candidateConfidence > observedConfidence)
    ) {
      observedDigit = candidate;
      observedConfidence = candidateConfidence;
      observedVotes = votes;
    }
  }

  for (const [candidate, votes] of digitVotes.entries()) {
    const candidateConfidence = bestConfidenceByDigit.get(candidate) ?? 0;
    if (votes >= 2 || candidateConfidence >= WHOLE_CELL_STRONG_MIN_CONFIDENCE) {
      if (
        votes > bestVotes ||
        (votes === bestVotes && candidateConfidence > bestConfidence)
      ) {
        bestDigit = candidate;
        bestConfidence = candidateConfidence;
        bestVotes = votes;
      }
    }
  }

  return {
    digit: bestDigit,
    confidence: bestConfidence,
    votes: bestVotes,
    observedDigit,
    observedConfidence,
    observedVotes,
  };
}

interface InkShapeStats {
  darkRatio: number;
  componentCount: number;
  occupiedSlots: number;
  bboxHeightRatio: number;
  bboxWidthRatio: number;
  largestHeightRatio: number;
  largestWidthRatio: number;
  likelyGiven: boolean;
  likelyPencilmarks: boolean;
}

interface GivenScaleProfile {
  medianDarkRatio: number;
  medianBboxHeightRatio: number;
  medianLargestHeightRatio: number;
}

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
    rawCanvas,
    cellCanvas,
    0,
    0,
    cellCanvas.width,
    cellCanvas.height,
    0,
    0,
    w,
    h
  );

  // Denoise, enhance contrast, binarize.
  let imageData = adapter.getImageData(rawCanvas, 0, 0, w, h);
  imageData = medianFilter(imageData);
  imageData = enhanceContrast(imageData, 1.3);
  imageData = adaptiveBinarize(imageData);
  const gridLineDepth = Math.max(3, Math.floor(w * 0.03));
  imageData = removeGridLines(imageData, gridLineDepth, 3);

  const binarizedCanvas = adapter.createCanvas(w, h);
  adapter.putImageData(binarizedCanvas, imageData, 0, 0);

  return {
    rawCanvas,
    binarizedCanvas,
    binarizedData: imageData,
    width: w,
    height: h,
  };
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

function analyzeInkShape(imageData: ImageDataLike): InkShapeStats {
  const { data, width, height } = imageData;
  const total = width * height;
  let darkCount = 0;
  for (let i = 0; i < total; i++) {
    if ((data[i * 4] ?? 255) < 128) darkCount++;
  }

  const components = findConnectedComponents(imageData, 20);
  if (components.length === 0) {
    return {
      darkRatio: 0,
      componentCount: 0,
      occupiedSlots: 0,
      bboxHeightRatio: 0,
      bboxWidthRatio: 0,
      largestHeightRatio: 0,
      largestWidthRatio: 0,
      likelyGiven: false,
      likelyPencilmarks: false,
    };
  }

  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let largestSize = 0;
  let largestHeightRatio = 0;
  let largestWidthRatio = 0;
  const occupiedSlots = new Set<number>();

  for (const component of components) {
    if (component.minX < minX) minX = component.minX;
    if (component.minY < minY) minY = component.minY;
    if (component.maxX > maxX) maxX = component.maxX;
    if (component.maxY > maxY) maxY = component.maxY;

    const componentWidth = component.maxX - component.minX + 1;
    const componentHeight = component.maxY - component.minY + 1;
    if (component.pixelCount > largestSize) {
      largestSize = component.pixelCount;
      largestHeightRatio = componentHeight / height;
      largestWidthRatio = componentWidth / width;
    }

    const centerX = (component.minX + component.maxX) / 2;
    const centerY = (component.minY + component.maxY) / 2;
    const slotX = Math.min(2, Math.max(0, Math.floor((centerX / width) * 3)));
    const slotY = Math.min(2, Math.max(0, Math.floor((centerY / height) * 3)));
    occupiedSlots.add(slotY * 3 + slotX + 1);
  }

  const bboxHeightRatio = (maxY - minY + 1) / height;
  const bboxWidthRatio = (maxX - minX + 1) / width;
  const darkRatio = darkCount / total;
  const likelyGiven =
    occupiedSlots.size <= 2 &&
    bboxHeightRatio >= 0.5 &&
    largestHeightRatio >= 0.42 &&
    darkRatio >= 0.02;
  const likelyPencilmarks =
    occupiedSlots.size >= 2 &&
    largestHeightRatio < 0.55 &&
    bboxHeightRatio < 0.75;

  return {
    darkRatio,
    componentCount: components.length,
    occupiedSlots: occupiedSlots.size,
    bboxHeightRatio,
    bboxWidthRatio,
    largestHeightRatio,
    largestWidthRatio,
    likelyGiven,
    likelyPencilmarks,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function buildGivenScaleProfile(
  cells: CellRecognition[],
  inkShapes: InkShapeStats[]
): GivenScaleProfile | null {
  const darkRatios: number[] = [];
  const bboxHeightRatios: number[] = [];
  const largestHeightRatios: number[] = [];

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const inkShape = inkShapes[i];
    if (!cell || cell.digit === null || !inkShape) continue;
    if (cell.confidence < 35) continue;
    darkRatios.push(inkShape.darkRatio);
    bboxHeightRatios.push(inkShape.bboxHeightRatio);
    largestHeightRatios.push(inkShape.largestHeightRatio);
  }

  if (darkRatios.length < 8) {
    return null;
  }

  return {
    medianDarkRatio: median(darkRatios),
    medianBboxHeightRatio: median(bboxHeightRatios),
    medianLargestHeightRatio: median(largestHeightRatios),
  };
}

function matchesGivenScale(
  inkShape: InkShapeStats,
  profile: GivenScaleProfile | null
): boolean {
  if (!profile) return false;

  return (
    Math.abs(inkShape.largestHeightRatio - profile.medianLargestHeightRatio) <=
      0.12 &&
    Math.abs(inkShape.bboxHeightRatio - profile.medianBboxHeightRatio) <=
      0.14 &&
    inkShape.darkRatio >= profile.medianDarkRatio * 0.55 &&
    inkShape.occupiedSlots <= 3
  );
}

/**
 * Check if a sub-cell region has enough dark pixels to warrant OCR.
 */
function subCellHasInk(
  imageData: ImageDataLike,
  sx: number,
  sy: number,
  sw: number,
  sh: number
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
  worker: {
    setParameters: (p: any) => Promise<void>;
    recognize: (
      image: any
    ) => Promise<{ data: { text: string; confidence?: number } }>;
  },
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
        subCanvas,
        rawCanvas,
        sx,
        sy,
        subW,
        subH,
        0,
        0,
        scaledW,
        scaledH
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
  classificationCells: CanvasLike[],
  rawCells: CanvasLike[],
  tesseract: TesseractModule,
  onProgress?: (progress: number) => void
): Promise<{ cells: CellRecognition[]; pencilmarkDigits: string[] }> {
  const results: CellRecognition[] = new Array(classificationCells.length);
  const pencilmarkDigits: string[] = new Array(classificationCells.length).fill(
    ''
  );
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
  }> = new Array(classificationCells.length);
  const inkShapes: InkShapeStats[] = new Array(classificationCells.length);

  const worker = await tesseract.createWorker('eng', 1, {
    logger: () => {},
  });

  // === Pass 1: SINGLE_BLOCK classification ===
  // SINGLE_BLOCK reads digits more accurately than SPARSE_TEXT (e.g., 8 vs 3)
  // and still detects scattered pencilmark characters in cells
  await worker.setParameters({
    tessedit_pageseg_mode: tesseract.PSM.SINGLE_BLOCK,
    tessedit_char_whitelist: '123456789',
  });

  for (let i = 0; i < classificationCells.length; i++) {
    const cell = classificationCells[i];
    const rawCell = rawCells[i];
    if (!cell || !rawCell) continue;

    const pp = preprocessPencilmarkCell(adapter, rawCell);
    preprocessed[i] = pp;
    inkShapes[i] = analyzeInkShape(pp.binarizedData);

    // Empty check — use both binarized and raw checks.
    // Only skip if BOTH agree the cell is empty (adaptive binarize can
    // fail on colored images, producing false empties).
    const rawImageData = adapter.getImageData(
      rawCell,
      0,
      0,
      rawCell.width,
      rawCell.height
    );
    if (isBinarizedCellEmpty(pp.binarizedData) && isCellEmpty(rawImageData)) {
      results[i] = { digit: null, confidence: 100 };
      onProgress?.(((i + 1) / classificationCells.length) * 50);
      continue;
    }

    // Run SPARSE_TEXT on binarized+padded cell
    const paddedCanvas = addPadding(
      adapter,
      pp.binarizedCanvas,
      OCR_CELL_PADDING
    );
    const tesseractInput = adapter.toTesseractInput(paddedCanvas);
    const { data } = await worker.recognize(tesseractInput as any);
    const symbols: TesseractSymbol[] = (
      (data.symbols as TesseractSymbol[] | undefined) ?? []
    ).filter(
      (s: TesseractSymbol) => s.text.length === 1 && /^[1-9]$/.test(s.text)
    );

    if (symbols.length === 0) {
      needsFallback.push(i);
      onProgress?.(((i + 1) / classificationCells.length) * 50);
      continue;
    }

    // Classify by bbox height
    const largeSymbols = symbols.filter((s) => {
      const symbolHeight = s.bbox.y1 - s.bbox.y0;
      return symbolHeight > pp.height * GIVEN_DIGIT_HEIGHT_RATIO;
    });

    if (largeSymbols.length > 0 && symbols.length <= 2) {
      // Large symbol + few total symbols → confirmed digit
      const best = largeSymbols.reduce((a, b) =>
        a.confidence > b.confidence ? a : b
      );
      results[i] = {
        digit: parseInt(best.text, 10),
        confidence: best.confidence,
      };
    } else if (largeSymbols.length > 0) {
      // Large symbol but many total symbols → pencilmarks misread as digit
      sparseTextFoundPencilmarks = true;
      needsSubCellOCR.push(i);
    } else {
      // Check if small symbols map to multiple distinct grid positions.
      // Pencilmarks occupy different 3x3 slots; digit fragments cluster together.
      const slotW = pp.width / 3;
      const slotH = pp.height / 3;
      const pad = OCR_CELL_PADDING;
      const uniqueSlots = new Set<number>();
      for (const s of symbols) {
        const cx = (s.bbox.x0 + s.bbox.x1) / 2 - pad;
        const cy = (s.bbox.y0 + s.bbox.y1) / 2 - pad;
        const gc = Math.min(2, Math.max(0, Math.floor(cx / slotW)));
        const gr = Math.min(2, Math.max(0, Math.floor(cy / slotH)));
        uniqueSlots.add(gr * 3 + gc + 1);
      }

      if (uniqueSlots.size >= 2) {
        // Multiple grid positions → pencilmarks
        sparseTextFoundPencilmarks = true;
        needsSubCellOCR.push(i);
      } else {
        // Single grid position → likely a digit fragment → fallback
        needsFallback.push(i);
      }
    }

    onProgress?.(((i + 1) / classificationCells.length) * 50);
  }

  // === Pass 2: SINGLE_CHAR fallback for cells SPARSE_TEXT missed ===
  if (needsFallback.length > 0) {
    await worker.setParameters({
      tessedit_pageseg_mode: tesseract.PSM.SINGLE_CHAR,
      tessedit_char_whitelist: '123456789',
    });

    for (const i of needsFallback) {
      const cell = rawCells[i];
      if (!cell) continue;

      let digit: number | null = null;
      let confidence = 0;
      const evidence = await collectWholeCellDigitEvidence(
        adapter,
        cell,
        preprocessed[i],
        worker,
        (canvas) => adapter.toTesseractInput(canvas)
      );
      digit = evidence.digit;
      confidence = evidence.confidence;

      if (digit !== null) {
        results[i] = { digit, confidence };
      } else if (sparseTextFoundPencilmarks) {
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

  // Final generic verification pass:
  // 1. rescue missed givens using whole-cell consensus
  // 2. demote unsupported digits when sub-cell OCR clearly shows pencilmarks
  const initialGivenScaleProfile = buildGivenScaleProfile(results, inkShapes);
  for (let i = 0; i < results.length; i++) {
    const rawCell = rawCells[i];
    const pp = preprocessed[i];
    const result = results[i];
    const inkShape = inkShapes[i];
    if (!rawCell || !pp || !result || !inkShape) continue;
    const givenLike =
      inkShape.likelyGiven ||
      matchesGivenScale(inkShape, initialGivenScaleProfile);

    await worker.setParameters({
      tessedit_pageseg_mode: tesseract.PSM.SINGLE_CHAR,
      tessedit_char_whitelist: '123456789',
    });

    const evidence = await collectWholeCellDigitEvidence(
      adapter,
      rawCell,
      pp,
      worker,
      (canvas) => adapter.toTesseractInput(canvas)
    );

    if (result.digit === null) {
      if (
        evidence.digit !== null &&
        pencilmarkDigits[i].length === 0 &&
        givenLike &&
        (evidence.confidence >= WHOLE_CELL_STRONG_MIN_CONFIDENCE ||
          evidence.votes >= 3)
      ) {
        results[i] = {
          digit: evidence.digit,
          confidence: evidence.confidence,
        };
        pencilmarkDigits[i] = '';
        continue;
      }
      continue;
    }

    if (
      evidence.digit === result.digit ||
      (result.confidence >= WHOLE_CELL_STRONG_MIN_CONFIDENCE && givenLike)
    ) {
      continue;
    }

    const subDigits = await recognizeSubCellPencilmarks(
      adapter,
      pp.rawCanvas,
      pp.binarizedData,
      pp.width,
      pp.height,
      worker,
      tesseract.PSM,
      (canvas) => adapter.toTesseractInput(canvas)
    );

    if (
      subDigits.length >= 2 &&
      (inkShape.likelyPencilmarks ||
        evidence.observedConfidence < 20 ||
        !givenLike)
    ) {
      results[i] = { digit: null, confidence: 0 };
      pencilmarkDigits[i] = subDigits.join('');
      continue;
    }

    if (
      result.confidence < 35 &&
      evidence.observedConfidence < 15 &&
      inkShape.occupiedSlots >= 2 &&
      inkShape.largestHeightRatio < 0.45 &&
      !givenLike
    ) {
      results[i] = { digit: null, confidence: 0 };
      pencilmarkDigits[i] = subDigits.join('');
    }
  }

  // Screenshot-style digit template matching.
  // Learn per-digit appearance from confident givens on the same board, then
  // use raw normalized correlation to rescue missed digits on screenshot-like
  // boards where typography is consistent across cells.
  const finalGivenScaleProfile = buildGivenScaleProfile(results, inkShapes);
  const templatesByDigit = new Map<number, Float32Array[]>();
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const pp = preprocessed[i];
    const inkShape = inkShapes[i];
    if (!result || result.digit === null || !pp || !inkShape) continue;
    if (
      result.confidence < 35 ||
      (!inkShape.likelyGiven &&
        !matchesGivenScale(inkShape, finalGivenScaleProfile))
    ) {
      continue;
    }

    const template = createInkTemplate(adapter, pp.binarizedData);
    if (!template) continue;
    const templates = templatesByDigit.get(result.digit) ?? [];
    templates.push(template);
    templatesByDigit.set(result.digit, templates);
  }

  const sameDigitScores: number[] = [];
  for (const templates of templatesByDigit.values()) {
    if (templates.length < 2) continue;
    for (let i = 0; i < templates.length; i++) {
      let bestPeerScore = -1;
      for (let j = 0; j < templates.length; j++) {
        if (i === j) continue;
        bestPeerScore = Math.max(
          bestPeerScore,
          rawTemplateSimilarity(templates[i]!, templates[j]!)
        );
      }
      if (bestPeerScore >= 0) sameDigitScores.push(bestPeerScore);
    }
  }

  const boardLooksTemplateFriendly =
    sameDigitScores.length >= 4 &&
    sameDigitScores.reduce((sum, score) => sum + score, 0) /
      sameDigitScores.length >=
      0.35;

  if (templatesByDigit.size > 0 && boardLooksTemplateFriendly) {
    for (let i = 0; i < results.length; i++) {
      const pp = preprocessed[i];
      const result = results[i];
      const inkShape = inkShapes[i];
      if (
        !pp ||
        !result ||
        !inkShape ||
        (!inkShape.likelyGiven &&
          !matchesGivenScale(inkShape, finalGivenScaleProfile))
      ) {
        continue;
      }

      const template = createInkTemplate(adapter, pp.binarizedData);
      if (!template) continue;

      let bestDigit: number | null = null;
      let bestScore = -Infinity;
      let secondBestScore = -Infinity;

      for (const [digit, templates] of templatesByDigit.entries()) {
        let score = -Infinity;
        for (const candidate of templates) {
          score = Math.max(score, rawTemplateSimilarity(template, candidate));
        }
        if (score > bestScore) {
          secondBestScore = bestScore;
          bestScore = score;
          bestDigit = digit;
        } else if (score > secondBestScore) {
          secondBestScore = score;
        }
      }

      if (
        result.digit === null &&
        pencilmarkDigits[i].length === 0 &&
        bestDigit !== null &&
        bestScore >= 0.36 &&
        bestScore - secondBestScore >= 0.05
      ) {
        results[i] = {
          digit: bestDigit,
          confidence: Math.max(35, Math.round(bestScore * 100)),
        };
        continue;
      }

      if (
        result.digit !== null &&
        bestDigit !== result.digit &&
        bestScore >= 0.45 &&
        bestScore - secondBestScore >= 0.1 &&
        result.confidence < WHOLE_CELL_STRONG_MIN_CONFIDENCE
      ) {
        results[i] = { digit: null, confidence: 0 };
      }
    }
  }

  // Fill unprocessed cells
  for (let i = 0; i < classificationCells.length; i++) {
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

function createInkTemplate(
  adapter: CanvasAdapter,
  imageData: ImageDataLike,
  templateSize: number = 24
): Float32Array | null {
  const cleaned = removeEdgeSpanningLines(imageData);
  const components = findConnectedComponents(cleaned, 20);
  if (components.length === 0) {
    return null;
  }

  let minX = cleaned.width;
  let minY = cleaned.height;
  let maxX = 0;
  let maxY = 0;
  for (const component of components) {
    if (component.minX < minX) minX = component.minX;
    if (component.minY < minY) minY = component.minY;
    if (component.maxX > maxX) maxX = component.maxX;
    if (component.maxY > maxY) maxY = component.maxY;
  }

  const cropWidth = maxX - minX + 1;
  const cropHeight = maxY - minY + 1;
  if (cropWidth <= 2 || cropHeight <= 2) {
    return null;
  }

  const croppedData = new Uint8ClampedArray(cropWidth * cropHeight * 4);
  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      const srcIdx = ((minY + y) * cleaned.width + (minX + x)) * 4;
      const dstIdx = (y * cropWidth + x) * 4;
      croppedData[dstIdx] = cleaned.data[srcIdx] ?? 255;
      croppedData[dstIdx + 1] = cleaned.data[srcIdx + 1] ?? 255;
      croppedData[dstIdx + 2] = cleaned.data[srcIdx + 2] ?? 255;
      croppedData[dstIdx + 3] = cleaned.data[srcIdx + 3] ?? 255;
    }
  }

  const cropped = adapter.createCanvas(cropWidth, cropHeight);
  adapter.putImageData(
    cropped,
    { data: croppedData, width: cropWidth, height: cropHeight },
    0,
    0
  );

  const resized = adapter.createCanvas(templateSize, templateSize);
  adapter.fillRect(resized, 'white', 0, 0, templateSize, templateSize);
  const pad = 2;
  adapter.drawImage(
    resized,
    cropped,
    0,
    0,
    cropWidth,
    cropHeight,
    pad,
    pad,
    templateSize - pad * 2,
    templateSize - pad * 2
  );

  const templateData = adapter.getImageData(
    resized,
    0,
    0,
    templateSize,
    templateSize
  );
  const values = new Float32Array(templateSize * templateSize);
  let sum = 0;

  for (let i = 0; i < templateSize * templateSize; i++) {
    const idx = i * 4;
    const gray =
      0.299 * (templateData.data[idx] ?? 255) +
      0.587 * (templateData.data[idx + 1] ?? 255) +
      0.114 * (templateData.data[idx + 2] ?? 255);
    values[i] = gray;
    sum += gray;
  }

  const mean = sum / values.length;
  let variance = 0;
  for (let i = 0; i < values.length; i++) {
    const centered = values[i] - mean;
    values[i] = centered;
    variance += centered * centered;
  }

  const stdDev = Math.sqrt(variance / values.length) || 1;
  for (let i = 0; i < values.length; i++) {
    values[i] /= stdDev;
  }

  return values;
}

function rawTemplateSimilarity(a: Float32Array, b: Float32Array): number {
  const total = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < total; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot / total;
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
  onProgress?: (progress: number) => void,
  rawCells?: CanvasLike[]
): Promise<{ cells: CellRecognition[]; pencilmarkDigits: string[] }> {
  // Pencilmark mode: use SPARSE_TEXT with bounding box classification
  if (recognizePencilmarks) {
    return recognizeCellsPencilmark(
      adapter,
      cells,
      rawCells ?? cells,
      tesseract,
      onProgress
    );
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
  const rawCells = cfg.recognizePencilmarks
    ? extractCells(adapter, croppedCanvas, cellMargin)
    : cells;

  onProgress?.({
    status: 'recognizing',
    progress: 20,
    message: 'Recognizing digits...',
  });

  // Run OCR
  const { cells: rawCellResults, pencilmarkDigits: ocrPencilmarkDigits } =
    await recognizeCells(
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
      },
      rawCells
    );
  const cellResults = removeConflictingDigits(rawCellResults);
  const hasDetectedPencilmarks = ocrPencilmarkDigits.some(
    (digits) => digits.length > 0
  );
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
