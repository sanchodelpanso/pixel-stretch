import type { LayerDocument } from '../types/layer';
import { createCanvas } from './layer-utils';

/**
 * Draw the layer stack into a 2D context, bottom layer first.
 * The context is expected to already be scaled to document coordinates.
 */
export function compositeDocument(
  ctx: CanvasRenderingContext2D,
  doc: LayerDocument,
): void {
  ctx.save();
  ctx.clearRect(0, 0, doc.width, doc.height);
  for (const layer of doc.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(layer.canvas, layer.x, layer.y);
  }
  ctx.restore();
}

/** Flatten the document to a single canvas at full document resolution. */
export function flattenDocument(doc: LayerDocument): HTMLCanvasElement {
  const canvas = createCanvas(doc.width, doc.height);
  compositeDocument(canvas.getContext('2d')!, doc);
  return canvas;
}

/**
 * Flatten and encode. PNG preserves transparency where layers don't cover
 * the canvas; JPEG flattens onto black, matching the app background.
 */
export function exportDocument(
  doc: LayerDocument,
  type: 'image/png' | 'image/jpeg' = 'image/png',
  quality = 0.95,
): Promise<Blob> {
  const canvas = flattenDocument(doc);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Canvas encoding failed'))),
      type,
      quality,
    );
  });
}
