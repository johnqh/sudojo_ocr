# @sudobility/sudojo_ocr

Cross-platform OCR library for extracting Sudoku puzzles, and optionally pencilmarks, from images.
It works in the browser and in Node.js. There's no React Native adapter; the RN app goes through
`sudojo_api`. ESM-only.

## Installation

```bash
bun add @sudobility/sudojo_ocr tesseract.js @sudobility/sudojo_types
bun add @napi-rs/canvas   # Node.js adapter only
```

`tesseract.js` (`^5 || ^6 || ^7`) and `@sudobility/sudojo_types` are peer dependencies. Tesseract
downloads `eng.traineddata` on first use: Node caches it in the process cwd, and browsers use
IndexedDB.

## Usage

```typescript
// Web
import { extractSudokuFromImage } from '@sudobility/sudojo_ocr';
import { createWebAdapter } from '@sudobility/sudojo_ocr/web';
import Tesseract from 'tesseract.js';

const adapter = createWebAdapter();
const result = await extractSudokuFromImage(adapter, imageFile, Tesseract, {
  recognizePencilmarks: true, // optional, default false
});
console.log(result.board.original);            // "004002008100400000..." ('0' = empty)
console.log(result.board.pencilmark.numbers);  // 81 comma-separated entries
console.log(result.confidence);                // 85.5
console.log(result.digitCount);                // 28

// Node.js (Buffer or file path)
import { createNodeAdapter } from '@sudobility/sudojo_ocr/node';
const adapter = await createNodeAdapter(); // async
const result = await extractSudokuFromImage(adapter, imageBuffer, Tesseract);
```

`result.board` is a `SolverBoard` from `@sudobility/sudojo_types`.

## API

- `extractSudokuFromImage()` -- Full OCR pipeline: image -> board detection -> cell extraction -> OCR -> digit parsing (plus pencilmark passes when `recognizePencilmarks` is set)
- `detectAndCropBoard()` -- Detect and crop board, returns data URL
- `extractCellImages()` -- Extract 81 cell images as data URLs
- Platform adapters: `createWebAdapter()`, `createNodeAdapter()`
- Low-level image-processing and board-detection algorithms are also exported (see `src/index.ts`)

## Development

```bash
bun run build        # Build ESM to dist/ (no CJS)
bun run test         # Run Vitest (unit + slow end-to-end Tesseract tests)
bun run typecheck    # TypeScript check
bun run lint         # ESLint (includes Prettier rules)
bun run verify       # Typecheck + lint + test + build
```

See [CLAUDE.md](CLAUDE.md) for the architecture and gotchas, and [docs/](docs/README.md) for OCR
tuning notes.

## Related Packages

- `sudojo_api` -- Backend `/ocr` route (Node adapter); prefers the `sudojo_ocr_ml` service when configured, with this library as the fallback
- `sudojo_app` -- Web application (uses web adapter)
- `sudojo_bot` -- Bot application (uses Node.js adapter)
- `sudojo_ocr_ml` -- Python ONNX OCR service that supersedes this pipeline on the server; benchmarks against it
- `@sudobility/sudojo_types` -- Peer dependency; defines `SolverBoard`, the result's `board` field

## License

BUSL-1.1
