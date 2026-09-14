import type { Layer } from '../types/layer';
import type { StretchSpec, Point } from '../types/stretch';
import { rectBasis, bandCorners, warpedCorners, isWarped, hasCurvedEdges } from '../types/stretch';
import type { ArcBand } from '../types/arc-band';
import { arcBounds, arcLookup } from '../types/arc-band';
import { bendPoint } from './projection';
import { bandSurface } from './surface';
import type { SurfaceMap } from './surface';
import { samplePath } from './sample-path';
import { clamp } from '../utils/math-utils';

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

/**
 * Read `columns` pixels along the sample path into a 1px-tall strip — the row
 * of colours the band repeats. The path's whole arc always maps across the
 * whole strip, so widening the rectangle stretches the same pixels rather than
 * reaching for new ones. Sampling is bilinear so a curve doesn't stairstep.
 */
function samplePathStrip(source: Layer, points: Point[], columns: number): HTMLCanvasElement {
  const strip = createCanvas(columns, 1);
  const ctx = strip.getContext('2d')!;
  const out = ctx.createImageData(columns, 1);
  out.data.set(samplePathRow(source, points, columns));
  ctx.putImageData(out, 0, 0);
  return strip;
}

/** The same row of colours as `samplePathStrip`, as raw RGBA. */
function samplePathRow(source: Layer, points: Point[], columns: number): Uint8ClampedArray {
  const pixels = sourcePixels(source);
  const along = samplePath(points, columns);
  const out = new Uint8ClampedArray(columns * 4);

  for (let i = 0; i < columns; i++) {
    // Into the source layer's own pixel space.
    const sx = along[i].x - source.x;
    const sy = along[i].y - source.y;

    const x0 = Math.floor(sx);
    const y0 = Math.floor(sy);
    const fx = sx - x0;
    const fy = sy - y0;

    for (let c = 0; c < 4; c++) {
      let acc = 0;
      // Bilinear across the four neighbours, treating out-of-bounds as empty.
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const px = x0 + dx;
          const py = y0 + dy;
          if (px < 0 || py < 0 || px >= source.width || py >= source.height) continue;
          const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
          acc += pixels.data[(py * source.width + px) * 4 + c] * w;
        }
      }
      out[i * 4 + c] = acc;
    }
  }

  return out;
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
function renderArcBand(spec: StretchSpec, arc: ArcBand, source: Layer): BandRender | null {
  const width = Math.abs(spec.width);
  if (width < MIN_SIZE || Math.abs(arc.sweep) * (arc.radius + width / 2) < MIN_SIZE) return null;

  const bounds = arcBounds(arc, width);
  const minX = Math.floor(bounds.minX) - 1;
  const minY = Math.floor(bounds.minY) - 1;
  const outW = Math.ceil(bounds.maxX) + 1 - minX;
  const outH = Math.ceil(bounds.maxY) + 1 - minY;
  if (outW < MIN_SIZE || outH < MIN_SIZE) return null;

  const columns = Math.max(2, Math.round(width));
  const row = samplePathRow(source, spec.points, columns);
  const soft = clamp(spec.edgeSoftness, 0, 0.49);

  const output = createCanvas(outW, outH);
  const octx = output.getContext('2d')!;
  const image = octx.createImageData(outW, outH);
  const data = image.data;

  const lookup = arcLookup(arc, width);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const hit = lookup(minX + x + 0.5, minY + y + 0.5);
      if (!hit) continue;

      const position = hit.u * (columns - 1);
      const left = Math.min(columns - 2, Math.floor(position));
      const mix = position - left;
      const alpha = hit.coverage * fadeAlong(hit.t, spec.fade, soft) * fadeAcross(hit.u, soft);
      const i = (y * outW + x) * 4;
      const a = left * 4;
      const b = a + 4;
      data[i] = row[a] + (row[b] - row[a]) * mix;
      data[i + 1] = row[a + 1] + (row[b + 1] - row[a + 1]) * mix;
      data[i + 2] = row[a + 2] + (row[b + 2] - row[a + 2]) * mix;
      data[i + 3] = (row[a + 3] + (row[b + 3] - row[a + 3]) * mix) * alpha;
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

/** Boundary samples used to bound a warped or bent band. */
const OUTLINE_STEPS = 64;

/**
 * Grid resolution for the curved-surface renderer, in cells per axis. A fold
 * curves as sharply along the band as across it, so both axes need the same.
 */
const PATCH_CELLS = 72;

/**
 * Trace the band's projected outline. A bend pushes columns past the quad's
 * own corners, so the bounding box has to come from the real edges rather
 * than from four points.
 */
function projectedOutline(spec: StretchSpec, at: SurfaceMap): Point[] {
  const outline: Point[] = [];
  for (let i = 0; i <= OUTLINE_STEPS; i++) {
    // Each column stays a straight segment, so its two ends bound it.
    for (const v of [0, 1]) {
      const point = bendPoint(i / OUTLINE_STEPS, v, spec.bend);
      outline.push(at(point.x, point.y));
    }
  }
  return outline;
}

/** A curved band diced into cells: `points[row][column]` in document space. */
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
 * Draw the band across a curved sheet.
 *
 * A Bézier sheet bends columns as well as displacing them, so unlike the
 * projective case a column is no longer a straight segment and one affine per
 * column won't do. The band is diced into a grid instead, each cell mapped by
 * the affine through three of its corners — which converges quickly because
 * the surface is smooth. Cells are drawn a touch oversized so their neighbours
 * cover the seams.
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
 * Draw the band through a projective map, one column at a time.
 *
 * A homography takes straight lines to straight lines, so each column of the
 * upright band lands as a straight segment — which is why the streaks stay
 * straight however the quad is pulled about. Each column gets its own affine
 * approximation, exact for that column's own geometry, and is drawn one pixel
 * wider than its slot so the next column covers the seam.
 */
function drawProjected(
  ctx: CanvasRenderingContext2D,
  local: HTMLCanvasElement,
  spec: StretchSpec,
  at: SurfaceMap,
  offsetX: number,
  offsetY: number,
): void {
  const { width, height } = local;

  for (let i = 0; i < width; i++) {
    const nearTop = bendPoint(i / width, 0, spec.bend);
    const farTop = bendPoint((i + 1) / width, 0, spec.bend);
    const nearBottom = bendPoint(i / width, 1, spec.bend);

    const topLeft = at(nearTop.x, nearTop.y);
    const topRight = at(farTop.x, farTop.y);
    const bottomLeft = at(nearBottom.x, nearBottom.y);

    let ax = topRight.x - topLeft.x;
    let ay = topRight.y - topLeft.y;
    const span = Math.hypot(ax, ay);
    if (!Number.isFinite(span) || span === 0) continue;
    // Overdraw by a pixel; the next column paints over the excess.
    const widen = (span + 1) / span;
    ax *= widen;
    ay *= widen;

    const cx = (bottomLeft.x - topLeft.x) / height;
    const cy = (bottomLeft.y - topLeft.y) / height;
    if (![ax, ay, cx, cy].every(Number.isFinite)) continue;

    ctx.setTransform(
      ax, ay, cx, cy,
      topLeft.x - ax * i + offsetX,
      topLeft.y - ay * i + offsetY,
    );
    ctx.drawImage(local, i, 0, 1, height, i, 0, 1, height);
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
export function renderStretchBand(spec: StretchSpec, source: Layer): BandRender | null {
  if (spec.arc) return spec.points.length < 2 ? null : renderArcBand(spec, spec.arc, source);

  const width = Math.round(Math.abs(spec.width));
  const height = Math.round(Math.abs(spec.length));
  if (spec.points.length < 2 || width < MIN_SIZE || height < MIN_SIZE) return null;

  const { along, out } = rectBasis(spec);
  const flipped = spec.length < 0;
  // Local +y always points the way the band actually extrudes.
  const outSigned = { x: out.x * (flipped ? -1 : 1), y: out.y * (flipped ? -1 : 1) };

  const local = createCanvas(width, height);
  const lctx = local.getContext('2d')!;
  // Every output row is the same row of colours; no resampling wanted.
  lctx.imageSmoothingEnabled = false;
  lctx.drawImage(samplePathStrip(source, spec.points, width), 0, 0, width, 1, 0, 0, width, height);
  shapeAlpha(local, spec);

  // Local (0,0) is the anchor on the path for either sign of `length` — the
  // side is carried entirely by `outSigned`, so the origin never moves.
  const origin: Point = spec.anchor;
  const curved = hasCurvedEdges(spec);
  const projected = curved || isWarped(spec) || spec.bend !== 0;

  // The corner order already matches local (0,0)→(w,0)→(w,h)→(0,h): local
  // (0,height) lands on corner 3 for either sign of `length`, because
  // `outSigned` and `|length|` flip together.
  const quad = warpedCorners(spec);
  const at = bandSurface(spec);
  // A folded sheet can reach past its own outline, so bound it by every vertex.
  const mesh = curved ? patchMesh(spec, at, width, height) : null;

  const bounds = mesh ? mesh.points.flat() : projected ? projectedOutline(spec, at) : quad;
  const minX = Math.floor(Math.min(...bounds.map((c) => c.x)) + PIXEL_EPSILON);
  const minY = Math.floor(Math.min(...bounds.map((c) => c.y)) + PIXEL_EPSILON);
  const maxX = Math.ceil(Math.max(...bounds.map((c) => c.x)) - PIXEL_EPSILON);
  const maxY = Math.ceil(Math.max(...bounds.map((c) => c.y)) - PIXEL_EPSILON);
  if (maxX - minX < MIN_SIZE || maxY - minY < MIN_SIZE) return null;

  const output = createCanvas(maxX - minX, maxY - minY);
  const octx = output.getContext('2d')!;
  octx.imageSmoothingQuality = 'high';

  if (mesh) {
    drawPatch(octx, local, mesh, -minX, -minY);
  } else if (projected) {
    drawProjected(octx, local, spec, at, -minX, -minY);
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
