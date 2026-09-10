import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RoonDesktopController } from '../src/controller.mjs';
import { DesktopError } from '../src/errors.mjs';
import { navigate } from '../src/navigation.mjs';

function solidPixels(width = 300, height = 200, value = 0) {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
    data[index + 3] = 255;
  }
  return { width, height, data };
}

function patchPixels(image, { x, y, width, height }, value = 255) {
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

function frame(tag, pixels = solidPixels(), elements) {
  return {
    tag,
    pixels,
    elements: elements || [{
      element_index: 7,
      element_token: 'stable-token',
      label: 'Browse',
      role: 'button',
      frame: { x: 1040, y: 560, w: 80, h: 30 },
    }],
  };
}

class FakeJournal {
  constructor() {
    this.records = new Map();
    this.transitions = [];
  }

  async begin({ operationId, request, baseline }) {
    const existing = this.records.get(operationId);
    if (existing) return { replay: true, record: existing };
    const record = { operationId, request, baseline, state: 'prepared' };
    this.records.set(operationId, record);
    return { replay: false, record };
  }

  async transition(operationId, state, evidence = {}) {
    const record = this.records.get(operationId);
    if (!record) throw new Error(`unknown fake operation ${operationId}`);
    record.state = state;
    record.evidence = evidence;
    this.transitions.push({ operationId, state, evidence });
    return record;
  }

  async get(operationId) {
    return this.records.get(operationId) || null;
  }
}

function expectCode(code) {
  return (error) => error instanceof DesktopError && error.code === code;
}

function navigationRequest(frameId, operationId, overrides = {}) {
  return {
    operation_id: operationId,
    frame_id: frameId,
    intent: 'navigate',
    action: { kind: 'click', target: { x: 120, y: 90 } },
    ...overrides,
  };
}

function dragRequest(frameId, operationId, overrides = {}) {
  return {
    operation_id: operationId,
    frame_id: frameId,
    intent: 'navigate',
    action: {
      kind: 'drag',
      target: { x: 120, y: 90 },
      to: { x: 200, y: 150 },
    },
    ...overrides,
  };
}

function activationRequest(frameId, operationId, overrides = {}) {
  return {
    operation_id: operationId,
    frame_id: frameId,
    user_authorized: true,
    ...overrides,
  };
}

async function createHarness(t, { frames = [frame('initial')], allowForeground = false, allowInput = true, foregroundPermitTtlMs } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'roon-desktop-controller-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const roonPath = path.join(dataDir, 'Roon.exe');
  const state = {
    pid: 501,
    startedAt: 'start-a',
    identityPath: roonPath,
    appOverride: undefined,
    windows: undefined,
    frames,
    captureCount: 0,
    calls: [],
    actionError: undefined,
    activationError: undefined,
    activationResult: undefined,
    lockCalls: 0,
  };
  const journal = new FakeJournal();
  let now = 1_700_000_000_000;

  const defaultApp = () => ({ bundle_id: roonPath, pid: state.pid, running: true });
  const defaultWindow = (pid) => ({
    pid,
    window_id: 100_000 + pid,
    title: 'Roon',
    minimized: false,
    is_on_screen: true,
    bounds: { x: 1000, y: 500, width: 300, height: 200 },
  });
  const driver = {
    async call(method, args = {}) {
      state.calls.push({ method, args });
      if (method === 'list_apps') return { apps: state.appOverride || [defaultApp()] };
      if (method === 'list_windows') return { windows: state.windows || [defaultWindow(args.pid)] };
      if (method === 'get_window_state') {
        const selected = state.frames[Math.min(state.captureCount, state.frames.length - 1)];
        state.captureCount += 1;
        await writeFile(args.screenshot_out_file, Buffer.from(selected.tag));
        return {
          pid: args.pid,
          window_id: args.window_id,
          snapshot_id: `snapshot-${state.captureCount}`,
          elements: selected.elements,
          elements_complete: false,
        };
      }
      if (method === 'bring_to_front') {
        if (state.activationError) throw state.activationError;
        return state.activationResult || {
          previous_fg_hwnd: 2_000,
          now_fg_hwnd: args.window_id,
        };
      }
      if (['click', 'type_text', 'press_key', 'hotkey', 'scroll', 'drag'].includes(method)) {
        if (state.actionError) throw state.actionError;
        return { route: args.delivery_mode, effect: 'unverifiable' };
      }
      throw new Error(`unexpected driver method ${method}`);
    },
  };
  const pixelByTag = new Map(frames.map(candidate => [candidate.tag, candidate.pixels]));
  const controller = new RoonDesktopController({
    roonPath,
    dataDir,
    driverPath: path.join(dataDir, 'cua-driver.exe'),
    snapshotTtlMs: 1_000,
    allowForeground,
    allowInput,
    foregroundPermitTtlMs,
  }, {
    driver,
    journal,
    clock: () => now,
    lock: async callback => {
      state.lockCalls += 1;
      return callback();
    },
    identifyProcess: async (pid) => ({ pid, path: state.identityPath, started_at: state.startedAt }),
    decodeImage: async buffer => pixelByTag.get(buffer.toString()) || solidPixels(),
    ocr: async () => ({ available: false, error: 'test', text: '', lines: [] }),
  });

  return {
    controller,
    dataDir,
    journal,
    roonPath,
    state,
    setNow(value) { now = value; },
    activationCalls: () => state.calls.filter(call => call.method === 'bring_to_front'),
    inputCalls: () => state.calls.filter(call => ['click', 'type_text', 'press_key', 'hotkey', 'scroll', 'drag'].includes(call.method)),
  };
}

test('resolves only the configured Roon.exe and rejects a changed executable identity', async (t) => {
  const harness = await createHarness(t);
  harness.state.appOverride = [
    { bundle_id: path.join(harness.dataDir, 'RoonServer.exe'), pid: 80, running: true },
    { bundle_id: path.join(harness.dataDir, 'Notepad.exe'), pid: 81, running: true },
    { bundle_id: harness.roonPath, pid: 501, running: true },
  ];

  assert.deepEqual((await harness.controller.apps()).map(app => app.pid), [501]);
  harness.state.identityPath = path.join(harness.dataDir, 'other-app.exe');
  await assert.rejects(harness.controller.resolveTarget(), expectCode('APP_IDENTITY_CHANGED'));
  assert.equal(harness.state.calls.filter(call => call.method === 'list_windows').length, 0);
});

test('a Roon PID restart clears the old frame binding', async (t) => {
  const harness = await createHarness(t, { frames: [frame('first'), frame('second')] });
  const first = await harness.controller.capture({ includeOcr: false });

  harness.state.pid = 502;
  harness.state.startedAt = 'start-b';
  const second = await harness.controller.capture({ includeOcr: false });

  assert.equal(second.pid, 502);
  assert.notEqual(second.window_id, first.window_id);
  assert.throws(() => harness.controller.requireFrame(first.id), expectCode('STALE_FRAME'));
});

test('capture maps screen-space UIA frames into screenshot-local bounds', async (t) => {
  const harness = await createHarness(t);
  const snapshot = await harness.controller.capture({ includeOcr: false });

  assert.deepEqual(snapshot.elements[0].local_bounds, { x: 40, y: 60, width: 80, height: 30 });
  assert.equal(snapshot.width, 300);
  assert.equal(snapshot.height, 200);
});

test('stale and expired frames are refused before desktop input', async (t) => {
  const harness = await createHarness(t);
  const snapshot = await harness.controller.capture({ includeOcr: false });

  await assert.rejects(
    harness.controller.act(navigationRequest('wrong-frame', 'operation-stale')),
    expectCode('STALE_FRAME'),
  );
  harness.setNow(1_700_000_001_001);
  await assert.rejects(
    harness.controller.act(navigationRequest(snapshot.id, 'operation-expired')),
    expectCode('EXPIRED_FRAME'),
  );

  assert.equal(harness.inputCalls().length, 0);
  assert.deepEqual(harness.journal.transitions.map(transition => transition.state), ['refused', 'refused']);
});

test('foreground activation uses the exact observed Roon window, refreshes it, and never replays', async (t) => {
  const pixels = solidPixels();
  const harness = await createHarness(t, { frames: [frame('same', pixels)], allowForeground: true });
  const snapshot = await harness.controller.capture({ includeOcr: false });
  const permit = {
    action_digest: 'same-action-digest',
    pid: snapshot.pid,
    window_id: snapshot.window_id,
    process_started_at: snapshot.process_started_at,
    expires_at: 1_700_000_030_000,
  };
  harness.controller.foregroundPermit = permit;
  harness.state.activationResult = {
    previous_fg_hwnd: '0x30dd2',
    now_fg_hwnd: '0x18895',
  };
  const request = activationRequest(snapshot.id, 'operation-activate-exact');

  const activated = await harness.controller.activate(request);
  const replay = await harness.controller.activate(request);

  assert.equal(activated.state, 'confirmed');
  assert.deepEqual(activated.activation, {
    focused: true,
    previous_fg_hwnd: '0x30dd2',
    now_fg_hwnd: '0x18895',
  });
  assert.notEqual(activated.snapshot.id, snapshot.id);
  assert.equal(harness.state.captureCount, 3);
  assert.equal(harness.state.lockCalls, 2);
  assert.deepEqual(harness.activationCalls().map(call => call.args), [{ pid: 501, window_id: 100_501 }]);
  assert.deepEqual(harness.state.calls.map(call => call.method), [
    'list_apps', 'list_windows', 'get_window_state',
    'list_apps', 'list_windows', 'get_window_state',
    'bring_to_front',
    'list_apps', 'list_windows', 'get_window_state',
  ]);
  assert.deepEqual(harness.controller.foregroundPermit, permit);
  assert.equal(replay.replayed, true);
  assert.deepEqual(harness.journal.transitions.map(transition => transition.state), ['dispatched', 'confirmed']);
});

test('foreground activation confirms only safe decimal or hexadecimal HWND receipts', async (t) => {
  const accepted = ['100501', '0x18895'];
  const rejected = ['not-an-hwnd', '-1', -1, 100_501.5, Number.MAX_SAFE_INTEGER + 1, '0x20000000000000'];

  for (const [index, now_fg_hwnd] of accepted.entries()) {
    const harness = await createHarness(t, { allowForeground: true });
    const snapshot = await harness.controller.capture({ includeOcr: false });
    harness.state.activationResult = { now_fg_hwnd };

    const result = await harness.controller.activate(activationRequest(snapshot.id, `operation-safe-hwnd-${index}`));
    assert.equal(result.state, 'confirmed');
    assert.equal(result.activation.focused, true);
  }

  for (const [index, now_fg_hwnd] of rejected.entries()) {
    const harness = await createHarness(t, { allowForeground: true });
    const snapshot = await harness.controller.capture({ includeOcr: false });
    harness.state.activationResult = { now_fg_hwnd };

    const result = await harness.controller.activate(activationRequest(snapshot.id, `operation-unsafe-hwnd-${index}`));
    assert.equal(result.state, 'unknown');
    assert.equal(result.activation.focused, false);
  }
});

test('foreground activation refuses missing authorization, disabled configuration, and stale frames before focus', async (t) => {
  const missingAuthorization = await createHarness(t, { allowForeground: true });
  const authorizedFrame = await missingAuthorization.controller.capture({ includeOcr: false });
  await assert.rejects(
    missingAuthorization.controller.activate(activationRequest(authorizedFrame.id, 'operation-activate-missing-auth', { user_authorized: false })),
    expectCode('AUTHORIZATION_REQUIRED'),
  );

  const disabled = await createHarness(t);
  const disabledFrame = await disabled.controller.capture({ includeOcr: false });
  await assert.rejects(
    disabled.controller.activate(activationRequest(disabledFrame.id, 'operation-activate-disabled')),
    expectCode('FOREGROUND_DISABLED'),
  );

  const stale = await createHarness(t, { allowForeground: true });
  const staleFrame = await stale.controller.capture({ includeOcr: false });
  stale.setNow(1_700_000_001_001);
  await assert.rejects(
    stale.controller.activate(activationRequest(staleFrame.id, 'operation-activate-stale')),
    expectCode('EXPIRED_FRAME'),
  );

  for (const harness of [missingAuthorization, disabled, stale]) {
    assert.equal(harness.activationCalls().length, 0);
    assert.deepEqual(harness.journal.transitions.map(transition => transition.state), harness === disabled ? [] : ['refused']);
  }
});

test('foreground activation refuses a changed Roon generation or window identity before focus', async (t) => {
  const changedGeneration = await createHarness(t, { allowForeground: true });
  const generationFrame = await changedGeneration.controller.capture({ includeOcr: false });
  changedGeneration.state.startedAt = 'start-b';
  await assert.rejects(
    changedGeneration.controller.activate(activationRequest(generationFrame.id, 'operation-activate-generation')),
    expectCode('WINDOW_GENERATION_CHANGED'),
  );

  const changedWindow = await createHarness(t, { allowForeground: true });
  const windowFrame = await changedWindow.controller.capture({ includeOcr: false });
  changedWindow.state.windows = [{
    pid: 501,
    window_id: 'window-other',
    title: 'Roon',
    minimized: false,
    is_on_screen: true,
    bounds: { x: 1000, y: 500, width: 300, height: 200 },
  }];
  await assert.rejects(
    changedWindow.controller.activate(activationRequest(windowFrame.id, 'operation-activate-window')),
    expectCode('WINDOW_SELECTION_REQUIRED'),
  );

  for (const harness of [changedGeneration, changedWindow]) {
    assert.equal(harness.activationCalls().length, 0);
    assert.deepEqual(harness.journal.transitions.map(transition => transition.state), ['refused']);
  }
});

test('UI drift between observation and dispatch refuses input', async (t) => {
  const before = solidPixels();
  const drifted = patchPixels(before, { x: 80, y: 60, width: 100, height: 80 });
  const harness = await createHarness(t, { frames: [frame('before', before), frame('drifted', drifted)] });
  const snapshot = await harness.controller.capture({ includeOcr: false });

  await assert.rejects(
    harness.controller.act(navigationRequest(snapshot.id, 'operation-drift')),
    expectCode('VIEW_CHANGED'),
  );

  assert.equal(harness.inputCalls().length, 0);
  assert.deepEqual(harness.journal.transitions.map(transition => transition.state), ['refused']);
});

test('repeating an operation id never repeats desktop input', async (t) => {
  const pixels = solidPixels();
  const harness = await createHarness(t, { frames: [frame('same', pixels), frame('same', pixels), frame('same', pixels)] });
  const snapshot = await harness.controller.capture({ includeOcr: false });
  const request = navigationRequest(snapshot.id, 'operation-idempotent');

  const first = await harness.controller.act(request);
  const replay = await harness.controller.act(request);

  assert.equal(first.state, 'unknown');
  assert.equal(replay.replayed, true);
  assert.equal(harness.inputCalls().length, 1);
  assert.deepEqual(harness.journal.transitions.map(transition => transition.state), ['dispatched', 'unknown']);
});

test('a timeout after dispatch becomes unknown and immediately captures fresh state', async (t) => {
  const pixels = solidPixels();
  const harness = await createHarness(t, { frames: [frame('before', pixels), frame('fresh', pixels), frame('resnapshot', pixels)] });
  const snapshot = await harness.controller.capture({ includeOcr: false });
  harness.state.actionError = new DesktopError('ACTION_OUTCOME_UNKNOWN', 'driver timeout');

  await assert.rejects(
    harness.controller.act(navigationRequest(snapshot.id, 'operation-timeout')),
    (error) => error instanceof DesktopError && error.code === 'ACTION_OUTCOME_UNKNOWN' && error.details.dispatched === true,
  );

  assert.equal(harness.inputCalls().length, 1);
  assert.equal(harness.state.captureCount, 3);
  assert.notEqual(harness.controller.latest.id, snapshot.id);
  assert.deepEqual(harness.journal.transitions.map(transition => transition.state), ['dispatched', 'unknown']);
});

test('background drag is refused locally and permits one matching foreground retry', async (t) => {
  const pixels = solidPixels();
  const harness = await createHarness(t, { frames: [frame('same', pixels)], allowForeground: true });
  const snapshot = await harness.controller.capture({ includeOcr: false });

  await assert.rejects(
    harness.controller.act(dragRequest(snapshot.id, 'operation-background-drag')),
    (error) => error instanceof DesktopError && error.code === 'BACKGROUND_UNAVAILABLE' &&
      error.details.dispatched === false && error.details.journal_dispatched === false,
  );

  assert.equal(harness.state.calls.filter(call => call.method === 'drag').length, 0);
  assert.equal(harness.inputCalls().length, 0);
  assert.equal(harness.state.captureCount, 2);
  assert.notEqual(harness.controller.latest.id, snapshot.id);
  assert.deepEqual(harness.journal.transitions.map(transition => transition.state), ['refused']);
  assert.equal(harness.journal.transitions[0].evidence.delivery_mode, 'background');
  assert.match(harness.controller.foregroundPermit.action_digest, /^[a-f0-9]{64}$/);

  const retry = await harness.controller.act(dragRequest(harness.controller.latest.id, 'operation-foreground-drag', {
    delivery_mode: 'foreground',
  }));
  assert.equal(retry.state, 'unknown');
  assert.equal(harness.state.calls.filter(call => call.method === 'drag').length, 1);
  assert.equal(harness.inputCalls().length, 1);
  assert.equal(harness.controller.foregroundPermit, null);

  await assert.rejects(
    harness.controller.act(dragRequest(harness.controller.latest.id, 'operation-repeat-foreground-drag', {
      delivery_mode: 'foreground',
    })),
    expectCode('FOREGROUND_NOT_JUSTIFIED'),
  );
  assert.equal(harness.state.calls.filter(call => call.method === 'drag').length, 1);
});

test('a background drag permit cannot bypass disabled foreground delivery', async (t) => {
  const pixels = solidPixels();
  const harness = await createHarness(t, { frames: [frame('same', pixels)] });
  const snapshot = await harness.controller.capture({ includeOcr: false });

  await assert.rejects(
    harness.controller.act(dragRequest(snapshot.id, 'operation-disabled-background-drag')),
    expectCode('BACKGROUND_UNAVAILABLE'),
  );
  await assert.rejects(
    harness.controller.act(dragRequest(harness.controller.latest.id, 'operation-disabled-foreground-drag', {
      delivery_mode: 'foreground',
    })),
    expectCode('FOREGROUND_DISABLED'),
  );
  assert.equal(harness.state.calls.filter(call => call.method === 'drag').length, 0);
});

test('a background refusal preserves a fresh, semantic foreground permit', async (t) => {
  const pixels = solidPixels();
  const harness = await createHarness(t, { frames: [frame('before', pixels), frame('fresh', pixels), frame('resnapshot', pixels)] });
  const snapshot = await harness.controller.capture({ includeOcr: false });
  harness.state.actionError = new DesktopError('BACKGROUND_UNAVAILABLE', 'background delivery refused', { dispatched: false });

  await assert.rejects(
    harness.controller.act(navigationRequest(snapshot.id, 'operation-background-refusal')),
    (error) => error instanceof DesktopError && error.code === 'BACKGROUND_UNAVAILABLE' &&
      error.details.dispatched === false && error.details.journal_dispatched === true,
  );

  assert.equal(harness.inputCalls().length, 1);
  assert.equal(harness.state.captureCount, 3);
  assert.deepEqual(harness.controller.foregroundPermit, {
    action_digest: harness.journal.transitions[0].evidence.foreground_action_digest,
    pid: 501,
    window_id: 100_501,
    process_started_at: 'start-a',
    expires_at: 1_700_000_030_000,
  });
  assert.match(harness.controller.foregroundPermit.action_digest, /^[a-f0-9]{64}$/);
  assert.equal(harness.journal.transitions[0].evidence.delivery_mode, 'background');
  assert.deepEqual(harness.journal.transitions.map(transition => transition.state), ['dispatched', 'refused']);
});

test('a foreground retry must match the refused background action semantics', async (t) => {
  const pixels = solidPixels();
  const harness = await createHarness(t, { frames: [frame('same', pixels)], allowForeground: true });
  const snapshot = await harness.controller.capture({ includeOcr: false });
  harness.state.actionError = new DesktopError('BACKGROUND_UNAVAILABLE', 'background delivery refused');

  await assert.rejects(
    harness.controller.act(navigationRequest(snapshot.id, 'operation-semantic-background')),
    expectCode('BACKGROUND_UNAVAILABLE'),
  );
  harness.state.actionError = undefined;
  const retryFrame = harness.controller.latest;

  await assert.rejects(
    harness.controller.act(navigationRequest(retryFrame.id, 'operation-unrelated-foreground', {
      delivery_mode: 'foreground',
      action: { kind: 'click', target: { x: 121, y: 90 } },
    })),
    expectCode('FOREGROUND_NOT_JUSTIFIED'),
  );

  assert.equal(harness.inputCalls().length, 1);
  assert.notEqual(harness.controller.foregroundPermit, null);

  const retry = await harness.controller.act(navigationRequest(retryFrame.id, 'operation-matching-foreground', {
    delivery_mode: 'foreground',
  }));
  assert.equal(retry.state, 'unknown');
  assert.equal(harness.inputCalls().length, 2);
  assert.equal(harness.controller.foregroundPermit, null);
});

test('an expired foreground permit is refused without input', async (t) => {
  const pixels = solidPixels();
  const harness = await createHarness(t, {
    frames: [frame('same', pixels)],
    allowForeground: true,
    foregroundPermitTtlMs: 100,
  });
  const snapshot = await harness.controller.capture({ includeOcr: false });
  harness.state.actionError = new DesktopError('BACKGROUND_UNAVAILABLE', 'background delivery refused');

  await assert.rejects(
    harness.controller.act(navigationRequest(snapshot.id, 'operation-expiring-background')),
    expectCode('BACKGROUND_UNAVAILABLE'),
  );
  harness.setNow(1_700_000_000_101);
  const retryFrame = await harness.controller.capture({ includeOcr: false });
  harness.state.actionError = undefined;

  await assert.rejects(
    harness.controller.act(navigationRequest(retryFrame.id, 'operation-expired-foreground', { delivery_mode: 'foreground' })),
    expectCode('FOREGROUND_NOT_JUSTIFIED'),
  );

  assert.equal(harness.inputCalls().length, 1);
  assert.equal(harness.controller.foregroundPermit, null);
});

test('a matching foreground permit is consumed after one dispatch', async (t) => {
  const pixels = solidPixels();
  const harness = await createHarness(t, { frames: [frame('same', pixels)], allowForeground: true });
  const snapshot = await harness.controller.capture({ includeOcr: false });
  harness.state.actionError = new DesktopError('BACKGROUND_UNAVAILABLE', 'background delivery refused');

  await assert.rejects(
    harness.controller.act(navigationRequest(snapshot.id, 'operation-consume-background')),
    expectCode('BACKGROUND_UNAVAILABLE'),
  );
  harness.state.actionError = undefined;
  const firstRetry = await harness.controller.act(navigationRequest(harness.controller.latest.id, 'operation-consume-foreground', {
    delivery_mode: 'foreground',
  }));

  assert.equal(firstRetry.state, 'unknown');
  assert.equal(harness.inputCalls().length, 2);
  assert.equal(harness.controller.foregroundPermit, null);
  await assert.rejects(
    harness.controller.act(navigationRequest(harness.controller.latest.id, 'operation-consume-repeat', { delivery_mode: 'foreground' })),
    expectCode('FOREGROUND_NOT_JUSTIFIED'),
  );
  assert.equal(harness.inputCalls().length, 2);
});

test('a Roon restart clears a pending foreground permit', async (t) => {
  const pixels = solidPixels();
  const harness = await createHarness(t, { frames: [frame('same', pixels)], allowForeground: true });
  const snapshot = await harness.controller.capture({ includeOcr: false });
  harness.state.actionError = new DesktopError('BACKGROUND_UNAVAILABLE', 'background delivery refused');

  await assert.rejects(
    harness.controller.act(navigationRequest(snapshot.id, 'operation-restart-background')),
    expectCode('BACKGROUND_UNAVAILABLE'),
  );
  harness.state.pid = 502;
  harness.state.startedAt = 'start-b';
  const restarted = await harness.controller.capture({ includeOcr: false });
  harness.state.actionError = undefined;

  assert.equal(harness.controller.foregroundPermit, null);
  await assert.rejects(
    harness.controller.act(navigationRequest(restarted.id, 'operation-restart-foreground', { delivery_mode: 'foreground' })),
    expectCode('FOREGROUND_NOT_JUSTIFIED'),
  );
  assert.equal(harness.inputCalls().length, 1);
});

test('reconciliation only grants a foreground retry for a background action digest', async (t) => {
  const pixels = solidPixels();
  const harness = await createHarness(t, { frames: [frame('same', pixels)], allowForeground: true });
  const snapshot = await harness.controller.capture({ includeOcr: false });
  const background = await harness.controller.act(navigationRequest(snapshot.id, 'operation-reconcile-background'));

  await harness.controller.reconcile({
    operation_id: 'operation-reconcile-background',
    frame_id: background.snapshot.id,
    outcome: 'unchanged',
    evidence: { source: 'visual', summary: 'The requested screen remained unchanged.' },
  });

  assert.match(harness.controller.foregroundPermit.action_digest, /^[a-f0-9]{64}$/);
  const permit = harness.controller.foregroundPermit;
  await assert.rejects(
    harness.controller.act(navigationRequest(harness.controller.latest.id, 'operation-reconcile-unrelated', {
      delivery_mode: 'foreground',
      action: { kind: 'scroll', direction: 'down' },
    })),
    expectCode('FOREGROUND_NOT_JUSTIFIED'),
  );
  assert.deepEqual(harness.controller.foregroundPermit, permit);

  const foregroundHarness = await createHarness(t, { frames: [frame('same', pixels)], allowForeground: true });
  const foregroundSnapshot = await foregroundHarness.controller.capture({ includeOcr: false });
  foregroundHarness.journal.records.set('operation-reconcile-foreground', {
    operationId: 'operation-reconcile-foreground',
    state: 'unknown',
    baseline: {
      pid: foregroundSnapshot.pid,
      window_id: foregroundSnapshot.window_id,
      process_started_at: foregroundSnapshot.process_started_at,
    },
    evidence: {
      delivery_mode: 'foreground',
      foreground_action_digest: 'a'.repeat(64),
    },
  });
  await foregroundHarness.controller.reconcile({
    operation_id: 'operation-reconcile-foreground',
    frame_id: foregroundSnapshot.id,
    outcome: 'unchanged',
    evidence: { source: 'visual', summary: 'The requested screen remained unchanged.' },
  });

  assert.equal(foregroundHarness.controller.foregroundPermit, null);
});

test('readonly mode rejects forged authorization and navigation before reservation or input', async (t) => {
  const harness = await createHarness(t, { allowInput: false, allowForeground: true });
  const snapshot = await harness.controller.capture({ includeOcr: false });
  const status = await harness.controller.status();
  assert.equal(status.input_enabled, false);
  for (const action of [
    { kind: 'click', target: { x: 120, y: 90 } },
    { kind: 'key', keys: ['enter'] },
    { kind: 'type', target: { x: 120, y: 90 }, text: 'unapproved change' },
  ]) {
    await assert.rejects(harness.controller.act({
      operation_id: `readonly-${action.kind}`, frame_id: 'invalid-frame',
      intent: 'navigate', user_authorized: true, action,
    }), expectCode('READ_ONLY_MODE'));
  }
  await assert.rejects(navigate(harness.controller, {
    operation_id: 'readonly-navigation', frame_id: snapshot.id,
    destination: 'playlists', target: { x: 120, y: 90 },
  }), expectCode('READ_ONLY_MODE'));
  assert.equal(harness.journal.records.size, 0);
  assert.equal(harness.inputCalls().length, 0);
  assert.equal(harness.state.captureCount, 1);
});

test('disabled foreground activation does not allocate journal records', async (t) => {
  const harness = await createHarness(t, { allowForeground: false });
  await assert.rejects(harness.controller.activate(activationRequest('invalid-frame', 'disabled-activation')),
    expectCode('FOREGROUND_DISABLED'));
  assert.equal(harness.journal.records.size, 0);
  assert.equal(harness.state.captureCount, 0);
});

test('foreground input is disabled by default and is not dispatched', async (t) => {
  const harness = await createHarness(t, { allowForeground: false });
  const snapshot = await harness.controller.capture({ includeOcr: false });

  await assert.rejects(
    harness.controller.act(navigationRequest(snapshot.id, 'operation-foreground', { delivery_mode: 'foreground' })),
    expectCode('FOREGROUND_DISABLED'),
  );

  assert.equal(harness.inputCalls().length, 0);
  assert.equal(harness.state.captureCount, 1);
});
