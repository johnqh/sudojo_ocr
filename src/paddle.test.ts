import { describe, it, expect, afterEach } from 'vitest';
import {
  mapBlocksToBoard,
  recognizeBoard,
  type PaddleBlock,
} from './paddle.js';
import type { CanvasAdapter, CanvasLike } from './types.js';

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
    expect(cells.every((c) => c.digit === null)).toBe(true);
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
    globalThis.fetch = (async (url: string, init: { body?: unknown }) => {
      sentUrl = url;
      sentBody = init.body as string;
      return new Response(JSON.stringify({ blocks: [] }), { status: 200 });
    }) as unknown as typeof fetch;

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
      )) as unknown as typeof fetch;

    const { cells } = await recognizeBoard(
      fakeAdapter('data:image/png;base64,AAAB'),
      fakeBoard,
      { url: 'http://ocr.example.com' }
    );
    expect(cells[0].digit).toBe(5);
  });

  it('throws with the status on a non-2xx response', async () => {
    globalThis.fetch = (async () =>
      new Response('boom', { status: 500 })) as unknown as typeof fetch;

    await expect(
      recognizeBoard(fakeAdapter('data:image/png;base64,AAAB'), fakeBoard, {
        url: 'http://ocr.example.com',
      })
    ).rejects.toThrow(/500/);
  });

  it('aborts after timeoutMs', async () => {
    globalThis.fetch = ((
      _url: string,
      init: { signal?: { addEventListener(t: string, cb: () => void): void } }
    ) =>
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
