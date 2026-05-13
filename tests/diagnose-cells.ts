/**
 * Diagnostic script to analyze specific cells that fail digit recognition.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import Tesseract from 'tesseract.js';
import { createNodeAdapter } from '../src/adapters/node.js';
import {
  detectBoardRectangle,
  squarifyRectangle,
  preprocessForOCR,
  adaptiveBinarize,
  enhanceContrast,
  binarize,
} from '../src/algorithms/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imagePath = path.resolve(__dirname, 'lvc39h9c6ra81.jpg');

const adapter = await createNodeAdapter();
const { image, width, height } = await adapter.loadImage(imagePath);

const sourceCanvas = adapter.createCanvas(width, height);
adapter.drawImage(sourceCanvas, image, 0, 0, width, height, 0, 0, width, height);

const imgData = adapter.getImageData(sourceCanvas, 0, 0, width, height);
const rect = detectBoardRectangle(imgData);
let board = sourceCanvas;
if (rect) {
  const { x, y, size } = squarifyRectangle(rect);
  board = adapter.createCanvas(size, size);
  adapter.drawImage(board, sourceCanvas, x, y, size, size, 0, 0, size, size);
}

const boardData = adapter.getImageData(board, 0, 0, board.width, board.height);
const processed = preprocessForOCR(boardData);
const procCanvas = adapter.createCanvas(board.width, board.height);
adapter.putImageData(procCanvas, processed, 0, 0);

console.log(`Board: ${board.width}x${board.height}`);

const cellW = procCanvas.width / 9;
const cellH = procCanvas.height / 9;
const margin = 0.03;

const worker = await Tesseract.createWorker('eng', 1, { logger: () => {} });

for (const idx of [11, 38]) {
  const row = Math.floor(idx / 9);
  const col = idx % 9;
  const sx = col * cellW + cellW * margin;
  const sy = row * cellH + cellH * margin;
  const sw = cellW * (1 - 2 * margin);
  const sh = cellH * (1 - 2 * margin);

  console.log(`\n=== Cell ${idx} R${row}C${col} ===`);
  console.log(`  Extract: (${Math.round(sx)},${Math.round(sy)}) ${Math.round(sw)}x${Math.round(sh)}`);

  const cellCanvas = adapter.createCanvas(Math.round(sw), Math.round(sh));
  adapter.fillRect(cellCanvas, 'white', 0, 0, cellCanvas.width, cellCanvas.height);
  adapter.drawImage(cellCanvas, procCanvas, sx, sy, sw, sh, 0, 0, cellCanvas.width, cellCanvas.height);

  const cd = adapter.getImageData(cellCanvas, 0, 0, cellCanvas.width, cellCanvas.height);

  // Stats
  let dark = 0;
  let sum = 0;
  for (let i = 0; i < cd.width * cd.height; i++) {
    const g = cd.data[i * 4]!;
    if (g < 128) dark++;
    sum += g;
  }
  const mean = sum / (cd.width * cd.height);
  console.log(`  Dark pixels: ${dark}/${cd.width * cd.height} = ${(dark * 100 / (cd.width * cd.height)).toFixed(1)}%`);
  console.log(`  Mean brightness: ${mean.toFixed(1)}`);

  // Try different preprocessing + OCR
  const modes = [
    { name: 'SINGLE_CHAR', psm: Tesseract.PSM.SINGLE_CHAR },
    { name: 'SPARSE_TEXT', psm: Tesseract.PSM.SPARSE_TEXT },
    { name: 'SINGLE_BLOCK', psm: Tesseract.PSM.SINGLE_BLOCK },
    { name: 'AUTO', psm: Tesseract.PSM.AUTO },
  ];

  // Preprocessing variants
  const preps = [
    { name: 'raw', data: cd },
    { name: 'enhContrast', data: enhanceContrast(cd, 1.5) },
    { name: 'adaptiveBin', data: adaptiveBinarize(cd) },
    { name: 'binarize0.3', data: binarize(cd, 0.3) },
    { name: 'enh+adaptBin', data: adaptiveBinarize(enhanceContrast(cd, 1.5)) },
    { name: 'enh2x+adaptBin', data: adaptiveBinarize(enhanceContrast(cd, 2.0)) },
  ];

  for (const prep of preps) {
    // Upscale and pad
    const scale = Math.max(1, 200 / Math.min(cd.width, cd.height));
    const w = Math.round(cd.width * scale);
    const h = Math.round(cd.height * scale);
    const upCanvas = adapter.createCanvas(w, h);
    const prepCanvas = adapter.createCanvas(cd.width, cd.height);
    adapter.putImageData(prepCanvas, prep.data, 0, 0);
    adapter.fillRect(upCanvas, 'white', 0, 0, w, h);
    adapter.drawImage(upCanvas, prepCanvas, 0, 0, cd.width, cd.height, 0, 0, w, h);

    // Add padding
    const padded = adapter.createCanvas(w + 40, h + 40);
    adapter.fillRect(padded, 'white', 0, 0, w + 40, h + 40);
    adapter.drawImage(padded, upCanvas, 0, 0, w, h, 20, 20, w, h);

    for (const mode of modes) {
      await worker.setParameters({
        tessedit_pageseg_mode: mode.psm,
        tessedit_char_whitelist: '123456789',
      });

      try {
        const input = adapter.toTesseractInput(padded);
        const { data } = await worker.recognize(input as any);
        const text = data.text.trim();
        const conf = data.confidence || 0;
        if (text && conf > 0) {
          console.log(`  ${prep.name} + ${mode.name}: "${text}" conf=${conf.toFixed(1)}`);
        }
      } catch {
        // skip
      }
    }
  }
}

await worker.terminate();
console.log('\nDone.');
