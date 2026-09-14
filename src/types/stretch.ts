import type { ArcBand } from './arc-band.ts';

export interface Point {
  x: number;
  y: number;
}

/** A corner nudge, in the rectangle's own frame: `u` along, `v` outward. */
export interface WarpOffset {
  u: number;
  v: number;
}

export type Warp = [WarpOffset, WarpOffset, WarpOffset, WarpOffset];

export const NO_WARP: Warp = [
  { u: 0, v: 0 }, { u: 0, v: 0 }, { u: 0, v: 0 }, { u: 0, v: 0 },
];

/**
 * How the band's edges are drawn.
 * `straight` keeps every edge a straight line and renders through a true
 * perspective homography; `curved` makes each edge a cubic Bézier and renders
 * the free-form sheet they bound. Corner dragging respects the selected mode:
 * straight mode skews in 2D, while curved mode keeps the page-fold gesture.
 */
export type WarpMode = 'straight' | 'curved';

/** The two Bézier controls of one edge, as offsets from its straight thirds. */
export type EdgeControls = [WarpOffset, WarpOffset];

/** Controls for all four edges, in c0→c1, c1→c2, c2→c3, c3→c0 order. */
export type EdgeWarp = [EdgeControls, EdgeControls, EdgeControls, EdgeControls];

export const NO_EDGE_WARP: EdgeWarp = [
  [{ u: 0, v: 0 }, { u: 0, v: 0 }],
  [{ u: 0, v: 0 }, { u: 0, v: 0 }],
  [{ u: 0, v: 0 }, { u: 0, v: 0 }],
  [{ u: 0, v: 0 }, { u: 0, v: 0 }],
];

/**
 * A stretch band.
 *
 * Sampling and output geometry are deliberately independent. `points` is a
 * path the user shapes freely — a straight line by default, a smooth spline
 * once they bend it — but it only chooses *which* pixels are read. Those
 * pixels are always laid out across a straight rectangle, so the streaks stay
 * parallel however curved the path is.
 *
 * The rectangle lives in the frame defined by the path's chord (first point →
 * last point): `width` runs along it, `length` extrudes at right angles to it,
 * and `anchor` is the corner where both axes start. A negative `length` puts
 * the band on the other side of the path.
 */
export interface StretchSpec {
  /** Sample path control points, in document pixels. Two or more. */
  points: Point[];
  /** Layer the band samples its pixels from. */
  sourceLayerId: string;
  /** Rectangle corner where both local axes begin, in document pixels. */
  anchor: Point;
  /** Rectangle extent along the chord direction, in pixels. */
  width: number;
  /** Signed rectangle extent along the chord's perpendicular, in pixels. */
  length: number;
  /**
   * Rectangle rotation in radians, *relative to the path's chord*. Zero keeps
   * the band square to the path; reshaping the path then carries the rectangle
   * with it, which is almost always what's wanted.
   */
  rotation: number;
  /** 0 = solid to the far end, 1 = fully faded out at the far end. */
  fade: number;
  /** Edge softening, as a fraction of the band's size. */
  edgeSoftness: number;
  /**
   * Per-corner distortion, stored in the rectangle's own frame so that moving,
   * rotating or resizing the rectangle carries the distortion with it. Absent
   * (or all zeros) means an undistorted rectangle.
   */
  warp?: Warp;
  /**
   * Cylindrical wrap about the band's length axis. At ±1 the cylinder radius
   * equals the rectangle width; positive bows toward the viewer, negative away.
   */
  bend: number;
  /** Whether edges pull straight or curve. Absent means `straight`. */
  warpMode?: WarpMode;
  /**
   * Per-edge Bézier controls, stored like `warp` in the rectangle's own frame
   * as offsets from the straight-edge thirds. Only meaningful in curved mode.
   */
  edges?: EdgeWarp;
  /**
   * Sweep the band round a pivot instead of pulling it out straight. While set,
   * `width` is the band's radial thickness and the rectangle fields (`anchor`,
   * `length`, `rotation`, warps and bend) are ignored.
   */
  arc?: ArcBand;
}

export const DEFAULT_STRETCH = {
  fade: 0,
  edgeSoftness: 0,
  rotation: 0,
  bend: 0,
} satisfies Pick<StretchSpec, 'fade' | 'edgeSoftness' | 'rotation' | 'bend'>;

/** Straight-line distance from the path's first point to its last. */
export function chordLength(points: Point[]): number {
  if (points.length < 2) return 0;
  const a = points[0];
  const b = points[points.length - 1];
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Angle of the path's chord in radians, for display. */
export function chordAngle(points: Point[]): number {
  if (points.length < 2) return 0;
  const a = points[0];
  const b = points[points.length - 1];
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/**
 * Orthonormal basis for the band rectangle.
 * `along` follows the path's chord; `out` is the extrusion direction for a
 * positive length — chosen so a top-to-bottom path extrudes rightward.
 */
export function bandBasis(points: Point[]): { along: Point; out: Point } {
  const extent = chordLength(points);
  if (extent < 1e-6) return { along: { x: 1, y: 0 }, out: { x: 0, y: 1 } };
  const a = points[0];
  const b = points[points.length - 1];
  const along = { x: (b.x - a.x) / extent, y: (b.y - a.y) / extent };
  return { along, out: { x: along.y, y: -along.x } };
}

/**
 * Basis for the band rectangle itself — the chord's, turned by the spec's own
 * rotation. Sampling never uses this: walking the path is orientation-free, so
 * rotating the rectangle moves where the pixels land, not which ones are read.
 */
export function rectBasis(spec: StretchSpec): { along: Point; out: Point } {
  if (!spec.rotation) return bandBasis(spec.points);
  const angle = chordAngle(spec.points) + spec.rotation;
  const along = { x: Math.cos(angle), y: Math.sin(angle) };
  return { along, out: { x: along.y, y: -along.x } };
}

/** The rectangle's four corners in document space, anchor first, clockwise. */
export function bandCorners(spec: StretchSpec): [Point, Point, Point, Point] {
  const { along, out } = rectBasis(spec);
  const w = { x: along.x * spec.width, y: along.y * spec.width };
  const l = { x: out.x * spec.length, y: out.y * spec.length };
  return [
    { x: spec.anchor.x, y: spec.anchor.y },
    { x: spec.anchor.x + w.x, y: spec.anchor.y + w.y },
    { x: spec.anchor.x + w.x + l.x, y: spec.anchor.y + w.y + l.y },
    { x: spec.anchor.x + l.x, y: spec.anchor.y + l.y },
  ];
}

/** Whether any edge has been bowed away from straight. */
export function hasCurvedEdges(spec: StretchSpec): boolean {
  return (
    spec.warpMode === 'curved' &&
    Boolean(spec.edges?.some((e) => e.some((c) => c.u !== 0 || c.v !== 0)))
  );
}

/**
 * The four Bézier edges of the band, in document space. Each control sits at
 * its straight-edge third plus the stored offset, rotated into the rect frame
 * so the curve travels with the rectangle.
 */
export function edgeCurves(spec: StretchSpec): [
  [Point, Point, Point, Point], [Point, Point, Point, Point],
  [Point, Point, Point, Point], [Point, Point, Point, Point],
] {
  const corners = warpedCorners(spec);
  const { along, out } = rectBasis(spec);
  const controls = spec.edges ?? NO_EDGE_WARP;

  return corners.map((from, i) => {
    const to = corners[(i + 1) % 4];
    const offsets = controls[i];
    const knot = (fraction: number, offset: WarpOffset): Point => ({
      x: from.x + (to.x - from.x) * fraction + along.x * offset.u + out.x * offset.v,
      y: from.y + (to.y - from.y) * fraction + along.y * offset.u + out.y * offset.v,
    });
    return [from, knot(1 / 3, offsets[0]), knot(2 / 3, offsets[1]), to];
  }) as ReturnType<typeof edgeCurves>;
}

/** Express a document point as an edge-control offset in the rectangle's frame. */
export function toEdgeOffset(
  spec: StretchSpec,
  edgeIndex: number,
  controlIndex: 0 | 1,
  target: Point,
): WarpOffset {
  const corners = warpedCorners(spec);
  const from = corners[edgeIndex];
  const to = corners[(edgeIndex + 1) % 4];
  const fraction = controlIndex === 0 ? 1 / 3 : 2 / 3;
  const base = {
    x: from.x + (to.x - from.x) * fraction,
    y: from.y + (to.y - from.y) * fraction,
  };
  const { along, out } = rectBasis(spec);
  const dx = target.x - base.x;
  const dy = target.y - base.y;
  return { u: dx * along.x + dy * along.y, v: dx * out.x + dy * out.y };
}

/**
 * Pull one corner to `target`, bending the band like a sheet of paper.
 *
 * Only that corner moves. The other three stay pinned and every edge handle
 * stays exactly where it was, so each edge meeting the corner has to arc out
 * to reach it: one lengthens into a curve, the other rolls over in a rounded
 * fold. A handle only pulls its own part of the sheet, so the bend stays near
 * the corner rather than shearing the whole band. The handles stay draggable
 * afterwards to reshape the bend.
 */
export function pullCorner(
  spec: StretchSpec,
  corner: number,
  target: Point,
): Pick<StretchSpec, 'warp' | 'edges' | 'warpMode'> {
  // A straight band ignores its stored controls, so start from the edges as
  // they're drawn.
  const current: StretchSpec = spec.warpMode === 'curved' ? spec : { ...spec, edges: NO_EDGE_WARP };
  const handles = edgeCurves(current);

  const warp = (current.warp ?? NO_WARP).map((offset) => ({ ...offset })) as Warp;
  warp[corner] = toWarpOffset(current, corner, target);
  const pulled: StretchSpec = { ...current, warp };

  // Handles are stored relative to the straight line between their edge's
  // corners, so only the two edges meeting this corner need re-expressing.
  const edges = (current.edges ?? NO_EDGE_WARP).map((edge) => (
    edge.map((control) => ({ ...control }))
  )) as EdgeWarp;
  for (const edge of [(corner + 3) % 4, corner]) {
    edges[edge] = [
      toEdgeOffset(pulled, edge, 0, handles[edge][1]),
      toEdgeOffset(pulled, edge, 1, handles[edge][2]),
    ];
  }
  return { warp, edges, warpMode: 'curved' };
}

/**
 * Move one corner as an ordinary flat quadrilateral edit.
 *
 * This deliberately keeps the straight-edge mode and clears cylindrical depth,
 * so a corner drag is a 2D skew/perspective transform rather than a page fold.
 * Stored Bézier controls are left alone and return if curved mode is re-enabled.
 */
export function skewCorner(
  spec: StretchSpec,
  corner: number,
  target: Point,
): Pick<StretchSpec, 'warp' | 'warpMode' | 'bend'> {
  const warp = (spec.warp ?? NO_WARP).map((offset) => ({ ...offset })) as Warp;
  warp[corner] = toWarpOffset(spec, corner, convexCornerTarget(spec, corner, target));
  return { warp, warpMode: 'straight', bend: 0 };
}

/** How much a vertex turns: positive or negative by winding, zero when straight. */
function turnAt(previous: Point, at: Point, next: Point): number {
  return (at.x - previous.x) * (next.y - at.y) - (at.y - previous.y) * (next.x - at.x);
}

/**
 * Whether the quad is strictly convex. The straight-mode homography is only
 * well-behaved for convex quads — past that its horizon cuts through the band
 * and points are thrown out towards infinity.
 */
export function isConvexQuad(quad: [Point, Point, Point, Point]): boolean {
  const turns = quad.map((point, i) => turnAt(quad[(i + 3) % 4], point, quad[(i + 1) % 4]));
  return turns.every((t) => t > 0) || turns.every((t) => t < 0);
}

/**
 * Keep a dragged straight-mode corner where the quad stays convex, with a small
 * margin so it never quite flattens into a triangle. With the other three
 * corners fixed, the allowed spots are the intersection of three half-planes,
 * so the corner slides along whichever limit it runs into.
 */
function convexCornerTarget(spec: StretchSpec, corner: number, target: Point): Point {
  const quad = warpedCorners(spec);
  const previous = quad[(corner + 3) % 4];
  const next = quad[(corner + 1) % 4];
  const opposite = quad[(corner + 2) % 4];
  const rect = bandCorners(spec);
  const winding = Math.sign(turnAt(rect[3], rect[0], rect[1])) || 1;
  const margin = Math.max(1, 0.02 * Math.min(Math.abs(spec.width), Math.abs(spec.length)));

  // Each limit: the corner must sit at least `margin` on the winding side of
  // the line through `origin` along `direction`.
  const limits = [
    { origin: previous, direction: { x: previous.x - opposite.x, y: previous.y - opposite.y } },
    { origin: next, direction: { x: opposite.x - next.x, y: opposite.y - next.y } },
    { origin: previous, direction: { x: previous.x - next.x, y: previous.y - next.y } },
  ].filter(({ direction }) => Math.hypot(direction.x, direction.y) > 1e-9);
  const clearance = (p: Point, { origin, direction }: typeof limits[number]) => {
    const length = Math.hypot(direction.x, direction.y);
    return winding * (direction.x * (p.y - origin.y) - direction.y * (p.x - origin.x)) / length;
  };
  const allowed = (p: Point) => limits.every((limit) => clearance(p, limit) >= margin - 1e-6);

  let point = { ...target };
  for (let pass = 0; pass < 16 && !allowed(point); pass++) {
    for (const limit of limits) {
      const short = margin - clearance(point, limit);
      if (short <= 0) continue;
      const length = Math.hypot(limit.direction.x, limit.direction.y);
      point = {
        x: point.x - (winding * limit.direction.y / length) * short,
        y: point.y + (winding * limit.direction.x / length) * short,
      };
    }
  }
  if (allowed(point)) return point;

  // Limits that can't all be met (a band already folded some other way): walk
  // from where the corner is now towards the pointer as far as stays valid.
  const current = quad[corner];
  if (!allowed(current)) return current;
  let lo = 0;
  let hi = 1;
  for (let step = 0; step < 24; step++) {
    const mid = (lo + hi) / 2;
    const candidate = { x: current.x + (target.x - current.x) * mid, y: current.y + (target.y - current.y) * mid };
    if (allowed(candidate)) lo = mid;
    else hi = mid;
  }
  return { x: current.x + (target.x - current.x) * lo, y: current.y + (target.y - current.y) * lo };
}

/** Whether the band is distorted away from a plain rectangle. */
export function isWarped(spec: StretchSpec): boolean {
  return Boolean(spec.warp?.some((w) => w.u !== 0 || w.v !== 0));
}

/**
 * The band's actual quad: the rectangle's corners with each corner's warp
 * offset applied in the rectangle's own frame.
 */
export function warpedCorners(spec: StretchSpec): [Point, Point, Point, Point] {
  const corners = bandCorners(spec);
  if (!spec.warp) return corners;
  const { along, out } = rectBasis(spec);
  return corners.map((c, i) => {
    const w = spec.warp![i];
    return {
      x: c.x + along.x * w.u + out.x * w.v,
      y: c.y + along.y * w.u + out.y * w.v,
    };
  }) as [Point, Point, Point, Point];
}

/** Express a document-space point as a corner offset in the rectangle's frame. */
export function toWarpOffset(spec: StretchSpec, cornerIndex: number, target: Point): WarpOffset {
  const base = bandCorners(spec)[cornerIndex];
  const { along, out } = rectBasis(spec);
  const dx = target.x - base.x;
  const dy = target.y - base.y;
  return { u: dx * along.x + dy * along.y, v: dx * out.x + dy * out.y };
}

/** Centre of the rectangle, which is what rotation turns about. */
export function rectCenter(spec: StretchSpec): Point {
  const { along, out } = rectBasis(spec);
  return {
    x: spec.anchor.x + (along.x * spec.width) / 2 + (out.x * spec.length) / 2,
    y: spec.anchor.y + (along.y * spec.width) / 2 + (out.y * spec.length) / 2,
  };
}

/**
 * The anchor that keeps `centre` fixed for a given rotation — rotating about
 * the middle means the corner has to move.
 */
export function anchorForCentre(
  spec: StretchSpec,
  centre: Point,
  rotation: number,
): Point {
  const { along, out } = rectBasis({ ...spec, rotation });
  return {
    x: centre.x - (along.x * spec.width) / 2 - (out.x * spec.length) / 2,
    y: centre.y - (along.y * spec.width) / 2 - (out.y * spec.length) / 2,
  };
}

/** The rectangle a freshly-locked path starts from, before it's dragged out. */
export function initialRect(points: Point[]): Pick<StretchSpec, 'anchor' | 'width' | 'length'> {
  return { anchor: { ...points[0] }, width: chordLength(points), length: 0 };
}
