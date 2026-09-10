import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CuaDriver } from '../src/driver.mjs';
import { DesktopError } from '../src/errors.mjs';

const executable = path.join(os.tmpdir(), 'roon-test-cua-driver.exe');

function expectCode(code) {
  return (error) => error instanceof DesktopError && error.code === code;
}

test('driver sends a fixed argv vector with shell disabled', async () => {
  let invocation;
  const driver = new CuaDriver({
    executable,
    timeoutMs: 456,
    runner: async (...args) => {
      invocation = args;
      return { stdout: JSON.stringify({ route: 'background', effect: 'unverifiable' }), stderr: '' };
    },
  });

  const result = await driver.call('click', { pid: 44, window_id: 'roon-window', x: 12, y: 34 });

  assert.deepEqual(result, { route: 'background', effect: 'unverifiable' });
  assert.equal(invocation[0], executable);
  assert.deepEqual(invocation[1].slice(0, 2), ['call', 'click']);
  assert.deepEqual(JSON.parse(invocation[1][2]), { pid: 44, window_id: 'roon-window', x: 12, y: 34 });
  assert.equal(invocation[2].shell, false);
  assert.equal(invocation[2].windowsHide, true);
  assert.equal(invocation[2].timeout, 456);
});

test('driver exposes the installed public bring_to_front tool with only pid and window_id', async () => {
  let invocation;
  const driver = new CuaDriver({
    executable,
    runner: async (...args) => {
      invocation = args;
      return { stdout: JSON.stringify({ previous_fg_hwnd: 12, now_fg_hwnd: 44 }), stderr: '' };
    },
  });

  const result = await driver.call('bring_to_front', { pid: 44, window_id: 44 });

  assert.deepEqual(result, { previous_fg_hwnd: 12, now_fg_hwnd: 44 });
  assert.deepEqual(invocation[1].slice(0, 2), ['call', 'bring_to_front']);
  assert.deepEqual(JSON.parse(invocation[1][2]), { pid: 44, window_id: 44 });
});

test('invalid driver JSON is a read protocol error but an action outcome is unknown', async () => {
  const runner = async () => ({ stdout: 'not-json', stderr: '' });
  const driver = new CuaDriver({ executable, runner });

  await assert.rejects(driver.call('list_apps'), expectCode('DRIVER_PROTOCOL'));
  await assert.rejects(
    driver.call('click', { pid: 44, window_id: 'roon-window', x: 12, y: 34 }),
    (error) => error instanceof DesktopError && error.code === 'ACTION_OUTCOME_UNKNOWN' && error.details.dispatched === true,
  );
});

test('daemon-proxy fallback is refused for both observation and input', async () => {
  const driver = new CuaDriver({
    executable,
    runner: async () => ({ stdout: '{}', stderr: 'daemon proxy connection failed; running helper in-process' }),
  });

  await assert.rejects(driver.call('list_apps'), expectCode('DRIVER_DAEMON_UNREACHABLE'));
  await assert.rejects(
    driver.call('click', { pid: 44, window_id: 'roon-window', x: 12, y: 34 }),
    (error) => error instanceof DesktopError && error.code === 'ACTION_OUTCOME_UNKNOWN' && error.details.dispatched === true,
  );
});

test('background delivery refusal is surfaced without claiming dispatch', async () => {
  const driver = new CuaDriver({
    executable,
    runner: async () => ({ stdout: JSON.stringify({ isError: true, error: { code: 'background_unavailable' } }), stderr: '' }),
  });

  await assert.rejects(
    driver.call('click', { pid: 44, window_id: 'roon-window', x: 12, y: 34 }),
    (error) => error instanceof DesktopError && error.code === 'BACKGROUND_UNAVAILABLE' && error.details.dispatched === false,
  );
});

test('a CLI session-ended refusal is not treated as a dispatched action', async () => {
  const driver = new CuaDriver({
    executable,
    runner: async () => ({
      stdout: JSON.stringify({
        status: 'refused',
        refusal: { code: 'session_ended', message: 'The isolated CLI session ended.' },
      }),
      stderr: '',
    }),
  });

  await assert.rejects(
    driver.call('click', { pid: 44, window_id: 'roon-window', x: 12, y: 34 }),
    (error) => error instanceof DesktopError && error.code === 'DRIVER_SESSION_ENDED' && error.details.dispatched === false,
  );
});
