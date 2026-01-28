/**
 * Web/Browser canvas adapter
 * Uses HTMLCanvasElement and related browser APIs
 */

import type {
  CanvasAdapter,
  CanvasLike,
  ImageLike,
  ImageDataLike,
} from './types.js';

type WebCanvas = HTMLCanvasElement & CanvasLike;

/**
 * Get 2D context from canvas, throwing if not available
 */
function getContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get 2D context from canvas');
  }
  return ctx;
}

/**
 * Browser/Web canvas adapter implementation
 */
export class WebCanvasAdapter implements CanvasAdapter {
  createCanvas(width: number, height: number): WebCanvas {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas as WebCanvas;
  }

  async loadImage(
    source: File | Blob | HTMLImageElement | HTMLCanvasElement | string
  ): Promise<{ image: ImageLike; width: number; height: number }> {
    if (source instanceof HTMLCanvasElement) {
      return {
        image: source as unknown as ImageLike,
        width: source.width,
        height: source.height,
      };
    }

    if (source instanceof HTMLImageElement) {
      return {
        image: source as unknown as ImageLike,
        width: source.naturalWidth,
        height: source.naturalHeight,
      };
    }

    // File, Blob, or data URL string
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        resolve({
          image: img as unknown as ImageLike,
          width: img.naturalWidth,
          height: img.naturalHeight,
        });
      };
      img.onerror = () => reject(new Error('Failed to load image'));

      if (typeof source === 'string') {
        img.src = source;
      } else {
        img.src = URL.createObjectURL(source);
      }
    });
  }

  getImageData(
    canvas: CanvasLike,
    x: number,
    y: number,
    width: number,
    height: number
  ): ImageDataLike {
    const ctx = getContext(canvas as HTMLCanvasElement);
    return ctx.getImageData(x, y, width, height);
  }

  putImageData(
    canvas: CanvasLike,
    imageData: ImageDataLike,
    x: number,
    y: number
  ): void {
    const ctx = getContext(canvas as HTMLCanvasElement);
    ctx.putImageData(imageData as ImageData, x, y);
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
    const ctx = getContext(canvas as HTMLCanvasElement);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      source as HTMLCanvasElement | HTMLImageElement,
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
    const ctx = getContext(canvas as HTMLCanvasElement);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, width, height);
  }

  toTesseractInput(canvas: CanvasLike): HTMLCanvasElement {
    return canvas as HTMLCanvasElement;
  }

  toDataURL(canvas: CanvasLike): string {
    return (canvas as HTMLCanvasElement).toDataURL('image/png');
  }
}

/**
 * Create a web canvas adapter
 */
export function createWebAdapter(): CanvasAdapter {
  return new WebCanvasAdapter();
}

export default createWebAdapter;
