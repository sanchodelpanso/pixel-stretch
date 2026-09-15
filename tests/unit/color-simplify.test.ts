import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simplifyRow } from '../../src/rendering/color-simplify.ts';

type Rgba = [number, number, number, number];

function row(colors: Rgba[]): Uint8ClampedArray {
  return Uint8ClampedArray.from(colors.flat());
}

function colorsOf(data: Uint8ClampedArray): Rgba[] {
  return Array.from({ length: data.length / 4 }, (_, i) => Array.from(data.subarray(i * 4, i * 4 + 4)) as Rgba);
}

const distinct = (colors: Rgba[]) => new Set(colors.map((c) => c.join(','))).size;

test('merges similar neighbours first and keeps the strong edge', () => {
  // A dark gradient, then a bright gradient: the best two stripes split between them.
  const input: Rgba[] = [
    [10, 10, 10, 255], [14, 14, 14, 255], [18, 18, 18, 255],
    [240, 240, 240, 255], [244, 244, 244, 255], [248, 248, 248, 255],
  ];
  const out = colorsOf(simplifyRow(row(input), 6, 2));
  assert.equal(distinct(out), 2);
  assert.deepEqual(out.slice(0, 3), [[14, 14, 14, 255], [14, 14, 14, 255], [14, 14, 14, 255]]);
  assert.deepEqual(out.slice(3), [[244, 244, 244, 255], [244, 244, 244, 255], [244, 244, 244, 255]]);
});

test('stripes stay contiguous and never exceed the requested count', () => {
  const input: Rgba[] = Array.from({ length: 300 }, (_, i) => [
    (i * 37) % 256, (i * 91) % 256, (i * 13) % 256, 255,
  ]);
  for (const count of [2, 5, 17, 120]) {
    const out = colorsOf(simplifyRow(row(input), input.length, count));
    let runs = 1;
    for (let i = 1; i < out.length; i++) if (out[i].join() !== out[i - 1].join()) runs++;
    assert.ok(runs <= count, `${runs} runs for ${count} colours`);
  }
});

test('transparent gaps stay transparent instead of darkening their neighbours', () => {
  const input: Rgba[] = [
    [255, 120, 0, 255], [250, 118, 0, 255],
    [0, 0, 0, 0], [0, 0, 0, 0],
    [252, 121, 0, 255], [248, 119, 0, 255],
  ];
  const out = colorsOf(simplifyRow(row(input), 6, 3));
  assert.deepEqual(out[2], [0, 0, 0, 0]);
  assert.deepEqual(out[3], [0, 0, 0, 0]);
  assert.equal(out[0][3], 255);
  assert.ok(out[0][0] > 240, 'orange stays orange');
});

test('asking for as many colours as columns changes nothing', () => {
  const input = row([[1, 2, 3, 255], [4, 5, 6, 255]]);
  assert.equal(simplifyRow(input, 2, 2), input);
  assert.equal(simplifyRow(input, 2, 10), input);
});

test('soft borders ramp between stripes over a few columns and leave stripe centres solid', () => {
  const input: Rgba[] = [
    ...Array.from({ length: 10 }, (): Rgba => [0, 0, 0, 255]),
    ...Array.from({ length: 10 }, (): Rgba => [200, 200, 200, 255]),
  ];
  const hard = colorsOf(simplifyRow(row(input), 20, 2));
  const soft = colorsOf(simplifyRow(row(input), 20, 2, 5));
  assert.deepEqual(hard[9], [0, 0, 0, 255]);
  assert.deepEqual(hard[10], [200, 200, 200, 255]);

  const reds = soft.map((c) => c[0]);
  // A five-pixel gradient centred on the border at 10: columns 8–11 carry the mix.
  assert.ok(reds.slice(0, 8).every((red) => red === 0), 'left stripe solid away from the border');
  assert.ok(reds.slice(12).every((red) => red === 200), 'right stripe solid away from the border');
  const ramp = reds.slice(8, 12);
  for (let i = 1; i < ramp.length; i++) assert.ok(ramp[i] > ramp[i - 1], `ramp rises: ${ramp}`);
  assert.ok(ramp[0] > 0 && ramp[ramp.length - 1] < 200, `ramp stays between the two colours: ${ramp}`);
});
