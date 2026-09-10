import assert from 'node:assert/strict';
import test from 'node:test';
import { navigate } from '../src/navigation.mjs';

test('search navigation does not silently dispatch an unreliable background Ctrl shortcut', async () => {
  const calls = [];
  const controller = { requireFrame: () => ({ id: 'frame', width: 1520, height: 855 }),
    act: async request => { calls.push(request); return { ok: true }; } };
  const request = { operation_id: 'search-test', frame_id: 'frame', destination: 'search' };
  const refusal = await navigate(controller, request);
  assert.equal(refusal.error.code, 'NAVIGATION_ANCHOR_REQUIRED');
  assert.equal(calls.length, 0);
  const result = await navigate(controller, { ...request, target: { x: 1420, y: 61 } });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].action, { kind: 'click', target: { x: 1420, y: 61 } });
});

test('explicit foreground shortcut still passes through controller authorization', async () => {
  let captured;
  const controller = { requireFrame: () => ({ id: 'frame' }), act: async request => {
    captured = request; return { ok: false, error: { code: 'FOREGROUND_NOT_JUSTIFIED' } };
  } };
  const result = await navigate(controller, { operation_id: 'foreground-search', frame_id: 'frame', destination: 'search', delivery_mode: 'foreground' });
  assert.equal(result.error.code, 'FOREGROUND_NOT_JUSTIFIED');
  assert.deepEqual(captured.action, { kind: 'key', keys: ['ctrl', 'f'] });
});
