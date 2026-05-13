import path from 'path';
import { fileURLToPath } from 'url';
import Tesseract from 'tesseract.js';
import { createNodeAdapter } from '../src/adapters/node.js';
import {
  detectBoardRectangle, squarifyRectangle, preprocessForOCR,
  adaptiveBinarize, enhanceContrast, binarize,
} from '../src/algorithms/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adapter = await createNodeAdapter();

async function diagnoseCell(imagePath: string, cellIdx: number) {
  const { image, width, height } = await adapter.loadImage(imagePath);
  const src = adapter.createCanvas(width, height);
  adapter.drawImage(src, image, 0,0,width,height, 0,0,width,height);
  const imgData = adapter.getImageData(src, 0, 0, width, height);
  const rect = detectBoardRectangle(imgData);
  let board = src;
  if (rect) {
    const {x,y,size} = squarifyRectangle(rect);
    board = adapter.createCanvas(size, size);
    adapter.drawImage(board, src, x,y,size,size, 0,0,size,size);
  }
  const bd = adapter.getImageData(board, 0, 0, board.width, board.height);
  const processed = preprocessForOCR(bd);
  const pc = adapter.createCanvas(board.width, board.height);
  adapter.putImageData(pc, processed, 0, 0);

  const cw = pc.width/9, ch = pc.height/9, m = 0.03;
  const row = Math.floor(cellIdx/9), col = cellIdx%9;
  const sx = col*cw+cw*m, sy = row*ch+ch*m, sw = cw*(1-2*m), sh = ch*(1-2*m);
  const cc = adapter.createCanvas(Math.round(sw), Math.round(sh));
  adapter.fillRect(cc, 'white', 0, 0, cc.width, cc.height);
  adapter.drawImage(cc, pc, sx,sy,sw,sh, 0,0,cc.width,cc.height);
  const cd = adapter.getImageData(cc, 0, 0, cc.width, cc.height);

  const worker = await Tesseract.createWorker('eng', 1, {logger:()=>{}});
  const modes = [
    {n:'SINGLE_CHAR', p:Tesseract.PSM.SINGLE_CHAR},
    {n:'SINGLE_BLOCK', p:Tesseract.PSM.SINGLE_BLOCK},
  ];
  const preps = [
    {n:'raw', d:cd},
    {n:'binarize0.3', d:binarize(cd, 0.3)},
    {n:'adaptBin', d:adaptiveBinarize(cd)},
    {n:'enh+adaptBin', d:adaptiveBinarize(enhanceContrast(cd, 1.5))},
  ];

  for (const prep of preps) {
    const scale = Math.max(1, 200/Math.min(cd.width, cd.height));
    const w = Math.round(cd.width*scale), h = Math.round(cd.height*scale);
    const up = adapter.createCanvas(w, h);
    const prepC = adapter.createCanvas(cd.width, cd.height);
    adapter.putImageData(prepC, prep.d, 0, 0);
    adapter.fillRect(up, 'white', 0, 0, w, h);
    adapter.drawImage(up, prepC, 0,0,cd.width,cd.height, 0,0,w,h);
    const padded = adapter.createCanvas(w+40, h+40);
    adapter.fillRect(padded, 'white', 0, 0, w+40, h+40);
    adapter.drawImage(padded, up, 0,0,w,h, 20,20,w,h);
    for (const mode of modes) {
      await worker.setParameters({tessedit_pageseg_mode: mode.p, tessedit_char_whitelist: '123456789'});
      try {
        const {data} = await worker.recognize(adapter.toTesseractInput(padded) as any);
        const text = data.text.trim(), conf = data.confidence || 0;
        if (text && conf > 0) console.log(`  ${prep.n}+${mode.n}: "${text}" conf=${conf.toFixed(0)}`);
      } catch {}
    }
  }
  await worker.terminate();
}

for (const [img, cells] of [
  ['pencil_marks_sample.gif', [12,19,31,35,65,71]],
  ['pencilmarks-full.png', [51,60]],
] as const) {
  console.log(`\n=== ${img} ===`);
  for (const c of cells) {
    console.log(`Cell ${c} R${Math.floor(c/9)}C${c%9}:`);
    await diagnoseCell(path.resolve(__dirname, img), c);
  }
}
console.log('\nDone.');
