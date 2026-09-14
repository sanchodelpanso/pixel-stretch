import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isConvexShape, setRemovedEdge, skewCorner, warpedCorners, type StretchSpec,
} from '../../src/types/stretch.ts';
import { bandSurface } from '../../src/rendering/surface.ts';

const spec: StretchSpec = {
  points: [{ x: 0, y: 0 }, { x: 200, y: 0 }],
  sourceLayerId: 'source',
  anchor: { x: 0, y: 0 },
  width: 200,
  length: 400,
  rotation: 0,
  fade: 0,
  edgeSoftness: 0,
  bend: 0,
};

const round = (p: { x: number; y: number }) => ({ x: Math.round(p.x), y: Math.round(p.y) });

test('a removed side edge folds onto its sample-line corner; the far edge meets in the middle', () => {
  const [c0, c1, c2, c3] = warpedCorners(spec);
  assert.deepEqual(warpedCorners({ ...spec, removedEdge: 1 })[2], c1);
  assert.deepEqual(warpedCorners({ ...spec, removedEdge: 3 })[3], c0);
  const apex = { x: (c2.x + c3.x) / 2, y: (c2.y + c3.y) / 2 };
  const far = warpedCorners({ ...spec, removedEdge: 2 });
  assert.deepEqual([far[2], far[3]], [apex, apex]);
  assert.ok(isConvexShape({ ...spec, removedEdge: 2 }));
});

test('a triangle surface keeps the sample line and runs every column into the apex', () => {
  const surface = bandSurface({ ...spec, removedEdge: 2 });
  const apex = round(warpedCorners({ ...spec, removedEdge: 2 })[2]);
  assert.deepEqual(round(surface(0.5, 0)), { x: 100, y: 0 });
  for (const u of [0, 0.3, 1]) assert.deepEqual(round(surface(u, 1)), apex);
});

test('dragging a far-edge apex moves both corners and stops short of flattening the triangle', () => {
  const triangle: StretchSpec = { ...spec, removedEdge: 2 };
  const moved = { ...triangle, ...skewCorner(triangle, 2, { x: 300, y: -350 }) };
  const [, , c2, c3] = warpedCorners(moved);
  assert.deepEqual(c2, c3);
  assert.ok(isConvexShape(moved), 'apex dragged across the sample line stays a valid triangle');
});

test('restoring the far edge reopens it around the apex, and switching edges restores first', () => {
  const triangle: StretchSpec = { ...spec, removedEdge: 2 };
  const dragged = { ...triangle, ...skewCorner(triangle, 2, { x: 150, y: 300 }) };
  const restored = { ...dragged, ...setRemovedEdge(dragged, undefined) };
  assert.equal(restored.removedEdge, undefined);
  assert.ok(isConvexShape(restored));
  const [, , c2, c3] = warpedCorners(restored).map(round);
  assert.equal(c2.x - c3.x, 200);

  const switched = { ...dragged, ...setRemovedEdge(dragged, 1) };
  assert.equal(switched.removedEdge, 1);
  assert.ok(isConvexShape(switched));
});
