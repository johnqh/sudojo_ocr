# Pencilmark OCR Recognition — Design Spec

## Goal

Achieve 95%+ accuracy for recognizing Sudoku pencilmarks from images, supporting varied image types (black/purple/colored pencilmarks, shaded backgrounds, different resolutions). Uses Tesseract OCR with bounding box analysis instead of pure ink-detection heuristics.

## Approach: Full-Cell OCR with Spatial Mapping (Approach C)

Run Tesseract on each cell using `PSM.SPARSE_TEXT` mode, classify symbols as given digits vs. pencilmarks based on bounding box size, and map pencilmark positions to the 3x3 grid.

## Cell Classification via Bounding Box Size

Instead of the current connected-component heuristic (`classifyCellContent()`), classification is driven by Tesseract's own bounding boxes:

1. Preprocess cell (upscale, enhance contrast, adaptive binarize, remove grid lines)
2. Run Tesseract with `PSM.SPARSE_TEXT` on the full cell, getting `data.symbols`
3. Classify by symbol bbox height relative to cell height:
   - Any symbol bbox height **> 40%** of cell → **given digit** (take highest-confidence large symbol)
   - All symbol bbox heights **<= 40%** → **pencilmarks** (map each to 3x3 grid)
   - No symbols recognized → **empty**

### Tesseract Configuration

- `tessedit_pageseg_mode`: `PSM.SPARSE_TEXT` (mode 11) — designed for scattered text
- `tessedit_char_whitelist`: `'123456789'` — only recognize valid Sudoku digits
- Each symbol in `data.symbols` is an individual character with its own `bbox: { x0, y0, x1, y1 }`, `text`, and `confidence`
- No need for `parseDigitFromText()` corrections since Tesseract is constrained to `1-9`

## Pencilmark Position Mapping

For cells classified as pencilmarks (all symbols have small bounding boxes):

1. Map each symbol's bounding box center to the 3x3 grid:
   - Center: `cx = (x0 + x1) / 2`, `cy = (y0 + y1) / 2`
   - Grid column: `Math.floor(cx / (cellWidth / 3))` → 0, 1, 2
   - Grid row: `Math.floor(cy / (cellHeight / 3))` → 0, 1, 2
   - Expected digit: `row * 3 + col + 1` → 1-9
2. Position validation — pencilmarks are always at their fixed position, so position is ground truth:
   - **Match** (OCR "3" in top-right = position 3) → include with high confidence
   - **Mismatch** (OCR "8" in top-right = position 3) → trust position, record as digit 3
   - **Duplicate** (two symbols map to same slot) → take the one closer to slot center
3. Output: sorted array of detected digits per cell (e.g., `[1, 3, 7]`)

## Preprocessing Pipeline

Per-cell pipeline: **upscale → enhance contrast → adaptive binarize → remove grid lines**

### Upscaling

Pencilmark digits can be 10-15px in source. Upscale each cell so the shortest dimension is at least 200px (2x `OCR_TARGET_CELL_SIZE`). Larger input gives Tesseract more to work with.

### Adaptive Binarization

The current `binarize()` uses a global luminance threshold which fails on:
- `pencilmarks-full.png` — purple pencilmarks on white (low contrast)
- `lvc39h9c6ra81.jpg` — blue background shading in bottom rows

Replace with per-cell adaptive binarization: compute threshold from each cell's own pixel distribution.

### Grid Line Removal

Keep existing `removeGridLines()` with pencilmark-tuned parameters (depth=3, minBorderRun=3). Minimal cell margin (`OCR_PENCILMARK_CELL_MARGIN = 0.03`) already in place.

### Contrast Enhancement

Apply `enhanceContrast()` before binarization to boost faint pencilmarks (e.g., purple in `pencilmarks-full.png`).

## Overall Pipeline Flow

### When `recognizePencilmarks` is enabled:

1. Load image, detect board, crop, preprocess (unchanged)
2. Extract cells with minimal margin (`OCR_PENCILMARK_CELL_MARGIN`)
3. Create one Tesseract worker with `PSM.SPARSE_TEXT` and `tessedit_char_whitelist: '123456789'`
4. For each cell:
   - Preprocess: upscale → enhance contrast → adaptive binarize → remove grid lines
   - Run `worker.recognize()` → get `data.symbols`
   - If no symbols → **empty** (digit=0, no pencilmarks)
   - If any symbol bbox height > 40% of cell → **given digit** (highest-confidence large symbol)
   - Otherwise → **pencilmarks** (map symbol centers to 3x3 grid positions)
5. Build result: `board.original` from given digits, `board.pencilmark.numbers` from pencilmark data

### When `recognizePencilmarks` is disabled (default):

Existing pipeline unchanged — `SINGLE_CHAR` mode, `isCellEmpty()`, etc.

## Code Changes

### Modified files:
- **`src/types.ts`** — extend `TesseractWorker.recognize()` return type to include `symbols` with bounding boxes
- **`src/ocr.ts`** — new pencilmark recognition code path in `recognizeCells()`:
  - Uses `SPARSE_TEXT` PSM mode
  - Classifies cells by symbol bounding box height
  - Maps pencilmark symbol positions to 3x3 grid
  - Replaces current `classifyCellContent()` + `detectPencilmarks()` flow
- **`src/algorithms/imageProcessing.ts`** — add adaptive binarization function

### Unchanged:
- `classifyCellContent()`, `isPencilmarkPresent()`, `findConnectedComponents()` — kept for backward compatibility but no longer used in pencilmark OCR path
- Non-pencilmark OCR path — fully unchanged
- Board detection, cropping, `extractCells()` — unchanged

### New files:
- None — all changes in existing files

## Validation Plan

Before writing tests with accuracy assertions:

1. Run pipeline on 3 sample images (`pencil_marks_sample.gif`, `pencilmarks-full.png`, `lvc39h9c6ra81.jpg`)
2. Write per-cell results to JSON files in `/tests` folder
3. User compares JSON output against ground truth
4. Iterate on preprocessing/thresholds based on feedback
5. Once accuracy confirmed, add test fixtures with regression tests

## Fallback

If Approach C doesn't achieve 95%+ accuracy, fall back to Approach B (ink detection + position validation hybrid) which improves the existing position-based approach with better preprocessing and OCR validation.

## Test Samples

Three images in `tests/`:
- `pencil_marks_sample.gif` — black pencilmarks, standard grid
- `pencilmarks-full.png` — purple/gray pencilmarks, lighter than given digits
- `lvc39h9c6ra81.jpg` — high-res, blue givens, dark pencilmarks, background shading
