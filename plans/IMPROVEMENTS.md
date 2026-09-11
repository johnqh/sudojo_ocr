# IMPROVEMENTS.md - Prioritized Improvement Suggestions

## Priority 1: Critical / High Impact

### 1.1 Add Perspective Correction
**Current**: Board detection finds a bounding rectangle but assumes the board is roughly axis-aligned. Angled or perspective-distorted photos produce skewed cell extractions.
**Improvement**: Implement perspective (homography) transform after detecting the four corners of the board. Use a 4-point transform to warp the board to a perfect square.
**Impact**: Significantly better OCR accuracy for real-world phone photos taken at angles.

### 1.2 Add Adaptive Thresholding
**Current**: Standard mode uses `binarize(img, 0.3)`, a per-cell threshold relative to that cell's luminance range. Pencilmark mode already uses per-cell Otsu (`adaptiveBinarize`). Neither is *local within* a cell or board, so both still struggle with shadows and glare. (`OCR_BINARIZE_THRESHOLD = 160` in `types.ts` is unused.)
**Improvement**: Add a locally adaptive threshold (e.g., Sauvola) that computes thresholds per region.
**Impact**: Much better digit extraction under poor or uneven lighting conditions.

### 1.3 Add OCR Confidence Retry Strategy
**Current**: In standard mode, a failed OCR gets only one retry with dilation, and low-confidence results are accepted as-is if above minConfidence. Pencilmark mode, which every consumer uses, already votes across four preprocessing variants (see `docs/OCR.md`).
**Improvement**: Implement multiple retry strategies (different contrast levels, different margin ratios, rotation correction) and pick the result with highest overall confidence.
**Impact**: Higher accuracy on marginal images.

## Priority 2: Important / Moderate Impact

### 2.1 Add Image Orientation Detection
**Current**: Assumes images are upright. Rotated photos (90/180/270) will fail completely.
**Improvement**: Detect EXIF orientation metadata and/or use edge analysis to determine if the board is rotated. Auto-rotate before processing.
**Impact**: Handles photos from cameras that embed rotation in EXIF rather than pixels.

### 2.2 Add React Native Adapter
**Current**: Only Web and Node.js adapters exist. React Native is listed as supported in docs but has no adapter.
**Improvement**: Create `src/adapters/react-native.ts` using `react-native-canvas` or `expo-gl`. Add `./react-native` export path.
**Impact**: Native mobile support without going through web or Node.

### 2.3 Improve Board Detection Scoring
**Current**: Board detection scores rectangles by area * aspect ratio * squareBonus. The scoring can select non-board rectangles in cluttered images.
**Improvement**: Add internal grid line validation -- after finding a candidate rectangle, verify that it contains approximately 10 horizontal and 10 vertical internal lines at evenly-spaced intervals.
**Impact**: More reliable board detection in images with other rectangular elements.

### 2.4 Add Worker Pool for OCR
**Current**: Uses a single Tesseract worker per call, created and terminated inside `extractSudokuFromImage()`, that processes cells sequentially. Pencilmark mode makes several OCR calls per cell.
**Improvement**: Create a pool of 2-4 workers and process cells in parallel batches. Tesseract supports multiple worker instances.
**Impact**: 2-4x faster OCR processing.

### 2.5 Add Published Algorithm Documentation
**Current**: `docs/OCR.md` covers the pencilmark-mode pipeline and its tuning history, and `CLAUDE.md` has an architecture overview. Board detection and standard mode are only documented in code comments.
**Improvement**: Add `docs/ALGORITHMS.md` documenting each processing step with diagrams of the pipeline, threshold values, and tuning guidance.
**Impact**: Easier onboarding for contributors and better understanding of tuning parameters.

## Priority 3: Nice to Have / Low Impact

### 3.1 Add Debug Mode with Intermediate Images
**Current**: No way to inspect intermediate processing steps (grayscale, edges, detected rectangle, individual cells).
**Improvement**: Add a `debug: boolean` config option that returns intermediate `data:` URLs at each pipeline stage in the result object.
**Impact**: Much easier to diagnose why OCR fails on specific images.

### 3.2 Add Confidence Heatmap Output
**Current**: Per-cell confidence is computed internally but not returned. `OCRResult` only exposes the average `confidence` and `digitCount`.
**Improvement**: Add an optional `generateConfidenceHeatmap()` function that renders a color-coded overlay showing which cells had low confidence.
**Impact**: Helps users understand which cells to manually verify.

### 3.3 Support Multiple OCR Engines
**Current**: Hard-coded to Tesseract.js via `TesseractModule` interface.
**Improvement**: Add support for alternative OCR backends (e.g., PaddleOCR, EasyOCR) via a generic `OCREngine` interface.
**Impact**: Flexibility for users who need better accuracy or performance.

### 3.4 Add Printed vs Handwritten Detection
**Current**: Same processing pipeline for printed and handwritten digits.
**Improvement**: Detect whether digits are printed or handwritten (based on stroke regularity) and adjust preprocessing accordingly.
**Impact**: Better accuracy on handwritten puzzles.

### 3.5 Optimize Image Processing Performance
**Current**: Pixel-level operations iterate with individual array accesses and `safeGet()` bounds checks.
**Improvement**: Use TypedArray bulk operations where possible, eliminate redundant bounds checks in inner loops (guard at boundaries only), and consider WASM for heavy processing.
**Impact**: Faster preprocessing, especially for high-resolution images.
