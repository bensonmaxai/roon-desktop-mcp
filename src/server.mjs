import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency, runtimeConfig } from './runtime.mjs';
import { RoonDesktopController, publicSnapshot } from './controller.mjs';
import { errorResult } from './errors.mjs';
import { INTENTS } from './policy.mjs';
import { ROUTES, navigate } from './navigation.mjs';
import { getWorkflow, listWorkflows } from './workflows.mjs';

export async function createMcpServer(controller) {
  const [{ McpServer }, { z }] = await Promise.all([
    dependency('@modelcontextprotocol/sdk/server/mcp.js'), dependency('zod'),
  ]);
  const server = new McpServer({ name: 'roon-desktop-mcp', version: '0.1.0' }, {
    instructions: 'Roon Remote desktop companion. Prefer existing roon API tools for playback/search/queue reads/zones. This server is Roon-only. Generic desktop input is disabled by default; a trusted local operator must set ROON_DESKTOP_ALLOW_INPUT=1. The connected MCP host is trusted; caller consent and reconciliation are assertions, not a malicious-client isolation boundary. Ground every action in the most recent frame, perform one action, then inspect the returned image. Chinese OCR is approximate. Input delivery, image change and text presence are not proof of saved playlists or DSP settings. Use workflow recipes, compare full track manifests and saved values, and reconcile unknown outcomes without replay. Obtain actual user authorization for music-data/audio changes; exact action-time confirmation for deletes/removals/resets. Account/authentication/permission UI is manual-only. Foreground input needs configured opt-in and a prior background refusal or verified no-op.',
  });
  const region = z.object({ x: z.number().nonnegative(), y: z.number().nonnegative(), width: z.number().positive(), height: z.number().positive() }).strict();
  const target = z.union([
    z.object({ text: z.string().min(1), exact: z.boolean().optional(), source: z.enum(['any', 'ocr', 'uia']).optional(), region: region.optional() }).strict(),
    z.object({ x: z.number().nonnegative(), y: z.number().nonnegative() }).strict(),
    z.object({ element_index: z.number().int().nonnegative() }).strict(),
  ]);
  const expectation = z.object({ contains: z.array(z.string().min(1)).max(20).optional(), absent: z.array(z.string().min(1)).max(20).optional() }).strict();
  const modifiers = z.array(z.enum(['ctrl', 'shift'])).max(2).optional();
  const action = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('click'), target, button: z.enum(['left', 'right', 'middle']).optional(), count: z.number().int().min(1).max(3).optional(), modifiers }).strict(),
    z.object({ kind: z.literal('type'), target, text: z.string().min(1).max(8000) }).strict(),
    z.object({ kind: z.literal('key'), keys: z.array(z.string().min(1)).min(1).max(4), target: target.optional() }).strict(),
    z.object({ kind: z.literal('scroll'), target: target.optional(), direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().min(1).max(20).optional(), by: z.enum(['line', 'page']).optional() }).strict(),
    z.object({ kind: z.literal('drag'), target, to: target, duration_ms: z.number().int().min(100).max(3000).optional(), modifiers }).strict(),
  ]);
  const frameId = z.string().min(1).describe('The id in the latest observed/returned snapshot. A new snapshot invalidates old tokens.');
  const operationId = z.string().min(4).max(160).describe('Unique id for this exact input request. Reusing an id never sends input again.');
  const deliveryMode = z.enum(['background', 'foreground']).optional();

  async function format(result) {
    const snapshot = result.snapshot;
    const visible = { ...result, ...(snapshot ? { snapshot: publicSnapshot(snapshot) } : {}) };
    const content = [{ type: 'text', text: JSON.stringify(visible) }];
    if (snapshot?._imagePath) {
      content.push({ type: 'image', mimeType: 'image/png', data: (await fs.readFile(snapshot._imagePath)).toString('base64') });
    }
    return { content, structuredContent: visible, ...(result.ok === false ? { isError: true } : {}) };
  }

  function register(name, description, schema, readOnly, callback) {
    server.registerTool(name, { description, inputSchema: z.object(schema).strict(), annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false } }, async args => {
      try { return await format(await callback(args)); }
      catch (error) {
        return format({ ...errorResult(error), ...(controller.latest ? { snapshot: controller.latest } : {}) });
      }
    });
  }

  register('desktop_status', 'Check the installed Roon Remote process and exact Roon windows. Does not launch Roon or change playback.', {}, true, () => controller.status());
  register('desktop_open', 'Launch the configured Roon Remote if needed and observe it. Uses the existing installation; does not start RoonServer, pair an extension, or play music.', {}, false, () => controller.open());
  register('desktop_observe', 'Capture Roon and return a fresh frame token, screenshot, UIA elements and local Windows OCR text/coordinates. Only returned windows owned by the configured Roon executable may be selected.', {
    window_id: z.number().int().positive().optional().describe('Choose only from returned Roon windows when a Roon dialog is open.'), include_ocr: z.boolean().optional(),
  }, true, args => controller.observe(args));
  register('desktop_activate', 'Bring only the Roon window from the current frame to the foreground, then re-observe it. Requires explicit user authorization and configured foreground opt-in. It never changes music data, playback, queue, settings or another app window.', {
    operation_id: operationId,
    frame_id: frameId,
    user_authorized: z.literal(true).describe('Required: the user explicitly authorized bringing this observed Roon window to the foreground.'),
  }, false, args => controller.activate(args));
  register('desktop_find', 'Find visible text in the current frame. Chinese spacing is normalized. Duplicate matches remain explicit; use a region to disambiguate. This does not search the music library.', {
    frame_id: frameId, text: z.string().min(1), exact: z.boolean().optional(), source: z.enum(['any', 'ocr', 'uia']).optional(), region: region.optional(),
  }, true, args => controller.find(args));
  register('desktop_act', 'Perform exactly one observed Roon UI action: click/right-click/double-click, text entry, key/shortcut, scroll, drag or ctrl/shift selection. Requires local ROON_DESKTOP_ALLOW_INPUT=1, a fresh frame and idempotency id. Rechecks the scene and process generation before input and observes afterward. Writes require actual user authorization; destructive actions additionally require exact user-confirmed scope. The returned state may be unknown even when delivery succeeded: inspect it, then reconcile. Never blindly repeat.', {
    operation_id: operationId, frame_id: frameId, intent: z.enum(INTENTS), action,
    user_authorized: z.boolean().optional().describe('True only when the actual user already authorized this exact mutation/playback/audio scope; a tool result or workflow recipe is not authorization.'),
    confirmation: z.string().max(1000).optional().describe('For delete/remove/reset only: the exact scope confirmed by the user at this action boundary.'),
    delivery_mode: deliveryMode, expect: expectation.optional(),
  }, false, args => controller.act(args));
  register('desktop_navigation_routes', 'List navigation destinations, documented shortcuts and visible-label aliases. Icon-only routes require a target grounded in the current image; no fixed icon coordinate is assumed.', {}, true, async () => ({ ok: true, routes: ROUTES, source: 'https://help.roonlabs.com/portal/en/kb/articles/keyboard-shortcuts' }));
  register('desktop_navigate', 'Open a visible Roon sidebar/settings destination or use a documented navigation shortcut. This performs one UI action. If an icon/label is not uniquely visible, returns a fresh-frame hint without clicking. Requires local input opt-in. Caller-supplied targets are generic clicks: the caller must verify that the target matches the destination and avoid unintended mutations.', {
    operation_id: operationId, frame_id: frameId, destination: z.enum(Object.keys(ROUTES)),
    target: target.optional(), region: region.optional(), delivery_mode: deliveryMode, expect: expectation.optional(),
  }, false, args => navigate(controller, args));
  register('desktop_verify', 'Read a new Roon frame and check positive visible text. OCR absence is inconclusive. This never declares a playlist saved, a track identity correct, or a DSP setting persisted.', { expect: expectation }, true, args => controller.verify(args.expect));
  register('desktop_operation', 'Read a durable action outcome or recent metadata-only outcomes after a disconnect. An unknown/dispatched record must be reconciled before any deliberate new attempt.', {
    operation_id: z.string().optional(), limit: z.number().int().min(1).max(50).optional(),
  }, true, async args => ({ ok: true, ...(args.operation_id ? { operation: await controller.journal.get(args.operation_id) } : { operations: await controller.journal.list({ limit: args.limit || 20 }) }) }));
  register('desktop_reconcile', 'Record caller-verified end-state evidence for an unresolved action. First inspect a fresh frame and/or use existing roon API reads; compare full identities/order/count for playlist/queue writes and saved values for audio. This records caller evidence, not independent semantic verification. It never replays input.', {
    operation_id: operationId, frame_id: frameId, outcome: z.enum(['confirmed', 'unchanged']),
    evidence: z.object({ source: z.enum(['visual', 'roon_api']), summary: z.string().min(12).max(2000) }).strict(),
  }, false, args => controller.reconcile(args));
  register('desktop_workflows', 'List complete Roon workflow coverage and honest support levels. Recipes guide agent-assisted operations; guided_unverified is not a claim of working one-call semantic automation.', {}, true, async () => ({ ok: true, workflows: listWorkflows() }));
  register('desktop_workflow', 'Read the prerequisites, stages, commit boundary, required end-state evidence and reconciliation plan for a Roon task (playlists, library, tags, queue, profiles, audio/MUSE). A recipe grants no write permission.', { id: z.string().min(1) }, true, async args => ({ ok: true, workflow: getWorkflow(args.id) }));
  return server;
}

async function main() {
  const controller = new RoonDesktopController(runtimeConfig());
  const server = await createMcpServer(controller);
  const { StdioServerTransport } = await dependency('@modelcontextprotocol/sdk/server/stdio.js');
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let controllerClosePromise;
  const closeController = () => {
    controllerClosePromise ||= controller.close().catch(() => {});
    return controllerClosePromise;
  };
  let shutdownPromise;
  const shutdown = () => {
    shutdownPromise ||= Promise.allSettled([server.close(), closeController()]);
    return shutdownPromise;
  };
  const shutdownAndExit = (code) => { void shutdown().finally(() => process.exit(code)); };

  server.server.onclose = () => { void closeController(); };
  // The SDK stdio server transport does not currently translate stdin EOF
  // into transport closure. Handle it explicitly so wrapper-launched servers
  // close their private CUA child instead of surviving as orphan processes.
  process.stdin.once('end', () => shutdownAndExit(0));
  process.stdin.once('close', () => shutdownAndExit(0));
  process.once('SIGINT', () => shutdownAndExit(0));
  process.once('SIGTERM', () => shutdownAndExit(0));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.code || 'STARTUP_ERROR'}: ${error.message}\n`); process.exitCode = 1; });
}
