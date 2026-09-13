import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STRETCH, type StretchSpec } from '../../src/types/stretch.ts';
import { bendPreset } from '../../src/types/stretch-presets.ts';
import { bendColumn, bendPoint } from '../../src/rendering/projection.ts';

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

test('arc presets bow both long edges together and taper the far edge', () => {
  const right = bendPreset(spec, 'arc-right');
  const left = bendPreset(spec, 'arc-left');
  assert.equal(right.warpMode, 'curved');
  assert.equal(Math.round(right.edges?.[1][0].u ?? 0), 56);
  assert.equal(Math.round(right.edges?.[3][1].u ?? 0), 56);
  assert.equal(Math.round(left.edges?.[1][0].u ?? 0), -56);
  assert.deepEqual(right.warp?.slice(2), [{ u: -20, v: 0 }, { u: 20, v: 0 }]);
});

test('S curve reverses direction halfway while flat clears every deformation', () => {
  const curve = bendPreset(spec, 's-curve');
  assert.deepEqual(curve.edges?.[1], [{ u: 44, v: 0 }, { u: -44, v: 0 }]);
  assert.deepEqual(curve.edges?.[3], [{ u: -44, v: 0 }, { u: 44, v: 0 }]);

  const flat = bendPreset(spec, 'flat');
  assert.equal(flat.bend, 0);
  assert.equal(flat.warpMode, 'straight');
  assert.ok(flat.warp?.every(({ u, v }) => u === 0 && v === 0));
  assert.ok(flat.edges?.flat().every(({ u, v }) => u === 0 && v === 0));
});

test('wrap 1 projects a width-radius cylinder while keeping its side corners fixed', () => {
  const left = bendColumn(0, 1);
  const middle = bendColumn(0.5, 1);
  const right = bendColumn(1, 1);
  assert.ok(Math.abs(left.u) < 1e-12);
  assert.ok(Math.abs(right.u - 1) < 1e-12);
  assert.ok(middle.scale > 1);
  assert.ok(bendColumn(0.5, -1).scale < 1);

  const top = bendPoint(0.5, 0, 1);
  const bottom = bendPoint(0.5, 1, 1);
  assert.ok(top.y < 0);
  assert.ok(bottom.y > 1);
});

test('new stretches start fully opaque with hard edges', () => {
  assert.equal(DEFAULT_STRETCH.fade, 0);
  assert.equal(DEFAULT_STRETCH.edgeSoftness, 0);
});
