/**
 * End-to-end tests for extractSudokuFromImage.
 *
 * The offline suite fakes the paddle_ocr HTTP response so board detection and
 * assembly are exercised without the network. The live suite runs the real
 * service and is opt-in:
 *
 *   PADDLE_OCR_URL=http://ocr.sudobility.com bun run test
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractSudokuFromImage, detectAndCropBoard } from '../ocr.js';
import { createNodeAdapter } from '../adapters/node.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, 'fixtures');

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

/** Build one paddle block per given digit, centred in its cell. */
function blocksFor(expected: string, size: number) {
  const cell = size / 9;
  const blocks = [];
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
  return blocks;
}

describe('extractSudokuFromImage with a faked paddle service', () => {
  it('builds a board from the blocks paddle returns', async () => {
    const adapter = await createNodeAdapter();
    const image = readFileSync(path.join(FIXTURES, BOARDS[0].file));
    const expected = BOARDS[0].expected;

    // The fake must lay its blocks out on the same grid the real crop produces,
    // so ask for the crop first and use its actual size.
    const croppedUrl = await detectAndCropBoard(adapter, image);
    expect(croppedUrl).toContain('data:image/png;base64,');
    const cropped = await adapter.loadImage(
      Buffer.from(croppedUrl.split(',')[1], 'base64')
    );

    const blocks = blocksFor(expected, cropped.width);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ blocks }), {
        status: 200,
      })) as unknown as typeof fetch;
    try {
      const result = await extractSudokuFromImage(adapter, image, {
        url: 'http://fake.invalid',
      });
      expect(result.board.original).toBe(expected);
      expect(result.digitCount).toBe(
        expected.split('').filter((d) => d !== '0').length
      );
      expect(result.confidence).toBe(100);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns an empty board when paddle finds nothing', async () => {
    const adapter = await createNodeAdapter();
    const image = readFileSync(path.join(FIXTURES, BOARDS[0].file));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ blocks: [] }), {
        status: 200,
      })) as unknown as typeof fetch;
    try {
      const result = await extractSudokuFromImage(adapter, image, {
        url: 'http://fake.invalid',
      });
      expect(result.board.original).toBe('0'.repeat(81));
      expect(result.digitCount).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/** The live service. Opt in with PADDLE_OCR_URL. */
const LIVE_URL = process.env.PADDLE_OCR_URL;

describe.skipIf(!LIVE_URL)(
  'extractSudokuFromImage against live paddle_ocr',
  () => {
    for (const board of BOARDS) {
      it(`reads ${board.file} exactly`, { timeout: 60000 }, async () => {
        const adapter = await createNodeAdapter();
        const image = readFileSync(path.join(FIXTURES, board.file));
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
  }
);
