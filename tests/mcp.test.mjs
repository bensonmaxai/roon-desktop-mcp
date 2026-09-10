import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMcpServer } from '../src/server.mjs';
import { DesktopError } from '../src/errors.mjs';
import { dependency } from '../src/runtime.mjs';

// This repository deliberately keeps dependencies out of OneDrive. An
// explicit runtime wins; otherwise use the same portable local default as
// setup.ps1 and launch.ps1. Tests never download dependencies.
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
process.env.ROON_DESKTOP_DEPENDENCIES ||= path.join(localAppData, 'Codex', 'dependencies', 'roon-desktop-mcp');

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLk+QAAAABJRU5ErkJggg==', 'base64');
const toolNames = [
  'desktop_status', 'desktop_open', 'desktop_observe', 'desktop_activate',
  'desktop_find', 'desktop_act', 'desktop_navigation_routes', 'desktop_navigate', 'desktop_verify',
  'desktop_operation', 'desktop_reconcile', 'desktop_workflows', 'desktop_workflow',
];

function createController(snapshot) {
  const calls = {
    status: [], open: [], observe: [], find: [], activate: [], act: [], verify: [], reconcile: [],
  };
  const controller = {
    latest: snapshot || null,
    calls,
    async status(...args) { calls.status.push(args); return { ok: true, running: true }; },
    async open(...args) { calls.open.push(args); return { ok: true }; },
    async observe(...args) { calls.observe.push(args); return { ok: true, snapshot }; },
    async find(...args) { calls.find.push(args); return { ok: true, matches: [] }; },
    async activate(...args) { calls.activate.push(args); return { ok: true, state: 'confirmed' }; },
    async act(...args) { calls.act.push(args); return { ok: true, state: 'unknown' }; },
    async verify(...args) { calls.verify.push(args); return { ok: true, verification: { status: 'not_requested' } }; },
    async reconcile(...args) { calls.reconcile.push(args); return { ok: true }; },
    journal: { get: async () => null, list: async () => [] },
  };
  return controller;
}

async function connectServer(t, controller) {
  const [{ Client }, { InMemoryTransport }] = await Promise.all([
    dependency('@modelcontextprotocol/sdk/client/index.js'),
    dependency('@modelcontextprotocol/sdk/inMemory.js'),
  ]);
  const server = await createMcpServer(controller);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'roon-desktop-mcp-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await Promise.allSettled([client.close(), server.close()]); });
  return client;
}

async function imageSnapshot(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'roon-desktop-mcp-image-'));
  const imagePath = path.join(directory, 'frame.png');
  await writeFile(imagePath, PNG_1X1);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    id: 'frame-test-1',
    observed_at: '2026-09-10T00:00:00.000Z',
    pid: 44,
    window_id: 'roon-window',
    process_started_at: 'start-1',
    window_title: 'Roon',
    width: 1,
    height: 1,
    window_bounds: { x: 0, y: 0, width: 1, height: 1 },
    elements: [],
    elements_complete: false,
    ocr: { available: false, error: 'test', text: '', lines: [] },
    accessibility_coverage: 'window_chrome_only',
    image_sha256: 'test-digest',
    _pixels: { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) },
    _imagePath: imagePath,
  };
}

test('MCP initializes over the official in-memory transport and publishes strict tool schemas', async (t) => {
  const controller = createController();
  const client = await connectServer(t, controller);
  const listed = await client.listTools();
  const act = listed.tools.find(tool => tool.name === 'desktop_act');
  const activate = listed.tools.find(tool => tool.name === 'desktop_activate');

  assert.deepEqual(client.getServerVersion(), { name: 'roon-desktop-mcp', version: '0.1.0' });
  assert.ok(client.getServerCapabilities()?.tools);
  assert.deepEqual(listed.tools.map(tool => tool.name), toolNames);
  assert.equal(act.inputSchema.additionalProperties, false);
  assert.equal(act.inputSchema.properties.action.anyOf.length, 5);
  assert.deepEqual(act.inputSchema.properties.action.anyOf.map(branch => branch.properties.kind.const), ['click', 'type', 'key', 'scroll', 'drag']);
  assert.equal(activate.inputSchema.additionalProperties, false);
  assert.equal(activate.inputSchema.required.includes('operation_id'), true);
  assert.equal(activate.inputSchema.required.includes('frame_id'), true);
  assert.equal(activate.inputSchema.required.includes('user_authorized'), true);
});

test('unknown raw process parameters and invalid action-union fields are rejected before controller calls', async (t) => {
  const controller = createController();
  const client = await connectServer(t, controller);

  const rawPid = await client.callTool({ name: 'desktop_observe', arguments: { pid: 44 } });
  const rawPath = await client.callTool({ name: 'desktop_open', arguments: { path: 'C:\\Raw\\Roon.exe' } });
  const extraFind = await client.callTool({ name: 'desktop_find', arguments: { frame_id: 'frame-1', text: 'Browse', extra: true } });
  const malformedAction = await client.callTool({
    name: 'desktop_act',
    arguments: {
      operation_id: 'op-union', frame_id: 'frame-1', intent: 'navigate',
      action: { kind: 'click', target: { x: 10, y: 40 }, text: 'not valid for click' },
    },
  });
  const activationRawWindow = await client.callTool({
    name: 'desktop_activate',
    arguments: { operation_id: 'op-activate-raw-window', frame_id: 'frame-1', user_authorized: true, window_id: 44 },
  });
  const activationMissingAuthorization = await client.callTool({
    name: 'desktop_activate',
    arguments: { operation_id: 'op-activate-missing-auth', frame_id: 'frame-1' },
  });

  for (const result of [rawPid, rawPath, extraFind, malformedAction, activationRawWindow, activationMissingAuthorization]) {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Input validation error/u);
  }
  assert.deepEqual(controller.calls.observe, []);
  assert.deepEqual(controller.calls.open, []);
  assert.deepEqual(controller.calls.find, []);
  assert.deepEqual(controller.calls.activate, []);
  assert.deepEqual(controller.calls.act, []);
});

test('desktop_activate forwards only frame-scoped explicit authorization', async (t) => {
  const controller = createController();
  const client = await connectServer(t, controller);
  const request = {
    operation_id: 'op-activate-valid',
    frame_id: 'frame-1',
    user_authorized: true,
  };

  const result = await client.callTool({ name: 'desktop_activate', arguments: request });

  assert.notEqual(result.isError, true);
  assert.deepEqual(controller.calls.activate, [[request]]);
  assert.deepEqual(result.structuredContent, { ok: true, state: 'confirmed' });
});

test('desktop_act accepts only a valid union member and forwards no raw pid or path', async (t) => {
  const controller = createController();
  const client = await connectServer(t, controller);
  const request = {
    operation_id: 'op-valid',
    frame_id: 'frame-1',
    intent: 'navigate',
    action: { kind: 'scroll', direction: 'down', amount: 2, by: 'line' },
  };

  const result = await client.callTool({ name: 'desktop_act', arguments: request });

  assert.notEqual(result.isError, true);
  assert.deepEqual(controller.calls.act, [[request]]);
  assert.deepEqual(result.structuredContent, { ok: true, state: 'unknown' });
});

test('observations expose a text payload and image while omitting private pixel and path fields', async (t) => {
  const snapshot = await imageSnapshot(t);
  const controller = createController(snapshot);
  const client = await connectServer(t, controller);

  const result = await client.callTool({ name: 'desktop_observe', arguments: { include_ocr: false } });
  const visible = result.structuredContent.snapshot;
  const textPayload = JSON.parse(result.content.find(item => item.type === 'text').text);
  const image = result.content.find(item => item.type === 'image');

  assert.notEqual(result.isError, true);
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.data, PNG_1X1.toString('base64'));
  assert.equal(visible.id, 'frame-test-1');
  assert.equal(Object.hasOwn(visible, '_pixels'), false);
  assert.equal(Object.hasOwn(visible, '_imagePath'), false);
  assert.equal(Object.hasOwn(textPayload.snapshot, '_pixels'), false);
  assert.equal(Object.hasOwn(textPayload.snapshot, '_imagePath'), false);
});

test('controller errors return MCP isError output without leaking private snapshot fields', async (t) => {
  const snapshot = await imageSnapshot(t);
  const controller = createController(snapshot);
  controller.observe = async () => { throw new DesktopError('TEST_REFUSAL', 'mock controller refusal'); };
  const client = await connectServer(t, controller);

  const result = await client.callTool({ name: 'desktop_observe', arguments: {} });
  const visible = result.structuredContent;
  const textPayload = JSON.parse(result.content.find(item => item.type === 'text').text);

  assert.equal(result.isError, true);
  assert.equal(visible.error.code, 'TEST_REFUSAL');
  assert.equal(Object.hasOwn(visible.snapshot, '_pixels'), false);
  assert.equal(Object.hasOwn(visible.snapshot, '_imagePath'), false);
  assert.equal(Object.hasOwn(textPayload.snapshot, '_pixels'), false);
  assert.equal(Object.hasOwn(textPayload.snapshot, '_imagePath'), false);
});
