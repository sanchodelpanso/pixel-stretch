import type { Layer, LayerDocument } from '../types/layer';
import { featherSubjectAlpha } from '../segmentation/subject-blend';
import { renderSubjectMelt, type SubjectMelt } from '../rendering/edge-blend';
import { createCanvas } from './layer-utils';

/**
 * Melts per band, keyed on the band's pixels, which are replaced whenever its
 * spec changes, and on the subject's pixels they smear. Moving either shifts
 * its bitmap without re-rendering, so the melt is rebuilt when they move.
 */
const bandMelts = new WeakMap<HTMLCanvasElement, { key: string; melt: SubjectMelt | null }>();
/** A stable number per band bitmap, so a subject's cache can tell when its bands change. */
const canvasIds = new WeakMap<HTMLCanvasElement, number>();
let nextCanvasId = 1;
const canvasId = (canvas: HTMLCanvasElement) => {
  let id = canvasIds.get(canvas);
  if (id === undefined) {
    id = nextCanvasId++;
    canvasIds.set(canvas, id);
  }
  return id;
};

/**
 * Stretch bands that melt into this subject: visible ones from its source,
 * behind it in the stack, with an edge blend. A band laid over the subject
 * covers it already and doesn't erase it.
 */
function blendingBands(layer: Layer, doc: LayerDocument): Layer[] {
  const index = doc.layers.indexOf(layer);
  return doc.layers.filter((band, bandIndex) => (
    bandIndex < index
    && band.visible
    && band.stretch?.sourceLayerId === layer.protectionSourceId
    && (band.stretch?.edgeBlend ?? 0) > 0
  ));
}

function bandMelt(band: Layer, subject: Layer): SubjectMelt | null {
  const key = `${canvasId(subject.canvas)}@${subject.x},${subject.y}:${band.x},${band.y}`;
  const cached = bandMelts.get(band.canvas);
  if (cached?.key === key) return cached.melt;
  const melt = renderSubjectMelt(band.stretch!, subject);
  bandMelts.set(band.canvas, { key, melt });
  return melt;
}

interface CachedCanvas {
  key: string;
  canvas: HTMLCanvasElement;
}

/** A layer's pixels as drawn, and where their top-left sits in the document. */
export interface PlacedCanvas {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
}

/** The feathered subject on its own, which only changes with the subject. */
const featheredSubjects = new WeakMap<HTMLCanvasElement, CachedCanvas>();
/** The feathered subject with its blending bands erased, which changes as bands are edited. */
const blendedSubjects = new WeakMap<HTMLCanvasElement, { key: string; placed: PlacedCanvas }>();

/**
 * Feather the lifted subject inward, and melt it into any stretch bands that
 * blend with it, leaving its original bitmap intact for editing and project
 * saves. Working in document pixels keeps preview and export identical;
 * caching avoids filtering again during stretch gestures.
 */
export function subjectBlendCanvas(layer: Layer, doc: LayerDocument): HTMLCanvasElement {
  return subjectBlendRender(layer, doc).canvas;
}

/**
 * The layer as it should be drawn, with its position. A subject melting into a
 * band can smear past its own trimmed bounds, so its canvas may be larger than
 * the layer and start above or left of it.
 */
export function subjectBlendRender(layer: Layer, doc: LayerDocument): PlacedCanvas {
  const unchanged = { canvas: layer.canvas, x: layer.x, y: layer.y };
  if (!layer.protectionSourceId || layer.stretch) return unchanged;

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
  const featherKey = `${radius}:${+borders.left}${+borders.top}${+borders.right}${+borders.bottom}`;
  const feathered = featheredSubject(layer, radius, borders, featherKey);

  const bands = blendingBands(layer, doc);
  if (bands.length === 0) return { canvas: feathered, x: layer.x, y: layer.y };
  const key = `${featherKey}:${layer.x},${layer.y}:`
    + bands.map((band) => `${canvasId(band.canvas)}@${band.x},${band.y}`).join('|');
  const cached = blendedSubjects.get(layer.canvas);
  if (cached?.key === key) return cached.placed;

  // Where each blending band melts the subject, swap the subject for its own
  // pixels smeared along the streaks. Both are drawn on the GPU over a copy,
  // so dragging a band doesn't re-feather the subject. The smear trails past
  // the subject's trimmed bounds, so the canvas grows to hold it — clipping it
  // there would leave a hard straight edge where the object's bounding box ends.
  const melts = bands.map((band) => bandMelt(band, layer)).filter((melt): melt is SubjectMelt => melt !== null);
  const left = Math.min(layer.x, ...melts.map((melt) => melt.smear.x));
  const top = Math.min(layer.y, ...melts.map((melt) => melt.smear.y));
  const right = Math.max(layer.x + layer.width, ...melts.map((melt) => melt.smear.x + melt.smear.canvas.width));
  const bottom = Math.max(layer.y + layer.height, ...melts.map((melt) => melt.smear.y + melt.smear.canvas.height));
  const canvas = createCanvas(right - left, bottom - top);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(feathered, layer.x - left, layer.y - top);
  for (const melt of melts) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(melt.erase.canvas, melt.erase.x - left, melt.erase.y - top);
    // Add rather than paint over: the subject was erased by the handover amount
    // and the smear carries that same amount, so summing them is an exact
    // crossfade. Painting over would leave the pair partly see-through mid-way,
    // letting the darker band beneath show as a seam.
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(melt.smear.canvas, melt.smear.x - left, melt.smear.y - top);
  }
  ctx.globalCompositeOperation = 'source-over';
  const placed = { canvas, x: left, y: top };
  blendedSubjects.set(layer.canvas, { key, placed });
  return placed;
}

function featheredSubject(
  layer: Layer,
  radius: number,
  borders: { left: boolean; top: boolean; right: boolean; bottom: boolean },
  key: string,
): HTMLCanvasElement {
  const cached = featheredSubjects.get(layer.canvas);
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
  featheredSubjects.set(layer.canvas, { key, canvas });
  return canvas;
}
