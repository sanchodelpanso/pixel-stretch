import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brushMaskToBox, maskBoundingBox, resizeMask } from '../../src/segmentation/mask-utils.ts';

test('bilinear resizing aligns pixel centers and clamps the outer edges', () => {
  assert.deepEqual([...resizeMask(new Float32Array([0, 1]), 2, 1, 4, 1)], [0, .25, .75, 1]);
  assert.deepEqual([...resizeMask(new Float32Array([0, 1]), 1, 2, 1, 4)], [0, .25, .75, 1]);
  assert.deepEqual([...resizeMask(new Float32Array([0, 0, 1, 1]), 4, 1, 2, 1)], [0, 1]);
});

test('a single half-opacity brush dab is enough to prompt SAM', () => {
  const mask = new Uint8Array(20 * 20);
  mask[10 * 20 + 10] = 128;
  assert.deepEqual(brushMaskToBox(mask, 20, 20), [5, 5, 15, 15]);
  assert.equal(brushMaskToBox(new Uint8Array(400), 20, 20), null);
});

test('mask bounds use the requested confidence threshold', () => {
  const mask = new Float32Array([.01, .01, .01, .01, .9, .01]);
  assert.deepEqual(maskBoundingBox(mask, 3, 2, .5), { x: 1/3, y: .5, w: 1/3, h: .5 });
  assert.equal(maskBoundingBox(new Float32Array(6), 3, 2), null);
});
