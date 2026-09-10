import { createHash } from 'node:crypto';
import { dependency } from './runtime.mjs';

export async function decodeImage(buffer) {
  const module = await dependency('pngjs');
  const PNG = module.PNG || module.default?.PNG;
  return PNG.sync.read(buffer);
}

export function imageDigest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function pixelDifference(before, after, region, step = 4) {
  if (before.width !== after.width || before.height !== after.height) return 1;
  const x0 = Math.max(0, Math.floor(region?.x || 0));
  const y0 = Math.max(0, Math.floor(region?.y || 0));
  const x1 = Math.min(before.width, Math.ceil(x0 + (region?.width ?? before.width)));
  const y1 = Math.min(before.height, Math.ceil(y0 + (region?.height ?? before.height)));
  let changed = 0, sampled = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const index = (y * before.width + x) * 4;
      // Small antialiasing changes are not layout drift; visible changes are.
      const delta = Math.max(...[0, 1, 2].map(c => Math.abs(before.data[index + c] - after.data[index + c])));
      if (delta > 24) changed++;
      sampled++;
    }
  }
  return sampled ? changed / sampled : 1;
}

export function compareScene(before, after, points = []) {
  if (before.width !== after.width || before.height !== after.height) {
    return { stable: false, reason: 'window_resized', scene_difference: 1, target_difference: 1 };
  }
  // The persistent transport footer contains an advancing timer/progress bar.
  // Mask it only for the broad scene check; an action there still checks its
  // own target patch, so a zone picker or changed control is not ignored.
  const sceneDifference = pixelDifference(before, after, { x: 0, y: 32, width: before.width, height: Math.max(1, before.height - 142) }, 4);
  const targetDifference = points.reduce((largest, point) => Math.max(largest,
    pixelDifference(before, after, { x: point.x - 38, y: point.y - 24, width: 76, height: 48 }, 2)), 0);
  return {
    stable: sceneDifference < 0.008 && targetDifference < 0.025,
    scene_difference: Number(sceneDifference.toFixed(5)),
    target_difference: Number(targetDifference.toFixed(5)),
    note: 'A sampled pixel drift check reduces stale-target risk; it is not an atomic lock on human interaction.',
  };
}
