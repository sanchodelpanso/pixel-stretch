import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gridEffect, gridLineWidth, onGridLine, parseHexColor, splitColorAndAlpha,
} from '../../src/rendering/grid-texture.ts';

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test('grid lines sit at the end of every cell and thicken as cells grow', () => {
  assert.equal(gridLineWidth(8), 1);
  assert.equal(gridLineWidth(32), 4);
  assert.ok(!onGridLine(3, 3, 8));
  assert.ok(onGridLine(7, 3, 8), 'a line across');
  assert.ok(onGridLine(3, 15, 8), 'a line along');
  assert.ok(onGridLine(28, 5, 32) && !onGridLine(27, 5, 32), 'a 4 px line on a 32 px grid');
});

test('cut lines turn see-through without a colour, or take the colour with one', () => {
  const cut = { strength: 0.8, size: 8, style: 'cut' as const };
  assert.deepEqual(gridEffect(3, 3, cut), { keep: 1, paint: 0 });
  const line = gridEffect(7, 3, cut);
  assert.ok(near(line.keep, 0.2) && line.paint === 0);
  assert.deepEqual(gridEffect(7, 3, { ...cut, color: '#ff0000' }), { keep: 1, paint: 0.8 });
});

test('grid only leaves the cells transparent and keeps the stretch on the lines', () => {
  const lines = { strength: 0.9, size: 8, style: 'lines' as const };
  assert.deepEqual(gridEffect(3, 3, lines), { keep: 0, paint: 0 }, 'cells are empty');
  assert.deepEqual(gridEffect(7, 3, lines), { keep: 0.9, paint: 0 }, 'lines keep the stretch at the strength');
  assert.deepEqual(gridEffect(7, 3, { ...lines, color: '#00ff00' }), { keep: 0.9, paint: 0 }, 'a colour never paints grid-only lines');
  assert.deepEqual(gridEffect(3, 3, { ...lines, strength: 0 }), { keep: 1, paint: 0 }, 'no strength, no grid');
});

test('grid colours parse from #rrggbb only', () => {
  assert.deepEqual(parseHexColor('#1a2B3c'), [26, 43, 60]);
  assert.equal(parseHexColor('red'), null);
  assert.equal(parseHexColor(undefined), null);
});

test('splitting keeps colour and alpha, and gives transparent pixels a neighbour\'s colour', () => {
  // 4×2: row 0 is transparent, orange half-alpha, transparent, blue; row 1 fully transparent.
  const data = Uint8ClampedArray.from([
    0, 0, 0, 0, 255, 128, 0, 128, 0, 0, 0, 0, 0, 0, 255, 255,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const { color, alpha } = splitColorAndAlpha(data, 4, 2);
  const px = (buffer: Uint8ClampedArray, x: number, y: number) => Array.from(buffer.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4));

  assert.deepEqual(px(alpha, 1, 0), [128, 128, 128, 255], 'alpha becomes opaque grey');
  assert.deepEqual(px(alpha, 0, 1), [0, 0, 0, 255]);
  assert.deepEqual(px(color, 1, 0), [255, 128, 0, 255], 'colour is opaque');
  assert.deepEqual(px(color, 0, 0), [255, 128, 0, 255], 'leading gap takes the first colour');
  assert.deepEqual(px(color, 2, 0), [255, 128, 0, 255], 'inner gap takes the colour before it');
  assert.deepEqual(px(color, 3, 1), [0, 0, 255, 255], 'an empty row copies the nearest row');
});
