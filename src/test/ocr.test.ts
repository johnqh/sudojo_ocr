import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import Tesseract from 'tesseract.js';
import { createNodeAdapter } from '../adapters/node.js';
import { extractSudokuFromImage } from '../ocr.js';
import type { CanvasAdapter } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TIMEOUT = { timeout: 120_000 };

let adapter: CanvasAdapter;

beforeAll(async () => {
  adapter = await createNodeAdapter();
});

describe('extractSudokuFromImage', () => {
  const TEST_CASES = [
    {
      name: 'Board-1',
      path: path.resolve(__dirname, 'fixtures/Sudoku-Board-1.jpg'),
      expected:
        '509000400708304900601000730462500000385720649107408200200100004003040087070053006',
    },
    {
      name: 'Board-2',
      path: path.resolve(__dirname, 'fixtures/Sudoku-Board-2.png'),
      expected:
        '700520008056098000040367050062780000801400002430019060000005000500602931007941500',
    },
    {
      name: 'Board-3',
      path: path.resolve(__dirname, 'fixtures/Sudoku-Board-3.jpg'),
      expected:
        '000150000000894062908070050050483020603010500800205309140008090280940005000607800',
    },
  ];

  for (const tc of TEST_CASES) {
    it(`should recognize digits in ${tc.name}`, TIMEOUT, async () => {
      const result = await extractSudokuFromImage(adapter, tc.path, Tesseract, {
        skipBoardDetection: false,
      });

      expect(result.board.original).toHaveLength(81);
      expect(result.digitCount).toBeGreaterThan(0);

      let correct = 0;
      for (let i = 0; i < 81; i++) {
        if (result.board.original[i] === tc.expected[i]) correct++;
      }
      expect(correct).toBeGreaterThanOrEqual(77);
    });
  }

  it('should set autopencil false when recognizePencilmarks is disabled', TIMEOUT, async () => {
    const tc = TEST_CASES[0]!;
    const result = await extractSudokuFromImage(adapter, tc.path, Tesseract, {
      recognizePencilmarks: false,
    });

    expect(result.board.pencilmark.autopencil).toBe(false);
  });

  it(
    'should set autopencil false for digit-only board with recognizePencilmarks enabled',
    TIMEOUT,
    async () => {
      const tc = TEST_CASES[0]!;
      const result = await extractSudokuFromImage(adapter, tc.path, Tesseract, {
        recognizePencilmarks: true,
      });

      expect(result.board.pencilmark.autopencil).toBe(false);
      expect(result.digitCount).toBeGreaterThan(0);
    }
  );
});

describe('extractSudokuFromImage with pencilmarks', () => {
  const PENCILMARK_IMAGE = path.resolve(
    __dirname,
    'fixtures/Sudoku-Board-Pencilmarks.png'
  );

  // Expected large digits from the image (0 = empty/pencilmark cell)
  const EXPECTED_DIGITS =
    '600320709' +
    '290000300' +
    '073869002' +
    '300604000' +
    '060200030' +
    '000503001' +
    '700932000' +
    '031006298' +
    '926000073';

  // Expected pencilmarks per cell (comma-separated, 81 entries)
  // Empty string = no pencilmarks (digit cell or truly empty)
  const EXPECTED_PENCILMARKS =
    ',1458,458,,,15,,1458,' +
    ',,,458,147,1457,157,,14568,456,' +
    '145,,,,,,145,145,,' +
    ',158,25789,,1789,,589,258,57,' +
    '1458,,45789,,1789,178,4589,,457,' +
    '48,48,24789,,789,,4689,2468,,' +
    ',458,458,,,,1456,1456,456,' +
    '45,,,47,457,,,,,' +
    ',,,14,1458,158,145,,';

  const expectedEntries = EXPECTED_PENCILMARKS.split(',');

  // Indices of cells that have pencilmarks
  const PENCILMARK_CELL_INDICES = expectedEntries
    .map((e, i) => (e.length > 0 ? i : -1))
    .filter((i) => i >= 0);

  it('should detect pencilmarks and set autopencil true', TIMEOUT, async () => {
    const result = await extractSudokuFromImage(adapter, PENCILMARK_IMAGE, Tesseract, {
      recognizePencilmarks: true,
    });

    expect(result.board.pencilmark.autopencil).toBe(true);

    const entries = result.board.pencilmark.numbers.split(',');
    expect(entries).toHaveLength(81);

    // Should detect pencilmarks in multiple cells
    const nonEmpty = entries.filter((e) => e.length > 0);
    expect(nonEmpty.length).toBeGreaterThanOrEqual(10);
  });

  it('should recognize large digits correctly alongside pencilmarks', TIMEOUT, async () => {
    const result = await extractSudokuFromImage(adapter, PENCILMARK_IMAGE, Tesseract, {
      recognizePencilmarks: true,
    });

    expect(result.digitCount).toBeGreaterThan(0);

    const puzzle = result.board.original;
    let correctGivens = 0;
    let totalGivens = 0;
    for (let i = 0; i < 81; i++) {
      if (EXPECTED_DIGITS[i] !== '0') {
        totalGivens++;
        if (puzzle[i] === EXPECTED_DIGITS[i]) correctGivens++;
      }
    }
    // Expect at least 90% of given digits recognized correctly
    expect(correctGivens).toBeGreaterThanOrEqual(Math.floor(totalGivens * 0.9));
  });

  it('should not set autopencil when recognizePencilmarks is disabled', TIMEOUT, async () => {
    const result = await extractSudokuFromImage(adapter, PENCILMARK_IMAGE, Tesseract, {
      recognizePencilmarks: false,
    });

    expect(result.board.pencilmark.autopencil).toBe(false);
    const entries = result.board.pencilmark.numbers.split(',');
    expect(entries.every((e) => e === '')).toBe(true);
  });

  it('should produce valid pencilmark number entries', TIMEOUT, async () => {
    const result = await extractSudokuFromImage(adapter, PENCILMARK_IMAGE, Tesseract, {
      recognizePencilmarks: true,
    });

    const entries = result.board.pencilmark.numbers.split(',');

    // Each entry should be empty or contain only digits 1-9
    for (const entry of entries) {
      if (entry.length > 0) {
        expect(entry).toMatch(/^[1-9]+$/);
      }
    }

    // Cells with large digits should NOT have pencilmark entries
    for (let i = 0; i < 81; i++) {
      if (EXPECTED_DIGITS[i] !== '0' && result.board.original[i] !== '0') {
        expect(entries[i]).toBe('');
      }
    }
  });

  it('should detect pencilmarks in expected cells', TIMEOUT, async () => {
    const result = await extractSudokuFromImage(adapter, PENCILMARK_IMAGE, Tesseract, {
      recognizePencilmarks: true,
    });

    const entries = result.board.pencilmark.numbers.split(',');

    // Count how many expected pencilmark cells were actually detected
    let detected = 0;
    for (const idx of PENCILMARK_CELL_INDICES) {
      if (entries[idx] && entries[idx].length > 0) {
        detected++;
      }
    }

    // Expect at least 50% of known pencilmark cells to be detected
    expect(detected).toBeGreaterThanOrEqual(
      Math.floor(PENCILMARK_CELL_INDICES.length * 0.5)
    );
  });

  it('should detect correct pencilmark digits per cell', TIMEOUT, async () => {
    const result = await extractSudokuFromImage(adapter, PENCILMARK_IMAGE, Tesseract, {
      recognizePencilmarks: true,
    });

    const entries = result.board.pencilmark.numbers.split(',');

    // For each detected pencilmark cell, check that detected digits are
    // a subset of the expected digits (no false positives for wrong digits)
    let correctSubsetCount = 0;
    let detectedCells = 0;
    for (const idx of PENCILMARK_CELL_INDICES) {
      if (!entries[idx] || entries[idx].length === 0) continue;
      detectedCells++;
      const detectedDigits = new Set(entries[idx].split(''));
      const expectedDigits = new Set(expectedEntries[idx].split(''));
      // Check each detected digit is in the expected set
      const allCorrect = [...detectedDigits].every((d) => expectedDigits.has(d));
      if (allCorrect) correctSubsetCount++;
    }

    // At least 50% of detected cells should have only correct digits (no false positives)
    expect(correctSubsetCount).toBeGreaterThanOrEqual(Math.floor(detectedCells * 0.5));
  });
});
