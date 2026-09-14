import type { Layer } from '../types/layer';
import type { SourceImage } from '../types/image';
import type { StretchSpec } from '../types/stretch';
import { maskBoundingBox, resizeMask } from '../segmentation/mask-utils';
import { renderStretchBand } from '../rendering/stretch-band';

/** Alpha below this counts as empty when trimming or hit-testing. */
const ALPHA_EPSILON = 0.004;

let idCounter = 0;

function nextId(): string {
  idCounter += 1;
  return `layer-${idCounter}`;
}

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/**
 * Render a small preview of the layer's pixels for the layers panel.
 * Drawn on a transparent background so cut-outs read as cut-outs.
 */
export function makeThumbnail(canvas: HTMLCanvasElement, maxSize = 72): string {
  const scale = Math.min(maxSize / canvas.width, maxSize / canvas.height, 1);
  const thumb = createCanvas(canvas.width * scale, canvas.height * scale);
  const ctx = thumb.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, thumb.width, thumb.height);
  return thumb.toDataURL('image/png');
}

/** Build a layer from an existing canvas, taking ownership of it. */
export function layerFromCanvas(
  canvas: HTMLCanvasElement,
  name: string,
  x = 0,
  y = 0,
): Layer {
  return {
    id: nextId(),
    name,
    canvas,
    width: canvas.width,
    height: canvas.height,
    x,
    y,
    visible: true,
    opacity: 1,
    locked: false,
    thumbnail: makeThumbnail(canvas),
  };
}

/** Build the initial background layer from a decoded image. */
export function layerFromImage(image: SourceImage, name = 'Background'): Layer {
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d')!.drawImage(image, 0, 0);
  return layerFromCanvas(canvas, name);
}

/** Read a bounded analysis image without copying a full-resolution photo to JS. */
export function layerImageData(layer: Layer, maxSize = 1536): ImageData {
  const scale = Math.min(1, maxSize / Math.max(layer.width, layer.height));
  const canvas = createCanvas(layer.width * scale, layer.height * scale);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(layer.canvas, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Bring a mask into a layer's pixel space, resizing if the segmentation ran
 * at a different resolution.
 */
function fitMaskToLayer(
  layer: Layer,
  mask: Float32Array,
  maskWidth: number,
  maskHeight: number,
): Float32Array {
  if (maskWidth === layer.width && maskHeight === layer.height) return mask;
  return resizeMask(mask, maskWidth, maskHeight, layer.width, layer.height);
}

/**
 * Cut the masked region of `source` out into its own layer, trimmed to the
 * mask's bounding box and positioned so it lands exactly where it started.
 *
 * Returns null when the mask is empty.
 */
export function extractLayer(
  source: Layer,
  mask: Float32Array,
  maskWidth: number,
  maskHeight: number,
  name: string,
): Layer | null {
  const fitted = fitMaskToLayer(source, mask, maskWidth, maskHeight);
  const bbox = maskBoundingBox(fitted, source.width, source.height, ALPHA_EPSILON);
  if (!bbox) return null;

  const bx = Math.round(bbox.x * source.width);
  const by = Math.round(bbox.y * source.height);
  const bw = Math.round(bbox.w * source.width);
  const bh = Math.round(bbox.h * source.height);

  const out = createCanvas(bw, bh);
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source.canvas, bx, by, bw, bh, 0, 0, bw, bh);

  // Multiply the cut-out's alpha by the mask so soft edges stay soft.
  const pixels = ctx.getImageData(0, 0, bw, bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const m = fitted[(by + y) * source.width + (bx + x)];
      const i = (y * bw + x) * 4 + 3;
      pixels.data[i] = Math.round(pixels.data[i] * Math.max(0, Math.min(1, m)));
    }
  }
  ctx.putImageData(pixels, 0, 0);

  return layerFromCanvas(out, name, source.x + bx, source.y + by);
}

/**
 * Return a copy of `source` with the masked region erased — the hole left
 * behind by a "cut to layer".
 */
export function eraseMaskedRegion(
  source: Layer,
  mask: Float32Array,
  maskWidth: number,
  maskHeight: number,
): Layer {
  const fitted = fitMaskToLayer(source, mask, maskWidth, maskHeight);

  const out = createCanvas(source.width, source.height);
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source.canvas, 0, 0);

  const pixels = ctx.getImageData(0, 0, source.width, source.height);
  for (let i = 0; i < fitted.length; i++) {
    const keep = 1 - Math.max(0, Math.min(1, fitted[i]));
    const a = i * 4 + 3;
    pixels.data[a] = Math.round(pixels.data[a] * keep);
  }
  ctx.putImageData(pixels, 0, 0);

  return { ...source, canvas: out, thumbnail: makeThumbnail(out) };
}

/** Duplicate a layer, pixels and all. */
export function duplicateLayer(layer: Layer): Layer {
  const out = createCanvas(layer.width, layer.height);
  out.getContext('2d')!.drawImage(layer.canvas, 0, 0);
  return {
    ...layer,
    id: nextId(),
    name: `${layer.name} copy`,
    canvas: out,
    thumbnail: layer.thumbnail,
  };
}

/**
 * Topmost visible, unlocked layer whose pixel at the given document point is
 * not transparent. Returns null when the point hits nothing.
 */
export function hitTestLayers(layers: Layer[], docX: number, docY: number): Layer | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (!layer.visible || layer.locked) continue;

    const lx = Math.floor(docX - layer.x);
    const ly = Math.floor(docY - layer.y);
    if (lx < 0 || ly < 0 || lx >= layer.width || ly >= layer.height) continue;

    const ctx = layer.canvas.getContext('2d', { willReadFrequently: true })!;
    if (ctx.getImageData(lx, ly, 1, 1).data[3] > ALPHA_EPSILON * 255) {
      return layer;
    }
  }
  return null;
}

/**
 * Crop a document-space mask down to one layer's pixel space.
 * Brush strokes are painted over the whole canvas, but SAM was encoded
 * against a single layer, so prompts have to be re-based onto it.
 */
export function docMaskToLayerSpace(
  mask: Uint8Array,
  docWidth: number,
  docHeight: number,
  layer: Layer,
): Uint8Array {
  const out = new Uint8Array(layer.width * layer.height);
  for (let y = 0; y < layer.height; y++) {
    const docY = y + layer.y;
    if (docY < 0 || docY >= docHeight) continue;
    for (let x = 0; x < layer.width; x++) {
      const docX = x + layer.x;
      if (docX < 0 || docX >= docWidth) continue;
      out[y * layer.width + x] = mask[docY * docWidth + docX];
    }
  }
  return out;
}

/**
 * Move a layer, keeping a stretch layer's geometry in step with it — the band
 * is defined by document-space points, so a translated band has to carry them
 * along or the next re-render would snap it back.
 */
export function translateLayer(layer: Layer, dx: number, dy: number): Layer {
  const moved: Layer = { ...layer, x: Math.round(layer.x + dx), y: Math.round(layer.y + dy) };
  if (layer.stretch) {
    moved.stretch = {
      ...layer.stretch,
      points: layer.stretch.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      anchor: { x: layer.stretch.anchor.x + dx, y: layer.stretch.anchor.y + dy },
      ...(layer.stretch.arc ? {
        arc: {
          ...layer.stretch.arc,
          origin: { x: layer.stretch.arc.origin.x + dx, y: layer.stretch.arc.origin.y + dy },
        },
      } : {}),
    };
  }
  return moved;
}

/** The subject lifted off `sourceId` to protect it from its stretches, if any. */
export function protectedSubject(layers: Layer[], sourceId: string): Layer | null {
  return layers.find((layer) => layer.protectionSourceId === sourceId && !layer.stretch) ?? null;
}

/** Build a brand-new generative stretch layer, or null if the band is degenerate. */
export function createStretchLayer(
  spec: StretchSpec,
  source: Layer,
  name: string,
  subject: Layer | null = null,
): Layer | null {
  const band = renderStretchBand(spec, source, subject);
  if (!band) return null;
  return { ...layerFromCanvas(band.canvas, name, band.x, band.y), stretch: spec };
}

/**
 * Re-render an existing stretch layer against a new spec, preserving its
 * identity, name, opacity and everything else the user set on it.
 */
export function rerenderStretchLayer(
  layer: Layer,
  spec: StretchSpec,
  source: Layer,
  subject: Layer | null = null,
): Layer {
  const band = renderStretchBand(spec, source, subject);
  // A degenerate spec keeps the old pixels rather than blanking the layer.
  if (!band) return { ...layer, stretch: spec };
  return {
    ...layer,
    stretch: spec,
    canvas: band.canvas,
    width: band.canvas.width,
    height: band.canvas.height,
    x: band.x,
    y: band.y,
    thumbnail: makeThumbnail(band.canvas),
  };
}
