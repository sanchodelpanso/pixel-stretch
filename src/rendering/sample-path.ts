import type { Point } from '../types/stretch';

/** Polyline resolution per spline segment. Plenty for arc-length accuracy. */
const STEPS_PER_SEGMENT = 24;

/** Centripetal Catmull-Rom exponent; 0.5 is what avoids cusps and loops. */
const ALPHA = 0.5;

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function mix(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * One centripetal Catmull-Rom segment, from p1 to p2, using p0/p3 as tangent
 * neighbours. Barry-Goldman form — knots spaced by the square root of chord
 * length, which is what keeps unevenly-placed points from overshooting into
 * loops the way uniform Catmull-Rom does.
 */
function segmentPoints(p0: Point, p1: Point, p2: Point, p3: Point, steps: number): Point[] {
  const t0 = 0;
  const t1 = t0 + Math.pow(distance(p0, p1), ALPHA);
  const t2 = t1 + Math.pow(distance(p1, p2), ALPHA);
  const t3 = t2 + Math.pow(distance(p2, p3), ALPHA);

  // Coincident points collapse a knot span; fall back to the straight chord.
  if (t1 === t0 || t2 === t1 || t3 === t2) {
    return Array.from({ length: steps }, (_, i) => mix(p1, p2, i / steps));
  }

  const out: Point[] = [];
  for (let i = 0; i < steps; i++) {
    const t = t1 + ((t2 - t1) * i) / steps;
    const a1 = mix(p0, p1, (t - t0) / (t1 - t0));
    const a2 = mix(p1, p2, (t - t1) / (t2 - t1));
    const a3 = mix(p2, p3, (t - t2) / (t3 - t2));
    const b1 = mix(a1, a2, (t - t0) / (t2 - t0));
    const b2 = mix(a2, a3, (t - t1) / (t3 - t1));
    out.push(mix(b1, b2, (t - t1) / (t2 - t1)));
  }
  return out;
}

/**
 * Flatten the control points into a dense polyline following a smooth spline
 * through every one of them. Two points give a straight line.
 */
export function pathToPolyline(points: Point[], stepsPerSegment = STEPS_PER_SEGMENT): Point[] {
  if (points.length < 2) return [...points];
  if (points.length === 2) return [points[0], points[1]];

  // Reflect the ends so the first and last segments get a tangent neighbour.
  const first = points[0];
  const last = points[points.length - 1];
  const padded = [
    { x: 2 * first.x - points[1].x, y: 2 * first.y - points[1].y },
    ...points,
    { x: 2 * last.x - points[points.length - 2].x, y: 2 * last.y - points[points.length - 2].y },
  ];

  const out: Point[] = [];
  for (let i = 1; i < padded.length - 2; i++) {
    out.push(...segmentPoints(padded[i - 1], padded[i], padded[i + 1], padded[i + 2], stepsPerSegment));
  }
  out.push(last);
  return out;
}

/** Total length of a polyline in document pixels. */
export function polylineLength(polyline: Point[]): number {
  let total = 0;
  for (let i = 1; i < polyline.length; i++) total += distance(polyline[i - 1], polyline[i]);
  return total;
}

/**
 * Resample a polyline into `count` points spaced evenly by arc length, so the
 * pixels read off a curve are as evenly spread as those read off a line.
 */
export function resamplePolyline(polyline: Point[], count: number): Point[] {
  if (count <= 0) return [];
  if (polyline.length === 0) return [];
  if (polyline.length === 1 || count === 1) return Array.from({ length: count }, () => polyline[0]);

  // Cumulative arc length at each vertex.
  const cumulative = [0];
  for (let i = 1; i < polyline.length; i++) {
    cumulative.push(cumulative[i - 1] + distance(polyline[i - 1], polyline[i]));
  }
  const total = cumulative[cumulative.length - 1];
  if (total === 0) return Array.from({ length: count }, () => polyline[0]);

  const out: Point[] = [];
  let vertex = 1;
  for (let i = 0; i < count; i++) {
    const target = (total * i) / (count - 1);
    while (vertex < cumulative.length - 1 && cumulative[vertex] < target) vertex++;
    const span = cumulative[vertex] - cumulative[vertex - 1];
    const t = span === 0 ? 0 : (target - cumulative[vertex - 1]) / span;
    out.push(mix(polyline[vertex - 1], polyline[vertex], t));
  }
  return out;
}

/** Sample the control path at `count` evenly-spaced points along its arc. */
export function samplePath(points: Point[], count: number): Point[] {
  return resamplePolyline(pathToPolyline(points), count);
}

/**
 * The point on the path nearest to `target`, as a segment index and the
 * fraction along it — used to decide where a new control point lands.
 */
export function nearestOnPolyline(
  polyline: Point[],
  target: Point,
): { index: number; t: number; distance: number } {
  let best = { index: 0, t: 0, distance: Infinity };
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1];
    const b = polyline[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((target.x - a.x) * dx + (target.y - a.y) * dy) / len2));
    const d = distance(target, { x: a.x + dx * t, y: a.y + dy * t });
    if (d < best.distance) best = { index: i - 1, t, distance: d };
  }
  return best;
}
