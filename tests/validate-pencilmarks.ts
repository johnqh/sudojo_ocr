/**
 * Validation script for pencilmark OCR.
 * Runs the pipeline on sample images and writes JSON results for manual comparison.
 *
 * Usage: bun run tests/validate-pencilmarks.ts
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Tesseract from 'tesseract.js';
import { createNodeAdapter } from '../src/adapters/node.js';
import { extractSudokuFromImage } from '../src/ocr.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SAMPLES = [
  { name: 'pencil_marks_sample', file: 'pencil_marks_sample.gif' },
  { name: 'pencilmarks-full', file: 'pencilmarks-full.png' },
  { name: 'lvc39h9c6ra81', file: 'lvc39h9c6ra81.jpg' },
];

async function main() {
  const adapter = await createNodeAdapter();

  for (const sample of SAMPLES) {
    const imagePath = path.resolve(__dirname, sample.file);
    console.log(`\nProcessing ${sample.file}...`);

    const result = await extractSudokuFromImage(adapter, imagePath, Tesseract, {
      recognizePencilmarks: true,
    });

    const pencilmarkEntries = result.board.pencilmark.numbers.split(',');

    // Build per-cell detail array
    const cells = [];
    for (let i = 0; i < 81; i++) {
      const row = Math.floor(i / 9);
      const col = i % 9;
      const digit = result.board.original[i];
      const pm = pencilmarkEntries[i] ?? '';
      cells.push({
        index: i,
        row,
        col,
        digit: digit !== '0' ? parseInt(digit!, 10) : null,
        pencilmarks: pm,
      });
    }

    const output = {
      image: sample.file,
      puzzle: result.board.original,
      pencilmarks: pencilmarkEntries,
      digitCount: result.digitCount,
      confidence: Math.round(result.confidence * 100) / 100,
      cells,
    };

    const outPath = path.resolve(__dirname, `${sample.name}_results.json`);
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
    console.log(`  -> wrote ${outPath}`);
    console.log(
      `  Digits: ${result.digitCount}, Confidence: ${output.confidence}`
    );
    console.log(`  Puzzle: ${result.board.original}`);
    console.log(
      `  Pencilmark cells: ${pencilmarkEntries.filter((e) => e.length > 0).length}`
    );
  }

  console.log('\nDone. Check JSON files in tests/ folder.');
}

main().catch((err) => {
  console.error('Validation failed:', err);
  process.exit(1);
});
