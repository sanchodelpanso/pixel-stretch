import { test } from 'node:test';
import assert from 'node:assert/strict';
import { featherSubjectAlpha } from '../../src/segmentation/subject-blend.ts';

const PHOTO_BORDERS = { left: true, top: true, right: true, bottom: true };

test('a hard contour softens inward while its interior stays opaque', () => {
  const alpha = Uint8ClampedArray.from({ length: 20 }, (_, x) => x < 8 ? 0 : 255);
  const result = featherSubjectAlpha(alpha, 20, 1, 3, PHOTO_BORDERS);

  assert.deepEqual(result.slice(0, 8), new Uint8ClampedArray(8));
  assert.ok(result[8] > 0 && result[8] < result[9]);
  assert.ok(result[9] < result[10]);
  assert.ok(result[10] < result[11]);
  assert.deepEqual(result.slice(11), new Uint8ClampedArray(9).fill(255));
});

test('feathering never grows alpha or introduces an outside halo', () => {
  const alpha = Uint8ClampedArray.from({ length: 63 }, (_, i) => (i * 73) % 256);
  alpha[20] = 0;
  alpha[40] = 0;
  const original = new Uint8ClampedArray(alpha);
  const result = featherSubjectAlpha(alpha, 9, 7, 2.5);

  for (let i = 0; i < alpha.length; i++) {
    assert.ok(result[i] <= alpha[i], `alpha grew at pixel ${i}`);
    if (alpha[i] === 0) assert.equal(result[i], 0);
  }
  assert.deepEqual(alpha, original);
  assert.notEqual(result, alpha);
});

test('thin features and soft selections survive without a binary threshold', () => {
  const alpha = new Uint8ClampedArray(11 * 11);
  for (let y = 0; y < 11; y++) alpha[y * 11 + 2] = 128;
  alpha[5 * 11 + 8] = 48;
  const result = featherSubjectAlpha(alpha, 11, 11, 3);

  assert.ok(result[5 * 11 + 2] > 0 && result[5 * 11 + 2] < 128);
  assert.ok(result[5 * 11 + 8] > 0 && result[5 * 11 + 8] <= 48);
  assert.equal(result[5 * 11 + 7], 0);
  const translucent = new Uint8ClampedArray(9 * 7).fill(64);
  assert.deepEqual(featherSubjectAlpha(translucent, 9, 7, 3, PHOTO_BORDERS), translucent);
});

test('a broad linear alpha ramp sheds background fringe even where Gaussian blur is unchanged', () => {
  const alpha = Uint8ClampedArray.from({ length: 33 }, (_, x) => Math.min(255, x * 8));
  const result = featherSubjectAlpha(alpha, 33, 1, 3, PHOTO_BORDERS);

  // Each sample here is farther than the kernel radius from either endpoint.
  // A symmetric Gaussian preserves this linear ramp exactly, so any reduction
  // comes from the conservative inward bias toward nearby stronger alpha.
  for (const x of [4, 8, 16, 24]) {
    assert.ok(result[x] < alpha[x], `soft contour was unchanged at pixel ${x}`);
    assert.ok(result[x] >= alpha[x] * 0.7, `soft contour lost too much alpha at pixel ${x}`);
  }
  assert.equal(result[0], 0);
});

test('inward bias preserves uniform translucent regions at multiple opacities', () => {
  for (const opacity of [8, 48, 128, 224]) {
    const alpha = new Uint8ClampedArray(17 * 13).fill(opacity);
    assert.deepEqual(featherSubjectAlpha(alpha, 17, 13, 4, PHOTO_BORDERS), alpha);
  }
});

test('a thin local alpha maximum receives no additional inward bias', () => {
  const alpha = new Uint8ClampedArray([0, 0, 0, 0, 128, 0, 0, 0, 0]);
  const result = featherSubjectAlpha(alpha, 9, 1, 3, PHOTO_BORDERS);
  const sigma = 1.5;
  let weights = 0;
  for (let offset = -3; offset <= 3; offset++) {
    weights += Math.exp(-0.5 * (offset / sigma) ** 2);
  }
  assert.equal(result[4], Math.round(128 / weights));
});

test('clamped photo boundaries preserve opaque and empty masks', () => {
  for (const [width, height] of [[1, 1], [9, 5]]) {
    for (const value of [0, 255]) {
      const alpha = new Uint8ClampedArray(width * height).fill(value);
      assert.deepEqual(featherSubjectAlpha(alpha, width, height, 3, PHOTO_BORDERS), alpha);
    }
  }
});

test('cutout crop boundaries feather against transparency on every side', () => {
  const result = featherSubjectAlpha(new Uint8ClampedArray(9 * 9).fill(255), 9, 9, 2);
  const center = result[4 * 9 + 4];
  const sides = [result[4], result[4 * 9], result[4 * 9 + 8], result[8 * 9 + 4]];
  assert.equal(center, 255);
  for (const side of sides) assert.ok(side > 0 && side < center);
  assert.ok(result[0] > 0 && result[0] < sides[0]);
  assert.equal(result[0], result[8 * 9 + 8]);
});

test('each source photo boundary can be clamped independently', () => {
  const result = featherSubjectAlpha(new Uint8ClampedArray(9 * 9).fill(255), 9, 9, 2, {
    left: true, top: true, right: false, bottom: false,
  });
  assert.equal(result[0], 255);
  assert.equal(result[4], 255);
  assert.equal(result[4 * 9], 255);
  assert.ok(result[8] < 255);
  assert.ok(result[8 * 9] < 255);
  assert.ok(result[8 * 9 + 8] < result[8]);
});

test('zero and fractional radii are supported without changing inputs', () => {
  const alpha = new Uint8ClampedArray([0, 0, 255, 255, 255]);
  const copy = featherSubjectAlpha(alpha, 5, 1, 0);
  assert.deepEqual(copy, alpha);
  assert.notEqual(copy, alpha);
  assert.deepEqual(featherSubjectAlpha(alpha, 5, 1, Number.MIN_VALUE), alpha);
  const fractional = featherSubjectAlpha(alpha, 5, 1, 1.5, PHOTO_BORDERS);
  assert.ok(fractional[2] > 0 && fractional[2] < 255);
  assert.equal(fractional[4], 255);
  assert.deepEqual(featherSubjectAlpha(new Uint8ClampedArray(), 0, 0, 2), new Uint8ClampedArray());
  assert.deepEqual(
    featherSubjectAlpha(alpha, 5, 1, 80, PHOTO_BORDERS),
    featherSubjectAlpha(alpha, 5, 1, 8, PHOTO_BORDERS),
  );
});

test('invalid dimensions and radii fail before sampling', () => {
  const alpha = new Uint8ClampedArray(4);
  assert.throws(() => featherSubjectAlpha(alpha, 3, 2, 1), RangeError);
  assert.throws(() => featherSubjectAlpha(alpha, 2.5, 2, 1), RangeError);
  for (const radius of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => featherSubjectAlpha(alpha, 2, 2, radius), RangeError);
  }
});
