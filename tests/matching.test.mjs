import assert from 'node:assert/strict';
import test from 'node:test';

import { findText, resolveText, verifyText } from '../src/matching.mjs';
import { DesktopError } from '../src/errors.mjs';

function snapshot({ elements = [], ocr = { available: true, text: '', lines: [] } } = {}) {
  return { width: 600, height: 400, elements, ocr };
}

function expectCode(code) {
  return (error) => error instanceof DesktopError && error.code === code;
}

test('separate labels never concatenate into a false visible-text match', () => {
  const matches = findText(snapshot({
    elements: [
      { element_index: 1, label: 'foo', enabled: true, frame: { x: 10, y: 50 }, local_bounds: { x: 10, y: 50, width: 30, height: 18 } },
      { element_index: 2, label: 'bar', enabled: true, frame: { x: 50, y: 50 }, local_bounds: { x: 50, y: 50, width: 30, height: 18 } },
    ],
  }), { text: 'foobar' });

  assert.deepEqual(matches, []);
});

test('normalized duplicate Chinese OCR labels require a region before resolving', () => {
  const observed = snapshot({
    ocr: {
      available: true,
      text: '我的播放清單 我的播放清單',
      lines: [
        { text: '我的播放清單', bounds: { x: 40, y: 60, width: 120, height: 28 }, words: [] },
        { text: '我 的 播 放 清 單', bounds: { x: 320, y: 60, width: 120, height: 28 }, words: [] },
      ],
    },
  });

  assert.throws(() => resolveText(observed, { text: '我的播放清單' }), expectCode('AMBIGUOUS_TARGET'));
  const resolved = resolveText(observed, {
    text: '我的播放清單',
    region: { x: 0, y: 32, width: 200, height: 100 },
  });

  assert.equal(resolved.source, 'ocr');
  assert.equal(resolved.x, 100);
  assert.equal(resolved.y, 74);
});

test('a missing OCR result makes negative visible-text checks inconclusive', () => {
  const verification = verifyText(snapshot({
    elements: [],
    ocr: { available: false, error: 'not_installed', text: '', lines: [] },
  }), { contains: ['我的播放清單'] });

  assert.equal(verification.status, 'inconclusive');
  assert.equal(verification.checks[0].matched, false);
});
