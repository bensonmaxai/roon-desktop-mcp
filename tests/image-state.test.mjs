import assert from 'node:assert/strict';
import test from 'node:test';

import { compareScene } from '../src/image-state.mjs';

function pixels(width = 300, height = 200, value = 0) {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
    data[index + 3] = 255;
  }
  return { width, height, data };
}

function patch(image, { x, y, width, height }, value = 255) {
  const data = new Uint8Array(image.data);
  for (let row = y; row < Math.min(image.height, y + height); row += 1) {
    for (let column = x; column < Math.min(image.width, x + width); column += 1) {
      const index = (row * image.width + column) * 4;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
    }
  }
  return { width: image.width, height: image.height, data };
}

test('scene comparison ignores a moving footer unless the target is in that patch', () => {
  const before = pixels();
  const footerMoved = patch(before, { x: 0, y: 140, width: 300, height: 60 });

  const broadOnly = compareScene(before, footerMoved);
  const footerTargeted = compareScene(before, footerMoved, [{ x: 150, y: 160 }]);

  assert.equal(broadOnly.stable, true);
  assert.equal(broadOnly.scene_difference, 0);
  assert.equal(footerTargeted.stable, false);
  assert.ok(footerTargeted.target_difference > 0.025);
});

test('scene comparison detects a modal-sized content change', () => {
  const before = pixels();
  const modal = patch(before, { x: 80, y: 50, width: 120, height: 80 });
  const result = compareScene(before, modal, [{ x: 120, y: 90 }]);

  assert.equal(result.stable, false);
  assert.ok(result.scene_difference >= 0.008);
  assert.ok(result.target_difference >= 0.025);
});

test('scene comparison refuses a resized screenshot', () => {
  const result = compareScene(pixels(300, 200), pixels(301, 200));

  assert.deepEqual(result, {
    stable: false,
    reason: 'window_resized',
    scene_difference: 1,
    target_difference: 1,
  });
});
