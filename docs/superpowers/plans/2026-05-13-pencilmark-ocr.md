# Pencilmark OCR Recognition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Achieve 95%+ accuracy pencilmark recognition by replacing position-based ink detection with Tesseract SPARSE_TEXT OCR and bounding-box-driven cell classification.

**Architecture:** Run Tesseract with PSM.SPARSE_TEXT on each preprocessed cell. Classify symbols as given digits (bbox height > 40% of cell) or pencilmarks (small bbox, mapped to 3x3 grid position). Preprocessing pipeline: upscale -> enhance contrast -> adaptive binarize (Otsu) -> remove grid lines.

**Tech Stack:** TypeScript, Tesseract.js (PSM.SPARSE_TEXT, data.symbols with bbox), Vitest, @napi-rs/canvas (Node adapter for validation)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/types.ts` | Modify | Add `TesseractSymbolBbox`, `TesseractSymbol` interfaces; extend `TesseractWorker.recognize()` return type; add `SPARSE_TEXT` to `TesseractModule.PSM`; add `OCR_PENCILMARK_TARGET_CELL_SIZE` constant |
| `src/algorithms/imageProcessing.ts` | Modify | Add `adaptiveBinarize()` function (Otsu's method) |
| `src/algorithms/imageProcessing.test.ts` | Modify | Add tests for `adaptiveBinarize()` |
| `src/algorithms/index.ts` | Modify | Export `adaptiveBinarize` |
| `src/index.ts` | Modify | Export `adaptiveBinarize` |
| `src/ocr.ts` | Modify | Add `preprocessPencilmarkCell()`, `recognizeCellsPencilmark()`, update `recognizeCells()` to branch |
| `tests/validate-pencilmarks.ts` | Create | Validation script — runs pipeline on 3 sample images, writes JSON results |

---

### Task 1: Extend Tesseract Types

**Files:**
- Modify: `src/types.ts:58-63` (add constant), `src/types.ts:154-181` (extend interfaces)

- [ ] **Step 1: Add pencilmark target cell size constant**

In `src/types.ts`, after the `OCR_PENCILMARK_CELL_MARGIN` constant (line 63), add:

```typescript
/** Target minimum cell dimension for pencilmark OCR (px) — larger than standard for small text */
export const OCR_PENCILMARK_TARGET_CELL_SIZE = 200;
```

- [ ] **Step 2: Add TesseractSymbolBbox and TesseractSymbol interfaces**

In `src/types.ts`, before the `TesseractModule` interface (line 158), add:

```typescript
/** Bounding box for a recognized Tesseract symbol */
export interface TesseractSymbolBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A single recognized character with position and confidence */
export interface TesseractSymbol {
  text: string;
  confidence: number;
  bbox: TesseractSymbolBbox;
}
```

- [ ] **Step 3: Add SPARSE_TEXT to TesseractModule.PSM**

In `src/types.ts`, change the `PSM` property in `TesseractModule` from:

```typescript
  PSM: {
    SINGLE_CHAR: number;
  };
```

to:

```typescript
  PSM: {
    SINGLE_CHAR: number;
    SPARSE_TEXT: number;
  };
```

- [ ] **Step 4: Extend TesseractWorker.recognize() return type**

In `src/types.ts`, change the `recognize` method in `TesseractWorker` from:

```typescript
  recognize: (image: any) => Promise<{
    data: {
      text: string;
      confidence?: number;
    };
  }>;
```

to:

```typescript
  recognize: (image: any) => Promise<{
    data: {
      text: string;
      confidence?: number;
      symbols?: TesseractSymbol[];
    };
  }>;
```

- [ ] **Step 5: Export new types from index.ts**

In `src/index.ts`, add `TesseractSymbolBbox` and `TesseractSymbol` to the type exports:

```typescript
export type {
  OCRProgress,
  OCRResult,
  OCRConfig,
  Rectangle,
  CanvasAdapter,
  CanvasLike,
  ImageLike,
  ImageDataLike,
  TesseractModule,
  TesseractWorker,
  TesseractSymbolBbox,
  TesseractSymbol,
} from './types.js';
```

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: PASS — no type errors (the new types are additive, existing code is unaffected)

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/index.ts
git commit -m "feat: extend Tesseract types with symbol bbox and SPARSE_TEXT PSM"
```

---

### Task 2: Add Adaptive Binarization (Otsu's Method)

**Files:**
- Modify: `src/algorithms/imageProcessing.ts` (add function after `binarize`)
- Modify: `src/algorithms/imageProcessing.test.ts` (add tests)
- Modify: `src/algorithms/index.ts` (add export)
- Modify: `src/index.ts` (add export)

- [ ] **Step 1: Write failing tests for adaptiveBinarize**

In `src/algorithms/imageProcessing.test.ts`, add a new `describe` block at the end:

```typescript
describe('adaptiveBinarize', () => {
  it('should binarize a bimodal image into black and white', () => {
    // 10x10 image: left half dark (50), right half bright (200)
    const img = createTestImageData(10, 10);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        const val = x < 5 ? 50 : 200;
        setPixel(img, x, y, val, val, val);
      }
    }
    const result = adaptiveBinarize(img);
    expect(result.width).toBe(10);
    expect(result.height).toBe(10);

    // Left half should be black (0), right half white (255)
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        const idx = (y * 10 + x) * 4;
        if (x < 5) {
          expect(result.data[idx]).toBe(0);
        } else {
          expect(result.data[idx]).toBe(255);
        }
      }
    }
  });

  it('should treat uniform white image as all white', () => {
    const img = createTestImageData(10, 10);
    // Default is all white (255)
    const result = adaptiveBinarize(img);
    for (let i = 0; i < result.data.length; i += 4) {
      expect(result.data[i]).toBe(255);
    }
  });

  it('should treat uniform dark image as all black', () => {
    const img = createTestImageData(10, 10, { r: 30, g: 30, b: 30, a: 255 });
    const result = adaptiveBinarize(img);
    for (let i = 0; i < result.data.length; i += 4) {
      expect(result.data[i]).toBe(0);
    }
  });

  it('should preserve alpha channel', () => {
    const img = createTestImageData(4, 4);
    // Set some pixels with specific alpha
    const idx = 0;
    img.data[idx + 3] = 128;
    const result = adaptiveBinarize(img);
    expect(result.data[idx + 3]).toBe(128);
  });

  it('should handle colored input (purple pencilmarks on white)', () => {
    // Simulate purple pencilmark: RGB(128, 0, 128) on white
    const img = createTestImageData(10, 10);
    // Draw a purple mark in center
    for (let y = 3; y < 7; y++) {
      for (let x = 3; x < 7; x++) {
        setPixel(img, x, y, 128, 0, 128);
      }
    }
    const result = adaptiveBinarize(img);
    // Purple mark should be dark (0), background should be white (255)
    expect(result.data[(5 * 10 + 5) * 4]).toBe(0); // center of mark
    expect(result.data[0]).toBe(255); // top-left corner (background)
  });
});
```

Also add the import for `adaptiveBinarize` at the top of the test file:

```typescript
import {
  // ... existing imports ...
  adaptiveBinarize,
} from './imageProcessing.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- src/algorithms/imageProcessing.test.ts`
Expected: FAIL — `adaptiveBinarize` is not exported

- [ ] **Step 3: Implement adaptiveBinarize using Otsu's method**

In `src/algorithms/imageProcessing.ts`, add after the `binarize` function (after line 216):

```typescript
/**
 * Adaptive binarization using Otsu's method.
 * Automatically computes the optimal threshold to separate foreground (ink)
 * from background by maximizing between-class variance of the grayscale histogram.
 * Better than fixed-threshold binarization for images with varying contrast,
 * colored ink (purple pencilmarks), or tinted backgrounds (blue shading).
 * @param imageData - Source RGBA image data
 * @returns Binarized ImageDataLike (black ink on white background)
 */
export function adaptiveBinarize(imageData: ImageDataLike): ImageDataLike {
  const { data, width, height } = imageData;
  const numPixels = width * height;
  const newData = new Uint8ClampedArray(data.length);

  // Convert to grayscale and build histogram
  const gray = new Uint8Array(numPixels);
  const histogram = new Uint32Array(256);

  for (let i = 0; i < numPixels; i++) {
    const idx = i * 4;
    const g = Math.floor(
      0.299 * safeGet(data, idx) +
        0.587 * safeGet(data, idx + 1) +
        0.114 * safeGet(data, idx + 2)
    );
    gray[i] = g;
    histogram[g]++;
  }

  // Otsu's method: find threshold maximizing between-class variance
  let totalSum = 0;
  for (let i = 0; i < 256; i++) {
    totalSum += i * histogram[i];
  }

  let bestThreshold = 128;
  let bestVariance = 0;
  let w0 = 0;
  let sum0 = 0;

  for (let t = 0; t < 256; t++) {
    w0 += histogram[t] ?? 0;
    if (w0 === 0) continue;
    const w1 = numPixels - w0;
    if (w1 === 0) break;

    sum0 += t * (histogram[t] ?? 0);
    const mean0 = sum0 / w0;
    const mean1 = (totalSum - sum0) / w1;
    const variance = w0 * w1 * (mean0 - mean1) * (mean0 - mean1);

    if (variance > bestVariance) {
      bestVariance = variance;
      bestThreshold = t;
    }
  }

  // Binarize: pixels above threshold -> white, below -> black
  for (let i = 0; i < numPixels; i++) {
    const idx = i * 4;
    const val = (gray[i] ?? 0) >= bestThreshold ? 255 : 0;
    newData[idx] = val;
    newData[idx + 1] = val;
    newData[idx + 2] = val;
    newData[idx + 3] = safeGet(data, idx + 3);
  }

  return { data: newData, width, height };
}
```

- [ ] **Step 4: Export adaptiveBinarize from algorithms/index.ts**

In `src/algorithms/index.ts`, add `adaptiveBinarize` to the imageProcessing exports:

```typescript
export {
  toGrayscale,
  gaussianBlur,
  cannyEdgeDetection,
  enhanceContrast,
  binarize,
  adaptiveBinarize,
  dilate,
  preprocessForOCR,
  isCellEmpty,
  removeGridLines,
} from './imageProcessing.js';
```

- [ ] **Step 5: Export adaptiveBinarize from src/index.ts**

In `src/index.ts`, add `adaptiveBinarize` to the algorithm exports:

```typescript
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun run test -- src/algorithms/imageProcessing.test.ts`
Expected: PASS — all existing tests plus new adaptiveBinarize tests

- [ ] **Step 7: Commit**

```bash
git add src/algorithms/imageProcessing.ts src/algorithms/imageProcessing.test.ts src/algorithms/index.ts src/index.ts
git commit -m "feat: add adaptiveBinarize using Otsu's method for pencilmark preprocessing"
```

---

### Task 3: Implement Pencilmark OCR Pipeline

**Files:**
- Modify: `src/ocr.ts:1-33` (imports), `src/ocr.ts:131-161` (new preprocessing), `src/ocr.ts:217-327` (new recognition function + update existing)

- [ ] **Step 1: Update imports in ocr.ts**

In `src/ocr.ts`, update the type imports to include new types:

```typescript
import type {
  CanvasAdapter,
  CanvasLike,
  OCRConfig,
  OCRResult,
  OCRProgress,
  TesseractModule,
  TesseractSymbol,
} from './types.js';
```

Update the value imports to include new constants:

```typescript
import {
  DEFAULT_OCR_CONFIG,
  OCR_TARGET_CELL_SIZE,
  OCR_CELL_PADDING,
  OCR_CONTRAST_FACTOR,
  OCR_PENCILMARK_CELL_MARGIN,
  OCR_PENCILMARK_TARGET_CELL_SIZE,
} from './types.js';
```

Update the algorithm imports to include `adaptiveBinarize`:

```typescript
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
} from './algorithms/index.js';
```

Remove imports that are no longer needed in the pencilmark path (but still used elsewhere — keep them):
- `classifyCellContent` — remove from import (only used in pencilmark path, being replaced)
- `isPencilmarkPresent` — remove from import (only used in pencilmark path, being replaced)

- [ ] **Step 2: Add preprocessPencilmarkCell function**

In `src/ocr.ts`, after the `processForOCR` function (after line 161), add:

```typescript
/**
 * Preprocess a cell for pencilmark OCR.
 * Upscales, enhances contrast, binarizes adaptively (Otsu), removes grid lines,
 * and adds padding. Returns the processed canvas plus inner dimensions
 * (before padding) needed for bounding box coordinate mapping.
 */
function preprocessPencilmarkCell(
  adapter: CanvasAdapter,
  cellCanvas: CanvasLike
): { canvas: CanvasLike; innerWidth: number; innerHeight: number; padding: number } {
  // Upscale so shortest dimension >= OCR_PENCILMARK_TARGET_CELL_SIZE
  const scale = Math.max(
    1,
    OCR_PENCILMARK_TARGET_CELL_SIZE / Math.min(cellCanvas.width, cellCanvas.height)
  );
  const scaledWidth = Math.round(cellCanvas.width * scale);
  const scaledHeight = Math.round(cellCanvas.height * scale);

  const scaledCanvas = adapter.createCanvas(scaledWidth, scaledHeight);
  adapter.fillRect(scaledCanvas, 'white', 0, 0, scaledWidth, scaledHeight);
  adapter.drawImage(
    scaledCanvas,
    cellCanvas,
    0, 0, cellCanvas.width, cellCanvas.height,
    0, 0, scaledWidth, scaledHeight
  );

  // Enhance contrast -> adaptive binarize -> remove grid lines
  let imageData = adapter.getImageData(scaledCanvas, 0, 0, scaledWidth, scaledHeight);
  imageData = enhanceContrast(imageData, OCR_CONTRAST_FACTOR);
  imageData = adaptiveBinarize(imageData);
  imageData = removeGridLines(imageData, 3, 3);

  const processedCanvas = adapter.createCanvas(scaledWidth, scaledHeight);
  adapter.putImageData(processedCanvas, imageData, 0, 0);

  // Add padding for Tesseract
  const padding = OCR_CELL_PADDING;
  const paddedCanvas = addPadding(adapter, processedCanvas, padding);

  return { canvas: paddedCanvas, innerWidth: scaledWidth, innerHeight: scaledHeight, padding };
}
```

- [ ] **Step 3: Add mapSymbolsToGridPositions helper**

In `src/ocr.ts`, after `preprocessPencilmarkCell`, add:

```typescript
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
```

- [ ] **Step 4: Add recognizeCellsPencilmark function**

In `src/ocr.ts`, after `mapSymbolsToGridPositions`, add:

```typescript
/** Height ratio threshold: symbols taller than this fraction of cell height are given digits */
const GIVEN_DIGIT_HEIGHT_RATIO = 0.4;

/**
 * Recognize cells using Tesseract SPARSE_TEXT mode with bounding box analysis.
 * Classifies each cell as empty, given digit, or pencilmarks based on
 * recognized symbol bounding box sizes.
 */
async function recognizeCellsPencilmark(
  adapter: CanvasAdapter,
  cells: CanvasLike[],
  tesseract: TesseractModule,
  onProgress?: (progress: number) => void
): Promise<{ cells: CellRecognition[]; pencilmarkDigits: string[] }> {
  const results: CellRecognition[] = [];
  const pencilmarkDigits: string[] = new Array(cells.length).fill('');

  const worker = await tesseract.createWorker('eng', 1, {
    logger: () => {},
  });

  await worker.setParameters({
    tessedit_pageseg_mode: tesseract.PSM.SPARSE_TEXT,
    tessedit_char_whitelist: '123456789',
  });

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (!cell) continue;

    // Preprocess cell for pencilmark OCR
    const { canvas, innerWidth, innerHeight, padding } =
      preprocessPencilmarkCell(adapter, cell);

    const tesseractInput = adapter.toTesseractInput(canvas);
    const { data } = await worker.recognize(tesseractInput as any);
    const symbols: TesseractSymbol[] = (data.symbols ?? []).filter(
      (s: TesseractSymbol) => s.text.length === 1 && /^[1-9]$/.test(s.text)
    );

    if (symbols.length === 0) {
      // Empty cell
      results.push({ digit: null, confidence: 100 });
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
      results.push({ digit, confidence: best.confidence });
    } else {
      // Pencilmarks — map symbol positions to 3x3 grid
      const digits = mapSymbolsToGridPositions(
        symbols,
        innerWidth,
        innerHeight,
        padding
      );
      pencilmarkDigits[i] = digits.join('');
      results.push({ digit: null, confidence: 0 });
    }

    onProgress?.(((i + 1) / cells.length) * 100);
  }

  await worker.terminate();
  return { cells: results, pencilmarkDigits };
}
```

- [ ] **Step 5: Update recognizeCells to branch to new function**

In `src/ocr.ts`, replace the `recognizeCells` function (lines 217-327) with:

```typescript
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
```

- [ ] **Step 6: Clean up unused imports**

In `src/ocr.ts`, remove `classifyCellContent` and `isPencilmarkPresent` from the import block (line 29-31), since they are no longer called. The old `detectPencilmarks` function (lines 170-205) can also be removed since it's a local function no longer called.

Updated algorithm imports:

```typescript
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
} from './algorithms/index.js';
```

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 8: Run existing tests**

Run: `bun run test`
Expected: All 95 tests PASS. The non-pencilmark path is unchanged. The existing pencilmark tests (`extractSudokuFromImage with pencilmarks`) may change results since the algorithm changed — that's expected and fine; these tests have loose thresholds (>=50%) which should still pass.

- [ ] **Step 9: Commit**

```bash
git add src/ocr.ts
git commit -m "feat: implement pencilmark OCR using SPARSE_TEXT with bounding box classification"
```

---

### Task 4: Write Validation Script

**Files:**
- Create: `tests/validate-pencilmarks.ts`

- [ ] **Step 1: Create the validation script**

Create `tests/validate-pencilmarks.ts`:

```typescript
/**
 * Validation script for pencilmark OCR.
 * Runs the pipeline on sample images and writes JSON results for manual comparison.
 *
 * Usage: bun run tests/validate-pencilmarks.ts
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Tesseract from 'tesseract.js';
import { createNodeAdapter } from '../src/adapters/node.js';
import { extractSudokuFromImage } from '../src/ocr.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SAMPLES = [
  { name: 'pencil_marks_sample', file: 'pencil_marks_sample.gif' },
  { name: 'pencilmarks-full', file: 'pencilmarks-full.png' },
  { name: 'lvc39h9c6ra81', file: 'lvc39h9c6ra81.jpg' },
];

async function main() {
  const adapter = await createNodeAdapter();

  for (const sample of SAMPLES) {
    const imagePath = path.resolve(__dirname, sample.file);
    console.log(`\nProcessing ${sample.file}...`);

    const result = await extractSudokuFromImage(adapter, imagePath, Tesseract, {
      recognizePencilmarks: true,
    });

    const pencilmarkEntries = result.board.pencilmark.numbers.split(',');

    // Build per-cell detail array
    const cells = [];
    for (let i = 0; i < 81; i++) {
      const row = Math.floor(i / 9);
      const col = i % 9;
      const digit = result.board.original[i];
      const pm = pencilmarkEntries[i] ?? '';
      cells.push({
        index: i,
        row,
        col,
        digit: digit !== '0' ? parseInt(digit, 10) : null,
        pencilmarks: pm,
      });
    }

    const output = {
      image: sample.file,
      puzzle: result.board.original,
      pencilmarks: pencilmarkEntries,
      digitCount: result.digitCount,
      confidence: Math.round(result.confidence * 100) / 100,
      cells,
    };

    const outPath = path.resolve(__dirname, `${sample.name}_results.json`);
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
    console.log(`  -> wrote ${outPath}`);
    console.log(`  Digits: ${result.digitCount}, Confidence: ${output.confidence}`);
    console.log(`  Puzzle: ${result.board.original}`);
    console.log(`  Pencilmark cells: ${pencilmarkEntries.filter((e) => e.length > 0).length}`);
  }

  console.log('\nDone. Check JSON files in tests/ folder.');
}

main().catch((err) => {
  console.error('Validation failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the validation script**

Run: `bun run tests/validate-pencilmarks.ts`
Expected: Processes all 3 images, writes `pencil_marks_sample_results.json`, `pencilmarks-full_results.json`, `lvc39h9c6ra81_results.json` to the `tests/` folder. Console output shows per-image stats.

- [ ] **Step 3: Commit**

```bash
git add tests/validate-pencilmarks.ts
git commit -m "feat: add pencilmark validation script for manual accuracy comparison"
```

---

### Task 5: Run Full Verification

**Files:** None (verification only)

- [ ] **Step 1: Run all tests**

Run: `bun run test`
Expected: All tests PASS (95 existing tests). If any pencilmark tests fail due to changed thresholds, note the specific failures for investigation but do not modify tests yet.

- [ ] **Step 2: Run typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS — no type errors, no lint violations

- [ ] **Step 3: Run validation script and review output**

Run: `bun run tests/validate-pencilmarks.ts`
Expected: 3 JSON files written. Review them manually against the sample images:
- Check that given digits are correctly recognized
- Check that pencilmark cells have plausible digit sets
- Note any obvious errors for tuning

- [ ] **Step 4: Commit JSON results for user review**

```bash
git add tests/*_results.json
git commit -m "chore: add pencilmark validation results for review"
```
