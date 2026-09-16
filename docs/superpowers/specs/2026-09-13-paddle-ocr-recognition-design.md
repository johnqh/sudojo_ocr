# PaddleOCR Recognition — Design

**Status:** approved design, not yet implemented
**Date:** 2026-09-13
**Repos touched:** `sudojo_ocr`, `sudojo_api`, `sudojo_types`, `sudojo_client`, `sudojo_app`, `sudojo_app_rn`, `sudojo_extension`, `sudojo_bot`

## Goal

Replace Tesseract with the `paddle_ocr` HTTP service as `sudojo_ocr`'s recognition engine, and let
callers choose the OCR route by image source:

- **RN camera capture** → paddle only.
- **Web, or RN photo-library pick** → `sudojo_ocr_ml` first, paddle on failure.

Tesseract is removed entirely. Frontends keep talking only to `sudojo_api`.

## Naming, because three things are called "ocr"

| Name | What it is | Address |
| --- | --- | --- |
| `sudojo_ocr` | npm library `@sudobility/sudojo_ocr` — classical CV, runs **in-process** | none |
| `sudojo_ocr_ml` | HTTP service, Python/FastAPI + ONNX, Sudoku-specific | `sudoocr.sudobility.com` (:8081) |
| `paddle_ocr` | HTTP service, Python/FastAPI + PaddleOCR, **generic document text** | `ocr.sudobility.com` (:8080) |

`sudojo_ocr` has no server and never will under this design. Its only consumer is `sudojo_api`;
every frontend dropped it during the server-side-OCR migration.

## Measured evidence

All numbers below were taken against the live `ocr.sudobility.com` on 2026-09-13, using this repo's
fixtures and the ground-truth strings in `src/test/ocr.test.ts:24-36`.

**With `detectAndCropBoard` applied first, then one `POST /v1/ocr`:**

| Fixture | Crop | Cropped size | Paddle | Correct cells | Given glyph h/cell |
| --- | --- | --- | --- | --- | --- |
| `Sudoku-Board-1.jpg` | 40 ms | 384×384 | 464 ms | **81/81** | 0.56–0.80 |
| `Sudoku-Board-2.png` | 234 ms | 1468×1468 | 1382 ms | **81/81** | 0.53–0.63 |
| `Sudoku-Board-3.jpg` | 143 ms | 836×836 | 928 ms | **81/81** | 0.81–0.99 |

**243/243.** The current Tesseract suite asserts only ≥77/81 per board
(`src/test/ocr.test.ts:40-55`) and takes ~8 minutes across roughly 500–1000 worker round-trips.

**Without cropping**, the same three images score 81, 62 and 35 — the digits are read correctly but
land in the wrong rows, because the board does not fill the frame. Board detection is therefore
load-bearing, not optional: `Sudoku-Board-3.jpg` additionally returns the page's cover text
(`'LARGE PRINT'`, `'Puzzle Book for Adults'`, `'EASY'`) as blocks.

**No montage is needed.** On a cropped board, Paddle emits one block per digit at 100 % confidence;
the grid lines separate the glyphs. An earlier plan to tile 81 cells into a spaced montage was
solving a problem that does not exist, and would have inflated a ~400 KB request to 1800×1800 px.

## Architecture

```
FE (web / RN / ext / bot)   →  sudojo_api  POST /api/v1/ocr/extract  { image, source }
                                   │
                    source=camera  ├──────────────► sudojo_ocr (in-process CV) ──HTTP──► paddle_ocr
                                   │                                                     ocr.sudobility.com
                    source=library ├──► sudojo_ocr_ml (sudoocr.sudobility.com)
                                   │        └── on failure (not 422) ──► sudojo_ocr ──► paddle_ocr
                                   └──  Tesseract: deleted
```

`sudojo_ocr` keeps board detection and swaps everything after it for one HTTP call. The new pipeline is:

```
load image → detect + squarify + crop → POST cropped board to paddle_ocr → map blocks to cells
           → removeConflictingDigits → computeLegalPencilmarks → assemble SolverBoard
```

Two stages leave the main path entirely:

- **Preprocess** (`src/ocr.ts:1470-1488`, contrast stretch + gamma) — the 243/243 measurements used the
  raw crop with no preprocessing; PP-OCRv6 does its own normalization. `cfg.preprocess` becomes a no-op.
- **Cell extraction** (`src/ocr.ts:1490-1497`) — Paddle reads the whole board in one pass, so the 81
  crops are never made. `cfg.cellMargin` and `cfg.minConfidence` become no-ops. `extractCellImages`
  stays exported for UI previews.

The canvas passed to Paddle is `croppedCanvas` (the un-preprocessed crop), not `processedCanvas`.

## `sudojo_ocr` changes

### The seam

`recognizeCells` (`src/ocr.ts:1288-1384`) has exactly **one** call site (`src/ocr.ts:1507-1523`).
Above it is pure canvas work; below it is pure array math over `CellRecognition[]`
(`{ digit: number | null; confidence: number }`, `src/ocr.ts:1088-1091`). Everything
Tesseract-related is reachable only through it. Cutting here changes two signatures and nothing else.

- `extractSudokuFromImage(adapter, imageSource, tesseract, config)` → third parameter becomes
  `paddle: PaddleConfig`.
- `recognizeCells(adapter, cells, minConfidence, tesseract, …)` → fourth parameter becomes the same.

### New `src/paddle.ts`

```ts
export interface PaddleConfig {
  /** Base URL of the paddle_ocr service, e.g. "http://ocr.sudobility.com" */
  url: string;
  /** Request timeout in ms. Default 30000. */
  timeoutMs?: number;
}
```

`recognizeBoard(adapter, boardCanvas, cfg): Promise<{ cells: CellRecognition[]; pencilmarkCells: boolean[] }>`

1. Serialize with `adapter.toDataURL(boardCanvas).split(',')[1]` — uniform PNG base64 on both
   adapters, and exactly what `POST /v1/ocr` expects (`paddle_ocr/src/paddle_ocr/schemas.py:34`).
   Note `paddle_ocr` does **not** strip a `data:` prefix (`app.py:125` calls `b64decode` directly).
2. `POST ${url}/v1/ocr` with `{ image }`, under an `AbortController` bounded by `timeoutMs`.
3. Normalize full-width digits (`'３６'` → `'36'`) before matching; Paddle returns them on some
   pencilmark boards.
4. Map every block to a cell by exact geometry: `col = floor(cx * 9 / width)`,
   `row = floor(cy * 9 / height)`, where `cx`/`cy` are the bbox centre.
5. Classify (see below) and return two 81-length arrays, row-major.

`Block.confidence` is already 0–100 (`paddle_ocr/src/paddle_ocr/schemas.py:19`), the same scale
`avgConfidence` (`src/ocr.ts:1542-1545`) assumes. No rescaling.

### Given vs pencilmark classification

Measured on the two pencilmark fixtures, height alone does **not** separate them: single-digit blocks
span h/cell 0.22–0.67 while multi-char blocks span 0.41–1.01. Paddle merges a vertical column of
candidates into one tall, narrow block — e.g. `('147', h=1.01, w=0.32)`. Two signals together work:

- A cell containing **more than one block** is a pencilmark cell. Givens are always exactly one block.
  (Measured: 39 and 51 such cells on the two fixtures; per-cell block counts run 1–5.)
- For a single-block cell, it is a **given** iff the block's text matches `/^[1-9]$/` **and**
  `bbox.height / cellHeight >= GIVEN_HEIGHT_RATIO` (0.45). Givens measured 0.53–0.99 across the three
  clean boards; lone candidates 0.22–0.35.

Tune `GIVEN_HEIGHT_RATIO` against the labelled candidate sets in `tests/*_truth.txt`.

This classifier only has to be approximately right. `src/ocr.ts:1525-1531` **discards** the recognized
marks and re-derives what it emits from `computeLegalPencilmarks(cellResults)`
(`src/ocr.ts:1134-1171`), which depends only on the givens. The classifier's real jobs are therefore
(a) never mistake a candidate for a given, and (b) set the `autopencil` flag
(`src/ocr.ts:1547`, `1555-1558`).

### Deletions

| What | Where | Why |
| --- | --- | --- |
| Sub-cell pencilmark pipeline | `src/ocr.ts:575-683` | Paddle needs one bit per cell, not 9 sub-cell OCR calls |
| Passes 4–5 (whole-cell re-verify, template match) | `src/ocr.ts:880-1074` | Exist only to compensate for Tesseract's per-cell unreliability |
| `tesseract.js` peer dependency | `package.json:52` | No longer referenced |
| `src/adapters/web.ts`, `toTesseractInput` | `src/types.ts:132`, `src/adapters/web.ts:152`, `node.ts:173` | No browser consumer remains; it is the only platform-divergent adapter method |
| Tesseract confusion table tests | `src/algorithms/digitParsing.test.ts` | Paddle's confusion set differs; assertions are Tesseract-specific |

`classifyCellContent` and `isPencilmarkPresent` (`src/algorithms/cellClassification.ts:106,149`) are
already dead in the pipeline — `src/ocr.ts` never calls them. Leave their exports alone; this design
does not depend on them.

### Testing

- Unit: fixtures + a faked paddle response (an object literal — `paddle_ocr`'s own tests "fake the
  pipeline at the boundary", `paddle_ocr/README.md:96`). Covers block→cell geometry, full-width
  normalization, the given/pencilmark rule, timeout and non-2xx handling.
- Integration (opt-in via env, skipped by default): the three clean fixtures against the live
  service, asserting **81/81** — not ≥77/81.
- There is no existing Tesseract mock to reuse; nothing is lost by deleting the old harness.

## `sudojo_api` changes

- `extractSchema` (`src/routes/ocr.ts:40-42`) gains
  `source: z.enum(['camera', 'library']).default('library')`.
- Dispatch in `src/routes/ocr.ts:61-100`:
  - `camera` → paddle path only.
  - `library` → `extractViaML`; on any failure **except** HTTP 422, fall back to the paddle path.
    The existing 422 short-circuit is unchanged: the model read the image and found too few clues, so
    a retry on the same pixels is pointless.
- New env: `PADDLE_OCR_URL`, `PADDLE_OCR_TIMEOUT_MS` (default 30000). Document in `.env.example` and
  `CLAUDE.md`. `OCR_ML_URL` / `OCR_ML_TIMEOUT_MS` are unchanged.
- **Unconfigured and all-failed cases.** With `PADDLE_OCR_URL` empty the paddle path is disabled: a
  `camera` request then returns 503 (`"Image recognition is unavailable"`), and a `library` request
  uses `sudojo_ocr_ml` alone. With both backends disabled, every request returns 503. When `library`
  tries both and both fail, return the **ML** error, since it is the preferred engine and its message
  is the more specific one. There is no Tesseract to fall through to any more, so a failure is now a
  real failure rather than a slow degradation.
- The "paddle path" means calling `extractSudokuFromImage(adapter, imageBuffer, { url, timeoutMs })`
  from `@sudobility/sudojo_ocr` in-process — same `createNodeAdapter()` singleton as today
  (`src/routes/ocr.ts:26-34`), same `{ skipBoardDetection: false, preprocess: true, cellMargin: 0.03,
  recognizePencilmarks: true }` config (`src/routes/ocr.ts:119-125`). The `minConfidence` option is
  dropped with the standard `recognizeCells` path.
- Delete the Tesseract branch (`src/routes/ocr.ts:102-153`), the `eng.traineddata` file, and the
  `tesseract.js` dependency. `@sudobility/sudojo_ocr` **stays** — it is the CV half and the paddle client.
- `getEnv` is read at module import (`src/services/ocr-ml-proxy.ts:16-17`), so the same applies to the
  new vars: changing them needs a restart.

## Contract changes

`sudojo_types`:

```ts
export type OcrSource = 'camera' | 'library';
```

`OCRExtractData` gains an optional `engine?: 'ml' | 'paddle'` so responses say which backend answered.
This is additive; existing consumers ignore it.

`sudojo_client` — `extractOcr(token, image, options)` gains `source`:

```ts
async extractOcr(
  token: string,
  image: string,
  options: { source?: OcrSource; timeout?: Optional<number> } = {},
): Promise<BaseResponse<OCRExtractData>>
```

sending `{ image, source }`. `useSudojoOcrExtract`'s `OcrExtractVariables` gains the same field.

Frontends:

| Repo | Change |
| --- | --- |
| `sudojo_app` | `ScanBoard.tsx` sends `source: 'library'` |
| `sudojo_app_rn` | `extractPuzzleFromImage(..., source)`; `EnterPuzzleScreen.tsx:329` already has `source` in hand, and `handleScan('gallery')` maps to `'library'` |
| `sudojo_extension`, `sudojo_bot` | send `source: 'library'` |

## Risks

1. **No perspective correction.** `detectAndCropBoard` (`src/ocr.ts:1425-1468`) does an axis-aligned
   bounding-rectangle crop plus `squarifyRectangle`; a skewed photo is never warped. Camera is the
   path routed to paddle exclusively, and every fixture measured here is a flat scan. **Measure paddle
   on genuinely skewed phone photos before calling the camera path done.** If accuracy is poor, the
   options are a perspective warp in the CV half, or routing camera through `sudojo_ocr_ml`'s
   CornerNet detector — which is what it was built for.
2. **Paddle has no board detector**, so classical CV quality is the ceiling on camera accuracy.
3. **`paddle_ocr` is a single GPU service** with a queue (`queue_depth` in `/healthz`). Two OCR
   backends now share one Windows box. Watch latency under concurrency.
4. **Plain HTTP.** Both `OCR_ML_URL` and the new `PADDLE_OCR_URL` are `http://`, so board images cross
   the wire unencrypted. Pre-existing, unchanged by this design, worth fixing separately.
5. **Reachability.** `sudojo_api`'s egress IP must be allowed by `ocr.sudobility.com`'s IIS IP
   allowlist, the same treatment `sudojo_ocr_ml` received.

## Out of scope

- TLS for either OCR service.
- Perspective warping (unless risk 1 forces it).
- Retiring `@sudobility/sudojo_ocr` as a package — it stays, as `sudojo_api`'s CV dependency.
