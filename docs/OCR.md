# OCR Pipeline — Technical Findings

## Overview

This document captures technical findings from implementing pencilmark recognition in the Sudoku OCR pipeline. It covers what works, what doesn't, and why — to inform future optimization work.

## Architecture

The pencilmark pipeline has three passes when `recognizePencilmarks: true`:

1. **Pass 1 — SINGLE_BLOCK classification**: Run Tesseract `PSM.SINGLE_BLOCK` on each preprocessed cell. Classify via symbol bounding box height:
   - Large symbol (height > 45% of cell) + few total symbols (≤ 2) → **given digit**
   - Large symbol + many symbols → **pencilmarks** (queue for sub-cell OCR)
   - Small symbols at 2+ grid positions → **pencilmarks**
   - Nothing found → **fallback**

2. **Pass 2 — SINGLE_CHAR fallback**: For cells where SINGLE_BLOCK found nothing. Tries `processForOCR` (standard binarize) then adaptive binarize. If no digit found and the board has pencilmarks elsewhere, queues for sub-cell OCR.

3. **Pass 3 — Sub-cell OCR**: For pencilmark cells, run `PSM.SINGLE_CHAR` on each of the 9 sub-cells (3x3 grid). Supplements with connected component ink detection for pencilmarks that OCR misses.

## Preprocessing Pipeline

Per-cell preprocessing for pencilmark mode:

```
Raw cell → Upscale (target 200px min dimension)
         → Median filter (3x3, noise reduction)
         → Contrast enhancement (1.3x)
         → Adaptive binarize (Otsu's method)
         → Grid line removal (BFS flood-fill, depth scaled to cell size)
```

### Why This Order

- **Upscale first**: Tesseract needs characters ≥ 20px. Pencilmarks in source images can be 10-15px. Upscaling to 200px minimum brings them to ~30-40px.
- **Median filter before binarize**: Removes salt-and-pepper noise that creates artifacts during binarization. Research shows noise reduction before thresholding prevents fragmented character outlines.
- **Contrast enhancement before binarize**: Boosts separation between ink and background. Factor 1.3 is a sweet spot — higher values (1.5+) create artifacts that break digit recognition on some images.
- **Adaptive binarize (Otsu)**: Per-cell threshold computed from the cell's own histogram. Better than fixed thresholds for varying image conditions (colored ink, tinted backgrounds).
- **Grid line removal last**: Operates on binarized data. BFS from border dark pixels, depth-limited to ~3% of cell width.

### What Was Tried and Rejected

| Technique | Result | Why |
|-----------|--------|-----|
| Contrast enhancement before adaptive binarize at 1.5x+ | Breaks digit "8" recognition on lvc image | Too much contrast causes Otsu threshold to shift, losing digit features |
| Sharpening (unsharp mask, amount 2.0) | Mixed — fixes some cells, breaks others | Over-sharpening creates halo artifacts that confuse Tesseract |
| 3x upscale (300px target) | Better for some digits but worse grid line proportions | Grid lines become proportionally larger, harder to remove |
| Double median filter | Too aggressive for thin digits | Smooths out digit "1" strokes |
| No preprocessing (raw image to Tesseract) | Poor results on colored images | Tesseract's internal Otsu fails on colored backgrounds |

## Classification Findings

### PSM Mode Selection

| Mode | Digit Reading | Digit/PM Classification | Notes |
|------|--------------|------------------------|-------|
| `SINGLE_CHAR` | Good for clear digits | N/A (single char only) | Best for fallback digit detection |
| `SINGLE_BLOCK` | Best (reads "8" correctly where others read "3") | Prone to false positives | Reads multi-pencilmark cells as single digits |
| `SPARSE_TEXT` | Occasionally misreads (8→3) | Best classification | Designed for scattered text, good at finding multiple symbols |

**Current approach**: Use `SINGLE_BLOCK` for pass 1 (best digit reading accuracy) with additional guards against false positives (symbol count check, grid position analysis).

### The 8→3 Problem

Tesseract with `SINGLE_CHAR` and `SPARSE_TEXT` consistently reads digit "8" as "3" on certain binarized images. `SINGLE_BLOCK` reads it correctly. This is a known Tesseract behavior where the page segmentation mode affects character recognition, not just layout detection.

### False Positive Digit Detection

The hardest unsolved problem: pencilmark cells where adjacent pencilmarks merge into a single blob during binarization. The merged blob looks like a large digit to Tesseract.

**What helps:**
- `symbols.length <= 2` check: Rejects cells where SINGLE_BLOCK found many symbols (clearly pencilmarks)
- Grid position uniqueness: Rejects cells where symbols span 2+ grid positions
- Median filter + mild contrast: Better separation of adjacent pencilmarks
- Connected component analysis: Verifies binarized image structure matches OCR classification

**What doesn't help:**
- Cross-validating with SPARSE_TEXT via mode switching: Corrupts worker state, produces unreliable results
- Two separate workers (SINGLE_BLOCK + SPARSE_TEXT): SPARSE_TEXT rejects too many real digits
- Connected component height/width checks: Digit "1" is thin (fails width), pencilmark stacks are tall (passes height)
- Sub-cell dark pixel distribution: Digits like "8" occupy 5-6 sub-cells, same as pencilmark cells with 5 marks

### The Core Tension

A single classification threshold cannot perfectly separate digits from pencilmarks because their binarized representations overlap:

- Digit "8" has ink in 5-6 sub-cells, multiple connected components, moderate height
- A pencilmark cell with marks at positions 2,5,8 (vertical column) has similar characteristics
- Digit "1" is thin and short — looks like a single pencilmark

Any threshold that correctly classifies one edge case breaks another.

## Sub-Cell OCR for Pencilmarks

For cells classified as pencilmarks, each of the 9 sub-cells is OCR'd individually:

1. Check `subCellHasInk()` on binarized data (1% dark pixel threshold) — skip empty sub-cells
2. Extract sub-cell from **raw** (non-binarized) canvas — Tesseract handles its own preprocessing better
3. Upscale to 150px target, add 10px padding
4. Run `SINGLE_CHAR` with whitelist `123456789`, confidence ≥ 10
5. Supplement with connected component ink detection (50+ pixels, 25% height, 12% width) for pencilmarks OCR missed

The position-based approach works because pencilmarks are always at fixed positions in the 3x3 grid (digit "1" at top-left, "2" at top-center, etc.). The digit value is inferred from position, not OCR text.

## Empty Cell Detection

Dual check to handle colored images (e.g., blue digits on blue-tinted backgrounds):

```typescript
if (isBinarizedCellEmpty(binarizedData) && isCellEmpty(rawImageData)) {
  // Truly empty — skip OCR
}
```

- `isBinarizedCellEmpty`: < 0.5% dark pixels after adaptive binarize
- `isCellEmpty`: stdDev < 8 on raw pixel data

Both must agree. This prevents the adaptive binarize from washing out colored content (failing the binarized check) while the raw check catches it.

## Tesseract Configuration

```typescript
tessedit_char_whitelist: '123456789'  // Only Sudoku digits
tessedit_pageseg_mode: PSM.SINGLE_BLOCK  // Pass 1 (classification + digit reading)
                     | PSM.SINGLE_CHAR   // Pass 2 (fallback) + Pass 3 (sub-cell OCR)
```

The `TesseractWorker` interface was extended to expose `data.symbols` (per-character bounding boxes) from `recognize()` results, and `PSM.SINGLE_BLOCK` / `PSM.SPARSE_TEXT` in addition to `PSM.SINGLE_CHAR`.

## Accuracy Results

Tested on 3 sample images with user-verified ground truth:

| Image | Resolution | Digit Accuracy | Notes |
|-------|-----------|---------------|-------|
| lvc39h9c6ra81.jpg | 1071x1071 | **81/81 (100%)** | High-res, blue digits, background shading |
| pencilmarks-full.png | 399x399 | **80/81 (98.8%)** | Purple pencilmarks, medium resolution |
| pencil_marks_sample.gif | 334x334 | **75/81 (92.6%)** | Low-res, small pencilmarks, hardest image |

### Error Patterns by Image Resolution

Higher resolution images produce better results. At lower resolutions:
- Pencilmarks are smaller and more likely to merge during binarization
- Thin digits (especially "1") may not produce detectable symbols
- Grid lines are proportionally larger relative to cell content

## Recommendations for Future Work

1. **Sudoku-rule post-validation**: After OCR, validate digits against Sudoku constraints (no duplicate in row/column/block). A digit that violates constraints is likely a false positive from a pencilmark cell. This would fix most remaining errors without touching the OCR pipeline.

2. **Resolution-adaptive preprocessing**: Adjust preprocessing parameters based on detected image resolution. Low-res images need more upscaling and gentler contrast enhancement.

3. **Custom classifier**: Train a small CNN to classify cells as digit/pencilmark/empty, replacing the bbox-based heuristic. Even a simple model would outperform threshold-based classification.

4. **Multi-attempt with voting**: Run OCR with multiple PSM modes and preprocessing variants, take majority vote. Current implementation avoids this due to Tesseract worker state issues with mode switching, but separate workers per mode would solve it (at the cost of memory/initialization time).
