import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { dependency } from '../src/runtime.mjs';

const [{ Client }, { StdioClientTransport }] = await Promise.all([
  dependency('@modelcontextprotocol/sdk/client/index.js'), dependency('@modelcontextprotocol/sdk/client/stdio.js'),
]);
const client = new Client({ name: 'roon-desktop-readonly-smoke', version: '0.1.0' });
const useLauncher = process.argv.includes('--launcher');
const transport = new StdioClientTransport({
  command: useLauncher ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : process.execPath,
  args: useLauncher ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./launch.ps1', import.meta.url)), '-NodePath', process.execPath]
    : [fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
  env: { ...process.env, ROON_DESKTOP_ALLOW_INPUT: '0', ROON_DESKTOP_ALLOW_FOREGROUND: '0' }, stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert(tools.tools.some(tool => tool.name === 'desktop_act'));
  assert(tools.tools.some(tool => tool.name === 'desktop_workflows'));
  const statusResult = await client.callTool({ name: 'desktop_status', arguments: {} });
  assert(!statusResult.isError, JSON.stringify(statusResult.structuredContent));
  const observed = await client.callTool({ name: 'desktop_observe', arguments: {} });
  assert(!observed.isError, JSON.stringify(observed.structuredContent));
  const frame = observed.structuredContent.snapshot;
  const image = observed.content.find(item => item.type === 'image');
  assert(image && Buffer.from(image.data, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  assert(frame.width > 0 && frame.height > 0 && frame.id);
  assert.equal(statusResult.structuredContent.input_enabled, false);
  const blocked = await client.callTool({ name: 'desktop_act', arguments: {
    operation_id: 'readonly-smoke-refusal', frame_id: frame.id,
    intent: 'navigate', user_authorized: true,
    action: { kind: 'key', keys: ['enter'] },
  } });
  assert.equal(blocked.structuredContent.error.code, 'READ_ONLY_MODE');
  const operation = await client.callTool({ name: 'desktop_operation', arguments: { operation_id: 'readonly-smoke-refusal' } });
  assert.equal(operation.structuredContent.operation, null);
  const workflows = await client.callTool({ name: 'desktop_workflows', arguments: {} });
  assert(!workflows.isError);
  console.log(JSON.stringify({ ok: true, protocol: 'stdio MCP initialize/listTools/callTool',
    launcher: useLauncher, foreground_enabled: statusResult.structuredContent.foreground_enabled,
    input_enabled: statusResult.structuredContent.input_enabled, readonly_refusal_verified: true,
    tool_count: tools.tools.length, app_running: statusResult.structuredContent.running,
    screenshot: { width: frame.width, height: frame.height, png: true },
    ocr_available: frame.ocr.available, ocr_lines: frame.ocr.lines?.length || 0,
    accessibility_coverage: frame.accessibility_coverage,
    workflow_count: workflows.structuredContent.workflows.length, writes_performed: 0 }, null, 2));
} finally {
  await client.close();
  if (stderr.trim()) process.stderr.write(stderr);
}
