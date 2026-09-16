# PaddleOCR Recognition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Tesseract with the `paddle_ocr` HTTP service as `sudojo_ocr`'s recognition engine, and route OCR by image source — RN camera to paddle only, everything else to `sudojo_ocr_ml` with paddle as fallback.

**Architecture:** `sudojo_ocr` stays an in-process library. It keeps board detection, then posts the cropped board as one image to `paddle_ocr` and maps each returned text block to a cell by exact grid geometry. `sudojo_api` becomes a dispatcher over two interchangeable backends (`sudojo_ocr_ml` and paddle-via-`sudojo_ocr`), selected by a new `source` field that the frontends send.

**Tech Stack:** Bun, TypeScript, vitest (`sudojo_ocr`, `sudojo_api`, `sudojo_client`); Hono + zod (`sudojo_api`); React/React Native (frontends). `@napi-rs/canvas` via `createNodeAdapter()`. No new runtime dependencies — `fetch` is built in.

**Spec:** `docs/superpowers/specs/2026-09-13-paddle-ocr-recognition-design.md` (in `sudojo_ocr`)

## Global Constraints

- **Bun only.** Never npm, yarn, or pnpm. `bun install`, `bun run test`, `bunx vitest run <file>`.
- **Git policy — every repo here forbids auto-commit and auto-push.** The `git commit` steps below are part of the recipe, but run them **only when the user explicitly asks in that turn**. Finishing a task is not permission to commit it. Never run `push_all.sh` unprompted.
- **Do not use feature branches.** Stay on the current branch.
- `paddle_ocr` base URL: `http://ocr.sudobility.com` (plain HTTP, port 8080 on the box). Health: `GET /healthz`. Recognition: `POST /v1/ocr` with `{ "image": "<base64, no data: prefix>" }`.
- `paddle_ocr` does **not** strip a `data:` URL prefix — it calls `b64decode(body.image, validate=True)` directly. Always strip it client-side.
- `Block.confidence` from paddle is already 0–100. Do not rescale.
- `MIN_CLUES = 17` everywhere.
- Given/pencilmark threshold constant: `GIVEN_HEIGHT_RATIO = 0.45`.
- Default paddle timeout: `30000` ms.
- Accuracy bar for the live integration test: **81/81** on the three clean fixtures, not the old ≥77/81.
- Release order for this family is fixed: `sudojo_types → sudojo_ocr → sudojo_api → sudojo_client → sudojo_lib → sudojo_ui → sudojo_app → sudojo_app_rn → sudojo_extension → sudojo_bot`.

---

## File Structure

**`sudojo_ocr`** (bulk of the work)

| File | Responsibility |
| --- | --- |
| `src/paddle.ts` *(new)* | The paddle client: serialize a board canvas, POST it, map blocks → cells, classify given vs pencilmark. Owns all HTTP and all geometry. |
| `src/paddle.test.ts` *(new)* | Unit tests for the above against faked responses. No network. |
| `src/types.ts` | Add `PaddleConfig`; drop `TesseractModule`, `TesseractWorker`, `toTesseractInput`. |
| `src/ocr.ts` | Rewire `extractSudokuFromImage` to call `recognizeBoard`; delete the Tesseract recognition machinery. |
| `src/adapters/node.ts`, `src/adapters/web.ts`, `src/adapters/index.ts` | Drop `toTesseractInput`; delete the web adapter. |
| `src/index.ts`, `src/algorithms/index.ts` | Fix barrel exports after deletions. |
| `src/test/ocr.test.ts` | Rewrite: faked-paddle unit path + opt-in live integration at 81/81. |
| `src/algorithms/digitParsing.test.ts` | Delete (Tesseract-specific confusion table). |
| `package.json` | Drop `tesseract.js` peer dep; drop the `./web` export. |

**`sudojo_types`** — `src/index.ts`: add `OcrSource`, add `OCRExtractData.engine?`.

**`sudojo_client`** — `src/network/sudojo-client.ts` (`extractOcr` gains `source`), `src/hooks/use-sudojo-ocr.ts` (`OcrExtractVariables` gains `source`), `src/network/__tests__/ocr.test.ts`.

**`sudojo_api`** — `src/services/ocr-paddle.ts` *(new, the in-process paddle path)*, `src/routes/ocr.ts` (dispatch), `.env.example`, `CLAUDE.md`. Delete `eng.traineddata`.

**Frontends** — `sudojo_app/src/components/sudoku/ScanBoard.tsx`, `sudojo_app_rn/src/services/ocrService.ts` + `src/screens/EnterPuzzleScreen.tsx`, `sudojo_extension`, `sudojo_bot`.

---

## Task 1: Paddle client — block→cell geometry

**Files:**
- Create: `src/paddle.ts`
- Create: `src/paddle.test.ts`
- Modify: `src/types.ts` (append `PaddleConfig`)

**Interfaces:**
- Consumes: `CanvasAdapter`, `CanvasLike`, `CellRecognition` from `src/types.ts` / `src/ocr.ts`.
- Produces:
  - `export interface PaddleConfig { url: string; timeoutMs?: number }`
  - `export interface PaddleBlock { text: string; confidence: number; bbox: { x: number; y: number; width: number; height: number } }`
  - `export interface BoardRecognition { cells: CellRecognition[]; pencilmarkCells: boolean[] }`
  - `export function mapBlocksToBoard(blocks: PaddleBlock[], width: number, height: number): BoardRecognition`
  - `export async function recognizeBoard(adapter: CanvasAdapter, board: CanvasLike, cfg: PaddleConfig): Promise<BoardRecognition>`
  - `export const GIVEN_HEIGHT_RATIO = 0.45`

`CellRecognition` is `{ digit: number | null; confidence: number }` (currently declared at `src/ocr.ts:1088-1091`). Move it into `src/types.ts` and re-export from `src/ocr.ts` so both files can use it without a cycle.

- [ ] **Step 1: Write the failing test for pure geometry**

Create `src/paddle.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapBlocksToBoard, type PaddleBlock } from './paddle.js';

/** A block centred on cell (row, col) of a 900x900 board (100px cells). */
function blockAt(
  row: number,
  col: number,
  text: string,
  heightRatio = 0.6,
  widthRatio = 0.4
): PaddleBlock {
  const cell = 100;
  const h = cell * heightRatio;
  const w = cell * widthRatio;
  return {
    text,
    confidence: 100,
    bbox: {
      x: Math.round(col * cell + (cell - w) / 2),
      y: Math.round(row * cell + (cell - h) / 2),
      width: Math.round(w),
      height: Math.round(h),
    },
  };
}

describe('mapBlocksToBoard', () => {
  it('places each digit in its cell, row-major', () => {
    const blocks = [blockAt(0, 0, '5'), blockAt(0, 8, '4'), blockAt(8, 8, '6')];
    const { cells } = mapBlocksToBoard(blocks, 900, 900);
    expect(cells).toHaveLength(81);
    expect(cells[0].digit).toBe(5);
    expect(cells[8].digit).toBe(4);
    expect(cells[80].digit).toBe(6);
    expect(cells[1].digit).toBeNull();
  });

  it('normalizes full-width digits', () => {
    const { cells } = mapBlocksToBoard([blockAt(1, 1, '７')], 900, 900);
    expect(cells[10].digit).toBe(7);
  });

  it('treats a cell with more than one block as pencilmarks, not a given', () => {
    const blocks = [blockAt(2, 2, '1', 0.3), blockAt(2, 2, '4', 0.3)];
    const { cells, pencilmarkCells } = mapBlocksToBoard(blocks, 900, 900);
    expect(cells[20].digit).toBeNull();
    expect(pencilmarkCells[20]).toBe(true);
  });

  it('treats a lone small glyph as a pencilmark', () => {
    const { cells, pencilmarkCells } = mapBlocksToBoard(
      [blockAt(3, 3, '9', 0.3)],
      900,
      900
    );
    expect(cells[30].digit).toBeNull();
    expect(pencilmarkCells[30]).toBe(true);
  });

  it('treats a lone tall glyph as a given', () => {
    const { cells, pencilmarkCells } = mapBlocksToBoard(
      [blockAt(3, 3, '9', 0.6)],
      900,
      900
    );
    expect(cells[30].digit).toBe(9);
    expect(pencilmarkCells[30]).toBe(false);
  });

  it('treats a multi-character block as pencilmarks', () => {
    const { cells, pencilmarkCells } = mapBlocksToBoard(
      [blockAt(4, 4, '147', 1.0, 0.32)],
      900,
      900
    );
    expect(cells[40].digit).toBeNull();
    expect(pencilmarkCells[40]).toBe(true);
  });

  it('ignores blocks whose centre falls outside the board', () => {
    const stray: PaddleBlock = {
      text: '3',
      confidence: 100,
      bbox: { x: 920, y: 10, width: 20, height: 60 },
    };
    const { cells } = mapBlocksToBoard([stray], 900, 900);
    expect(cells.every(c => c.digit === null)).toBe(true);
  });

  it('ignores non-digit text such as page headings', () => {
    const { cells } = mapBlocksToBoard(
      [blockAt(0, 0, 'LARGE PRINT', 0.6, 0.9)],
      900,
      900
    );
    expect(cells[0].digit).toBeNull();
  });

  it('carries paddle confidence through unscaled', () => {
    const b = blockAt(0, 0, '5');
    b.confidence = 87.5;
    const { cells } = mapBlocksToBoard([b], 900, 900);
    expect(cells[0].confidence).toBe(87.5);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd ~/projects/sudojo_ocr && bunx vitest run src/paddle.test.ts`
Expected: FAIL — `Failed to resolve import "./paddle.js"`.

- [ ] **Step 3: Add `PaddleConfig` and move `CellRecognition` into `src/types.ts`**

Append to `src/types.ts`:

```ts
/** Where a recognized digit came from, per cell. */
export interface CellRecognition {
  digit: number | null;
  confidence: number;
}

/** Connection settings for the paddle_ocr recognition service. */
export interface PaddleConfig {
  /** Base URL, e.g. "http://ocr.sudobility.com". No trailing slash. */
  url: string;
  /** Request timeout in ms. Default 30000. */
  timeoutMs?: number;
}
```

In `src/ocr.ts`, delete the local `CellRecognition` interface (currently `src/ocr.ts:1088-1091`) and import it from `./types.js` instead, keeping `export type { CellRecognition }` if it was previously re-exported.

- [ ] **Step 4: Implement `mapBlocksToBoard`**

Create `src/paddle.ts`:

```ts
/**
 * Recognition via the paddle_ocr HTTP service.
 *
 * PaddleOCR reads the whole cropped board in one pass: on a board that fills
 * the frame it emits one block per digit, so cells are assigned by exact grid
 * geometry rather than by cropping 81 images. Board detection upstream is what
 * makes that true - on an uncropped photo the digits land in the wrong rows and
 * the page's own text arrives as blocks.
 */

import type { CanvasAdapter, CanvasLike, CellRecognition, PaddleConfig } from './types.js';

/** One text region as paddle_ocr returns it. Confidence is already 0-100. */
export interface PaddleBlock {
  text: string;
  confidence: number;
  bbox: { x: number; y: number; width: number; height: number };
}

export interface BoardRecognition {
  cells: CellRecognition[];
  pencilmarkCells: boolean[];
}

/**
 * A lone glyph at least this tall, relative to its cell, is a given.
 *
 * Measured across the three clean fixtures, givens run 0.53-0.99 of cell
 * height while lone candidates run 0.22-0.35.
 */
export const GIVEN_HEIGHT_RATIO = 0.45;

const FULL_WIDTH_DIGITS = /[０-９]/g;

/** Paddle returns full-width digits on some pencilmark boards. */
function normalizeDigits(text: string): string {
  return text
    .replace(FULL_WIDTH_DIGITS, (d) =>
      String.fromCharCode(d.charCodeAt(0) - 0xfee0)
    )
    .trim();
}

export function mapBlocksToBoard(
  blocks: PaddleBlock[],
  width: number,
  height: number
): BoardRecognition {
  const cellWidth = width / 9;
  const cellHeight = height / 9;

  // Bucket every block by the cell its centre falls in. A cell holding more
  // than one block is pencilmarked: a given is always exactly one block.
  const perCell: PaddleBlock[][] = Array.from({ length: 81 }, () => []);
  for (const block of blocks) {
    const cx = block.bbox.x + block.bbox.width / 2;
    const cy = block.bbox.y + block.bbox.height / 2;
    const col = Math.floor(cx / cellWidth);
    const row = Math.floor(cy / cellHeight);
    if (row < 0 || row > 8 || col < 0 || col > 8) continue;
    perCell[row * 9 + col].push(block);
  }

  const cells: CellRecognition[] = [];
  const pencilmarkCells: boolean[] = [];

  for (let i = 0; i < 81; i++) {
    const found = perCell[i];
    if (found.length === 1) {
      const block = found[0];
      const text = normalizeDigits(block.text);
      const isDigit = /^[1-9]$/.test(text);
      const tall = block.bbox.height / cellHeight >= GIVEN_HEIGHT_RATIO;
      if (isDigit && tall) {
        cells.push({ digit: Number(text), confidence: block.confidence });
        pencilmarkCells.push(false);
        continue;
      }
      // A single small digit is a lone candidate; anything non-digit (a page
      // heading, a merged candidate column) is not a given either.
      cells.push({ digit: null, confidence: 0 });
      pencilmarkCells.push(isDigit || /^[1-9]+$/.test(text));
      continue;
    }
    cells.push({ digit: null, confidence: 0 });
    pencilmarkCells.push(found.length > 1);
  }

  return { cells, pencilmarkCells };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ~/projects/sudojo_ocr && bunx vitest run src/paddle.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit** *(only if the user asked for a commit this turn)*

```bash
git add src/paddle.ts src/paddle.test.ts src/types.ts src/ocr.ts
git commit -m "feat(ocr): add paddle block-to-cell geometry mapping"
```

---

## Task 2: Paddle client — the HTTP call

**Files:**
- Modify: `src/paddle.ts`
- Modify: `src/paddle.test.ts`

**Interfaces:**
- Consumes: `mapBlocksToBoard`, `PaddleConfig`, `PaddleBlock` from Task 1.
- Produces: `recognizeBoard(adapter, board, cfg): Promise<BoardRecognition>`.

- [ ] **Step 1: Write the failing tests**

Append to `src/paddle.test.ts`:

```ts
import { recognizeBoard } from './paddle.js';
import type { CanvasAdapter, CanvasLike } from './types.js';

/** Minimal adapter: recognizeBoard only needs toDataURL plus the dimensions. */
function fakeAdapter(dataUrl: string): CanvasAdapter {
  return { toDataURL: () => dataUrl } as unknown as CanvasAdapter;
}
const fakeBoard = { width: 900, height: 900 } as unknown as CanvasLike;

describe('recognizeBoard', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('posts raw base64 with the data: prefix stripped', async () => {
    let sentBody: string | undefined;
    let sentUrl: string | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sentUrl = url;
      sentBody = init.body as string;
      return new Response(JSON.stringify({ blocks: [] }), { status: 200 });
    }) as typeof fetch;

    await recognizeBoard(fakeAdapter('data:image/png;base64,AAAB'), fakeBoard, {
      url: 'http://ocr.example.com',
    });

    expect(sentUrl).toBe('http://ocr.example.com/v1/ocr');
    expect(JSON.parse(sentBody!)).toEqual({ image: 'AAAB' });
  });

  it('maps the returned blocks onto the board', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          blocks: [
            {
              text: '5',
              confidence: 100,
              bbox: { x: 20, y: 20, width: 40, height: 60 },
            },
          ],
        }),
        { status: 200 }
      )) as typeof fetch;

    const { cells } = await recognizeBoard(
      fakeAdapter('data:image/png;base64,AAAB'),
      fakeBoard,
      { url: 'http://ocr.example.com' }
    );
    expect(cells[0].digit).toBe(5);
  });

  it('throws with the status on a non-2xx response', async () => {
    globalThis.fetch = (async () =>
      new Response('boom', { status: 500 })) as typeof fetch;

    await expect(
      recognizeBoard(fakeAdapter('data:image/png;base64,AAAB'), fakeBoard, {
        url: 'http://ocr.example.com',
      })
    ).rejects.toThrow(/500/);
  });

  it('aborts after timeoutMs', async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as unknown as typeof fetch;

    await expect(
      recognizeBoard(fakeAdapter('data:image/png;base64,AAAB'), fakeBoard, {
        url: 'http://ocr.example.com',
        timeoutMs: 10,
      })
    ).rejects.toThrow(/timeout/i);
  });
});
```

Add `afterEach` to the existing vitest import at the top of the file.

- [ ] **Step 2: Run and watch it fail**

Run: `cd ~/projects/sudojo_ocr && bunx vitest run src/paddle.test.ts`
Expected: FAIL — `recognizeBoard is not a function`.

- [ ] **Step 3: Implement `recognizeBoard`**

Append to `src/paddle.ts`:

```ts
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Recognize a cropped board via paddle_ocr.
 *
 * The board must already be cropped to the grid: paddle has no board detector,
 * and on an uncropped image the geometry mapping silently misassigns rows.
 */
export async function recognizeBoard(
  adapter: CanvasAdapter,
  board: CanvasLike,
  cfg: PaddleConfig
): Promise<BoardRecognition> {
  // toDataURL is uniform across adapters; paddle wants the payload without the
  // data: prefix, which it does not strip itself.
  const dataUrl = adapter.toDataURL(board);
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;

  const controller = new AbortController();
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${cfg.url}/v1/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64 }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const err = new Error(
        `paddle_ocr error ${response.status}: ${detail.slice(0, 200)}`
      );
      (err as Error & { status?: number }).status = response.status;
      throw err;
    }

    const body = (await response.json()) as { blocks?: PaddleBlock[] };
    return mapBlocksToBoard(body.blocks ?? [], board.width, board.height);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`paddle_ocr timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd ~/projects/sudojo_ocr && bunx vitest run src/paddle.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit** *(only if the user asked for a commit this turn)*

```bash
git add src/paddle.ts src/paddle.test.ts
git commit -m "feat(ocr): add paddle_ocr HTTP client"
```

---

## Task 3: Rewire `extractSudokuFromImage`, delete Tesseract

**Files:**
- Modify: `src/ocr.ts` (signature at `:1396-1403`; call site at `:1505-1523`; delete `:575-683`, `:880-1074`, `:1288-1384`, and the Tesseract helpers at `:209-214`, `:581-588`)
- Modify: `src/types.ts` (delete `TesseractModule` `:176-188`, `TesseractWorker` `:191-202`, `toTesseractInput` `:132`)
- Modify: `src/adapters/node.ts` (`:173`), `src/adapters/index.ts`, `src/index.ts`
- Delete: `src/adapters/web.ts`, `src/algorithms/digitParsing.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `recognizeBoard`, `BoardRecognition`, `PaddleConfig` from Tasks 1–2.
- Produces: `extractSudokuFromImage(adapter: CanvasAdapter, imageSource: unknown, paddle: PaddleConfig, config?: Partial<OCRConfig>, onProgress?: (p: OCRProgress) => void): Promise<OCRResult>` — the third parameter changes from `tesseract: TesseractModule` to `paddle: PaddleConfig`.

- [ ] **Step 1: Change the signature and the call site**

In `src/ocr.ts`, change the third parameter of `extractSudokuFromImage` from `tesseract: TesseractModule` to `paddle: PaddleConfig`, and replace the preprocess stage (`:1470-1488`), cell extraction (`:1490-1497`) and the `recognizeCells` call (`:1505-1523`) with:

```ts
  onProgress?.({
    status: 'recognizing',
    progress: 20,
    message: 'Recognizing digits...',
  });

  // Paddle reads the whole cropped board in one pass. Preprocessing and the 81
  // cell crops existed for Tesseract's per-cell pipeline and are not used here:
  // the 243/243 fixture run went through the raw crop.
  const { cells: rawCellResults, pencilmarkCells } = await recognizeBoard(
    adapter,
    croppedCanvas,
    paddle
  );

  const cellResults = removeConflictingDigits(rawCellResults);
  const hasDetectedPencilmarks = pencilmarkCells.some(Boolean);
```

Leave `:1524` onward (`removeConflictingDigits` result handling, `computeLegalPencilmarks`, board assembly) unchanged apart from `hasDetectedPencilmarks` now coming from `pencilmarkCells`.

Add the import at the top of `src/ocr.ts`:

```ts
import { recognizeBoard } from './paddle.js';
import type { PaddleConfig } from './types.js';
```

- [ ] **Step 2: Delete the Tesseract machinery**

Delete from `src/ocr.ts`, largest line numbers first so earlier ranges stay valid:

1. `recognizeCells` — `:1288-1384`
2. Passes 4–5 (whole-cell re-verification, same-board template matching) — `:880-1074`
3. `recognizeCellsPencilmark` and the sub-cell pipeline — `:575-683`
4. The two structurally-typed worker helpers — `:209-214`, `:581-588`

Then delete from `src/types.ts`: `TesseractModule` (`:176-188`), `TesseractWorker` (`:191-202`), and the `toTesseractInput` member of `CanvasAdapter` (`:132`). Delete its implementations at `src/adapters/node.ts:173` and the whole of `src/adapters/web.ts`. Remove the web adapter from `src/adapters/index.ts` and from the `exports` map and `tesseract.js` from `peerDependencies` in `package.json`. Delete `src/algorithms/digitParsing.test.ts`.

- [ ] **Step 3: Typecheck to find every remaining reference**

Run: `cd ~/projects/sudojo_ocr && bun run typecheck`
Expected: PASS. Any error names a leftover Tesseract reference — delete it and re-run. Common leftovers: `parseDigitFromText` imports, `OCR_TARGET_CELL_SIZE`/`OCR_CELL_PADDING` now unused, `tesseractPSM` parameters.

- [ ] **Step 4: Run the unit suites that do not need the network**

Run: `cd ~/projects/sudojo_ocr && bunx vitest run src/paddle.test.ts src/algorithms/imageProcessing.test.ts src/algorithms/boardDetection.test.ts src/algorithms/cellClassification.test.ts`
Expected: PASS. `src/test/ocr.test.ts` still fails here — Task 4 rewrites it.

- [ ] **Step 5: Commit** *(only if the user asked for a commit this turn)*

```bash
git add -A
git commit -m "refactor(ocr): recognize via paddle_ocr, remove Tesseract"
```

---

## Task 4: Rewrite the end-to-end tests

**Files:**
- Modify: `src/test/ocr.test.ts`

**Interfaces:**
- Consumes: `extractSudokuFromImage(adapter, imageSource, paddle, config?)` from Task 3.
- Produces: nothing downstream.

The old suite imported real `tesseract.js` and asserted ≥77/81 with a 120 s timeout per case (~8 min total). Replace it with a fast faked-paddle path plus an opt-in live run.

- [ ] **Step 1: Write the new test file**

Replace the contents of `src/test/ocr.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractSudokuFromImage, detectAndCropBoard } from '../ocr.js';
import { createNodeAdapter } from '../adapters/node.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');

const BOARDS = [
  {
    file: 'Sudoku-Board-1.jpg',
    expected:
      '509000400708304900601000730462500000385720649107408200200100004003040087070053006',
  },
  {
    file: 'Sudoku-Board-2.png',
    expected:
      '700520008056098000040367050062780000801400002430019060000005000500602931007941500',
  },
  {
    file: 'Sudoku-Board-3.jpg',
    expected:
      '000150000000894062908070050050483020603010500800205309140008090280940005000607800',
  },
];

/** The live service. Opt in: PADDLE_OCR_URL=http://ocr.sudobility.com bun run test */
const LIVE_URL = process.env.PADDLE_OCR_URL;

describe('extractSudokuFromImage with a faked paddle service', () => {
  it('builds a board from the blocks paddle returns', async () => {
    const adapter = await createNodeAdapter();
    const image = readFileSync(join(FIXTURES, 'Sudoku-Board-1.jpg'));

    // Crop first so the fake can compute geometry against the real crop size.
    const cropped = await detectAndCropBoard(adapter, image);
    const size = 384; // Sudoku-Board-1 crops to 384x384
    const cell = size / 9;

    const blocks = [] as unknown[];
    const expected = BOARDS[0].expected;
    for (let i = 0; i < 81; i++) {
      const digit = expected[i];
      if (digit === '0') continue;
      const row = Math.floor(i / 9);
      const col = i % 9;
      blocks.push({
        text: digit,
        confidence: 100,
        bbox: {
          x: Math.round(col * cell + cell * 0.3),
          y: Math.round(row * cell + cell * 0.2),
          width: Math.round(cell * 0.4),
          height: Math.round(cell * 0.6),
        },
      });
    }

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ blocks }), { status: 200 })) as typeof fetch;
    try {
      const result = await extractSudokuFromImage(adapter, image, {
        url: 'http://fake.invalid',
      });
      expect(result.board.original).toBe(expected);
      expect(result.digitCount).toBe(
        expected.split('').filter(d => d !== '0').length
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(cropped).toContain('data:image/png;base64,');
  });
});

describe.skipIf(!LIVE_URL)('extractSudokuFromImage against live paddle_ocr', () => {
  for (const board of BOARDS) {
    it(`reads ${board.file} exactly`, { timeout: 60000 }, async () => {
      const adapter = await createNodeAdapter();
      const image = readFileSync(join(FIXTURES, board.file));
      const result = await extractSudokuFromImage(adapter, image, {
        url: LIVE_URL!,
      });
      let correct = 0;
      for (let i = 0; i < 81; i++) {
        if (result.board.original[i] === board.expected[i]) correct++;
      }
      expect(correct).toBe(81);
    });
  }
});
```

- [ ] **Step 2: Run the offline suite**

Run: `cd ~/projects/sudojo_ocr && bun run test`
Expected: PASS. The live block is skipped (no `PADDLE_OCR_URL`), and the whole suite now finishes in seconds rather than ~8 minutes.

- [ ] **Step 3: Run the live suite to confirm 81/81**

Run: `cd ~/projects/sudojo_ocr && PADDLE_OCR_URL=http://ocr.sudobility.com bun run test`
Expected: PASS, all three boards at exactly 81/81.

- [ ] **Step 4: Verify the whole repo**

Run: `cd ~/projects/sudojo_ocr && bun run typecheck && bun run lint && bun run test`
Expected: all PASS.

- [ ] **Step 5: Commit** *(only if the user asked for a commit this turn)*

```bash
git add src/test/ocr.test.ts
git commit -m "test(ocr): replace tesseract suite with faked + live paddle tests"
```

---

## Task 5: Measure paddle on skewed photos

**Files:**
- Create: `tests/skew-report.md` (findings)

This is the spec's headline risk (§Risks 1): `detectAndCropBoard` does an axis-aligned crop with **no perspective warp**, and camera is the path routed to paddle exclusively. Every fixture measured so far is a flat scan. Do this before declaring the camera path done.

- [ ] **Step 1: Collect skewed inputs**

Take or source at least 5 phone photos of a printed Sudoku at realistic angles (10–30° tilt, some with shadow and page curl). Save them under `tests/skew/` with a `<name>_truth.txt` holding the 81-character ground truth for each.

- [ ] **Step 2: Score them**

Run the live path over each:

```bash
cd ~/projects/sudojo_ocr
PADDLE_OCR_URL=http://ocr.sudobility.com bun run tests/evaluate-truth.ts tests/skew/*.jpg
```

If `tests/evaluate-truth.ts` does not already accept a paddle URL, adapt it to call `extractSudokuFromImage(adapter, image, { url: process.env.PADDLE_OCR_URL })`.

- [ ] **Step 3: Record the verdict in `tests/skew-report.md`**

Record per image: cells correct / 81, and whether failures came from the crop (board mis-detected) or from recognition (digits misread). The distinction decides the fix.

- [ ] **Step 4: Decide**

- **≥ 95% cells correct:** camera-to-paddle is fine as specified. Note it and move on.
- **Failures dominated by mis-cropping:** add a perspective warp to the CV half, or route camera through `sudojo_ocr_ml`'s CornerNet detector — which is what it was built for. Raise this with the user before building either; it changes the spec's routing decision.
- **Failures dominated by misread digits:** paddle is the wrong engine for camera. Raise with the user.

---

## Task 6: `sudojo_types` — `OcrSource` and `engine`

**Files:**
- Modify: `src/index.ts` (near `OCRExtractData`, `:547-551`)

**Interfaces:**
- Produces: `export type OcrSource = 'camera' | 'library'`; `OCRExtractData.engine?: 'ml' | 'paddle'`.

- [ ] **Step 1: Add the type and field**

In `src/index.ts`, replace the `OCRExtractData` interface with:

```ts
/** Where the scanned image came from. Chooses the OCR route server-side. */
export type OcrSource = "camera" | "library";

/** Response data for POST /api/v1/ocr/extract */
export interface OCRExtractData {
  board: SolverBoard;
  confidence: number;
  digitCount: number;
  /** Which backend produced this result. Absent on older API versions. */
  engine?: "ml" | "paddle";
}
```

- [ ] **Step 2: Verify**

Run: `cd ~/projects/sudojo_types && bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 3: Commit** *(only if the user asked for a commit this turn)*

```bash
git add src/index.ts
git commit -m "feat(types): add OcrSource and OCRExtractData.engine"
```

---

## Task 7: `sudojo_client` — send `source`

**Files:**
- Modify: `src/network/sudojo-client.ts:1267-1287`
- Modify: `src/hooks/use-sudojo-ocr.ts:11-18,55-58`
- Modify: `src/network/__tests__/ocr.test.ts`

**Interfaces:**
- Consumes: `OcrSource` from Task 6.
- Produces: `extractOcr(token: string, image: string, options?: { source?: OcrSource; timeout?: Optional<number> })`; `OcrExtractVariables` gains `source?: OcrSource`.

- [ ] **Step 1: Write the failing test**

Append to `src/network/__tests__/ocr.test.ts`:

```ts
it("sends the source hint when given", async () => {
  const networkClient = new MockNetworkClient();
  const client = new SudojoClient(networkClient, "https://api.example.com");
  networkClient.setResponse("/api/v1/ocr/extract", {
    success: true,
    data: { board: { original: "", user: "", pencilmark: null }, confidence: 0, digitCount: 0 },
  });

  await client.extractOcr("tok", "data:image/png;base64,AAAB", {
    source: "camera",
  });

  const body = networkClient.lastRequest()?.body as Record<string, unknown>;
  expect(body).toEqual({ image: "AAAB", source: "camera" });
});

it("defaults to library when no source is given", async () => {
  const networkClient = new MockNetworkClient();
  const client = new SudojoClient(networkClient, "https://api.example.com");
  networkClient.setResponse("/api/v1/ocr/extract", {
    success: true,
    data: { board: { original: "", user: "", pencilmark: null }, confidence: 0, digitCount: 0 },
  });

  await client.extractOcr("tok", "AAAB");

  const body = networkClient.lastRequest()?.body as Record<string, unknown>;
  expect(body).toEqual({ image: "AAAB", source: "library" });
});
```

Match the existing file's `MockNetworkClient` helper usage — read the top of `src/network/__tests__/ocr.test.ts` and reuse whatever accessor it already uses to inspect the sent body rather than inventing `lastRequest()` if a different one exists.

- [ ] **Step 2: Run and watch it fail**

Run: `cd ~/projects/sudojo_client && bunx vitest run src/network/__tests__/ocr.test.ts`
Expected: FAIL — body is `{ image: "AAAB" }`, missing `source`.

- [ ] **Step 3: Implement**

In `src/network/sudojo-client.ts`, change `extractOcr`:

```ts
  async extractOcr(
    token: string,
    image: string,
    options: { source?: OcrSource; timeout?: Optional<number> } = {},
  ): Promise<BaseResponse<OCRExtractData>> {
    // Callers hold images as canvas/file data URLs; the API wants raw base64.
    const base64 = image.replace(/^data:[^;,]*;base64,/, "").trim();
    if (!base64) {
      throw new Error("extractOcr: image is empty");
    }

    return this.request<BaseResponse<OCRExtractData>>(
      this.config.ENDPOINTS.OCR_EXTRACT,
      {
        method: "POST",
        body: { image: base64, source: options.source ?? "library" },
        token,
        timeout: options.timeout ?? 60000,
      },
    );
  }
```

Add `OcrSource` to the type import from `@sudobility/sudojo_types` at the top of the file.

In `src/hooks/use-sudojo-ocr.ts`, add to `OcrExtractVariables`:

```ts
  /** Where the image came from. Camera captures go straight to paddle_ocr. */
  source?: OcrSource;
```

and pass it through the mutation:

```ts
    mutationFn: async ({ token, image, source, timeout }: OcrExtractVariables) =>
      client.extractOcr(token, image, { source, timeout }),
```

- [ ] **Step 4: Run the tests**

Run: `cd ~/projects/sudojo_client && bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 5: Commit** *(only if the user asked for a commit this turn)*

```bash
git add src/network/sudojo-client.ts src/hooks/use-sudojo-ocr.ts src/network/__tests__/ocr.test.ts
git commit -m "feat(client): send OCR source hint"
```

---

## Task 8: `sudojo_api` — paddle service wrapper

**Files:**
- Create: `src/services/ocr-paddle.ts`
- Create: `tests/ocr-paddle.test.ts`
- Modify: `.env.example` (after the `OCR_ML_*` block at `:93-100`)

**Interfaces:**
- Consumes: `extractSudokuFromImage(adapter, imageSource, paddle, config?)` from Task 3.
- Produces: `isPaddleEnabled(): boolean`; `extractViaPaddle(image: string): Promise<OCRExtractData>`.

This mirrors `src/services/ocr-ml-proxy.ts` so the route can treat both backends the same way.

- [ ] **Step 1: Write the failing test**

Create `tests/ocr-paddle.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isPaddleEnabled } from "../src/services/ocr-paddle";

describe("isPaddleEnabled", () => {
  it("is false when PADDLE_OCR_URL is unset", () => {
    // The module reads env at import time, and .env.test sets no OCR vars.
    expect(isPaddleEnabled()).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd ~/projects/sudojo_api && bunx vitest run tests/ocr-paddle.test.ts`
Expected: FAIL — cannot resolve `../src/services/ocr-paddle`.

- [ ] **Step 3: Implement**

Create `src/services/ocr-paddle.ts`:

```ts
/**
 * OCR via the paddle_ocr service, through the sudojo_ocr library.
 *
 * sudojo_ocr does board detection in-process and posts the cropped board to
 * paddle_ocr, which has no board detector of its own. This is the fallback for
 * library images and the only path for camera captures.
 */

import {
  extractSudokuFromImage,
  type CanvasAdapter,
} from "@sudobility/sudojo_ocr";
import { createNodeAdapter } from "@sudobility/sudojo_ocr/node";
import type { OCRExtractData } from "@sudobility/sudojo_types";
import { getEnv } from "../lib/env-helper";

const PADDLE_OCR_URL = getEnv("PADDLE_OCR_URL", "");
const PADDLE_OCR_TIMEOUT_MS = parseInt(
  getEnv("PADDLE_OCR_TIMEOUT_MS", "30000"),
  10
);

let nodeAdapter: CanvasAdapter | null = null;

async function getAdapter(): Promise<CanvasAdapter> {
  if (!nodeAdapter) {
    nodeAdapter = await createNodeAdapter();
  }
  return nodeAdapter;
}

export function isPaddleEnabled(): boolean {
  return PADDLE_OCR_URL.length > 0;
}

export async function extractViaPaddle(
  image: string
): Promise<OCRExtractData> {
  const base64 = image.includes(",") ? image.split(",")[1] || image : image;
  const imageBuffer = Buffer.from(base64, "base64");
  const adapter = await getAdapter();
  const startedAt = Date.now();

  const result = await extractSudokuFromImage(
    adapter,
    imageBuffer,
    { url: PADDLE_OCR_URL, timeoutMs: PADDLE_OCR_TIMEOUT_MS },
    { skipBoardDetection: false, recognizePencilmarks: true }
  );

  console.log(
    `[OCR] paddle ${Date.now() - startedAt}ms digits=${result.digitCount} ` +
      `conf=${Math.round(result.confidence)}`
  );

  return {
    board: result.board,
    confidence: result.confidence,
    digitCount: result.digitCount,
    engine: "paddle",
  };
}
```

Append to `.env.example` after the `OCR_ML_*` block:

```
# PaddleOCR Service (Optional)
# URL of the paddle_ocr service. When empty the paddle path is disabled:
# camera scans return 503 and library scans use sudojo_ocr_ml alone.
PADDLE_OCR_URL=

# Request timeout in milliseconds for paddle_ocr (default: 30000)
PADDLE_OCR_TIMEOUT_MS=30000
```

- [ ] **Step 4: Run the test**

Run: `cd ~/projects/sudojo_api && bunx vitest run tests/ocr-paddle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** *(only if the user asked for a commit this turn)*

```bash
git add src/services/ocr-paddle.ts tests/ocr-paddle.test.ts .env.example
git commit -m "feat(api): add paddle OCR service wrapper"
```

---

## Task 9: `sudojo_api` — dispatch by source, delete Tesseract

**Files:**
- Modify: `src/routes/ocr.ts` (whole file)
- Delete: `eng.traineddata`
- Modify: `package.json` (drop `tesseract.js`), `CLAUDE.md`

**Interfaces:**
- Consumes: `isPaddleEnabled`, `extractViaPaddle` (Task 8); `extractViaML`, `isOCRMLEnabled` (existing).
- Produces: `POST /api/v1/ocr/extract` accepting `{ image, source? }`.

- [ ] **Step 1: Rewrite the route**

Replace `src/routes/ocr.ts` with:

```ts
/**
 * OCR Route - Extract Sudoku puzzles from images
 *
 * Two interchangeable backends, chosen by where the image came from:
 * camera captures go straight to paddle_ocr, everything else prefers the
 * sudojo_ocr_ml whole-board model and falls back to paddle.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  successResponse,
  errorResponse,
  type OCRExtractData,
} from "@sudobility/sudojo_types";
import { extractViaML, isOCRMLEnabled } from "../services/ocr-ml-proxy";
import { extractViaPaddle, isPaddleEnabled } from "../services/ocr-paddle";

const ocrRouter = new Hono();

/** Minimum clues for a well-posed Sudoku. */
const MIN_CLUES = 17;

const extractSchema = z.object({
  image: z.string().min(1, "Image data is required"),
  source: z.enum(["camera", "library"]).default("library"),
});

const TOO_FEW_CLUES =
  "Could not find enough digits in the image. Please retake the photo with the whole puzzle in frame.";
const UNAVAILABLE = "Image recognition is unavailable";

ocrRouter.post("/extract", zValidator("json", extractSchema), async c => {
  const { image, source } = c.req.valid("json");

  // Camera: paddle only. PP-OCRv6 reads real-world photographs better than the
  // whole-board model, which was trained on flat renders.
  if (source === "camera") {
    if (!isPaddleEnabled()) {
      return c.json(errorResponse(UNAVAILABLE), 503);
    }
    try {
      const data = await extractViaPaddle(image);
      return validated(c, data);
    } catch (error) {
      console.error("[OCR] paddle failed:", error);
      return c.json(
        errorResponse(
          "Failed to process image. Please try again with a clearer photo."
        ),
        500
      );
    }
  }

  // Library: prefer the ML model, fall back to paddle.
  let mlError: unknown = null;
  if (isOCRMLEnabled()) {
    try {
      const ml = await extractViaML(image, MIN_CLUES);
      if (ml.debug) {
        console.log(
          `[OCR] ml detection=${ml.debug.detection} solvable=${ml.debug.solvable} ` +
            `repaired=${ml.debug.constraintRepaired} ${ml.debug.elapsedMs}ms ` +
            `digits=${ml.digitCount} conf=${ml.confidence}`
        );
      }
      return validated(c, {
        board: ml.board,
        confidence: ml.confidence,
        digitCount: ml.digitCount,
        engine: "ml",
      });
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      if (status === 422) {
        // The model read the image and found too few clues. Another engine will
        // not do better on the same pixels.
        return c.json(errorResponse(TOO_FEW_CLUES), 400);
      }
      mlError = err;
      console.warn("[OCR] ML service failed, falling back to paddle:", err);
    }
  }

  if (!isPaddleEnabled()) {
    if (mlError) {
      console.error("[OCR] ML failed and paddle is not configured:", mlError);
    }
    return c.json(errorResponse(UNAVAILABLE), 503);
  }

  try {
    const data = await extractViaPaddle(image);
    return validated(c, data);
  } catch (error) {
    // Both backends failed: report the ML error, the preferred engine's, since
    // its message is the more specific one.
    console.error("[OCR] paddle failed:", error);
    if (mlError) {
      console.error("[OCR] ML error was:", mlError);
    }
    return c.json(
      errorResponse(
        "Failed to process image. Please try again with a clearer photo."
      ),
      500
    );
  }
});

/** Shared validation of a backend's board before it goes out. */
function validated(
  c: Parameters<Parameters<typeof ocrRouter.post>[2]>[0],
  data: OCRExtractData
) {
  const puzzle = data.board.original;
  if (!puzzle || puzzle.length !== 81) {
    return c.json(
      errorResponse("Could not extract a valid puzzle from the image"),
      400
    );
  }
  if (data.digitCount < MIN_CLUES) {
    return c.json(errorResponse(TOO_FEW_CLUES), 400);
  }
  return c.json(successResponse(data));
}

export default ocrRouter;
```

If the `validated` helper's context type proves awkward, type its first parameter as `Context` imported from `hono` instead.

- [ ] **Step 2: Remove the Tesseract remnants**

```bash
cd ~/projects/sudojo_api
git rm eng.traineddata
```

Remove `tesseract.js` from `dependencies` in `package.json`, then `bun install`. Keep `@sudobility/sudojo_ocr` — it is now the paddle client.

- [ ] **Step 3: Verify**

Run: `cd ~/projects/sudojo_api && bun run typecheck && bun run lint && bun run test`
Expected: all PASS.

- [ ] **Step 4: Smoke-test both routes locally**

With `PADDLE_OCR_URL=http://ocr.sudobility.com` and `OCR_ML_URL=http://sudoocr.sudobility.com` in `.env`, start the API and post a fixture:

```bash
cd ~/projects/sudojo_api && bun run dev &
IMG=$(base64 -i ../sudojo_ocr/src/test/fixtures/Sudoku-Board-1.jpg)
for SRC in camera library; do
  echo "--- $SRC ---"
  printf '{"image":"%s","source":"%s"}' "$IMG" "$SRC" > /tmp/ocr_req.json
  curl -s -X POST http://localhost:8010/api/v1/ocr/extract \
    -H 'Content-Type: application/json' -d @/tmp/ocr_req.json | head -c 400
  echo
done
```

Expected: both return `"success":true` with an 81-character `board.original` of
`509000400708304900601000730462500000385720649107408200200100004003040087070053006`, `camera`
reporting `"engine":"paddle"` and `library` reporting `"engine":"ml"`.

- [ ] **Step 5: Update `CLAUDE.md`**

Document `PADDLE_OCR_URL` / `PADDLE_OCR_TIMEOUT_MS` alongside the existing `OCR_ML_*` entries, and replace the description of the Tesseract fallback with the two-backend dispatch and its 503 behaviour.

- [ ] **Step 6: Commit** *(only if the user asked for a commit this turn)*

```bash
git add -A
git commit -m "feat(api): dispatch OCR by source, remove Tesseract fallback"
```

---

## Task 10: Frontends send `source`

**Files:**
- Modify: `sudojo_app/src/components/sudoku/ScanBoard.tsx`
- Modify: `sudojo_app_rn/src/services/ocrService.ts:51-56`, `sudojo_app_rn/src/screens/EnterPuzzleScreen.tsx:329-345`
- Modify: the OCR call sites in `sudojo_extension` and `sudojo_bot`

**Interfaces:**
- Consumes: `extractOcr(token, image, { source, timeout })` and `OcrExtractVariables.source` from Task 7.

- [ ] **Step 1: Web — `sudojo_app`**

In `ScanBoard.tsx`, the existing call is `await ocr.mutateAsync({ token: token ?? '', image })`. Add the source:

```ts
const response = await ocr.mutateAsync({
  token: token ?? '',
  image,
  source: 'library',
});
```

Run: `cd ~/projects/sudojo_app && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 2: RN — thread `source` through `ocrService`**

In `sudojo_app_rn/src/services/ocrService.ts`, add the parameter and pass it on:

```ts
export async function extractPuzzleFromImage(
  networkClient: NetworkClient,
  baseUrl: string,
  token: string,
  imageBase64: string,
  source: 'camera' | 'library' = 'library'
): Promise<OCRResult> {
  const client = new SudojoClient(networkClient, baseUrl);

  let data;
  try {
    const response = await client.extractOcr(token, imageBase64, { source });
    data = response.data;
  } catch (error) {
```

Leave the rest of the function unchanged.

- [ ] **Step 3: RN — map the picker source at the call site**

`EnterPuzzleScreen.tsx:330` already receives `source: 'camera' | 'gallery'`. In `handleScan`, pass it through translated to the API's vocabulary:

```ts
const result = await extractPuzzleFromImage(
  networkClient,
  baseUrl,
  token ?? '',
  imageResult.base64 ?? '',
  source === 'camera' ? 'camera' : 'library'
);
```

Match the surrounding call's existing argument names — read `EnterPuzzleScreen.tsx:329-360` first and adapt rather than pasting blind.

Note macOS: `handleScanPress` calls `handleScan('gallery')` unconditionally (`EnterPuzzleScreen.tsx:431-434`) because NSOpenPanel is the only source there, so macOS correctly sends `'library'`.

Run: `cd ~/projects/sudojo_app_rn && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 4: Extension and bot**

Find the OCR call sites:

```bash
cd ~/projects/sudojo_extension && grep -rn "extractOcr\|useSudojoOcrExtract" src/
cd ~/projects/sudojo_bot && grep -rn "extractOcr\|useSudojoOcrExtract" src/
```

Add `source: 'library'` to each. Both are library/upload flows; neither has a camera.

Run in each repo: `bun run typecheck && bun run lint && bun run test`
Expected: PASS.

- [ ] **Step 5: Commit** *(only if the user asked for a commit this turn)*

```bash
# in each of the four frontend repos
git add -A
git commit -m "feat: send OCR source hint"
```

---

## Task 11: Documentation

**Files:**
- Modify: `sudojo_ocr/CLAUDE.md`, `sudojo_ocr/README.md`, `sudojo_ocr/docs/OCR.md`
- Modify: `sudojo_app/CLAUDE.md` (the "Pending release: server-side OCR" section)

- [ ] **Step 1: `sudojo_ocr` docs**

Update all three to describe the new pipeline: board detection in-process, recognition via `paddle_ocr` over HTTP, no Tesseract, no web adapter, `PaddleConfig` as the third argument to `extractSudokuFromImage`. Remove the `bun add tesseract.js` line from the README's install instructions and the `./web` entry from its exports table. Record the measured 243/243 result and that board detection is load-bearing.

- [ ] **Step 2: `sudojo_app/CLAUDE.md`**

In the Cross-Repo Contracts table, the `sudojo_ocr` row currently reads "**No longer a dependency of this app.** OCR runs server-side: `sudojo_api` calls sudojo_ocr_ml and falls back to its own Tesseract pipeline." Replace the Tesseract half: `sudojo_api` now dispatches by `source` between `sudojo_ocr_ml` and `paddle_ocr` (reached in-process through `@sudobility/sudojo_ocr`), with no Tesseract anywhere.

- [ ] **Step 3: Commit** *(only if the user asked for a commit this turn)*

```bash
git add -A
git commit -m "docs: describe paddle_ocr recognition pipeline"
```

---

## Release order

These repos publish to npm in a fixed order, and each consumer needs its dependency published before it can typecheck. When the user asks for a release, run `~/projects/sudojo_app/scripts/push_all.sh` (background it — a full run is 20–60+ minutes) rather than bumping by hand. The relevant slice of the chain is:

```
sudojo_types (Task 6) → sudojo_ocr (Tasks 1-5) → sudojo_api (Tasks 8-9)
  → sudojo_client (Task 7) → … → sudojo_app → sudojo_app_rn → sudojo_extension → sudojo_bot (Task 10)
```

`sudojo_api` is a deploy, not a publish, and it must be live before the frontends ship, because they will start sending a `source` field an older API would ignore (harmless — zod strips unknown keys — so the ordering risk here is low).

## Deployment prerequisite

`sudojo_api`'s egress IP must be allowed by `ocr.sudobility.com`'s IIS IP allowlist, the same treatment `sudojo_ocr_ml` received. Re-run `~/projects/sudojo_ocr_ml/scripts/Install-IisSite.ps1` against the paddle site, or edit its `ipSecurity` block directly. Verify from the API host with:

```bash
curl -s -m 10 http://ocr.sudobility.com/healthz
```

Expected: `{"status":"ok","device":"gpu","gpu":true,"ready":true,...}`. A 404 means the allowlist is denying you — it is configured with `denyAction="NotFound"`.
