import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionStreakPixels } from '../../src/rendering/motion-streaks.ts';

const columns = 200;
const height = 300;
const row = Uint8ClampedArray.from(Array.from({ length: columns }, (_, i) => [i % 256, 200, 60, 255]).flat());

const alphaAt = (pixels: Uint8ClampedArray, x: number, y: number) => pixels[(y * columns + x) * 4 + 3];

/** How far each column's streak reaches: the last row it is still visible in. */
function reaches(pixels: Uint8ClampedArray): number[] {
  return Array.from({ length: columns }, (_, x) => {
    for (let y = height - 1; y >= 0; y--) if (alphaAt(pixels, x, y) > 0) return y + 1;
    return 0;
  });
}

test('no scatter or softness: every streak runs the full length with only a short end fade', () => {
  const pixels = motionStreakPixels(row, columns, height, { scatter: 0, softness: 0, fadeIn: 0 });
  const lengths = reaches(pixels);
  assert.ok(lengths.every((reach) => reach === lengths[0] && reach >= height * 0.95), `even lengths: ${lengths[0]}`);
  assert.equal(alphaAt(pixels, 50, 0), 255);
  assert.equal(alphaAt(pixels, 50, Math.floor(height * 0.8)), 255);
});

test('scatter varies lengths smoothly between neighbours, and ends fade out', () => {
  const pixels = motionStreakPixels(row, columns, height, { scatter: 1, softness: 0.6, fadeIn: 0 });
  const lengths = reaches(pixels);
  assert.ok(Math.max(...lengths) - Math.min(...lengths) > height * 0.3, 'lengths vary widely');
  const jumps = lengths.slice(1).map((reach, i) => Math.abs(reach - lengths[i]));
  assert.ok(Math.max(...jumps) < height * 0.2, 'neighbouring streaks end at similar distances');

  // Along one streak, opacity only falls away from the line.
  const x = lengths.indexOf(Math.min(...lengths));
  let previous = 255;
  for (let y = 0; y < height; y++) {
    const alpha = alphaAt(pixels, x, y);
    assert.ok(alpha <= previous, 'fades out rather than cutting off and back on');
    previous = alpha;
  }
  assert.ok(alphaAt(pixels, x, Math.max(0, lengths[x] - 3)) < 128, 'the end is a soft fade');
});

test('fade in starts transparent at the sample line and reaches full strength', () => {
  const pixels = motionStreakPixels(row, columns, height, { scatter: 0, softness: 0, fadeIn: 0.5 });
  assert.ok(alphaAt(pixels, 80, 0) < 10);
  assert.ok(alphaAt(pixels, 80, 40) > alphaAt(pixels, 80, 10));
  assert.equal(alphaAt(pixels, 80, Math.floor(height * 0.5)), 255);
});

test('softness blurs streaks across columns but transparent gaps stay clear of dark fringes', () => {
  const gap = Uint8ClampedArray.from(Array.from({ length: columns }, (_, i) => (i >= 90 && i < 110 ? [0, 0, 0, 0] : [240, 120, 20, 255])).flat());
  const pixels = motionStreakPixels(gap, columns, height, { scatter: 0, softness: 1, fadeIn: 0 });
  const at = (x: number) => (10 * columns + x) * 4;
  assert.equal(pixels[at(100) + 3], 0, 'the middle of the gap stays empty');
  assert.ok(pixels[at(90) + 3] > 0 && pixels[at(90) + 3] < 255, 'the gap edge is soft');
  assert.ok(pixels[at(90)] > 230, 'the soft edge keeps its colour');
});
