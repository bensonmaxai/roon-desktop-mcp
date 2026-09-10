import path from 'node:path';
import { dependency } from './runtime.mjs';
import { DRIVER_METHODS } from './driver.mjs';
import { DesktopError, invariant } from './errors.mjs';

const READ_METHODS = new Set(['list_apps', 'list_windows', 'get_window_state']);

/**
 * One private, daemon-backed CUA transport per Roon MCP server process.
 * The public `mcp` entry point owns session isolation; never revive the CLI's
 * anonymous/global session with start_session and never start a daemon here.
 */
export class CuaMcpDriver {
  constructor({ executable, timeoutMs = 25_000, connectionFactory, onDisconnect = () => {} }) {
    invariant(typeof executable === 'string' && path.isAbsolute(executable), 'DRIVER_CONFIG',
      'ROON_DESKTOP_DRIVER must point to the installed cua-driver executable.');
    this.executable = executable;
    this.timeoutMs = timeoutMs;
    this.connectionFactory = connectionFactory || defaultConnection;
    this.onDisconnect = onDisconnect;
    this.client = null;
    this.transport = null;
    this.connecting = null;
    this.closed = false;
    this.lost = false;
    this.generation = 0;
  }

  async connect() {
    if (this.client) return;
    if (this.connecting) return this.connecting;
    invariant(!this.closed, 'DRIVER_CLOSED', 'This controller connection has closed.');
    this.connecting = (async () => {
      let pair;
      try {
        pair = await this.connectionFactory(this.executable);
        pair.client.onclose = () => {
          if (this.client === pair.client) {
            this.client = null; this.transport = null; this.lost = true;
            this.onDisconnect();
          }
        };
        await pair.client.connect(pair.transport);
        const listed = await pair.client.listTools();
        const names = new Set(listed.tools.map(tool => tool.name));
        for (const name of DRIVER_METHODS) invariant(names.has(name), 'DRIVER_CAPABILITY_MISSING', `The installed driver lacks required tool ${name}.`);
        this.client = pair.client;
        this.transport = pair.transport;
        this.generation++;
        this.lost = false;
      } catch (error) {
        await pair?.client.close().catch(() => {});
        if (error instanceof DesktopError) throw error;
        throw new DesktopError('DRIVER_UNAVAILABLE', 'Cannot connect to the existing interactive Windows driver through its public MCP transport.');
      }
    })();
    try { await this.connecting; }
    finally { this.connecting = null; }
  }

  async call(method, args = {}) {
    invariant(DRIVER_METHODS.has(method), 'DRIVER_METHOD_DENIED', 'This adapter does not expose that driver method.');
    // After loss, the next command must be a read. It starts a new private
    // proxy session and invalidates old window/frame bindings in the caller.
    invariant(!(this.lost && !READ_METHODS.has(method)), 'READ_REQUIRED_AFTER_DISCONNECT',
      'The Windows driver disconnected. Observe through a fresh connection before any new input.', { dispatched: false });
    await this.connect();
    let result;
    try {
      result = await this.client.callTool({ name: method, arguments: args }, undefined, { timeout: this.timeoutMs });
    } catch {
      const stale = this.client;
      this.client = null; this.transport = null; this.lost = true;
      this.onDisconnect();
      await stale?.close().catch(() => {});
      throw new DesktopError(READ_METHODS.has(method) ? 'DRIVER_UNAVAILABLE' : 'ACTION_OUTCOME_UNKNOWN',
        'The driver did not return the operation outcome. No input will be replayed.', { method, dispatched: !READ_METHODS.has(method) });
    }
    let body = result.structuredContent;
    if (!body) {
      const text = (result.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
      try { body = JSON.parse(text); } catch { body = null; }
    }
    if (result.isError || body?.error || body?.status === 'refused' || body?.refusal) {
      const fingerprint = JSON.stringify(body || result.content?.filter(c => c.type === 'text'));
      const background = /background_unavailable/i.test(fingerprint);
      const ended = /session_ended/i.test(fingerprint);
      if (ended) {
        const stale = this.client;
        this.client = null; this.transport = null; this.lost = true;
        this.onDisconnect();
        await stale?.close().catch(() => {});
      }
      throw new DesktopError(background ? 'BACKGROUND_UNAVAILABLE' : ended ? 'DRIVER_SESSION_ENDED' : 'DRIVER_REJECTED',
        background ? 'Roon refused background delivery. Inspect a new frame before an explicit foreground retry.'
          : ended ? 'This private driver session ended. Start a new observation; never revive or replay the ended session.'
            : `The Windows driver rejected ${method}.`,
        { method, dispatched: !READ_METHODS.has(method) && !background && !ended,
          driver_error: { code: body?.refusal?.code || body?.error?.code || 'driver_error' } });
    }
    invariant(body && typeof body === 'object', READ_METHODS.has(method) ? 'DRIVER_PROTOCOL' : 'ACTION_OUTCOME_UNKNOWN',
      'The driver did not return structured state.', { method, dispatched: !READ_METHODS.has(method) });
    return body;
  }

  async close() {
    this.closed = true;
    const client = this.client;
    this.client = null; this.transport = null;
    await client?.close();
  }
}

async function defaultConnection(executable) {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    dependency('@modelcontextprotocol/sdk/client/index.js'), dependency('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);
  const client = new Client({ name: 'roon-desktop-private-driver', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: executable, args: ['mcp'], stderr: 'pipe' });
  // The SDK exclusively owns child stdout. Do not echo helper diagnostics,
  // arbitrary window text or paths to the parent MCP protocol stream.
  transport.stderr?.on('data', () => {});
  return { client, transport };
}
