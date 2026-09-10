import assert from 'node:assert/strict';
import test from 'node:test';

import { recognizeImage } from '../src/ocr.mjs';

const validResult = {
  available: true,
  language: 'zh-Hant',
  text: '我的播放清單',
  lines: [{
    text: '我的播放清單',
    bounds: { x: 18, y: 42, width: 150, height: 28 },
    words: [{ text: '我的播放清單', bounds: { x: 18, y: 42, width: 150, height: 28 } }],
  }],
  width: 1520,
  height: 855,
};

test('passes Unicode and whitespace image paths as one PowerShell argument', async () => {
  const imagePath = 'C:\\使用者 資料\\播放 清單\\封面 圖.png';
  let invocation;
  const result = await recognizeImage(imagePath, {
    runner: async (input) => {
      invocation = input;
      return { stdout: JSON.stringify(validResult) };
    },
  });

  assert.equal(result.available, true);
  assert.equal(invocation.args[invocation.args.indexOf('-ImagePath') + 1], imagePath);
  assert.deepEqual(JSON.parse(invocation.args[invocation.args.indexOf('-LanguagesJson') + 1]), ['zh-Hant', 'en-US']);
  assert.ok(invocation.args.includes('-NoProfile'));
  assert.ok(invocation.args.includes('-NonInteractive'));
  assert.ok(invocation.args.includes('-ExecutionPolicy'));
  assert.equal(invocation.args[invocation.args.indexOf('-ExecutionPolicy') + 1], 'Bypass');
  assert.ok(invocation.args[invocation.args.indexOf('-File') + 1].endsWith('windows-ocr.ps1'));
});

test('parses UTF-8 JSON OCR output and preserves pixel coordinates', async () => {
  const result = await recognizeImage('C:\\測試\\封面.png', {
    runner: async () => ({ stdout: `\uFEFF${JSON.stringify(validResult)}\n` }),
  });

  assert.deepEqual(result, validResult);
});

test('returns the script-reported unavailable state without inventing text', async () => {
  const result = await recognizeImage('C:\\測試\\封面.png', {
    runner: async () => ({ stdout: JSON.stringify({ available: false, error: 'No requested Windows OCR language is installed.' }) }),
  });

  assert.deepEqual(result, {
    available: false,
    error: 'No requested Windows OCR language is installed.',
  });
});

test('reports a timed out OCR process', async () => {
  const timeout = Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' });
  const result = await recognizeImage('C:\\測試\\封面.png', {
    timeoutMs: 123,
    runner: async () => { throw timeout; },
  });

  assert.deepEqual(result, {
    available: false,
    error: 'Windows OCR timed out after 123 ms.',
  });
});

test('reports runner errors and malformed OCR output as unavailable', async () => {
  const runnerError = await recognizeImage('C:\\測試\\封面.png', {
    runner: async () => { throw new Error('PowerShell was unavailable'); },
  });
  const malformedOutput = await recognizeImage('C:\\測試\\封面.png', {
    runner: async () => ({ stdout: '{not json' }),
  });

  assert.deepEqual(runnerError, {
    available: false,
    error: 'Windows OCR process could not be started.',
  });
  assert.deepEqual(malformedOutput, {
    available: false,
    error: 'Windows OCR returned invalid output.',
  });
});
