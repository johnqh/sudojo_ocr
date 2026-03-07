# @sudobility/sudojo_ocr

Cross-platform OCR library for extracting Sudoku puzzles from images. Works in browser, React Native, and Node.js.

## Installation

```bash
bun add @sudobility/sudojo_ocr
```

## Usage

```typescript
// Web
import { extractSudokuFromImage } from '@sudobility/sudojo_ocr';
import { createWebAdapter } from '@sudobility/sudojo_ocr/web';
import Tesseract from 'tesseract.js';

const adapter = createWebAdapter();
const result = await extractSudokuFromImage(adapter, imageFile, Tesseract);
console.log(result.puzzle);      // "004002008100400000..."
console.log(result.confidence);  // 85.5

// Node.js
import { createNodeAdapter } from '@sudobility/sudojo_ocr/node';
const adapter = await createNodeAdapter();
const result = await extractSudokuFromImage(adapter, imageBuffer, Tesseract);
```

## API

- `extractSudokuFromImage()` -- Full OCR pipeline: image -> board detection -> cell extraction -> OCR -> digit parsing
- `detectAndCropBoard()` -- Detect and crop board, returns data URL
- `extractCellImages()` -- Extract 81 cell images as data URLs
- Platform adapters: `createWebAdapter()`, `createNodeAdapter()`

## Development

```bash
bun run build        # Build ESM + CJS
bun run test         # Run Vitest
bun run typecheck    # TypeScript check
bun run lint         # ESLint
bun run verify       # Typecheck + lint + test + build
```

## Related Packages

- `sudojo_app` -- Web application (uses web adapter)
- `sudojo_bot` -- Bot application (uses Node.js adapter)
- `@sudobility/sudojo_types` -- Solver types for hint data

## License

BUSL-1.1
