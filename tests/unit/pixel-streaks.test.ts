import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pixelStreakCells, softenPixels } from '../../src/rendering/pixel-streaks.ts';

/** A sampled row: `columns` wide, each column coloured by `color(i)`. */
function row(columns: number, color: (i: number) => [number, number, number, number]): Uint8ClampedArray {
  return Uint8ClampedArray.from(Array.from({ length: columns }, (_, i) => color(i)).flat());
}

const gradient = row(96, (i) => [i * 2, 255 - i * 2, 120, 255]);

test('cells stay inside the band, never overlap, and keep to their block columns', () => {
  const cells = pixelStreakCells(gradient, 96, 400, { blockSize: 12, scatter: 0.7 });
  assert.ok(cells.length > 0);
  const covered = new Set<string>();
  for (const cell of cells) {
    assert.ok(cell.x >= 0 && cell.y >= 0 && cell.x + cell.width <= 96 && cell.y + cell.height <= 400 + 1e-9);
    assert.equal(cell.x % 12, 0, 'streaks start on block boundaries');
    for (let y = Math.floor(cell.y); y < Math.ceil(cell.y + cell.height) - 1; y++) {
      const key = `${cell.x},${y}`;
      assert.ok(!covered.has(key), `cells overlap at ${key}`);
      covered.add(key);
    }
  }
});

test('no scatter gives even, unbroken streaks to the far end; scatter makes them ragged', () => {
  const reach = (scatter: number) => {
    const ends = new Map<number, number>();
    let area = 0;
    for (const cell of pixelStreakCells(gradient, 96, 400, { blockSize: 12, scatter })) {
      ends.set(cell.x, Math.max(ends.get(cell.x) ?? 0, cell.y + cell.height));
      area += cell.width * cell.height;
    }
    return { ends: [...ends.values()], area };
  };

  const even = reach(0);
  assert.equal(even.ends.length, 8);
  for (const end of even.ends) assert.ok(Math.abs(end - 400) < 1e-9, 'every streak reaches the end');
  assert.ok(Math.abs(even.area - 96 * 400) < 1e-6, 'no gaps without scatter');

  const ragged = reach(1);
  assert.ok(new Set(ragged.ends.map(Math.round)).size > 3, 'streaks end at different distances');
  assert.ok(ragged.area < even.area * 0.9, 'scatter leaves gaps');
});

test('rendering is repeatable, and transparent columns produce no streak', () => {
  const options = { blockSize: 8, scatter: 0.5 };
  assert.deepEqual(pixelStreakCells(gradient, 96, 300, options), pixelStreakCells(gradient, 96, 300, options));

  const gap = row(48, (i) => (i >= 16 && i < 32 ? [0, 0, 0, 0] : [200, 80, 20, 255]));
  const cells = pixelStreakCells(gap, 48, 200, { blockSize: 16, scatter: 0.5 });
  assert.ok(cells.every((cell) => cell.x !== 16), 'the empty block stays empty');
  assert.ok(cells.some((cell) => cell.x === 0) && cells.some((cell) => cell.x === 32));
});

test('a ragged start staggers where streaks begin and breaks up that end', () => {
  const starts = (startScatter: number) => {
    const first = new Map<number, number>();
    for (const cell of pixelStreakCells(gradient, 96, 400, { blockSize: 12, scatter: 0, startScatter })) {
      first.set(cell.x, Math.min(first.get(cell.x) ?? Infinity, cell.y));
    }
    return [...first.values()];
  };
  assert.ok(starts(0).every((y) => y === 0), 'no ragged start: every streak begins at the sample line');
  const ragged = starts(1);
  assert.ok(new Set(ragged.map(Math.round)).size > 3, `streaks begin at different distances: ${ragged}`);
  assert.ok(ragged.every((y) => y <= 400 * 0.6), 'but none starts far from the line');
});

test('softening feathers a hard block edge without darkening it', () => {
  // A 40×40 square: opaque orange on the left half, transparent on the right. The image's own
  // borders soften into the transparent outside too, so read the middle row around the centre edge.
  const size = 40;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < 20; x++) data.set([255, 128, 0, 255], (y * size + x) * 4);
  softenPixels(data, size, size, 3);
  const at = (x: number) => (20 * size + x) * 4;
  const alphas = Array.from({ length: size }, (_, x) => data[at(x) + 3]);
  assert.equal(alphas[10], 255, 'solid away from the edge');
  for (let x = 11; x < 30; x++) assert.ok(alphas[x] <= alphas[x - 1], `alpha falls off across the edge: ${alphas}`);
  assert.ok(alphas[19] > 0 && alphas[19] < 255 && alphas[20] > 0 && alphas[20] < 255, `the edge is a ramp, not a step: ${alphas}`);
  assert.equal(alphas[30], 0, 'clear away from the edge');
  for (let x = 0; x < size; x++) {
    if (alphas[x] > 8) assert.ok(Math.abs(data[at(x)] - 255) <= 2 && Math.abs(data[at(x) + 1] - 128) <= 3, 'colour stays orange');
  }
});
