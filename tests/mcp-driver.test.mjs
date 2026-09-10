import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CuaMcpDriver } from '../src/mcp-driver.mjs';
import { DRIVER_METHODS } from '../src/driver.mjs';
import { DesktopError } from '../src/errors.mjs';

const executable = path.join(os.tmpdir(), 'roon-test-cua-driver.exe');

function expectCode(code, dispatched) {
  return (error) => error instanceof DesktopError
    && error.code === code
    && (dispatched === undefined || error.details.dispatched === dispatched);
}

function makeConnection({ toolNames = [...DRIVER_METHODS], callTool } = {}) {
  const stats = { connects: 0, listed: 0, calls: [], closes: 0 };
  const transport = { id: Symbol('transport') };
  const client = {
    onclose: undefined,
    async connect(receivedTransport) {
      stats.connects += 1;
      assert.equal(receivedTransport, transport);
    },
    async listTools() {
      stats.listed += 1;
      return { tools: toolNames.map(name => ({ name })) };
    },
    async callTool(request, schema, options) {
      stats.calls.push({ request, schema, options });
      return callTool ? callTool(request, schema, options) : { structuredContent: { apps: [] } };
    },
    async close() {
      stats.closes += 1;
      client.onclose?.();
    },
  };
  return { client, transport, stats };
}

function queuedFactory(...connections) {
  let calls = 0;
  return {
    factory: async (receivedExecutable) => {
      assert.equal(receivedExecutable, executable);
      const next = connections[calls];
      calls += 1;
      if (!next) throw new Error('unexpected connection attempt');
      return next;
    },
    calls: () => calls,
  };
}

test('one driver shares a single in-flight/private connection', async () => {
  const connection = makeConnection();
  const queued = queuedFactory(connection);
  const driver = new CuaMcpDriver({ executable, connectionFactory: queued.factory });

  await Promise.all([driver.call('list_apps'), driver.call('list_apps')]);

  assert.equal(queued.calls(), 1);
  assert.equal(connection.stats.connects, 1);
  assert.equal(connection.stats.listed, 1);
  assert.equal(connection.stats.calls.length, 2);
  await driver.close();
});

test('two drivers own independent connections and closing one leaves the other usable', async () => {
  const first = makeConnection();
  const second = makeConnection();
  const queued = queuedFactory(first, second);
  const one = new CuaMcpDriver({ executable, connectionFactory: queued.factory });
  const two = new CuaMcpDriver({ executable, connectionFactory: queued.factory });

  await one.call('list_apps');
  await two.call('list_apps');
  await one.close();
  await two.call('list_windows', { pid: 44 });

  assert.equal(queued.calls(), 2);
  assert.equal(first.stats.closes, 1);
  assert.equal(second.stats.closes, 0);
  assert.equal(second.stats.calls.length, 2);
  await two.close();
  assert.equal(second.stats.closes, 1);
});

test('connection refuses a driver missing the public bring_to_front capability', async () => {
  const missingBringToFront = makeConnection({ toolNames: [...DRIVER_METHODS].filter(name => name !== 'bring_to_front') });
  const queued = queuedFactory(missingBringToFront);
  const driver = new CuaMcpDriver({ executable, connectionFactory: queued.factory });

  await assert.rejects(driver.call('list_apps'), expectCode('DRIVER_CAPABILITY_MISSING'));

  assert.equal(missingBringToFront.stats.calls.length, 0);
  assert.equal(missingBringToFront.stats.closes, 1);
});

test('an input timeout is unknown, closes the lost session, and requires a new read before writes', async () => {
  const timedOut = makeConnection({ callTool: async () => { throw new Error('timeout'); } });
  const recovered = makeConnection();
  const queued = queuedFactory(timedOut, recovered);
  let disconnects = 0;
  const driver = new CuaMcpDriver({ executable, connectionFactory: queued.factory, onDisconnect: () => { disconnects += 1; } });

  await assert.rejects(driver.call('click', { pid: 44 }), expectCode('ACTION_OUTCOME_UNKNOWN', true));
  await assert.rejects(driver.call('click', { pid: 44 }), expectCode('READ_REQUIRED_AFTER_DISCONNECT', false));
  await driver.call('list_apps');

  assert.equal(timedOut.stats.calls.length, 1);
  assert.equal(timedOut.stats.closes, 1);
  assert.equal(disconnects, 1);
  assert.equal(queued.calls(), 2);
  assert.equal(recovered.stats.calls.length, 1);
  await driver.close();
});

test('a session-ended refusal is authoritative and never marked dispatched', async () => {
  const ended = makeConnection({
    callTool: async () => ({ structuredContent: { status: 'refused', refusal: { code: 'session_ended' } } }),
  });
  const queued = queuedFactory(ended);
  let disconnects = 0;
  const driver = new CuaMcpDriver({ executable, connectionFactory: queued.factory, onDisconnect: () => { disconnects += 1; } });

  await assert.rejects(driver.call('click', { pid: 44 }), expectCode('DRIVER_SESSION_ENDED', false));
  await assert.rejects(driver.call('click', { pid: 44 }), expectCode('READ_REQUIRED_AFTER_DISCONNECT', false));

  assert.equal(ended.stats.calls.length, 1);
  assert.equal(ended.stats.closes, 1);
  assert.equal(disconnects, 1);
  assert.equal(queued.calls(), 1);
});

test('a background refusal keeps the current private connection open', async () => {
  const connection = makeConnection({
    callTool: async (request) => request.name === 'click'
      ? { structuredContent: { status: 'refused', refusal: { code: 'background_unavailable' } } }
      : { structuredContent: { apps: [] } },
  });
  const queued = queuedFactory(connection);
  let disconnects = 0;
  const driver = new CuaMcpDriver({ executable, connectionFactory: queued.factory, onDisconnect: () => { disconnects += 1; } });

  await assert.rejects(driver.call('click', { pid: 44 }), expectCode('BACKGROUND_UNAVAILABLE', false));
  await driver.call('list_apps');

  assert.equal(queued.calls(), 1);
  assert.equal(connection.stats.closes, 0);
  assert.equal(disconnects, 0);
  await driver.close();
  assert.equal(connection.stats.closes, 1);
});
