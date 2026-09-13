import type { Point, StretchSpec } from '../types/stretch.ts';
import { edgeCurves, hasCurvedEdges, warpedCorners } from '../types/stretch.ts';
import { project, quadHomography } from './projection.ts';

/** A cubic Bézier edge: start, two controls, end. */
export type CubicEdge = [Point, Point, Point, Point];

/**
 * The four boundary curves of a patch, each running from one corner to the
 * next: c0→c1, c1→c2, c2→c3, c3→c0.
 */
export type PatchEdges = [CubicEdge, CubicEdge, CubicEdge, CubicEdge];

/** A bicubic Bézier control net, indexed `[row][column]`: rows by v, columns by u. */
export type ControlNet = Point[][];

/** Where a unit-square coordinate lands on the band. */
export type SurfaceMap = (u: number, v: number) => Point;

/** The controls that make an edge from `p0` to `p1` perfectly straight. */
export function straightControls(p0: Point, p1: Point): [Point, Point] {
  return [
    { x: p0.x + (p1.x - p0.x) / 3, y: p0.y + (p1.y - p0.y) / 3 },
    { x: p0.x + ((p1.x - p0.x) * 2) / 3, y: p0.y + ((p1.y - p0.y) * 2) / 3 },
  ];
}

function mix(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * The 4×4 Bézier net bounded by the four edges.
 *
 * Twelve of the sixteen points are the edges' own corners and handles, and
 * each of those only pulls the part of the sheet near it. That locality is
 * what lets a pulled corner fold over on its own like paper, instead of
 * shearing the whole band towards it.
 *
 * The four interior points span straight across between the side edges'
 * handles. The streaks run along the sides, so a bowed side edge carries them
 * all the way across. With straight end edges this is exactly the bilinearly
 * blended Coons patch through the same four curves, and with every edge
 * straight it is plain bilinear interpolation.
 */
export function controlNet(edges: PatchEdges): ControlNet {
  const [top, right, bottom, left] = edges;
  // The stored bottom edge runs c2→c3, i.e. backwards in u; likewise the left
  // edge runs c3→c0, backwards in v.
  const row = (from: Point, to: Point) => [from, mix(from, to, 1 / 3), mix(from, to, 2 / 3), to];
  return [
    [top[0], top[1], top[2], top[3]],
    row(left[2], right[1]),
    row(left[1], right[2]),
    [bottom[3], bottom[2], bottom[1], bottom[0]],
  ];
}

function bernstein(t: number): [number, number, number, number] {
  const s = 1 - t;
  return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
}

/** Point at (u, v) on the Bézier surface over `net`. */
export function patchPoint(net: ControlNet, u: number, v: number): Point {
  const bu = bernstein(u);
  const bv = bernstein(v);
  let x = 0;
  let y = 0;
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      const weight = bv[j] * bu[i];
      x += net[j][i].x * weight;
      y += net[j][i].y * weight;
    }
  }
  return { x, y };
}

/**
 * How a band's geometry is evaluated, before any cylindrical wrap: a
 * perspective quad while its edges are straight, a Bézier sheet once they
 * curve. Pixels and editing guides both go through this.
 */
export function bandSurface(spec: StretchSpec): SurfaceMap {
  if (hasCurvedEdges(spec)) {
    const net = controlNet(edgeCurves(spec));
    return (u, v) => patchPoint(net, u, v);
  }
  const m = quadHomography(warpedCorners(spec));
  return (u, v) => project(m, u, v);
}
