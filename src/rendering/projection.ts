import type { Point } from '../types/stretch.ts';

/**
 * Maps the unit square onto an arbitrary convex quadrilateral.
 * `g`/`h` are the perspective terms — zero for a parallelogram, non-zero once
 * a corner is dragged out of line, which is what makes the streaks converge.
 */
export interface Homography {
  a: number; b: number; c: number;
  d: number; e: number; f: number;
  g: number; h: number;
}

/**
 * Build the projective map taking (0,0), (1,0), (1,1), (0,1) to the four
 * given corners, in that order (Heckbert's unit-square-to-quad).
 */
export function quadHomography(corners: [Point, Point, Point, Point]): Homography {
  const [p0, p1, p2, p3] = corners;

  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;

  // No "twist" between the opposite edges: the quad is a parallelogram and the
  // map is a plain affine one.
  if (dx3 === 0 && dy3 === 0) {
    return {
      a: p1.x - p0.x, b: p2.x - p1.x, c: p0.x,
      d: p1.y - p0.y, e: p2.y - p1.y, f: p0.y,
      g: 0, h: 0,
    };
  }

  const den = dx1 * dy2 - dx2 * dy1;
  if (den === 0) {
    // Degenerate quad (collinear corners); fall back to the affine reading.
    return {
      a: p1.x - p0.x, b: p3.x - p0.x, c: p0.x,
      d: p1.y - p0.y, e: p3.y - p0.y, f: p0.y,
      g: 0, h: 0,
    };
  }

  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const h = (dx1 * dy3 - dx3 * dy1) / den;
  return {
    a: p1.x - p0.x + g * p1.x,
    b: p3.x - p0.x + h * p3.x,
    c: p0.x,
    d: p1.y - p0.y + g * p1.y,
    e: p3.y - p0.y + h * p3.y,
    f: p0.y,
    g,
    h,
  };
}

/** Project a unit-square coordinate through the homography. */
export function project(m: Homography, u: number, v: number): Point {
  const w = m.g * u + m.h * v + 1;
  // A point on the horizon divides by zero; nudge it rather than emit NaN.
  const safe = Math.abs(w) < 1e-9 ? 1e-9 : w;
  return {
    x: (m.a * u + m.b * v + m.c) / safe,
    y: (m.d * u + m.e * v + m.f) / safe,
  };
}

/** How far in front of the surface the notional viewer sits, in band widths. */
const CAMERA_DISTANCE = 2.6;
/** At wrap 1, a width-sized chord on a width-radius cylinder spans 60°. */
const HALF_ANGLE_AT_WIDTH_RADIUS = Math.PI / 6;

/**
 * Wrap the band around a cylinder whose radius is derived from its width.
 *
 * A wrap of ±1 means the cylinder radius equals the rectangle width. Smaller
 * magnitudes approach a flat plane; values up to ±2 allow a tighter wrap. The
 * quad's side corners remain fixed while interior columns follow the circular
 * surface and receive perspective foreshortening.
 */
export function bendColumn(u: number, bend: number): { u: number; scale: number } {
  if (!bend) return { u, scale: 1 };

  const wrap = Math.min(Math.abs(bend), 2);
  const half = wrap * HALF_ANGLE_AT_WIDTH_RADIUS;
  const sinHalf = Math.sin(half);
  if (sinHalf < 1e-6) return { u, scale: 1 };

  const theta = (u - 0.5) * 2 * half;
  // Normalising by the endpoint sine keeps both dragged side edges fixed.
  const flat = Math.sin(theta) / (2 * sinHalf);
  // R / width = 1 / (2 sin(half)); at wrap 1 that evaluates to exactly 1.
  const depth = (Math.cos(theta) - Math.cos(half)) / (2 * sinHalf);
  const towards = bend < 0 ? -depth : depth;

  const scale = CAMERA_DISTANCE / (CAMERA_DISTANCE - towards);
  return { u: 0.5 + flat * scale, scale };
}

/** Project one point on the cylindrical sheet, scaling around its centreline. */
export function bendPoint(u: number, v: number, bend: number): Point {
  const column = bendColumn(u, bend);
  return {
    x: column.u,
    y: 0.5 + (v - 0.5) * column.scale,
  };
}
