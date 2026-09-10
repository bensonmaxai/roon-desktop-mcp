import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runtimeConfig } from '../src/runtime.mjs';

const base = { LOCALAPPDATA: os.tmpdir(), ROON_DESKTOP_APP: path.join(os.tmpdir(), 'Roon.exe') };

test('runtime defaults to no desktop input or foreground with bounded journal', () => {
  const config = runtimeConfig(base);
  assert.equal(config.allowInput, false);
  assert.equal(config.allowForeground, false);
  assert.equal(config.maxOperations, 10_000);
  assert.equal(runtimeConfig({ ...base, ROON_DESKTOP_ALLOW_INPUT: 'true' }).allowInput, false);
  assert.equal(runtimeConfig({ ...base, ROON_DESKTOP_ALLOW_INPUT: '1' }).allowInput, true);
});

test('journal capacity is a bounded positive integer configured by the operator', () => {
  for (const value of ['', '0', '-1', '1.5', 'NaN', '100001']) {
    assert.throws(() => runtimeConfig({ ...base, ROON_DESKTOP_MAX_OPERATIONS: value }), { code: 'JOURNAL_CONFIG' });
  }
  assert.equal(runtimeConfig({ ...base, ROON_DESKTOP_MAX_OPERATIONS: '2' }).maxOperations, 2);
});
