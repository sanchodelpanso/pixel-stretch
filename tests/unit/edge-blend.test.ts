import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeBlendAmount, smearRate, smearStreak } from '../../src/rendering/edge-blend-profile.ts';

const columns = 300;
const length = 100;

test('the subject stays whole at the sample line and is fully erased well past the blend', () => {
  for (const x of [40, 150, 260]) {
    assert.equal(edgeBlendAmount(x, 0, columns, length), 0, `column ${x} at the line`);
    assert.ok(edgeBlendAmount(x, length * 2, columns, length) > 0.99, `column ${x} past the blend`);
  }
});

test('the erase rises steadily out from the line', () => {
  let previous = 0;
  for (let y = 0; y <= length * 2; y += 5) {
    const amount = edgeBlendAmount(120, y, columns, length);
    assert.ok(amount >= previous - 1e-9);
    previous = amount;
  }
});

test('where the melt starts wanders smoothly across streaks, and the band sides are feathered', () => {
  const at = (x: number) => edgeBlendAmount(x, length * 0.6, columns, length);
  const values = Array.from({ length: columns }, (_, x) => at(x));
  const middle = values.slice(30, 270);
  assert.ok(Math.max(...middle) - Math.min(...middle) > 0.2, 'streaks melt at different distances');
  for (let x = 31; x < 270; x++) assert.ok(Math.abs(values[x] - values[x - 1]) < 0.25, 'neighbours melt alike, give or take a fibre');
  assert.ok(edgeBlendAmount(0, length * 2, columns, length) < 0.1, 'the band edge keeps the subject');
  assert.equal(edgeBlendAmount(3, 0, columns, 0), 0, 'no blend, no erase');
});

/** A streak crossing an object: textured (alternating) for 60 px, then empty. */
function streak(count: number): Float32Array {
  const samples = new Float32Array(count * 4);
  for (let y = 0; y < 60; y++) samples.set(y % 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], y * 4);
  return samples;
}

test('the smear keeps texture where the melt starts and drags it out further along', () => {
  const out = smearStreak(streak(200), 200, 20, 0.8);
  // Before the melt, pixels are untouched: the alternating texture survives.
  assert.equal(out[10 * 4], 0);
  assert.equal(out[11 * 4], 255);
  // Well into the melt, the texture is averaged into one smeared colour.
  assert.ok(Math.abs(out[50 * 4] - out[51 * 4]) < 20, 'texture smeared together');
  assert.equal(out[50 * 4 + 3], 255, 'still solid inside the object');
});

test('the smear trails past the object edge and thins out', () => {
  const out = smearStreak(streak(200), 200, 20, 0.8);
  const alpha = (y: number) => out[y * 4 + 3];
  assert.ok(alpha(80) > 0 && alpha(80) < 255, 'a trail continues past the edge at 60');
  assert.ok(alpha(120) < alpha(80), 'and thins further out');
  const premultipliedRed = out[80 * 4];
  assert.ok(premultipliedRed <= alpha(80), 'colour never outruns coverage');
});

test('the blend strength sets how hard the subject smears: subtle when low, full streaks at the top', () => {
  const average = (strength: number) => {
    let total = 0;
    for (let x = 0; x < 200; x++) total += smearRate(x, strength);
    return total / 200;
  };
  assert.ok(average(0.01) < 0.1, `1% is a hint of softening: ${average(0.01)}`);
  assert.ok(average(0.25) > average(0.01) * 4, 'a quarter smears clearly more');
  assert.ok(average(1) > 1, 'full strength drags pixels into streaks');
  assert.equal(smearRate(10, 0), 0, 'no blend, no smear');
});
