# CLAUDE.md

This file provides context for AI assistants working on this codebase.

## Project Overview

`@sudobility/sudojo_ocr` (v1.1.1) is a cross-platform OCR library for Sudoku puzzle scanning. It works on:
- **Web/Browser** - using HTMLCanvasElement
- **React Native** - using compatible canvas libraries
- **Node.js** - using @napi-rs/canvas

The library extracts Sudoku puzzles from images using Tesseract.js for OCR, with platform-specific canvas adapters abstracting the rendering layer.

## Runtime & Package Manager

**This project uses Bun.** Do not use npm, yarn, or pnpm.

```bash
bun install           # Install dependencies
bun run verify        # Run all checks (typecheck, lint, test, build)
bun run typecheck     # Type-check without emitting
bun run lint          # Run ESLint
bun run lint:fix      # Run ESLint with auto-fix
bun run format        # Format code with Prettier
bun run format:check  # Check formatting without changes
bun run build         # Build ESM and CJS outputs to dist/
bun run clean         # Remove dist/
bun run dev           # Watch mode for development
bun run test          # Run tests once (vitest)
bun run test:watch    # Run tests in watch mode
bun run test:coverage # Run tests with coverage
```

## Tech Stack

- **Language**: TypeScript 5.9+ (strict mode)
- **Testing**: Vitest 4.x
- **Linting**: ESLint 9.x + `@typescript-eslint` 8.x
- **Formatting**: Prettier 3.x
- **Build**: Dual ESM/CJS via two separate `tsc` passes (`tsconfig.esm.json` + `tsconfig.cjs.json`)
- **Target**: ES2020 with DOM lib (for web adapter types)

## Architecture

### Platform Abstraction

The library uses a **CanvasAdapter** interface to abstract platform-specific canvas operations:

```typescript
interface CanvasAdapter {
  createCanvas(width: number, height: number): CanvasLike;
  loadImage(source: unknown): Promise<{ image: ImageLike; width: number; height: number }>;
  getImageData(canvas, x, y, width, height): ImageDataLike;
  putImageData(canvas, imageData, x, y): void;
  drawImage(canvas, source, sx, sy, sw, sh, dx, dy, dw, dh): void;
  fillRect(canvas, color, x, y, width, height): void;
  toTesseractInput(canvas): unknown;  // Platform-specific format for Tesseract
  toDataURL(canvas): string;
}
```

### Adapters

- **WebCanvasAdapter** (`src/adapters/web.ts`) - Browser implementation using HTMLCanvasElement. Accepts File, Blob, HTMLImageElement, HTMLCanvasElement, or data URL string.
- **NodeCanvasAdapter** (`src/adapters/node.ts`) - Node.js implementation using `@napi-rs/canvas`. Accepts Buffer or file path string. Requires async initialization via `createNodeAdapter()`.

### Algorithms

All image processing algorithms are platform-agnostic, operating on raw `ImageDataLike` pixel data:

- `src/algorithms/imageProcessing.ts` - Grayscale conversion, Gaussian blur, Canny edge detection, contrast enhancement, binarization, dilation, cell emptiness detection, OCR preprocessing
- `src/algorithms/boardDetection.ts` - Sudoku grid detection via edge analysis with line grouping, rectangle scoring (square preference), and multi-level fallbacks (line-based -> density-based -> dark pixel)
- `src/algorithms/digitParsing.ts` - OCR text correction for common misrecognitions (e.g., `l`->1, `O`->9, `B`->8, `S`->5)

### Main Entry Points

- `extractSudokuFromImage()` - Full OCR pipeline: load image -> detect board -> preprocess -> extract cells -> OCR -> parse digits
- `detectAndCropBoard()` - Detect and crop board without OCR, returns data URL
- `extractCellImages()` - Extract 81 cell images as data URLs (for UI previews)

## Package Exports

```json
{
  ".":      "dist/index.js"      // Main: extractSudokuFromImage, types, algorithms
  "./web":  "dist/adapters/web.js"   // createWebAdapter()
  "./node": "dist/adapters/node.js"  // createNodeAdapter()
}
```

Each export path provides `import` (ESM .js), `require` (CJS .cjs), and `types` (.d.ts) variants.

## OCR Pipeline

1. **Load Image** - Platform-specific image loading via adapter
2. **Board Detection** - Find the Sudoku grid using edge detection (skippable via config)
3. **Crop & Square** - Extract and normalize the board area to a square
4. **Preprocessing** - Contrast stretching and gamma correction (gamma=0.8)
5. **Cell Extraction** - Split into 81 cells with configurable margin removal (default 15.4%)
6. **Empty Detection** - Skip cells with low pixel standard deviation (stdDev < 8)
7. **Cell Processing** - Enhance contrast (1.5x), binarize (threshold 160), add padding (20px)
8. **OCR** - Run Tesseract in single-character mode (`PSM.SINGLE_CHAR`)
9. **Retry with Dilation** - If OCR fails, retry with morphological dilation for thin strokes
10. **Digit Parsing** - Apply character corrections for common OCR errors

## Configuration

```typescript
interface OCRConfig {
  cellMargin: number;           // Margin to remove from cells (0-0.5), default: 0.154
  minConfidence: number;        // Minimum confidence threshold (0-100), default: 1
  preprocess: boolean;          // Apply preprocessing, default: true
  skipBoardDetection: boolean;  // Skip board detection, default: false
}
```

### Internal Constants
- `OCR_TARGET_CELL_SIZE` = 100 (pixels, minimum cell size for OCR)
- `OCR_CELL_PADDING` = 20 (pixels, whitespace padding around cells)
- `OCR_BINARIZE_THRESHOLD` = 160 (0-255, black/white cutoff)
- `OCR_CONTRAST_FACTOR` = 1.5 (contrast enhancement multiplier)

## File Structure

```
src/
├── index.ts              # Main exports (types + functions + algorithms)
├── types.ts              # All type definitions and constants
├── ocr.ts                # Main OCR logic (extractSudokuFromImage, detectAndCropBoard, extractCellImages)
├── algorithms/
│   ├── index.ts          # Algorithm re-exports
│   ├── imageProcessing.ts    # Image processing functions (9 exports)
│   ├── boardDetection.ts     # Board detection algorithms (3 exports)
│   └── digitParsing.ts       # OCR text corrections (1 export)
│   ├── imageProcessing.test.ts
│   ├── boardDetection.test.ts
│   └── digitParsing.test.ts
└── adapters/
    ├── index.ts          # Adapter type re-exports
    ├── types.ts          # Adapter type re-exports from ../types.ts
    ├── web.ts            # WebCanvasAdapter + createWebAdapter()
    └── node.ts           # NodeCanvasAdapter + createNodeAdapter()
```

## Dependencies

### Peer Dependencies
- `tesseract.js` ^5.0.0 || ^6.0.0 || ^7.0.0 (OCR engine, required)

### Peer Dependencies (Optional)
- `@napi-rs/canvas` (required for Node.js adapter only)

### Dev Dependencies
- `@eslint/js` ^9.38.0, `eslint` ^9.38.0
- `@typescript-eslint/eslint-plugin` ^8.46.2, `@typescript-eslint/parser` ^8.46.2
- `@napi-rs/canvas` ^0.1.68 (for testing Node adapter)
- `@types/node` ^25.1.0
- `prettier` ^3.6.2, `rimraf` ^6.0.1
- `tesseract.js` ^5.1.1 (for testing)
- `typescript` ^5.9.3, `vitest` ^4.0.15

## Build System

Dual CJS/ESM build using two TypeScript configs:
1. `tsconfig.esm.json` - Emits ESM `.js` files
2. `tsconfig.cjs.json` - Emits `.js` files, then renamed to `.cjs` via shell script

Build order: `build:cjs` then `build:esm` (CJS first to avoid conflicts).

The base `tsconfig.json` is for type-checking only (`noEmit: true`).

## Usage Examples

### Web/Browser

```typescript
import { extractSudokuFromImage } from '@sudobility/sudojo_ocr';
import { createWebAdapter } from '@sudobility/sudojo_ocr/web';
import Tesseract from 'tesseract.js';

const adapter = createWebAdapter();
const result = await extractSudokuFromImage(
  adapter,
  imageFile,  // File, Blob, HTMLImageElement, or data URL
  Tesseract,
  { skipBoardDetection: false },
  (progress) => console.log(progress.message)
);

console.log(result.puzzle);      // "004002008100400000..."
console.log(result.confidence);  // 85.5
console.log(result.digitCount);  // 28
```

### Node.js

```typescript
import { extractSudokuFromImage } from '@sudobility/sudojo_ocr';
import { createNodeAdapter } from '@sudobility/sudojo_ocr/node';
import Tesseract from 'tesseract.js';

const adapter = await createNodeAdapter();  // async - loads @napi-rs/canvas
const result = await extractSudokuFromImage(
  adapter,
  imageBuffer,  // Buffer or file path
  Tesseract
);
```

## Common Tasks

### Add New Platform Adapter

1. Create `src/adapters/newplatform.ts`
2. Implement `CanvasAdapter` interface
3. Export factory function `createNewPlatformAdapter()`
4. Add export path in `package.json` exports map

### Improve OCR Accuracy

1. Adjust `cellMargin` in config (default 0.154 = 15.4%)
2. Modify preprocessing in `imageProcessing.ts`
3. Add character corrections to `CORRECTIONS` map in `digitParsing.ts`
4. Adjust `OCR_BINARIZE_THRESHOLD` or `OCR_CONTRAST_FACTOR` in `types.ts`

### Add New Algorithm

1. Create function in appropriate `algorithms/*.ts` file
2. Export from `algorithms/index.ts`
3. Export from main `index.ts` if public API

## Testing

Tests use Vitest. Run with `bun run test`.

Test files:
- `src/algorithms/imageProcessing.test.ts` - Image processing unit tests
- `src/algorithms/boardDetection.test.ts` - Board detection unit tests
- `src/algorithms/digitParsing.test.ts` - Digit parsing unit tests

## Related Projects

- `sudojo_app` - Web application (uses web adapter)
- `sudojo_bot` - Bot application (uses Node.js adapter)

## Gotchas

- `NodeCanvasAdapter.createCanvas()` throws if called before `init()`. Always use the `createNodeAdapter()` factory function.
- The `toTesseractInput()` return type varies by platform: `HTMLCanvasElement` for web, `Buffer` (PNG) for Node.js.
- The `0` -> `9` correction in `digitParsing.ts` is intentional: OCR "0" in a non-empty cell is likely a misrecognized 9 (since Sudoku uses 1-9, not 0).
- Build CJS first (`build:cjs`), then ESM (`build:esm`), because the CJS rename script copies `.js` to `.cjs` and ESM would conflict.
