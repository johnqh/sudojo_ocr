import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Tesseract from 'tesseract.js';
import { createNodeAdapter } from '../src/adapters/node.js';
import { extractSudokuFromImage } from '../src/ocr.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURES = [
  {
    image: 'pencil_marks_sample.gif',
    truth: 'pencil_marks_sample_truth.txt',
  },
  {
    image: 'pencilmarks-full.png',
    truth: 'pencilmarks-full_truth.txt',
  },
  {
    image: 'lvc39h9c6ra81.jpg',
    truth: 'lvc39h9c6ra81_truth.txt',
  },
];

interface TruthData {
  puzzle: string;
  pencilmarks: string[];
}

function parseTruthCell(token: string): { digit: string; pencilmarks: string } {
  const trimmed = token.trim();
  if (/^\{[1-9](,[1-9])*\}$/.test(trimmed)) {
    return {
      digit: '0',
      pencilmarks: trimmed
        .slice(1, -1)
        .split(',')
        .join(''),
    };
  }

  if (/^[1-9]$/.test(trimmed)) {
    return { digit: trimmed, pencilmarks: '' };
  }

  if (trimmed === '0') {
    return { digit: '0', pencilmarks: '' };
  }

  throw new Error(`Unsupported truth token: ${trimmed}`);
}

function parseTruthFile(filename: string): TruthData {
  const text = fs.readFileSync(filename, 'utf8').trim();
  const rows = text.split('\n').map((line) => line.trim());
  if (rows.length !== 9) {
    throw new Error(`${filename} must have 9 rows, got ${rows.length}`);
  }

  const puzzle: string[] = [];
  const pencilmarks: string[] = [];

  for (const row of rows) {
    const tokens = row.match(/\{[^}]*\}|[^,]+/g) ?? [];
    if (tokens.length !== 9) {
      throw new Error(`Row has ${tokens.length} cells instead of 9: ${row}`);
    }
    for (const token of tokens) {
      const parsed = parseTruthCell(token);
      puzzle.push(parsed.digit);
      pencilmarks.push(parsed.pencilmarks);
    }
  }

  return {
    puzzle: puzzle.join(''),
    pencilmarks,
  };
}

function diffIndices(actual: string, expected: string): number[] {
  const diffs: number[] = [];
  for (let i = 0; i < expected.length; i++) {
    if ((actual[i] ?? '') !== (expected[i] ?? '')) {
      diffs.push(i);
    }
  }
  return diffs;
}

function exactPmMismatches(actual: string[], expected: string[]): number[] {
  const diffs: number[] = [];
  for (let i = 0; i < expected.length; i++) {
    if ((actual[i] ?? '') !== (expected[i] ?? '')) {
      diffs.push(i);
    }
  }
  return diffs;
}

async function main() {
  const adapter = await createNodeAdapter();

  for (const fixture of FIXTURES) {
    const truth = parseTruthFile(path.resolve(__dirname, fixture.truth));
    const imagePath = path.resolve(__dirname, fixture.image);
    const result = await extractSudokuFromImage(adapter, imagePath, Tesseract, {
      recognizePencilmarks: true,
    });
    const actualPm = result.board.pencilmark.numbers.split(',');
    const digitDiffs = diffIndices(result.board.original, truth.puzzle);
    const pmDiffs = exactPmMismatches(actualPm, truth.pencilmarks);

    console.log(`\n${fixture.image}`);
    console.log(`digits exact: ${81 - digitDiffs.length}/81`);
    console.log(
      `digit mismatches: ${digitDiffs.map((i) => `${i}:${result.board.original[i]}!=${truth.puzzle[i]}`).join(' ') || 'none'}`
    );
    console.log(`pencilmark exact: ${81 - pmDiffs.length}/81`);
    console.log(
      `pencilmark mismatches: ${pmDiffs
        .slice(0, 30)
        .map((i) => `${i}:${actualPm[i] || '-'}!=${truth.pencilmarks[i] || '-'}`)
        .join(' ') || 'none'}`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
