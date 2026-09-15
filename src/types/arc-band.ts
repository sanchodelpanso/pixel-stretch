import type { Point, StretchSpec } from './stretch.ts';
import { bandBasis, chordLength } from './stretch.ts';

/**
 * A band swept around a pivot instead of pulled out straight.
 *
 * The sample line stays a radial spoke: every pixel along it travels round the
 * same centre, so each one draws a concentric arc and the band as a whole is a
 * slice of a ring. The band's radial thickness is the spec's own `width`.
 *
 * Geometry is stored from the start edge rather than the centre, so changing
 * the radius curls the band tighter or looser while it stays attached to where
 * it was pulled from.
 */
export interface ArcBand {
  /** Middle of the band's starting edge, in document pixels. */
  origin: Point;
  /** Direction from the centre to `origin`, in radians. */
  angle: number;
  /** Distance from the centre to the middle of the band. */
  radius: number;
  /** Signed turn from the start edge, in radians. ±2π closes a ring. */
  sweep: number;
  /** Whether the sample path's first point sits on the inner edge. */
  outward: boolean;
  /** Spline knots reshaping the inner edge. Absent means a plain circle. */
  inner?: EdgeKnot[];
  /** Spline knots reshaping the outer edge. */
  outer?: EdgeKnot[];
}

export type ArcEdge = 'inner' | 'outer';

/**
 * A point the edge passes through: `t` of the way round the sweep, pushed
 * `offset` pixels away from the centre (negative pulls it in).
 */
export interface EdgeKnot {
  t: number;
  offset: number;
}

/** Keeps open-arc knots off the pinned ends. */
const KNOT_END_GAP = 1e-3;
/** Resolution of the per-render edge lookup tables. */
const PROFILE_SAMPLES = 1024;

export const FULL_TURN = Math.PI * 2;
/** A sweep this close to a full turn snaps shut. */
export const CLOSE_SNAP = (12 * Math.PI) / 180;
/** Past this the circle is fixed and the pointer only drives the sweep. */
const FREEZE_SWEEP = Math.PI * 0.75;
/** Stands in for "no curve" when the drag is dead straight. */
export const MAX_RADIUS = 50_000;

export function isClosedArc(arc: ArcBand): boolean {
  return Math.abs(arc.sweep) >= FULL_TURN - 1e-9;
}

export function arcCentre(arc: ArcBand): Point {
  return {
    x: arc.origin.x - Math.cos(arc.angle) * arc.radius,
    y: arc.origin.y - Math.sin(arc.angle) * arc.radius,
  };
}

/**
 * A point on the band: `offset` pixels out from its middle radius, a fraction
 * `t` of the way round the sweep.
 */
export function arcPoint(arc: ArcBand, offset: number, t: number): Point {
  const centre = arcCentre(arc);
  const theta = arc.angle + arc.sweep * t;
  const r = arc.radius + offset;
  return { x: centre.x + Math.cos(theta) * r, y: centre.y + Math.sin(theta) * r };
}

/** Keep the inner edge from crossing the centre. */
export function clampRadius(radius: number, width: number): number {
  return Math.min(MAX_RADIUS, Math.max(Math.abs(width) / 2, radius));
}

/** Snap a nearly-closed sweep shut and never go past a full turn. */
export function snapSweep(sweep: number): number {
  const magnitude = Math.abs(sweep);
  if (magnitude >= FULL_TURN - CLOSE_SNAP) return Math.sign(sweep) * FULL_TURN;
  return sweep;
}

/** Signed angle turning `from` onto `to`, in (-π, π]. */
function turn(from: Point, to: Point): number {
  return Math.atan2(from.x * to.y - from.y * to.x, from.x * to.x + from.y * to.y);
}

/** Pick the representative of `angle` (mod 2π) closest to `near`. */
function unwrap(angle: number, near: number): number {
  return angle + FULL_TURN * Math.round((near - angle) / FULL_TURN);
}

/**
 * Where the pointer moves the sweep of an existing circle to — following it
 * round continuously, so passing the half-turn doesn't flip direction.
 */
export function sweepToward(arc: ArcBand, pointer: Point): number {
  const centre = arcCentre(arc);
  const raw = turn(
    { x: arc.origin.x - centre.x, y: arc.origin.y - centre.y },
    { x: pointer.x - centre.x, y: pointer.y - centre.y },
  );
  const sweep = unwrap(raw, arc.sweep);
  return snapSweep(Math.max(-FULL_TURN, Math.min(FULL_TURN, sweep)));
}

/**
 * Solve the sweep for a pull gesture.
 *
 * The band leaves the middle of the sample line at right angles to it, so its
 * centreline is a circle tangent to that direction there, with its centre on
 * the line's own extension. Early in the drag the circle is refitted to pass
 * through the pointer — a straight pull reads as a huge radius, a curling one
 * as a tight one. Once the band is most of the way round, the pointer can no
 * longer pin the radius down (near a full turn it is back beside the start),
 * so the circle is frozen and the pointer only drives how far round it goes.
 *
 * `previous` is the last result of the same gesture. Returns null until the
 * pointer has left the start.
 */
export function arcFromPull(
  start: Point,
  end: Point,
  width: number,
  pointer: Point,
  previous: ArcBand | null,
): ArcBand | null {
  const chord = Math.hypot(end.x - start.x, end.y - start.y);
  if (chord < 1e-6) return null;
  const along = { x: (end.x - start.x) / chord, y: (end.y - start.y) / chord };
  const out = { x: along.y, y: -along.x };
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };

  if (previous && Math.abs(previous.sweep) > FREEZE_SWEEP) {
    const sweep = sweepToward(previous, pointer);
    if (Math.abs(sweep) >= FREEZE_SWEEP) return { ...previous, sweep };
  }

  const dx = pointer.x - mid.x;
  const dy = pointer.y - mid.y;
  const du = dx * along.x + dy * along.y;
  const dv = dx * out.x + dy * out.y;
  if (Math.hypot(du, dv) < 1e-6) return null;

  // Which side the band leaves on stays whatever the gesture started with,
  // even once the pointer wraps round behind the line.
  let side = dv < 0 ? -1 : 1;
  if (previous && previous.sweep !== 0) {
    const previousCentre = arcCentre(previous);
    const centreSide = Math.sign((previousCentre.x - mid.x) * along.x + (previousCentre.y - mid.y) * along.y) || 1;
    side = Math.sign(previous.sweep) * centreSide;
  }

  // Centre at mid + along·s on a circle through the pointer:
  // |d − along·s|² = s²  ⇒  s = |d|² / 2du.
  // A dead-straight pull has no finite circle; it clamps like any huge one.
  const fitted = Math.abs(du) < 1e-9 ? Infinity : (du * du + dv * dv) / (2 * du);
  const s = Math.sign(fitted) * clampRadius(Math.abs(fitted), width);
  const centre = { x: mid.x + along.x * s, y: mid.y + along.y * s };
  const direction = side * Math.sign(s);

  let magnitude: number;
  if (Math.abs(s) === Math.abs(fitted)) {
    // On the fitted circle the inscribed-angle theorem gives the sweep
    // directly, without the atan2 branch cut at the start.
    magnitude = 2 * Math.atan2(Math.abs(du), side * dv);
  } else {
    // Clamped, so the pointer is off the circle: go by its bearing instead.
    const raw = turn(
      { x: mid.x - centre.x, y: mid.y - centre.y },
      { x: pointer.x - centre.x, y: pointer.y - centre.y },
    );
    magnitude = ((raw * direction) % FULL_TURN + FULL_TURN) % FULL_TURN;
  }

  return {
    origin: mid,
    angle: Math.atan2(mid.y - centre.y, mid.x - centre.x),
    radius: Math.abs(s),
    sweep: snapSweep(direction * magnitude),
    // The path runs from `start` towards `end`; it runs outward when the
    // centre lies behind `start`.
    outward: s < 0,
  };
}

/**
 * How far an edge is pushed out at `t`, from its knots.
 *
 * The edge is a smooth cubic Hermite spline through every knot, with
 * Catmull-Rom tangents spaced by each knot's own `t`, so unevenly spread
 * points still give an even curve. An open arc's edge is pinned to zero at both
 * ends, so the band stays attached to its sample line; a ring's edge wraps
 * round, so it closes without a seam.
 */
export function edgeOffset(knots: EdgeKnot[] | undefined, t: number, closed: boolean): number {
  if (!knots?.length) return 0;
  const sorted = [...knots].sort((a, b) => a.t - b.t);

  let points: EdgeKnot[];
  if (closed) {
    // Two wrapped copies either side, so every real segment has tangents.
    const n = sorted.length;
    const at = (i: number): EdgeKnot => {
      const k = sorted[((i % n) + n) % n];
      return { t: k.t + Math.floor(i / n), offset: k.offset };
    };
    points = Array.from({ length: n + 4 }, (_, i) => at(i - 2));
    t = ((t % 1) + 1) % 1;
    // Keep `t` within the span the padded list covers.
    if (t < points[2].t) t += 1;
  } else {
    points = [{ t: 0, offset: 0 }, ...sorted, { t: 1, offset: 0 }];
    t = Math.max(0, Math.min(1, t));
  }

  let i = 0;
  while (i < points.length - 2 && points[i + 1].t < t) i++;
  const p0 = points[i];
  const p1 = points[i + 1];
  const span = p1.t - p0.t;
  if (span <= 1e-9) return p1.offset;

  const tangent = (index: number): number => {
    const before = points[Math.max(0, index - 1)];
    const after = points[Math.min(points.length - 1, index + 1)];
    return after.t - before.t > 1e-9 ? (after.offset - before.offset) / (after.t - before.t) : 0;
  };
  const s = (t - p0.t) / span;
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * p0.offset
    + (s3 - 2 * s2 + s) * span * tangent(i)
    + (-2 * s3 + 3 * s2) * p1.offset
    + (s3 - s2) * span * tangent(i + 1);
}

/** Distance from the centre to an edge at `t`, before clamping at the centre. */
export function edgeRadius(arc: ArcBand, width: number, edge: ArcEdge, t: number): number {
  const half = Math.abs(width) / 2;
  const base = edge === 'inner' ? arc.radius - half : arc.radius + half;
  return base + edgeOffset(arc[edge], t, isClosedArc(arc));
}

/** A point on one edge, `t` of the way round. */
export function arcEdgePoint(arc: ArcBand, width: number, edge: ArcEdge, t: number): Point {
  return arcPoint(arc, Math.max(0, edgeRadius(arc, width, edge, t)) - arc.radius, t);
}

/** Where a pointer lands in an edge's own terms: `t` round the sweep and offset. */
export function edgeKnotAt(arc: ArcBand, width: number, edge: ArcEdge, pointer: Point): EdgeKnot {
  const centre = arcCentre(arc);
  const dx = pointer.x - centre.x;
  const dy = pointer.y - centre.y;
  const span = Math.abs(arc.sweep);
  let travelled = ((Math.atan2(dy, dx) - arc.angle) * (arc.sweep < 0 ? -1 : 1)) % FULL_TURN;
  if (travelled < 0) travelled += FULL_TURN;
  let t: number;
  if (isClosedArc(arc)) {
    t = travelled / FULL_TURN;
  } else {
    // Beyond the slice, snap to whichever end is nearer round the circle.
    if (travelled > span) travelled = travelled - span < FULL_TURN - travelled ? span : 0;
    t = Math.max(KNOT_END_GAP, Math.min(1 - KNOT_END_GAP, span > 0 ? travelled / span : 0));
  }
  const half = Math.abs(width) / 2;
  const base = edge === 'inner' ? arc.radius - half : arc.radius + half;
  return { t, offset: Math.hypot(dx, dy) - base };
}

/**
 * Where new knots can be pulled out of an edge: evenly between the existing
 * knots, at least four per turn so a plain edge has somewhere to start.
 */
export function edgeInsertionPoints(arc: ArcBand, edge: ArcEdge): number[] {
  const closed = isClosedArc(arc);
  const ts = (arc[edge] ?? []).map((k) => k.t).sort((a, b) => a - b);
  const anchors = closed
    ? (ts.length ? [...ts, ts[0] + 1] : [0, 1])
    : [0, ...ts, 1];
  const out: number[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const gap = anchors[i + 1] - anchors[i];
    const segments = Math.max(1, Math.round(gap * 4));
    for (let j = 0; j < segments; j++) {
      out.push((anchors[i] + (gap * (j + 0.5)) / segments) % 1);
    }
  }
  return out;
}

/** Sample both edges into lookup tables, indexed by `t` in [0, 1]. */
export function edgeTables(arc: ArcBand, width: number): { inner: Float64Array; outer: Float64Array } {
  const inner = new Float64Array(PROFILE_SAMPLES + 1);
  const outer = new Float64Array(PROFILE_SAMPLES + 1);
  for (let i = 0; i <= PROFILE_SAMPLES; i++) {
    const t = i / PROFILE_SAMPLES;
    inner[i] = Math.max(0, edgeRadius(arc, width, 'inner', t));
    outer[i] = edgeRadius(arc, width, 'outer', t);
  }
  return { inner, outer };
}

function sampleTable(table: Float64Array, t: number): number {
  const position = Math.max(0, Math.min(1, t)) * PROFILE_SAMPLES;
  const i = Math.min(PROFILE_SAMPLES - 1, Math.floor(position));
  return table[i] + (table[i + 1] - table[i]) * (position - i);
}

/**
 * The band's outline: along the inner edge, back along the outer edge. A
 * closed ring returns its two edges as separate loops instead.
 */
export function arcOutline(arc: ArcBand, width: number, steps = 96): Point[][] {
  const inner = Array.from({ length: steps + 1 }, (_, i) => arcEdgePoint(arc, width, 'inner', i / steps));
  const outer = Array.from({ length: steps + 1 }, (_, i) => arcEdgePoint(arc, width, 'outer', i / steps));
  if (isClosedArc(arc)) return [inner, outer];
  return [[...inner, ...outer.reverse()]];
}

/** Axis-aligned bounds of the band, in document pixels. */
export function arcBounds(arc: ArcBand, width: number): { minX: number; minY: number; maxX: number; maxY: number } {
  const points = arcOutline(arc, width, 256).flat();
  return {
    minX: Math.min(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxX: Math.max(...points.map((p) => p.x)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
}

/**
 * Which point of the strip a document pixel reads, or null outside the band.
 * `u` runs along the sample path (0 at its first point), `t` round the sweep,
 * and `coverage` antialiases the band's own edges. Built once per render, since
 * it runs for every pixel.
 */
export function arcLookup(
  arc: ArcBand,
  width: number,
): (x: number, y: number) => { u: number; t: number; coverage: number } | null {
  const centre = arcCentre(arc);
  const span = Math.abs(arc.sweep);
  const direction = arc.sweep < 0 ? -1 : 1;
  const closed = isClosedArc(arc);
  const tables = edgeTables(arc, width);
  // Rings that can't contain any of the band are rejected before any trig.
  let reachIn = Infinity;
  let reachOut = 0;
  for (let i = 0; i <= PROFILE_SAMPLES; i++) {
    reachIn = Math.min(reachIn, tables.inner[i]);
    reachOut = Math.max(reachOut, tables.outer[i]);
  }

  return (x, y) => {
    const dx = x - centre.x;
    const dy = y - centre.y;
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r < reachIn - 1 || r > reachOut + 1) return null;

    // Angle travelled from the start edge in the sweep's own direction, [0, 2π).
    let travelled = ((Math.atan2(dy, dx) - arc.angle) * direction) % FULL_TURN;
    if (travelled < 0) travelled += FULL_TURN;

    let coverage = 1;
    if (!closed) {
      if (travelled > span) {
        // Outside the slice: only a sliver of antialiasing past either end.
        const pastEnd = (travelled - span) * r;
        const beforeStart = (FULL_TURN - travelled) * r;
        const edge = 0.5 - Math.min(pastEnd, beforeStart);
        if (edge <= 0) return null;
        coverage = edge;
        travelled = pastEnd < beforeStart ? span : 0;
      } else {
        coverage = Math.min(1, travelled * r + 0.5, (span - travelled) * r + 0.5);
      }
    }

    const t = span > 0 ? travelled / (closed ? FULL_TURN : span) : 0;
    const inner = sampleTable(tables.inner, t);
    const outer = sampleTable(tables.outer, t);
    const thickness = outer - inner;
    if (thickness < 1e-3) return null;
    const radial = Math.min(1, r - inner + 0.5, outer - r + 0.5);
    if (radial <= 0) return null;

    // Streaks follow the reshaped edges: each keeps its share of the thickness.
    const across = Math.max(0, Math.min(1, (r - inner) / thickness));
    return {
      u: arc.outward ? across : 1 - across,
      t,
      coverage: coverage * radial,
    };
  };
}

/**
 * Curl an existing straight band. It keeps its thickness and pulled length,
 * leaving from the middle of its path on the same side.
 */
export function straightToArc(spec: StretchSpec): ArcBand {
  const start = spec.points[0];
  const end = spec.points[spec.points.length - 1];
  const { along } = bandBasis(spec.points);
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const radius = clampRadius(Math.max(Math.abs(spec.width), chordLength(spec.points)), spec.width);
  const side = spec.length < 0 ? -1 : 1;
  // Centre behind the path's first point, so the path runs outward and a
  // positive side turns the band the negative way round (see arcFromPull).
  return {
    origin: mid,
    angle: Math.atan2(along.y, along.x),
    radius,
    sweep: -side * snapSweep(Math.min(FULL_TURN, Math.abs(spec.length) / radius)),
    outward: true,
  };
}

/** Uncurl an arc band into the straight rectangle of the same length. */
export function arcToStraight(spec: StretchSpec, arc: ArcBand): Pick<StretchSpec, 'anchor' | 'length' | 'rotation' | 'arc'> {
  const { along, out } = bandBasis(spec.points);
  // Positive sweep travels a quarter turn ahead of the centre→origin spoke.
  const tangent = { x: -Math.sin(arc.angle) * Math.sign(arc.sweep), y: Math.cos(arc.angle) * Math.sign(arc.sweep) };
  const side = tangent.x * out.x + tangent.y * out.y < 0 ? -1 : 1;
  const start = spec.points[0];
  const end = spec.points[spec.points.length - 1];
  const width = Math.abs(spec.width);
  return {
    anchor: {
      x: (start.x + end.x) / 2 - (along.x * width) / 2,
      y: (start.y + end.y) / 2 - (along.y * width) / 2,
    },
    length: Math.round(side * arc.radius * Math.abs(arc.sweep)),
    rotation: 0,
    arc: undefined,
  };
}
