/**
 * Recognition via the paddle_ocr HTTP service.
 *
 * PaddleOCR reads the whole cropped board in one pass: on a board that fills
 * the frame it emits one block per digit, so cells are assigned by exact grid
 * geometry rather than by cropping 81 images. Board detection upstream is what
 * makes that true - on an uncropped photo the digits land in the wrong rows and
 * the page's own text arrives as blocks.
 */

import type {
  CanvasAdapter,
  CanvasLike,
  CellRecognition,
  PaddleConfig,
} from './types.js';

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
      pencilmarkCells.push(/^[1-9]+$/.test(text));
      continue;
    }
    cells.push({ digit: null, confidence: 0 });
    pencilmarkCells.push(found.length > 1);
  }

  return { cells, pencilmarkCells };
}

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
