# CLAUDE.md

This file provides context for AI assistants working on this codebase.

## Project Overview

`@sudobility/sudojo_ocr` is a cross-platform OCR library for Sudoku puzzle scanning. It works on:
- **Web/Browser** - using HTMLCanvasElement
- **React Native** - using compatible canvas libraries
- **Node.js** - using @napi-rs/canvas

The library extracts Sudoku puzzles from images using Tesseract.js for OCR.

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
bun run test          # Run tests once
bun run test:watch    # Run tests in watch mode
```

## Architecture

### Platform Abstraction

The library uses a **CanvasAdapter** interface to abstract platform-specific canvas operations:

```typescript
interface CanvasAdapter {
  createCanvas(width: number, height: number): CanvasLike;
  loadImage(source: unknown): Promise<{ image, width, height }>;
  getImageData(canvas, x, y, width, height): ImageDataLike;
  putImageData(canvas, imageData, x, y): void;
  drawImage(canvas, source, sx, sy, sw, sh, dx, dy, dw, dh): void;
  fillRect(canvas, color, x, y, width, height): void;
  toTesseractInput(canvas): unknown;  // Platform-specific format
  toDataURL(canvas): string;
}
```

### Adapters

- **WebCanvasAdapter** (`src/adapters/web.ts`) - Browser implementation using HTMLCanvasElement
- **NodeCanvasAdapter** (`src/adapters/node.ts`) - Node.js implementation using @napi-rs/canvas

### Algorithms

All image processing algorithms are platform-agnostic, operating on raw pixel data:

- `src/algorithms/imageProcessing.ts` - Grayscale, blur, edge detection, contrast, binarization
- `src/algorithms/boardDetection.ts` - Sudoku grid detection using edge analysis
- `src/algorithms/digitParsing.ts` - OCR text correction (l→1, O→9, etc.)

### Main Entry Points

- `extractSudokuFromImage()` - Main OCR function
- `detectAndCropBoard()` - Detect and crop board without OCR

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

console.log(result.puzzle);  // "004002008100400000..."
console.log(result.confidence);  // 85.5
```

### Node.js

```typescript
import { extractSudokuFromImage } from '@sudobility/sudojo_ocr';
import { createNodeAdapter } from '@sudobility/sudojo_ocr/node';
import Tesseract from 'tesseract.js';

const adapter = await createNodeAdapter();
const result = await extractSudokuFromImage(
  adapter,
  imageBuffer,  // Buffer or file path
  Tesseract
);
```

## OCR Pipeline

1. **Load Image** - Platform-specific image loading
2. **Board Detection** - Find the Sudoku grid using edge detection
3. **Crop & Square** - Extract and normalize the board area
4. **Preprocessing** - Contrast stretching and gamma correction
5. **Cell Extraction** - Split into 81 cells with margin removal
6. **Empty Detection** - Skip cells with low variance (empty)
7. **Cell Processing** - Enhance contrast, binarize, add padding
8. **OCR** - Run Tesseract in single-character mode
9. **Digit Parsing** - Apply corrections for common OCR errors

## Configuration

```typescript
interface OCRConfig {
  cellMargin: number;      // Margin to remove from cells (0-0.5), default: 0.154
  minConfidence: number;   // Minimum confidence threshold, default: 1
  preprocess: boolean;     // Apply preprocessing, default: true
  skipBoardDetection: boolean;  // Skip board detection, default: false
}
```

## File Structure

```
src/
├── index.ts              # Main exports
├── types.ts              # Type definitions
├── ocr.ts                # Main OCR logic
├── algorithms/
│   ├── index.ts          # Algorithm exports
│   ├── imageProcessing.ts    # Image processing functions
│   ├── boardDetection.ts     # Board detection algorithms
│   └── digitParsing.ts       # OCR text corrections
└── adapters/
    ├── index.ts          # Adapter exports
    ├── types.ts          # Adapter type re-exports
    ├── web.ts            # Web/Browser adapter
    └── node.ts           # Node.js adapter
```

## Dependencies

### Peer Dependencies
- `tesseract.js` - OCR engine (required)

### Optional Dependencies
- `@napi-rs/canvas` - Required for Node.js adapter

## Common Tasks

### Add New Platform Adapter

1. Create `src/adapters/newplatform.ts`
2. Implement `CanvasAdapter` interface
3. Export factory function `createNewPlatformAdapter()`
4. Add export path in `package.json`

### Improve OCR Accuracy

1. Adjust `cellMargin` in config (default 0.154 = 15.4%)
2. Modify preprocessing in `imageProcessing.ts`
3. Add corrections to `CORRECTIONS` in `digitParsing.ts`

### Add New Algorithm

1. Create function in appropriate `algorithms/*.ts` file
2. Export from `algorithms/index.ts`
3. Export from main `index.ts` if public API

## Testing

Tests use Vitest. Run with `bun run test`.

## Related Projects

- `sudojo_app` - Web application (original OCR implementation)
- `sudojo_bot` - Bot application (Node.js OCR implementation)
