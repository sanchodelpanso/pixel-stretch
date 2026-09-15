import type { Layer } from '../types/layer';
import type { Point, StretchSpec } from '../types/stretch';
import { hasCurvedEdges } from '../types/stretch';
import { arcBounds, arcLookup, arcPoint, edgeTables } from '../types/arc-band';
import { blendColumn, blendFraction, smearRate, smearStreak, smoothstep, swapRamp } from './edge-blend-profile';
import { bandLocalToDoc, bandPlacement, layerPixels, patchMesh, placeBandLocal, type BandRender } from './stretch-band';
import { bandSurface } from './surface';
import { getGL } from './gl/gl-context';
import { meltOnGL, type MeltInput } from './gl/melt';

/** Longest arc, in pixels, the melt is laid out along before being read back. */
const MAX_ARC_LENGTH = 4096;

/**
 * How a band melts its subject, in document space: `erase` is how much of the
 * subject gives way, and `smear` is the subject's own pixels dragged out along
 * the streaks to take its place.
 */
export interface SubjectMelt {
  erase: BandRender;
  smear: BandRender;
}

/** Bilinear, premultiplied RGBA of a layer at a document point, written into `out` at `offset`. */
function samplePremultiplied(layer: Layer, pixels: ImageData, point: Point, out: Float32Array, offset: number): void {
  const sx = point.x - layer.x - 0.5;
  const sy = point.y - layer.y - 0.5;
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const fx = sx - x0;
  const fy = sy - y0;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = 0; dx <= 1; dx++) {
      const px = x0 + dx;
      const py = y0 + dy;
      if (px < 0 || py < 0 || px >= layer.width || py >= layer.height) continue;
      const i = (py * layer.width + px) * 4;
      const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (pixels.data[i + 3] / 255);
      r += pixels.data[i] * weight;
      g += pixels.data[i + 1] * weight;
      b += pixels.data[i + 2] * weight;
      a += 255 * weight;
    }
  }
  out[offset] = r;
  out[offset + 1] = g;
  out[offset + 2] = b;
  out[offset + 3] = a;
}

/**
 * Build the melt as two upright textures, `columns × length`, one streak per
 * column: the subject is read along each streak from the sample line out,
 * smeared over a window that grows past where the melt starts, and handed
 * over from the subject to that smear over a short ramp.
 */
function meltTextures(
  subject: Layer,
  columns: number,
  length: number,
  strength: number,
  toDoc: (x: number, y: number) => Point,
): { erase: Uint8ClampedArray; smear: Uint8ClampedArray } {
  const pixels = layerPixels(subject);
  const blend = length * blendFraction(strength);
  const ramp = swapRamp(blend);
  const erase = new Uint8ClampedArray(columns * length * 4);
  const smear = new Uint8ClampedArray(columns * length * 4);
  const samples = new Float32Array(length * 4);

  for (let x = 0; x < columns; x++) {
    const { wander, side } = blendColumn(x, columns, blend);
    if (side <= 0) continue;
    for (let y = 0; y < length; y++) samplePremultiplied(subject, pixels, toDoc(x + 0.5, y + 0.5), samples, y * 4);
    const smeared = smearStreak(samples, length, wander, smearRate(x, strength));

    for (let y = 0; y < length; y++) {
      const amount = side * smoothstep((y + 0.5 - wander) / ramp);
      if (amount <= 0) continue;
      const i = (y * columns + x) * 4;
      erase[i + 3] = amount * 255;
      const coverage = smeared[y * 4 + 3];
      if (coverage <= 0) continue;
      const unpremultiply = 255 / coverage;
      smear[i] = smeared[y * 4] * unpremultiply;
      smear[i + 1] = smeared[y * 4 + 1] * unpremultiply;
      smear[i + 2] = smeared[y * 4 + 2] * unpremultiply;
      smear[i + 3] = coverage * amount;
    }
  }
  return { erase, smear };
}

function textureCanvas(data: Uint8ClampedArray, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(width, height);
  image.data.set(data);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * How a band with an edge blend melts its lifted subject, or null when it
 * doesn't blend. The subject stays sharp up to where each streak's melt
 * starts; past that its own pixels are dragged out along the streak into a
 * lengthening smear that thins away beyond the object's edge, so the object
 * runs into the stretch rather than fading over it.
 */
export function renderSubjectMelt(spec: StretchSpec, subject: Layer): SubjectMelt | null {
  const strength = Math.max(0, Math.min(1, spec.edgeBlend ?? 0));
  if (strength <= 0 || spec.points.length < 2) return null;
  const columns = Math.max(2, Math.round(Math.abs(spec.width)));

  const onGpu = meltWithGpu(spec, subject, columns, strength);
  if (onGpu !== undefined) return onGpu;

  if (!spec.arc) {
    const length = Math.round(Math.abs(spec.length));
    if (length < 1) return null;
    const { erase, smear } = meltTextures(subject, columns, length, strength, bandLocalToDoc(spec, columns, length));
    const erasePlaced = placeBandLocal(spec, textureCanvas(erase, columns, length));
    const smearPlaced = placeBandLocal(spec, textureCanvas(smear, columns, length));
    return erasePlaced && smearPlaced ? { erase: erasePlaced, smear: smearPlaced } : null;
  }

  const arc = spec.arc;
  const width = Math.abs(spec.width);
  const length = Math.max(1, Math.round(Math.min(MAX_ARC_LENGTH, Math.abs(arc.sweep) * arc.radius)));
  // Column x runs across the ring from whichever edge the path started on.
  const toDoc = (x: number, y: number): Point => {
    const across = x / columns;
    const offset = (arc.outward ? across : 1 - across) * width - width / 2;
    return arcPoint(arc, offset, y / length);
  };
  const textures = meltTextures(subject, columns, length, strength, toDoc);

  const bounds = arcBounds(arc, width);
  const minX = Math.floor(bounds.minX) - 1;
  const minY = Math.floor(bounds.minY) - 1;
  const outW = Math.ceil(bounds.maxX) + 1 - minX;
  const outH = Math.ceil(bounds.maxY) + 1 - minY;
  if (outW < 1 || outH < 1) return null;

  const erase = new Uint8ClampedArray(outW * outH * 4);
  const smear = new Uint8ClampedArray(outW * outH * 4);
  const lookup = arcLookup(arc, width);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const hit = lookup(minX + x + 0.5, minY + y + 0.5);
      if (!hit) continue;
      const column = Math.min(columns - 1, Math.round(hit.u * (columns - 1)));
      const row = Math.min(length - 1, Math.floor(hit.t * length));
      const from = (row * columns + column) * 4;
      const to = (y * outW + x) * 4;
      erase[to + 3] = textures.erase[from + 3] * hit.coverage;
      smear[to] = textures.smear[from];
      smear[to + 1] = textures.smear[from + 1];
      smear[to + 2] = textures.smear[from + 2];
      smear[to + 3] = textures.smear[from + 3] * hit.coverage;
    }
  }
  return {
    erase: { canvas: textureCanvas(erase, outW, outH), x: minX, y: minY },
    smear: { canvas: textureCanvas(smear, outW, outH), x: minX, y: minY },
  };
}

/**
 * The melt on the GPU, or undefined when there's no GPU (or it can't take
 * this size) so the CPU path runs. Null means the band itself is degenerate.
 */
function meltWithGpu(spec: StretchSpec, subject: Layer, columns: number, strength: number): SubjectMelt | null | undefined {
  const gpu = getGL();
  if (!gpu) return undefined;

  let length: number;
  let geometry: MeltInput['geometry'];
  if (spec.arc) {
    const arc = spec.arc;
    const width = Math.abs(spec.width);
    length = Math.max(1, Math.round(Math.min(MAX_ARC_LENGTH, Math.abs(arc.sweep) * arc.radius)));
    const box = arcBounds(arc, width);
    const minX = Math.floor(box.minX) - 1;
    const minY = Math.floor(box.minY) - 1;
    const bounds = { minX, minY, width: Math.ceil(box.maxX) + 1 - minX, height: Math.ceil(box.maxY) + 1 - minY };
    if (bounds.width < 1 || bounds.height < 1) return null;
    const tables = edgeTables(arc, width);
    geometry = { kind: 'arc', arc, width, inner: tables.inner, outer: tables.outer, bounds };
  } else {
    length = Math.round(Math.abs(spec.length));
    if (length < 1) return null;
    const placement = bandPlacement(spec, columns, length);
    if (!placement) return null;
    // A plain rectangle is one affine cell; the GPU still needs it as a mesh.
    const mesh = placement.mesh ?? patchMesh(spec, bandSurface(spec), 1, 1);
    geometry = { kind: 'mesh', mesh, bounds: placement.bounds, curved: hasCurvedEdges(spec) };
  }

  const blend = length * blendFraction(strength);
  const wander = new Float32Array(columns);
  const side = new Float32Array(columns);
  const rate = new Float32Array(columns);
  for (let x = 0; x < columns; x++) {
    const column = blendColumn(x, columns, blend);
    wander[x] = column.wander;
    side[x] = column.side;
    rate[x] = smearRate(x, strength);
  }

  const melted = meltOnGL(gpu, { subject, columns, length, wander, side, rate, ramp: swapRamp(blend), geometry });
  if (!melted) return undefined;
  const { minX, minY } = geometry.bounds;
  return {
    erase: { canvas: melted.erase, x: minX, y: minY },
    smear: { canvas: melted.smear, x: minX, y: minY },
  };
}
