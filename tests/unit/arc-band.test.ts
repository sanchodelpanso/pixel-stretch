import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FULL_TURN,
  arcCentre,
  arcFromPull,
  arcLookup,
  arcPoint,
  isClosedArc,
  sweepToward,
  type ArcBand,
} from '../../src/types/arc-band.ts';

// A vertical sample line, top to bottom, like the telephone screenshot.
const start = { x: 400, y: 380 };
const end = { x: 400, y: 660 };
const width = 280;
const mid = { x: 400, y: 520 };

function near(actual: number, expected: number, epsilon = 1e-6) {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≉ ${expected}`);
}

/** Follow the pointer round a circle, as a hand would, feeding each result back. */
function trace(centre: { x: number; y: number }, radius: number, from: number, to: number, steps = 72) {
  let arc: ArcBand | null = null;
  for (let i = 1; i <= steps; i++) {
    const theta = from + ((to - from) * i) / steps;
    arc = arcFromPull(start, end, width, {
      x: centre.x + Math.cos(theta) * radius,
      y: centre.y + Math.sin(theta) * radius,
    }, arc);
  }
  return arc!;
}

test('a straight pull reads as a very large, nearly flat arc', () => {
  // The line runs down, so a positive pull goes left (out = (along.y, -along.x)).
  const arc = arcFromPull(start, end, width, { x: 250, y: 520 }, null)!;
  assert.ok(arc.radius > 1000);
  near(arc.radius * Math.abs(arc.sweep), 150, 1);
});

test('the pointer lands on the fitted centreline and the band leaves at right angles', () => {
  const pointer = { x: 620, y: 360 };
  const arc = arcFromPull(start, end, width, pointer, null)!;
  const centre = arcCentre(arc);
  near(centre.x, 400, 1e-9);
  near(Math.hypot(pointer.x - centre.x, pointer.y - centre.y), arc.radius, 1e-6);
  const reached = arcPoint(arc, 0, 1);
  near(reached.x, pointer.x, 1e-6);
  near(reached.y, pointer.y, 1e-6);
});

test('curling up and round like the screenshot sweeps past a half turn without flipping', () => {
  // Centre above the line: the band goes right, up, and over to the left.
  const centre = { x: 400, y: 280 };
  const radius = 240;
  const arc = trace(centre, radius, Math.PI / 2, -Math.PI * 0.7, 96);
  near(arcCentre(arc).y, centre.y, 1);
  near(arc.radius, radius, 1);
  near(Math.abs(arc.sweep), Math.PI * 1.2, 0.02);
  // The line's first point is the one nearest the centre.
  assert.equal(arc.outward, true);
});

test('coming back around to the start closes the ring', () => {
  const centre = { x: 400, y: 280 };
  const arc = trace(centre, 240, Math.PI / 2, Math.PI / 2 - FULL_TURN * 0.98, 120);
  assert.ok(isClosedArc(arc));
});

test('backing off after closing reopens the ring on the same circle', () => {
  const centre = { x: 400, y: 280 };
  const closed = trace(centre, 240, Math.PI / 2, Math.PI / 2 - FULL_TURN * 0.98, 120);
  // The trace went right, over the top, and down the left; step back to the left.
  const reopened = sweepToward(closed, { x: 400 - 240, y: 280 });
  near(Math.abs(reopened), Math.PI / 2 * 3, 1e-6);
  assert.equal(Math.sign(reopened), Math.sign(closed.sweep));
});

test('the radius never lets the inner edge cross the centre', () => {
  const arc = arcFromPull(start, end, width, { x: 430, y: 520 }, null)!;
  assert.ok(arc.radius >= width / 2);
});

test('lookup maps the start edge back onto the sample line in path order', () => {
  const arc = arcFromPull(start, end, width, { x: 620, y: 360 }, null)!;
  const lookup = arcLookup(arc, width);
  const top = lookup(400.001, 380.5)!;
  const bottom = lookup(400.001, 659.5)!;
  assert.ok(top.u < 0.01, `top u ${top.u}`);
  assert.ok(bottom.u > 0.99, `bottom u ${bottom.u}`);
  const middle = lookup(mid.x + 0.001, mid.y)!;
  assert.ok(middle.t < 0.01);
  assert.equal(lookup(1400, 1400), null);
});
