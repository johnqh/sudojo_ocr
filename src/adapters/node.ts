/**
 * Node.js canvas adapter
 * Uses @napi-rs/canvas for server-side canvas operations
 */

import type {
  CanvasAdapter,
  CanvasLike,
  ImageLike,
  ImageDataLike,
} from './types.js';

// Dynamic import types for @napi-rs/canvas
type NapiCanvas = {
  width: number;
  height: number;
  getContext(type: '2d'): NapiContext;
  toBuffer(mimeType: string): Buffer;
  toDataURL(mimeType?: string): string;
};

type NapiContext = {
  fillStyle: string;
  imageSmoothingEnabled: boolean;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(
    image: NapiCanvas | NapiImage,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number
  ): void;
  getImageData(x: number, y: number, w: number, h: number): ImageDataLike;
  putImageData(imageData: ImageDataLike, x: number, y: number): void;
};

type NapiImage = {
  width: number;
  height: number;
};

type NapiCanvasModule = {
  createCanvas(width: number, height: number): NapiCanvas;
  loadImage(source: Buffer | string): Promise<NapiImage>;
};

let canvasModule: NapiCanvasModule | null = null;

async function getCanvasModule(): Promise<NapiCanvasModule> {
  if (!canvasModule) {
    // Dynamic import to avoid bundling issues
    canvasModule = (await import('@napi-rs/canvas')) as NapiCanvasModule;
  }
  return canvasModule;
}

/**
 * Node.js canvas adapter implementation
 */
export class NodeCanvasAdapter implements CanvasAdapter {
  private module: NapiCanvasModule | null = null;

  private async getModule(): Promise<NapiCanvasModule> {
    if (!this.module) {
      this.module = await getCanvasModule();
    }
    return this.module;
  }

  createCanvas(width: number, height: number): CanvasLike {
    if (!this.module) {
      throw new Error(
        'NodeCanvasAdapter not initialized. Call init() first or use createNodeAdapter().'
      );
    }
    return this.module.createCanvas(width, height) as unknown as CanvasLike;
  }

  async loadImage(
    source: Buffer | string
  ): Promise<{ image: ImageLike; width: number; height: number }> {
    const mod = await this.getModule();
    const image = await mod.loadImage(source);
    return {
      image: image as unknown as ImageLike,
      width: image.width,
      height: image.height,
    };
  }

  getImageData(
    canvas: CanvasLike,
    x: number,
    y: number,
    width: number,
    height: number
  ): ImageDataLike {
    const ctx = (canvas as unknown as NapiCanvas).getContext('2d');
    return ctx.getImageData(x, y, width, height);
  }

  putImageData(
    canvas: CanvasLike,
    imageData: ImageDataLike,
    x: number,
    y: number
  ): void {
    const ctx = (canvas as unknown as NapiCanvas).getContext('2d');
    ctx.putImageData(imageData, x, y);
  }

  drawImage(
    canvas: CanvasLike,
    source: CanvasLike | ImageLike,
    sx: number,
    sy: number,
    sWidth: number,
    sHeight: number,
    dx: number,
    dy: number,
    dWidth: number,
    dHeight: number
  ): void {
    const ctx = (canvas as unknown as NapiCanvas).getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      source as unknown as NapiCanvas,
      sx,
      sy,
      sWidth,
      sHeight,
      dx,
      dy,
      dWidth,
      dHeight
    );
  }

  fillRect(
    canvas: CanvasLike,
    color: string,
    x: number,
    y: number,
    width: number,
    height: number
  ): void {
    const ctx = (canvas as unknown as NapiCanvas).getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(x, y, width, height);
  }

  toTesseractInput(canvas: CanvasLike): Buffer {
    return (canvas as unknown as NapiCanvas).toBuffer('image/png');
  }

  toDataURL(canvas: CanvasLike): string {
    return (canvas as unknown as NapiCanvas).toDataURL('image/png');
  }

  /**
   * Initialize the adapter (loads the canvas module)
   */
  async init(): Promise<void> {
    this.module = await getCanvasModule();
  }
}

/**
 * Create and initialize a node canvas adapter
 */
export async function createNodeAdapter(): Promise<CanvasAdapter> {
  const adapter = new NodeCanvasAdapter();
  await adapter.init();
  return adapter;
}

export default createNodeAdapter;
