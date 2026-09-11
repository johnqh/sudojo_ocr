# CLAUDE.md

> **Git policy — never auto-commit or auto-push.** Leave your work in the working tree.
> Run `git commit`, `git push`, `gh pr create`, or `scripts/push_all.sh` **only when the user
> explicitly asks in that turn**. Approval for an earlier change does not carry forward, and
> finishing a task is not permission to commit it.

This file provides context for AI assistants working on this codebase. It is also shipped in the
npm tarball (`"files": ["dist/**/*", "CLAUDE.md"]`).

## Project Overview

`@sudobility/sudojo_ocr` (v1.1.42, BUSL-1.1) reads a Sudoku board, and optionally its pencilmarks,
from an image. It uses **Tesseract.js**, which the caller injects, plus hand-written image
processing on raw RGBA pixels. Platform canvas work sits behind a `CanvasAdapter`. There are two
adapters:

- **Web** (`/web`): `HTMLCanvasElement`, needs `document`
- **Node** (`/node`): `@napi-rs/canvas`

There is **no React Native adapter**, even though `package.json`'s description names React Native.
`sudojo_app_rn` uploads the image to `sudojo_api`, which runs this library on Node.

ESM-only (`"type": "module"`, no CJS build). Node 18+ for backend consumers. No ML model of its own:
the only "model" is Tesseract's `eng.traineddata` (see [Assets](#assets--relation-to-sudojo_ocr_ml)).

## Commands

**Bun only.** Don't use npm, yarn, or pnpm. Bun 1.3.10 is the verified version.

| Command | What it does | Verified |
|---|---|---|
| `bun install` | install deps (bun auto-installs peers such as `@sudobility/sudojo_types`) | n/a |
| `bun run typecheck` | `tsc --noEmit` (src only, **excludes `*.test.ts`**) | ✅ passes |
| `bun run lint` / `lint:fix` | `eslint src --ext .ts` (prettier violations are lint errors) | ✅ passes |
| `bun run format` / `format:check` | prettier on `src/**/*.{ts,js,json,md}` | ✅ check passes |
| `bun run test` | `vitest run`, no config file, default globs (5 files) | see next two rows |
| `bunx vitest run src/algorithms` | pure-pixel unit tests only (91 tests, ~3 s, no Tesseract) | ✅ 91/91 |
| `bunx vitest run src/test` | end-to-end OCR on fixtures (real Tesseract, ~8 min, 120 s/test timeout) | ⚠️ 10/11; one pencilmark test timed out under load, then passed alone in 35 s |
| `bun run build` | `tsc -p tsconfig.esm.json` → `dist/` (`.js` + `.d.ts` + maps) | ✅ (built to scratch) |
| `bun run clean` | `rimraf dist` | no |
| `bun run dev` | `tsc --watch` on `tsconfig.json`, which is `noEmit`: **watch typecheck only, emits nothing** | no |
| `bun run test:watch` | `vitest` watch | no |
| `bun run test:coverage` | `vitest --coverage`: **`@vitest/coverage-v8` isn't installed**, so this won't work as-is | no |
| `bun run verify` | typecheck, then lint, test, build | all parts verified separately |
| `bun run tests/evaluate-truth.ts` | accuracy vs `tests/*_truth.txt` (console only, ~3 min) | ✅ 81, 80, 80 of 81 digits |
| `bun run tests/validate-pencilmarks.ts` | **overwrites** the tracked `tests/*_results.json` | no |

**Release (document only, don't run).** `prepublishOnly` runs `clean` then `verify`. CI
(`.github/workflows/ci-cd.yml` → `johnqh/workflows` `unified-cicd.yml@main`) runs on pushes and
PRs to `main`/`develop` and publishes to npm (public) when `NPM_TOKEN` is set. Family releases go
through `sudojo_app/scripts/push_all.sh`, where this package is **2nd** in order, right after
`sudojo_types`. That script bumps the `sudojo_types` peer and the patch version, which is what the
`chore: bump sudojo_types … and bump version` commits are.

## Architecture

```
extractSudokuFromImage(adapter, source, Tesseract, config?, onProgress?)      src/ocr.ts
 ├─ adapter.loadImage → sourceCanvas
 ├─ detectBoardRectangle → squarifyRectangle → crop    (skipped if skipBoardDetection)
 │    Sobel edges → long H/V line runs → best square-ish rectangle
 │    → edge-density fallback → dark-pixel fallback (never returns null in practice)
 ├─ preprocessForOCR: contrast stretch + gamma 0.8     (if preprocess)
 ├─ extractCells: 81 canvases, upscaled to ≥100 px, margin = cellMargin
 │    (pencilmark mode: margin = min(cellMargin, 0.03), plus rawCells cut from the un-preprocessed crop)
 ├─ recognizePencilmarks=false → recognizeCells (standard, SINGLE_CHAR)
 │    isCellEmpty (stdDev<8) → enhanceContrast 1.5 → binarize(top 30% of luminance range = white)
 │    → pad 20 px → OCR → if no digit: dilate + OCR again → parseDigitFromText (+ minConfidence)
 ├─ recognizePencilmarks=true  → recognizeCellsPencilmark (whitelist 1-9, ignores minConfidence)
 │    P1 SINGLE_BLOCK on Otsu-binarized, grid-stripped cell; classify by symbol bbox height/slots
 │    P2 SINGLE_CHAR whole-cell vote (raw, binarize, binarize+dilate, Otsu): ≥2 votes or conf ≥50
 │    P3 per-sub-cell SINGLE_CHAR + connected-component ink check; digit value = 3x3 slot position
 │    P4 verification over all cells: rescue missed givens, demote pencilmark blobs misread as digits
 │    P5 same-board template matching (only if givens look typographically consistent)
 ├─ removeConflictingDigits: duplicate in a row/col/box → drop the lower-confidence one
 ├─ computeLegalPencilmarks (pencilmark mode, only if any cell had OCR-detected marks)
 └─ OCRResult { board: SolverBoard, confidence, digitCount }
```

`docs/OCR.md` has the pencilmark-mode thresholds and the reasoning behind them.

## Public API

| Import | Exports |
|---|---|
| `@sudobility/sudojo_ocr` | `extractSudokuFromImage`, `detectAndCropBoard` (→ data URL), `extractCellImages` (→ 81 data URLs, default margin 0.154), `DEFAULT_OCR_CONFIG` |
| ″ (algorithms) | `toGrayscale`, `gaussianBlur`, `cannyEdgeDetection`, `enhanceContrast`, `binarize`, `adaptiveBinarize`, `preprocessForOCR`, `isCellEmpty`, `removeGridLines`, `detectBoardRectangle`, `findRectangleDarkPixels`, `squarifyRectangle`, `parseDigitFromText`, `findConnectedComponents`, `classifyCellContent`, `isPencilmarkPresent` |
| ″ (types) | `OCRProgress`, `OCRResult`, `OCRConfig`, `Rectangle`, `CanvasAdapter`, `CanvasLike`, `ImageLike`, `ImageDataLike`, `TesseractModule`, `TesseractWorker`, `TesseractSymbol`, `TesseractSymbolBbox`, `ConnectedComponent`, `CellContentType` |
| `@sudobility/sudojo_ocr/web` | `createWebAdapter()` (sync; default export), `WebCanvasAdapter`. Accepts File, Blob, HTMLImageElement, HTMLCanvasElement, or a URL/data-URL string |
| `@sudobility/sudojo_ocr/node` | `createNodeAdapter()` (**async**; default export), `NodeCanvasAdapter`. Accepts Buffer or file path |

Not exported from the root: `medianFilter`, `dilate`, `removeEdgeSpanningLines`, and the `OCR_*`
constants. Import those from `src/algorithms` or `src/types` inside the repo.

**Result contract** (`SolverBoard` from `@sudobility/sudojo_types`):

| Field | Value |
|---|---|
| `board.original`, `board.user` | the same 81-char row-major string, `'0'` = empty |
| `board.pencilmark.numbers` | 81 comma-separated entries (`''` or digits `1-9`) |
| `board.pencilmark.autopencil` | `true` iff any entry is non-empty |
| `confidence` | mean Tesseract confidence (0–100) over recognized cells |
| `digitCount` | number of recognized givens |

**`OCRConfig`** (`Partial`, merged over `DEFAULT_OCR_CONFIG`):

| Option | Default | Notes |
|---|---|---|
| `cellMargin` | `0.154` | fraction trimmed per cell side; capped at `0.03` in pencilmark mode |
| `minConfidence` | `1` | standard mode only |
| `preprocess` | `true` | contrast stretch + gamma before cell extraction |
| `skipBoardDetection` | `false` | use when the image is already a tight board crop |
| `recognizePencilmarks` | `false` | switches to the 5-pass pipeline. **Every consumer sets it to `true`** (with `cellMargin: 0.03`), so the default path is effectively unused in production |

## Assets & relation to sudojo_ocr_ml

- **`eng.traineddata`**: the only model. Nothing in this repo loads it directly. `tesseract.js`
  loads it inside `createWorker('eng', 1 /* OEM LSTM_ONLY */)`. In Node it reads
  `./eng.traineddata` from the **process cwd**, and otherwise downloads
  `cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int` and caches it to cwd. Browsers cache
  it in IndexedDB. The repo-root copy (5.2 MB) is that cache and is gitignored. Without it, the
  first `bun run test` needs network.
- **sudojo_ocr_ml doesn't produce assets for this repo.** It's a separate Python ONNX service
  (whole-board recognizer + corner detector, `POST /v1/ocr`) that **replaces** this pipeline on the
  server. `sudojo_api/src/routes/ocr.ts` calls it first when `OCR_ML_URL` is set
  (`src/services/ocr-ml-proxy.ts`) and falls back to this library otherwise. Both return the same
  `SolverBoard`-shaped `{board, confidence, digitCount}`. Its `bench/run_tesseract.ts` uses this
  package with sudojo_api's exact config as the baseline. Its CLAUDE.md quotes this repo's older
  100% / 98.8% / 92.6% digit scores. The current numbers are in `docs/OCR.md`.

## Repo Map

```
src/
  index.ts                 root exports (curated subset of algorithms)
  types.ts                 OCRConfig/Result/Progress, CanvasAdapter, Tesseract shims, OCR_* constants
  ocr.ts                   entire pipeline (~1650 lines, including the private pencilmark passes)
  adapters/{web,node}.ts   CanvasAdapter implementations; types.ts/index.ts are type re-exports
  algorithms/
    imageProcessing.ts     grayscale, blur, Sobel edges, contrast, binarize, Otsu, median, dilate,
                           removeGridLines, removeEdgeSpanningLines, isCellEmpty
    boardDetection.ts      detectBoardRectangle (+ fallbacks), squarifyRectangle
    cellClassification.ts  findConnectedComponents; classifyCellContent/isPencilmarkPresent (unused by ocr.ts)
    digitParsing.ts        parseDigitFromText + CORRECTIONS map
    *.test.ts              unit tests on synthetic pixel data
  test/ocr.test.ts         e2e: 3 digit boards (≥77/81 each) + pencilmark board
  test/fixtures/           Sudoku-Board-{1,2,3}, Sudoku-Board-Pencilmarks.png
tests/                     NOT vitest (no .test suffix), bun scripts plus the accuracy corpus
  <img> + <img>_truth.txt + <img>_results.json   for lvc39h9c6ra81, pencilmarks-full, pencil_marks_sample
  evaluate-truth.ts, validate-pencilmarks.ts, diagnose-cells*.ts
docs/                      see docs/README.md
plans/IMPROVEMENTS.md      improvement backlog
```

## Conventions

- Algorithms are pure functions on `ImageDataLike` (RGBA `Uint8ClampedArray`) with no canvas
  access. Canvas I/O belongs in adapters.
- Binarized images use black ink on white. "Dark" means channel 0 `< 128`. Index `= row * 9 + col`.
- Defensive index guards (`arr[i] ?? 0`, `safeGet`) are used throughout. Keep them.
- Imports use `.js` suffixes (ESM). Prettier: single quotes, semicolons, width 80, `es5` trailing commas.
- A new public function goes in `algorithms/index.ts`, and also in `src/index.ts` if public.
- A new adapter needs a `src/adapters/<name>.ts` factory plus a `package.json` `exports` entry.
- Pipeline tuning is empirical. Re-run `tests/evaluate-truth.ts` and `src/test` before and after,
  and record findings in `docs/OCR.md`.

## Gotchas

- **Output pencilmarks aren't the OCR'd marks.** In pencilmark mode, OCR only decides *whether*
  the board has pencilmarks. If any cell does, every empty cell gets the **legal candidates**
  computed from the recognized givens (`computeLegalPencilmarks`). OCR'd sub-cell digits are
  discarded.
- A new Tesseract worker is created and terminated **per call**. There's no pooling, and callers
  can't pass `langPath`/`cachePath`, so offline or self-hosted traineddata relies on the cwd cache.
- Pencilmark mode is slow. P4 runs four whole-cell OCRs on **every** cell (empties included), on
  top of P1–P3. Budget minutes per image in Node.
- `createNodeAdapter()` is async. `new NodeCanvasAdapter().createCanvas()` throws until `init()`.
- `toTesseractInput()` returns an `HTMLCanvasElement` on web and a PNG `Buffer` on Node.
- `parseDigitFromText` maps `'0'`/`O`/`o` → 9 on purpose: OCR "0" in a non-empty cell is usually a 9.
- `OCR_BINARIZE_THRESHOLD` (160) and `OCR_PENCILMARK_MIN_INK_RATIO` are **dead constants**. Real
  binarization is range-relative (`binarize(img, 0.3)`) or Otsu.
- Code comments in `ocr.ts` say "SPARSE_TEXT" where pass 1 actually uses `PSM.SINGLE_BLOCK`.
- Test files are excluded from `tsc` (`tsconfig.json` `exclude`). `tests/*.ts` is covered by
  neither typecheck, lint, nor prettier.
- Both `eslint.config.js` and `eslint.config.mjs` exist. ESLint loads **`.js`**, so `.mjs` is dead.
- `@sudobility/sudojo_types` is a peer only, not a devDependency. `bun.lock` still resolves it to
  `1.2.36` while the peer range is `^1.2.67`.
- `dist/` is gitignored but a stale local copy may exist. Rebuild before linking into a sibling.

## Known Issues (not fixed)

- `src/ocr.ts:764`: the pass-1 `worker.recognize` isn't in a try block, and `worker.terminate()`
  (`:1083`, `:1381`) isn't in a `finally`. A throw leaks the Tesseract worker.
- `src/adapters/web.ts:74`: `URL.createObjectURL` is never revoked.
- `src/algorithms/boardDetection.ts:362`: the doc says it can return `null`, but the dark-pixel
  fallback always returns a rectangle, so the crop branch always runs.
- `OCRProgress.status: 'error'` is never emitted. In pencilmark mode, progress stalls near 57%
  until 95%.
- `src/test/ocr.test.ts` pencilmark cases take 30–50 s each against a 120 s timeout. Under CPU load
  one timed out, so `bun run verify` and `prepublishOnly` can flake.
- Accuracy regressed on `lvc39h9c6ra81.jpg`, from 81/81 to 80/81 digits, since `docs/OCR.md` was
  first written (see its table).

## Cross-Repo Contracts

| Repo | Relation |
|---|---|
| `sudojo_types` | **Peer dep** (`^1.2.67`). `OCRResult.board` is its `SolverBoard` |
| `sudojo_api` | `^1.1.42` + `tesseract.js ^5.1.1`, `/node`. `src/routes/ocr.ts` runs `{cellMargin: 0.03, recognizePencilmarks: true, preprocess: true, minConfidence: 1}` as the fallback behind sudojo_ocr_ml |
| `sudojo_bot` | `^1.1.42` + `tesseract.js ^5.1.1`, `/node`, same config (`src/services/ocrService.ts`) |
| `sudojo_app` | `^1.1.42` + `tesseract.js ^7.0.0`, `/web`. `src/utils/SudokuOCR.ts` wraps all 3 functions; `components/sudoku/ScanBoard.tsx` uses the same config as the API |
| `sudojo_app_rn` | no dependency; server-side OCR through sudojo_api |
| `sudojo_ocr_ml` | `bench/` depends on `^1.1.41` as the Tesseract baseline. Its service supersedes this library on the server |

Changing `OCRResult`, `OCRConfig` defaults, or subpath exports affects all of the above. Keep the
`tesseract.js` peer range at `^5 || ^6 || ^7`: `sudojo_app` is on v7, while the API, bot, and bench
are on v5.

## Git Workflow

- Do not use feature branches for code changes. Always stay on the current branch.
