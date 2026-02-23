# IMPROVEMENTS.md - Prioritized Improvement Suggestions

## Priority 1: Critical / High Impact

### 1.1 Add Perspective Correction
**Current**: Board detection finds a bounding rectangle but assumes the board is roughly axis-aligned. Angled or perspective-distorted photos produce skewed cell extractions.
**Improvement**: Implement perspective (homography) transform after detecting the four corners of the board. Use a 4-point transform to warp the board to a perfect square.
**Impact**: Significantly better OCR accuracy for real-world phone photos taken at angles.

### 1.2 Add Adaptive Thresholding
**Current**: Binarization uses a global threshold of 160, which fails on images with uneven lighting (shadows, glare).
**Improvement**: Replace the global `binarize()` with an adaptive threshold (e.g., Sauvola or Otsu method) that computes local thresholds per region.
**Impact**: Much better digit extraction under poor or uneven lighting conditions.

### 1.3 Add OCR Confidence Retry Strategy
**Current**: When initial OCR fails, only one retry with dilation is attempted. Low-confidence results are accepted as-is if above minConfidence.
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
**Current**: Uses a single Tesseract worker that processes cells sequentially (81 cells one at a time).
**Improvement**: Create a pool of 2-4 workers and process cells in parallel batches. Tesseract supports multiple worker instances.
**Impact**: 2-4x faster OCR processing.

### 2.5 Add Published Algorithm Documentation
**Current**: Algorithm details are only in code comments. No external documentation of the detection/preprocessing pipeline.
**Improvement**: Add `docs/ALGORITHMS.md` documenting each processing step with diagrams of the pipeline, threshold values, and tuning guidance.
**Impact**: Easier onboarding for contributors and better understanding of tuning parameters.

## Priority 3: Nice to Have / Low Impact

### 3.1 Add Debug Mode with Intermediate Images
**Current**: No way to inspect intermediate processing steps (grayscale, edges, detected rectangle, individual cells).
**Improvement**: Add a `debug: boolean` config option that returns intermediate `data:` URLs at each pipeline stage in the result object.
**Impact**: Much easier to diagnose why OCR fails on specific images.

### 3.2 Add Confidence Heatmap Output
**Current**: Returns per-cell confidence in `cellResults`, but no visual representation.
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
