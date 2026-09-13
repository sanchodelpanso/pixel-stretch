import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bandCorners,
  edgeCurves,
  pullCorner,
  warpedCorners,
  type Point,
  type StretchSpec,
} from '../../src/types/stretch.ts';
import { bendPreset } from '../../src/types/stretch-presets.ts';
import { bandSurface, controlNet, patchPoint, type PatchEdges } from '../../src/rendering/surface.ts';

const spec: StretchSpec = {
  points: [{ x: 0, y: 0 }, { x: 200, y: 0 }],
  sourceLayerId: 'source',
  anchor: { x: 0, y: 0 },
  width: 200,
  length: 400,
  rotation: 0.3,
  fade: 0,
  edgeSoftness: 0,
  bend: 0,
};

function assertNear(actual: Point, expected: Point, message?: string) {
  const distance = Math.hypot(actual.x - expected.x, actual.y - expected.y);
  assert.ok(distance < 1e-9, `${message ?? 'point'}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
}

/** The far corner dragged back across the band, as in a paper fold. */
function pulled(): StretchSpec {
  const far = bandCorners(spec)[2];
  return { ...spec, ...pullCorner(spec, 2, { x: far.x - 320, y: far.y - 90 }) };
}

test('pulling a corner moves only that corner and leaves every handle in place', () => {
  const before = edgeCurves(spec);
  const bent = pulled();
  const after = edgeCurves(bent);
  const corners = warpedCorners(bent);
  const original = bandCorners(spec);

  assert.equal(bent.warpMode, 'curved');
  for (const index of [0, 1, 3]) assertNear(corners[index], original[index], `corner ${index}`);
  assertNear(corners[2], { x: original[2].x - 320, y: original[2].y - 90 }, 'pulled corner');
  for (let edge = 0; edge < 4; edge++) {
    assertNear(after[edge][1], before[edge][1], `edge ${edge} handle 0`);
    assertNear(after[edge][2], before[edge][2], `edge ${edge} handle 1`);
  }
});

test('a pulled corner bends the edges meeting it and leaves the other two straight', () => {
  const at = bandSurface(pulled());
  const original = bandCorners(spec);
  const along = (from: Point, to: Point, t: number) => ({
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
  });

  for (const t of [0.25, 0.5, 0.75]) {
    assertNear(at(t, 0), along(original[0], original[1], t), 'sample edge');
    assertNear(at(0, t), along(original[0], original[3], t), 'opposite side edge');
  }
  const bentSide = at(1, 0.5);
  const straightSide = along(original[1], original[2], 0.5);
  assert.ok(Math.hypot(bentSide.x - straightSide.x, bentSide.y - straightSide.y) > 20);
});

test('pulling from a straight band starts from its visible edges, not stale controls', () => {
  const stale: StretchSpec = {
    ...spec,
    warpMode: 'straight',
    edges: [[{ u: 50, v: 0 }, { u: 50, v: 0 }], [{ u: 0, v: 0 }, { u: 0, v: 0 }],
      [{ u: 0, v: 0 }, { u: 0, v: 0 }], [{ u: 0, v: 0 }, { u: 0, v: 0 }]],
  };
  const far = bandCorners(spec)[2];
  const bent = { ...stale, ...pullCorner(stale, 2, { x: far.x - 10, y: far.y }) };
  assert.deepEqual(bent.edges?.[0], [{ u: 0, v: 0 }, { u: 0, v: 0 }]);
});

/** The bilinearly blended Coons patch the curved presets were designed against. */
function coonsPoint([top, right, bottom, left]: PatchEdges, u: number, v: number): Point {
  const cubic = ([p0, c0, c1, p1]: Point[], t: number) => {
    const s = 1 - t;
    const w = [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
    return {
      x: w[0] * p0.x + w[1] * c0.x + w[2] * c1.x + w[3] * p1.x,
      y: w[0] * p0.y + w[1] * c0.y + w[2] * c1.y + w[3] * p1.y,
    };
  };
  const cTop = cubic(top, u);
  const cBottom = cubic(bottom, 1 - u);
  const cLeft = cubic(left, 1 - v);
  const cRight = cubic(right, v);
  const [p00, p10, p11, p01] = [top[0], top[3], bottom[0], bottom[3]];
  const blend = (key: 'x' | 'y') => (
    (1 - v) * cTop[key] + v * cBottom[key] + (1 - u) * cLeft[key] + u * cRight[key]
    - ((1 - u) * (1 - v) * p00[key] + u * (1 - v) * p10[key] + u * v * p11[key] + (1 - u) * v * p01[key])
  );
  return { x: blend('x'), y: blend('y') };
}

test('curved presets keep the same sheet they had as a Coons patch', () => {
  for (const preset of ['arc-left', 'arc-right', 's-curve'] as const) {
    const curves = edgeCurves({ ...spec, ...bendPreset(spec, preset) });
    const net = controlNet(curves);
    for (const u of [0, 0.2, 0.5, 0.9, 1]) {
      for (const v of [0, 0.3, 0.5, 0.8, 1]) {
        assertNear(patchPoint(net, u, v), coonsPoint(curves, u, v), `${preset} at ${u},${v}`);
      }
    }
  }
});
