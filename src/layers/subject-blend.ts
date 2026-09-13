import type { Layer, LayerDocument } from '../types/layer';
import { featherSubjectAlpha } from '../segmentation/subject-blend';
import { createCanvas } from './layer-utils';

const blendedSubjects = new WeakMap<HTMLCanvasElement, {
  key: string;
  canvas: HTMLCanvasElement;
}>();

/**
 * Feather the lifted subject inward, leaving its original bitmap intact for
 * editing and project saves. Working in document pixels keeps preview and
 * export identical; caching avoids filtering again during stretch gestures.
 */
export function subjectBlendCanvas(layer: Layer, doc: LayerDocument): HTMLCanvasElement {
  if (!layer.protectionSourceId || layer.stretch) return layer.canvas;

  const source = doc.layers.find((candidate) => candidate.id === layer.protectionSourceId);
  const bounds = source ?? { x: 0, y: 0, width: doc.width, height: doc.height };
  // A few pixels on a small photo, scaled up for full-resolution camera images.
  const radius = Math.max(2, Math.min(8, Math.max(bounds.width, bounds.height) / 400));
  // A cutout's trimmed boundary is transparent, except where the photograph
  // itself ends. Clamping those sides preserves subjects cropped by the photo.
  const borders = {
    left: layer.x === bounds.x,
    top: layer.y === bounds.y,
    right: layer.x + layer.width === bounds.x + bounds.width,
    bottom: layer.y + layer.height === bounds.y + bounds.height,
  };
  const key = `${radius}:${+borders.left}${+borders.top}${+borders.right}${+borders.bottom}`;
  const cached = blendedSubjects.get(layer.canvas);
  if (cached?.key === key) return cached.canvas;

  const canvas = createCanvas(layer.width, layer.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(layer.canvas, 0, 0);
  const pixels = ctx.getImageData(0, 0, layer.width, layer.height);
  const alpha = new Uint8ClampedArray(layer.width * layer.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = pixels.data[i * 4 + 3];
  const feathered = featherSubjectAlpha(alpha, layer.width, layer.height, radius, borders);
  for (let i = 0; i < alpha.length; i++) pixels.data[i * 4 + 3] = feathered[i];
  ctx.putImageData(pixels, 0, 0);
  blendedSubjects.set(layer.canvas, { key, canvas });
  return canvas;
}
