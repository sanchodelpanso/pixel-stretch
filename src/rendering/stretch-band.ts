import type { Layer } from '../types/layer';
import type { StretchSpec, Point } from '../types/stretch';
import { rectBasis, bandCorners, warpedCorners, isWarped, hasCurvedEdges, isConvexShape } from '../types/stretch';
import type { ArcBand } from '../types/arc-band';
import { arcBounds, arcLookup } from '../types/arc-band';
import { bendPoint } from './projection';
import { bandSurface } from './surface';
import type { SurfaceMap } from './surface';
import { samplePath } from './sample-path';
import { clamp } from '../utils/math-utils';
import { simplifyRow } from './color-simplify';
import {
  DEFAULT_GRID_SIZE, gridEffect, gridLineWidth, parseHexColor, splitColorAndAlpha, type GridOptions,
} from './grid-texture';
import {
  DEFAULT_MOTION_FADE_IN, DEFAULT_MOTION_SCATTER, DEFAULT_MOTION_SOFTNESS, motionStreakPixels,
} from './motion-streaks';
import {
  DEFAULT_PIXEL_SCATTER, DEFAULT_PIXEL_SIZE, DEFAULT_PIXEL_SOFTNESS, DEFAULT_PIXEL_START_SCATTER, drawPixelStreaks,
} from './pixel-streaks';

export interface BandRender {
  /** Band pixels, sized to the rectangle's axis-aligned bounding box. */
  canvas: HTMLCanvasElement;
  /** Where that bounding box sits in the document. */
  x: number;
  y: number;
}

/** Bands smaller than this in either axis aren't worth rendering. */
const MIN_SIZE = 1;

/**
 * Absorbed when snapping the bounding box to whole pixels. A rotated basis is
 * built from sin/cos, so an axis that should be exactly 40 long comes out at
 * 40.0000000000000006 — enough for `ceil` to add a stray transparent row.
 */
const PIXEL_EPSILON = 1e-6;

/**
 * Reading a full-resolution layer back off the GPU costs more than the whole
 * band render, and a live handle drag re-renders every frame. Layers swap in a
 * new canvas whenever their pixels change, so keying on the canvas keeps this
 * correct without an explicit invalidation.
 */
const sourcePixelCache = new WeakMap<HTMLCanvasElement, ImageData>();

export function layerPixels(source: Layer): ImageData {
  return sourcePixels(source);
}

function sourcePixels(source: Layer): ImageData {
  let cached = sourcePixelCache.get(source.canvas);
  if (!cached) {
    cached = source.canvas
      .getContext('2d', { willReadFrequently: true })!
      .getImageData(0, 0, source.width, source.height);
    sourcePixelCache.set(source.canvas, cached);
  }
  return cached;
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}


/** The pixel style's options for a band, with defaults filled in. */
function pixelOptions(spec: StretchSpec) {
  return {
    blockSize: spec.pixelSize ?? DEFAULT_PIXEL_SIZE,
    scatter: spec.pixelScatter ?? DEFAULT_PIXEL_SCATTER,
    startScatter: spec.pixelStartScatter ?? DEFAULT_PIXEL_START_SCATTER,
    softness: spec.pixelSoftness ?? DEFAULT_PIXEL_SOFTNESS,
  };
}

/** The motion style's options for a band, with defaults filled in. */
function motionOptions(spec: StretchSpec) {
  return {
    scatter: spec.motionScatter ?? DEFAULT_MOTION_SCATTER,
    softness: spec.motionSoftness ?? DEFAULT_MOTION_SOFTNESS,
    fadeIn: spec.motionFadeIn ?? DEFAULT_MOTION_FADE_IN,
  };
}

/** Longest band, in pixels, the pixel and motion styles lay out for an arc before scaling it to fit. */
const MAX_PIXEL_ARC_LENGTH = 4096;

/** How many colours the sampled row is merged into, and whether their borders are softened. */
type ColorOptions = Pick<StretchSpec, 'colorCount' | 'colorBlend'>;

/** Bilinear read of one channel at a document point, treating out-of-bounds as empty. */
function sampleChannel(layer: Layer, pixels: ImageData, point: Point, channel: number): number {
  // Into the layer's own pixel space.
  const sx = point.x - layer.x;
  const sy = point.y - layer.y;
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const fx = sx - x0;
  const fy = sy - y0;
  let acc = 0;
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = 0; dx <= 1; dx++) {
      const px = x0 + dx;
      const py = y0 + dy;
      if (px < 0 || py < 0 || px >= layer.width || py >= layer.height) continue;
      acc += pixels.data[(py * layer.width + px) * 4 + channel] * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
    }
  }
  return acc;
}

/**
 * Read `columns` pixels along the sample path — the row of colours the band
 * repeats, as raw RGBA. The path's whole arc always maps across the whole
 * row, so widening the band stretches the same pixels rather than reaching
 * for new ones; sampling is bilinear so a curve doesn't stairstep. With a `subject`
 * mask, each sample keeps only as much opacity as the subject has there, so
 * background the path crosses drops out of the band.
 */
function samplePathRow(
  source: Layer,
  points: Point[],
  columns: number,
  subject: Layer | null,
  colors: ColorOptions = {},
): Uint8ClampedArray {
  const pixels = sourcePixels(source);
  const mask = subject ? sourcePixels(subject) : null;
  const along = samplePath(points, columns);
  const out = new Uint8ClampedArray(columns * 4);

  for (let i = 0; i < columns; i++) {
    for (let c = 0; c < 4; c++) out[i * 4 + c] = sampleChannel(source, pixels, along[i], c);
    if (subject && mask) out[i * 4 + 3] *= sampleChannel(subject, mask, along[i], 3) / 255;
  }

  return colors.colorCount
    ? simplifyRow(out, columns, colors.colorCount, colors.colorBlend ?? 0)
    : out;
}

/** How much of the path has to run over the subject before a new band reads only the subject. */
const SUBJECT_COVERAGE = 0.05;

/**
 * Whether a path runs over the lifted subject enough that its band should
 * read only the subject. A path laid purely across background stays as it is.
 */
export function pathCrossesSubject(points: Point[], subject: Layer): boolean {
  const mask = sourcePixels(subject);
  const samples = samplePath(points, 256);
  const covered = samples.filter((point) => sampleChannel(subject, mask, point, 3) > 127).length;
  return covered / samples.length >= SUBJECT_COVERAGE;
}

/** How opaque the band is `t` of the way along its extrusion. */
function fadeAlong(t: number, fade: number, soft: number): number {
  const far = clamp(1 - fade, 0, 1);
  if (soft <= 0) return 1 + (far - 1) * t;
  const knee = 1 - soft;
  return t < knee ? 1 + (far - 1) * (t / knee) : far * (1 - (t - knee) / soft);
}

/** Softening across the band: ramps in over `soft` at either end of the row. */
function fadeAcross(u: number, soft: number): number {
  if (soft <= 0) return 1;
  return Math.min(1, u / soft, (1 - u) / soft);
}

/**
 * Render a band swept round a pivot.
 *
 * Every column of the strip travels round the same centre, so the band is a
 * slice of a ring. It is drawn by inverse mapping: each output pixel finds its
 * radius (which pixel of the strip) and bearing (how far along the sweep), so
 * the streaks come out as exact concentric arcs with antialiased edges.
 */
function renderArcBand(spec: StretchSpec, arc: ArcBand, source: Layer, subject: Layer | null): BandRender | null {
  const width = Math.abs(spec.width);
  if (width < MIN_SIZE || Math.abs(arc.sweep) * (arc.radius + width / 2) < MIN_SIZE) return null;

  const bounds = arcBounds(arc, width);
  const minX = Math.floor(bounds.minX) - 1;
  const minY = Math.floor(bounds.minY) - 1;
  const outW = Math.ceil(bounds.maxX) + 1 - minX;
  const outH = Math.ceil(bounds.maxY) + 1 - minY;
  if (outW < MIN_SIZE || outH < MIN_SIZE) return null;

  const columns = Math.max(2, Math.round(width));
  const pixel = spec.style === 'pixel';
  const motion = spec.style === 'motion';
  // Pixel and motion streaks shape the colours themselves; merging them first would fight that.
  const row = samplePathRow(source, spec.points, columns, subject, pixel || motion ? {} : spec);
  const soft = clamp(spec.edgeSoftness, 0, 0.49);

  // Pixel and motion streaks are laid out once along the unrolled arc, then read back per output pixel.
  let streaks: { data: Uint8ClampedArray; length: number } | null = null;
  if (pixel || motion) {
    const length = Math.max(1, Math.min(MAX_PIXEL_ARC_LENGTH, Math.round(Math.abs(arc.sweep) * arc.radius)));
    if (motion) {
      streaks = { data: motionStreakPixels(row, columns, length, motionOptions(spec)), length };
    } else {
      const unrolled = createCanvas(columns, length);
      const uctx = unrolled.getContext('2d', { willReadFrequently: true })!;
      drawPixelStreaks(uctx, row, columns, length, pixelOptions(spec));
      streaks = { data: uctx.getImageData(0, 0, columns, length).data, length };
    }
  }

  const output = createCanvas(outW, outH);
  const octx = output.getContext('2d')!;
  const image = octx.createImageData(outW, outH);
  const data = image.data;

  const grid = gridOptions(spec);
  const gridColor = parseHexColor(grid.color);
  const arcLength = Math.abs(arc.sweep) * arc.radius;
  const lookup = arcLookup(arc, width);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const hit = lookup(minX + x + 0.5, minY + y + 0.5);
      if (!hit) continue;

      const position = hit.u * (columns - 1);
      const effect = gridEffect(position, hit.t * arcLength, grid);
      const alpha = hit.coverage * fadeAlong(hit.t, spec.fade, soft) * fadeAcross(hit.u, soft) * effect.keep;
      const i = (y * outW + x) * 4;
      if (streaks) {
        // Nearest cell, so the blocks stay crisp.
        const column = Math.min(columns - 1, Math.round(position));
        const along = Math.min(streaks.length - 1, Math.floor(hit.t * streaks.length));
        const s = (along * columns + column) * 4;
        data[i] = streaks.data[s];
        data[i + 1] = streaks.data[s + 1];
        data[i + 2] = streaks.data[s + 2];
        data[i + 3] = streaks.data[s + 3] * alpha;
      } else {
        const left = Math.min(columns - 2, Math.floor(position));
        const mix = position - left;
        const a = left * 4;
        const b = a + 4;
        data[i] = row[a] + (row[b] - row[a]) * mix;
        data[i + 1] = row[a + 1] + (row[b + 1] - row[a + 1]) * mix;
        data[i + 2] = row[a + 2] + (row[b + 2] - row[a + 2]) * mix;
        data[i + 3] = (row[a + 3] + (row[b + 3] - row[a + 3]) * mix) * alpha;
      }
      if (gridColor && effect.paint > 0) {
        // Grid lines take the chosen colour, within the band's own opacity.
        data[i] += (gridColor[0] - data[i]) * effect.paint;
        data[i + 1] += (gridColor[1] - data[i + 1]) * effect.paint;
        data[i + 2] += (gridColor[2] - data[i + 2]) * effect.paint;
      }
    }
  }

  octx.putImageData(image, 0, 0);
  return { canvas: output, x: minX, y: minY };
}

/**
 * Fade along the extrusion, and soften all four edges. Both are alpha-only, so
 * they're applied as gradients through `destination-in`, which multiplies.
 */
function shapeAlpha(canvas: HTMLCanvasElement, spec: StretchSpec): void {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  const soft = clamp(spec.edgeSoftness, 0, 0.49);
  ctx.globalCompositeOperation = 'destination-in';

  // Along the extrusion: the fade ramp, plus a soft stop at the far end.
  // Local +y always runs away from the path, whichever side the band is on,
  // so this ramp needs no special case for a flipped band.
  const ramp = ctx.createLinearGradient(0, 0, 0, height);
  ramp.addColorStop(0, 'rgba(0,0,0,1)');
  const farAlpha = clamp(1 - spec.fade, 0, 1);
  if (soft > 0) {
    ramp.addColorStop(clamp(1 - soft, 0, 1), `rgba(0,0,0,${farAlpha})`);
  }
  ramp.addColorStop(1, soft > 0 ? 'rgba(0,0,0,0)' : `rgba(0,0,0,${farAlpha})`);
  ctx.fillStyle = ramp;
  ctx.fillRect(0, 0, width, height);

  // Across the band: soften both ends of the sampled row.
  if (soft > 0) {
    const ends = ctx.createLinearGradient(0, 0, width, 0);
    ends.addColorStop(0, 'rgba(0,0,0,0)');
    ends.addColorStop(soft, 'rgba(0,0,0,1)');
    ends.addColorStop(1 - soft, 'rgba(0,0,0,1)');
    ends.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = ends;
    ctx.fillRect(0, 0, width, height);
  }

  ctx.globalCompositeOperation = 'source-over';
}

/**
 * Grid resolution for distorted bands, in cells per axis. A fold curves as
 * sharply along the band as across it, and perspective magnifies as strongly,
 * so both axes need the same.
 */
const PATCH_CELLS = 72;

/** A distorted band diced into cells: `points[row][column]` in document space. */
interface PatchMesh {
  cols: number;
  rows: number;
  points: Point[][];
  /** How far each vertex moved from where the flat rectangle had it. */
  lift: number[][];
}

function patchMesh(spec: StretchSpec, at: SurfaceMap, width: number, height: number): PatchMesh {
  const cols = Math.max(1, Math.min(PATCH_CELLS, width));
  const rows = Math.max(1, Math.min(PATCH_CELLS, height));
  const { along, out } = rectBasis(spec);
  const points: Point[][] = [];
  const lift: number[][] = [];
  for (let j = 0; j <= rows; j++) {
    const pointRow: Point[] = [];
    const liftRow: number[] = [];
    for (let i = 0; i <= cols; i++) {
      const u = i / cols;
      const v = j / rows;
      const uv = bendPoint(u, v, spec.bend);
      const point = at(uv.x, uv.y);
      const flatX = spec.anchor.x + along.x * spec.width * u + out.x * spec.length * v;
      const flatY = spec.anchor.y + along.y * spec.width * u + out.y * spec.length * v;
      pointRow.push(point);
      liftRow.push(Math.hypot(point.x - flatX, point.y - flatY));
    }
    points.push(pointRow);
    lift.push(liftRow);
  }
  return { cols, rows, points, lift };
}

/**
 * Draw the band across a distorted surface — a Bézier sheet, a perspective
 * skew or a cylindrical bend.
 *
 * The band is diced into a grid, each cell mapped by the affine through three
 * of its corners, which converges quickly because the surface is smooth.
 * Cells are drawn a touch oversized so their neighbours cover the seams.
 *
 * One affine per source column would be exact for a skew, but a column is
 * only a pixel wide at the sample line: where perspective widens the far end
 * the columns spread into separate streaks with gaps between, and where it
 * narrows hundreds of them pile onto a few pixels and alias into moiré.
 * Cells stay a few pixels across in the source, so smoothing covers both.
 *
 * A corner pulled far enough folds the sheet over itself. Cells go down in
 * order of how far they moved from the flat rectangle, so the folded-over flap
 * lands on top of the sheet beneath it, as paper would.
 */
function drawPatch(
  ctx: CanvasRenderingContext2D,
  local: HTMLCanvasElement,
  mesh: PatchMesh,
  offsetX: number,
  offsetY: number,
): void {
  const { width, height } = local;
  const { cols, rows, points, lift } = mesh;
  const cellW = width / cols;
  const cellH = height / rows;

  const cells: { i: number; j: number; lift: number }[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      cells.push({ i, j, lift: lift[j][i] + lift[j][i + 1] + lift[j + 1][i] + lift[j + 1][i + 1] });
    }
  }
  cells.sort((a, b) => a.lift - b.lift);

  for (const { i, j } of cells) {
    const topLeft = points[j][i];
    const topRight = points[j][i + 1];
    const bottomLeft = points[j + 1][i];

    const ax = (topRight.x - topLeft.x) / cellW;
    const ay = (topRight.y - topLeft.y) / cellW;
    const cx = (bottomLeft.x - topLeft.x) / cellH;
    const cy = (bottomLeft.y - topLeft.y) / cellH;
    if (![ax, ay, cx, cy].every(Number.isFinite)) continue;

    const sx = i * cellW;
    const sy = j * cellH;
    ctx.setTransform(
      ax, ay, cx, cy,
      topLeft.x - ax * sx - cx * sy + offsetX,
      topLeft.y - ay * sx - cy * sy + offsetY,
    );
    // Overdraw by a pixel of source on each far side to hide the seams.
    const w = Math.min(cellW + 1, width - sx);
    const h = Math.min(cellH + 1, height - sy);
    ctx.drawImage(local, sx, sy, w, h, sx, sy, w, h);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * Render a stretch band to its own bitmap.
 *
 * The band is built upright in local space — the sampled row across the top,
 * extruded straight down — then blitted into the output with a single affine
 * transform built from the path's chord. Because every column is a constant
 * colour, the extrusion is one `drawImage` that scales a 1px-tall strip to
 * full height rather than any per-pixel work.
 *
 * Returns null when the rectangle is degenerate.
 */
export function renderStretchBand(spec: StretchSpec, source: Layer, subject: Layer | null = null): BandRender | null {
  // The subject only masks the samples when the band asks for it.
  const mask = spec.subjectOnly ? subject : null;
  if (spec.arc) return spec.points.length < 2 ? null : renderArcBand(spec, spec.arc, source, mask);

  const width = Math.round(Math.abs(spec.width));
  const height = Math.round(Math.abs(spec.length));
  if (spec.points.length < 2 || width < MIN_SIZE || height < MIN_SIZE) return null;

  const local = createCanvas(width, height);
  const lctx = local.getContext('2d')!;
  const pixel = spec.style === 'pixel';
  /** Whether every sample on the path is fully opaque; pixel and motion streaks have gaps regardless. */
  let solidRow = false;
  if (pixel) {
    // Pixel blocks already quantise the colours, so they read the raw samples.
    drawPixelStreaks(lctx, samplePathRow(source, spec.points, width, mask), width, height, pixelOptions(spec));
  } else if (spec.style === 'motion') {
    const pixels = motionStreakPixels(samplePathRow(source, spec.points, width, mask), width, height, motionOptions(spec));
    const image = lctx.createImageData(width, height);
    image.data.set(pixels);
    lctx.putImageData(image, 0, 0);
  } else {
    const row = samplePathRow(source, spec.points, width, mask, spec);
    for (let i = 3; i < row.length; i += 4) if (row[i] < 255) solidRow = false;
    // Every output row is the same row of colours; no resampling wanted.
    lctx.imageSmoothingEnabled = false;
    lctx.drawImage(stripFromRow(row, width), 0, 0, width, 1, 0, 0, width, height);
  }
  shapeAlpha(local, spec);
  applyGridTexture(local, gridOptions(spec));
  // Only a smooth band with solid samples and no fade, softening or grid is fully opaque.
  const translucent = !solidRow || spec.fade > 0 || spec.edgeSoftness > 0 || (spec.gridTexture ?? 0) > 0;
  // Keep crisp pixel blocks crisp; smooth streaks and feathered blocks want high-quality filtering.
  return placeBandLocal(spec, local, pixel && !spec.pixelSoftness, translucent);
}

/** A 1px-tall canvas holding a sampled row of colours. */
function stripFromRow(row: Uint8ClampedArray, columns: number): HTMLCanvasElement {
  const strip = createCanvas(columns, 1);
  const ctx = strip.getContext('2d')!;
  const out = ctx.createImageData(columns, 1);
  out.data.set(row);
  ctx.putImageData(out, 0, 0);
  return strip;
}

/** A band's grid texture settings, with defaults filled in. */
function gridOptions(spec: StretchSpec): GridOptions {
  return {
    strength: spec.gridTexture ?? 0,
    size: spec.gridSize ?? DEFAULT_GRID_SIZE,
    style: spec.gridStyle ?? 'cut',
    color: spec.gridColor,
  };
}

/**
 * Apply the grid texture to a band's upright local bitmap with repeating
 * tiles, matching `gridEffect` pixel for pixel: cut lines are erased or
 * painted over, staying within the band's own opacity; in grid-only mode the
 * cells are erased entirely and the lines keep the stretch at `strength`.
 */
function applyGridTexture(local: HTMLCanvasElement, grid: GridOptions): void {
  const strength = Math.max(0, Math.min(1, grid.strength));
  if (strength <= 0) return;
  const cell = Math.max(1, Math.round(grid.size));
  const line = gridLineWidth(cell);
  const ctx = local.getContext('2d')!;

  const fillTile = (paint: (tctx: CanvasRenderingContext2D) => void, operation: GlobalCompositeOperation) => {
    const tile = createCanvas(cell, cell);
    paint(tile.getContext('2d')!);
    const pattern = ctx.createPattern(tile, 'repeat');
    if (!pattern) return;
    ctx.globalCompositeOperation = operation;
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, local.width, local.height);
    ctx.globalCompositeOperation = 'source-over';
  };
  const lines = (tctx: CanvasRenderingContext2D) => {
    tctx.fillRect(cell - line, 0, line, cell);
    tctx.fillRect(0, cell - line, cell - line, line);
  };

  if (grid.style === 'lines') {
    // Clear the cells, and thin the lines to the chosen strength.
    fillTile((tctx) => {
      tctx.fillStyle = '#000';
      tctx.fillRect(0, 0, cell - line, cell - line);
      tctx.globalAlpha = 1 - strength;
      lines(tctx);
    }, 'destination-out');
    return;
  }
  fillTile((tctx) => {
    tctx.globalAlpha = strength;
    tctx.fillStyle = grid.color ?? '#000';
    lines(tctx);
  }, grid.color ? 'source-atop' : 'destination-out');
}

/**
 * Draw a translucent texture across the cell mesh without seams. Cells overlap
 * by a pixel to hide gaps, which is invisible for opaque pixels but doubles up
 * translucent ones into a visible grid along every cell border. So colour and
 * alpha are drawn as two opaque images, whose overlaps match exactly, and
 * recombined afterwards.
 */
function drawPatchSeamless(
  ctx: CanvasRenderingContext2D,
  local: HTMLCanvasElement,
  mesh: PatchMesh,
  offsetX: number,
  offsetY: number,
  crisp: boolean,
): void {
  const { width, height } = local;
  const source = local.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, width, height);
  const { color, alpha } = splitColorAndAlpha(source.data, width, height);
  const toCanvas = (data: Uint8ClampedArray) => {
    const canvas = createCanvas(width, height);
    const cctx = canvas.getContext('2d')!;
    const image = cctx.createImageData(width, height);
    image.data.set(data);
    cctx.putImageData(image, 0, 0);
    return canvas;
  };

  const out = ctx.canvas;
  const coverage = createCanvas(out.width, out.height);
  const actx = coverage.getContext('2d', { willReadFrequently: true })!;
  if (crisp) actx.imageSmoothingEnabled = false;
  else actx.imageSmoothingQuality = 'high';
  drawPatch(ctx, toCanvas(color), mesh, offsetX, offsetY);
  drawPatch(actx, toCanvas(alpha), mesh, offsetX, offsetY);

  const colorPixels = ctx.getImageData(0, 0, out.width, out.height);
  const alphaPixels = actx.getImageData(0, 0, out.width, out.height).data;
  for (let i = 0; i < alphaPixels.length; i += 4) {
    // Grey carries the texture's alpha; the grey image's own alpha is the mesh's edge coverage.
    colorPixels.data[i + 3] = (alphaPixels[i] * alphaPixels[i + 3]) / 255;
  }
  ctx.putImageData(colorPixels, 0, 0);
}

/**
 * Where a point of a straight band's upright local bitmap — `width × height`,
 * the sample line along its top — lands in the document, through the same
 * geometry `placeBandLocal` draws with.
 */
export function bandLocalToDoc(spec: StretchSpec, width: number, height: number): (x: number, y: number) => Point {
  const distorted = hasCurvedEdges(spec) || isWarped(spec) || spec.bend !== 0 || spec.removedEdge !== undefined;
  if (distorted) {
    const at = bandSurface(spec);
    return (x, y) => {
      const uv = bendPoint(x / width, y / height, spec.bend);
      return at(uv.x, uv.y);
    };
  }
  const { along, out } = rectBasis(spec);
  const sign = spec.length < 0 ? -1 : 1;
  return (x, y) => ({
    x: spec.anchor.x + along.x * x + out.x * sign * y,
    y: spec.anchor.y + along.y * x + out.y * sign * y,
  });
}

/**
 * Lay a straight band's upright local bitmap — `|width| × |length|`, the sample
 * line along its top — onto the document through the band's geometry: one
 * affine blit for a plain rectangle, the cell mesh once it is skewed, bent or
 * curved. Returns null when the shape is degenerate.
 */
export function placeBandLocal(
  spec: StretchSpec,
  local: HTMLCanvasElement,
  crisp = false,
  translucent = true,
): BandRender | null {
  const width = local.width;
  const height = local.height;
  const { along, out } = rectBasis(spec);
  const flipped = spec.length < 0;
  // Local +y always points the way the band actually extrudes.
  const outSigned = { x: out.x * (flipped ? -1 : 1), y: out.y * (flipped ? -1 : 1) };

  // Local (0,0) is the anchor on the path for either sign of `length` — the
  // side is carried entirely by `outSigned`, so the origin never moves.
  const origin: Point = spec.anchor;
  const curved = hasCurvedEdges(spec);
  const distorted = curved || isWarped(spec) || spec.bend !== 0 || spec.removedEdge !== undefined;

  // The corner order already matches local (0,0)→(w,0)→(w,h)→(0,h): local
  // (0,height) lands on corner 3 for either sign of `length`, because
  // `outSigned` and `|length|` flip together.
  const quad = warpedCorners(spec);
  // A non-convex quad throws the homography's points out towards infinity —
  // an unbounded canvas. Keep the last good pixels instead (e.g. a width
  // slider shrinking a skewed band past its own corners).
  if (!curved && distorted && !isConvexShape(spec)) return null;
  const at = bandSurface(spec);
  // A folded sheet or a bend can reach past the quad's own corners, so bound
  // it by every vertex.
  const mesh = distorted ? patchMesh(spec, at, width, height) : null;

  const bounds = mesh ? mesh.points.flat() : quad;
  const minX = Math.floor(Math.min(...bounds.map((c) => c.x)) + PIXEL_EPSILON);
  const minY = Math.floor(Math.min(...bounds.map((c) => c.y)) + PIXEL_EPSILON);
  const maxX = Math.ceil(Math.max(...bounds.map((c) => c.x)) - PIXEL_EPSILON);
  const maxY = Math.ceil(Math.max(...bounds.map((c) => c.y)) - PIXEL_EPSILON);
  if (maxX - minX < MIN_SIZE || maxY - minY < MIN_SIZE) return null;

  const output = createCanvas(maxX - minX, maxY - minY);
  const octx = output.getContext('2d')!;
  if (crisp) octx.imageSmoothingEnabled = false;
  else octx.imageSmoothingQuality = 'high';

  if (mesh && translucent) {
    drawPatchSeamless(octx, local, mesh, -minX, -minY, crisp);
  } else if (mesh) {
    drawPatch(octx, local, mesh, -minX, -minY);
  } else {
    // Undistorted: one blit, columns of the matrix are the local axes.
    octx.setTransform(
      along.x, along.y,
      outSigned.x, outSigned.y,
      origin.x - minX, origin.y - minY,
    );
    octx.drawImage(local, 0, 0);
    octx.setTransform(1, 0, 0, 1, 0, 0);
  }

  return { canvas: output, x: minX, y: minY };
}

export { bandCorners };
