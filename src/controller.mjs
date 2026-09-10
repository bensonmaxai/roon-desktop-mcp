import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopError, invariant } from './errors.mjs';
import { CuaMcpDriver } from './mcp-driver.mjs';
import { recognizeImage } from './ocr.mjs';
import { processIdentity } from './process-identity.mjs';
import { compareScene, decodeImage, imageDigest } from './image-state.mjs';
import { findText, normalizeText, resolveText, verifyText } from './matching.mjs';
import { validateIntent, validatePoint, validateKeys, validateText, validateModifiers } from './policy.mjs';
import { withDesktopLock } from './lock.mjs';
import { OperationJournal } from './journal.mjs';

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const unwrap = result => result?.structuredContent || result;
const DEFAULT_FOREGROUND_PERMIT_TTL_MS = 30_000;
const MAX_FOREGROUND_PERMIT_TTL_MS = 120_000;
const MAX_SAFE_WINDOW_HANDLE = BigInt(Number.MAX_SAFE_INTEGER);

function normalizeWindowHandle(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0) ? value : null;
  }
  if (typeof value !== 'string') return null;
  const digits = /^\d+$/u.test(value)
    ? value
    : /^0x[0-9a-f]+$/iu.test(value) ? `0x${value.slice(2)}` : null;
  if (!digits) return null;
  const normalized = BigInt(digits);
  return normalized <= MAX_SAFE_WINDOW_HANDLE ? Number(normalized) : null;
}

const isWindowHandle = value => normalizeWindowHandle(value) !== null;
const sameWindowHandle = (left, right) => {
  const normalizedLeft = normalizeWindowHandle(left);
  const normalizedRight = normalizeWindowHandle(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
};

function semanticTarget(target, label = '') {
  if (!target) return null;
  return {
    source: target.source || 'pixels',
    ...(typeof target.text === 'string' && normalizeText(target.text) ? { text: normalizeText(target.text) } : {}),
    ...(normalizeText(label) ? { label: normalizeText(label) } : {}),
    ...(Number.isFinite(target.x) ? { x: target.x } : {}),
    ...(Number.isFinite(target.y) ? { y: target.y } : {}),
  };
}

function foregroundActionDigest({ intent, action, primary, end, targetLabel, keys }) {
  const semanticAction = {
    kind: action.kind,
    target: semanticTarget(primary, targetLabel),
  };
  switch (action.kind) {
    case 'click':
      Object.assign(semanticAction, { button: action.button || 'left', count: action.count || 1, modifiers: action.modifiers || [] });
      break;
    case 'type':
      Object.assign(semanticAction, { text: action.text });
      break;
    case 'key':
      Object.assign(semanticAction, { keys });
      break;
    case 'scroll':
      Object.assign(semanticAction, { direction: action.direction, amount: action.amount ?? 3, by: action.by || 'line' });
      break;
    case 'drag':
      Object.assign(semanticAction, { to: semanticTarget(end), duration_ms: action.duration_ms ?? 700, modifiers: action.modifiers || [] });
      break;
  }
  return createHash('sha256').update(JSON.stringify({ intent, action: semanticAction })).digest('hex');
}

function backgroundFallbackDigest(operation) {
  const evidence = [operation?.evidence, ...(operation?.history || []).map(entry => entry?.evidence)].filter(Boolean).reverse();
  for (const entry of evidence) {
    const delivery = entry.delivery_mode || entry.deliveryMode;
    const digest = entry.foreground_action_digest || entry.foregroundActionDigest;
    if (delivery === 'background' && typeof digest === 'string' && /^[a-f0-9]{64}$/u.test(digest)) return digest;
  }
  return null;
}

export class RoonDesktopController {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.driver = dependencies.driver || new CuaMcpDriver({ executable: config.driverPath,
      onDisconnect: () => { this.latest = null; this.binding = null; this.foregroundPermit = null; } });
    this.ocr = dependencies.ocr || recognizeImage;
    this.identifyProcess = dependencies.identifyProcess || processIdentity;
    this.decodeImage = dependencies.decodeImage || decodeImage;
    this.journal = dependencies.journal || new OperationJournal({ dataDir: config.dataDir, maxOperations: config.maxOperations });
    this.clock = dependencies.clock || Date.now;
    this.lock = dependencies.lock || (callback => withDesktopLock(config.dataDir, callback));
    this.latest = null;
    this.binding = null;
    this.serial = Promise.resolve();
    this.foregroundPermit = null;
  }

  runExclusive(callback) {
    const result = this.serial.then(() => this.lock(callback));
    this.serial = result.catch(() => {});
    return result;
  }

  foregroundPermitTtlMs() {
    const ttl = this.config.foregroundPermitTtlMs;
    if (!Number.isInteger(ttl) || ttl <= 0) return DEFAULT_FOREGROUND_PERMIT_TTL_MS;
    return Math.min(ttl, MAX_FOREGROUND_PERMIT_TTL_MS);
  }

  issueForegroundPermit(actionDigest, frame) {
    this.foregroundPermit = {
      action_digest: actionDigest,
      pid: frame.pid,
      window_id: frame.window_id,
      process_started_at: frame.process_started_at,
      expires_at: this.clock() + this.foregroundPermitTtlMs(),
    };
  }

  foregroundPermitFor(frame) {
    const permit = this.foregroundPermit;
    if (!permit) return null;
    if (this.clock() >= permit.expires_at || permit.pid !== frame.pid || permit.window_id !== frame.window_id ||
      permit.process_started_at !== frame.process_started_at) {
      this.foregroundPermit = null;
      return null;
    }
    return permit;
  }

  matchingForegroundPermit(actionDigest, frame) {
    const permit = this.foregroundPermitFor(frame);
    return permit?.action_digest === actionDigest;
  }

  async apps() {
    const result = unwrap(await this.driver.call('list_apps', {}));
    return (result.apps || []).filter(app => app.bundle_id && samePath(app.bundle_id, this.config.roonPath));
  }

  async status() {
    const apps = await this.apps();
    return {
      ok: true, version: '0.1.0', app: 'Roon Remote',
      running: apps.some(app => app.running && app.pid > 0),
      instances: apps.filter(app => app.running).map(app => ({ pid: app.pid, windows: app.windows || [] })),
      foreground_enabled: this.config.allowForeground,
      input_enabled: this.config.allowInput === true,
      journal_max_operations: this.config.maxOperations ?? 10_000,
      driver_session: 'private_stdio_proxy',
      binding: this.binding ? { pid: this.binding.pid, window_id: this.binding.window_id } : null,
      scope: 'Roon-only agent-assisted desktop control; existing roon MCP remains the API/Core engine.',
      semantic_workflows: 'Guided until a specific workflow has live end-state verification.',
    };
  }

  async resolveTarget({ windowId } = {}) {
    const running = (await this.apps()).filter(app => app.running && app.pid > 0);
    invariant(running.length > 0, 'ROON_NOT_RUNNING', 'Roon Remote is not running. Use desktop_open.');
    invariant(running.length === 1, 'AMBIGUOUS_ROON_INSTANCE', 'More than one Roon Remote process is running; resolve the duplicate instances manually.');
    const app = running[0];
    const identity = await this.identifyProcess(app.pid);
    invariant(samePath(identity.path, this.config.roonPath), 'APP_IDENTITY_CHANGED', 'The process no longer matches the configured Roon executable.');
    const result = unwrap(await this.driver.call('list_windows', { pid: app.pid }));
    const windows = (result.windows || []).filter(window => window.pid === app.pid);
    let candidateId = windowId ?? this.binding?.window_id;
    if (this.binding && (this.binding.pid !== app.pid || this.binding.started_at !== identity.started_at)) {
      this.latest = null;
      this.binding = null;
      this.foregroundPermit = null;
      candidateId = windowId;
    }
    let candidates = candidateId === undefined ? windows.filter(window => window.title === 'Roon') : windows.filter(window => window.window_id === candidateId);
    if (candidateId === undefined && candidates.length === 0 && windows.length === 1) candidates = windows;
    invariant(candidates.length === 1, 'WINDOW_SELECTION_REQUIRED', 'Choose one returned Roon window using desktop_observe; no other app can be targeted.', { windows: windows.map(w => ({ window_id: w.window_id, title: w.title, minimized: w.minimized })) });
    const selected = candidates[0];
    invariant(!selected.minimized && selected.is_on_screen !== false, 'ROON_WINDOW_HIDDEN', 'Restore the Roon window to capture and control its canvas.');
    if (this.foregroundPermit && (this.foregroundPermit.pid !== app.pid || this.foregroundPermit.window_id !== selected.window_id ||
      this.foregroundPermit.process_started_at !== identity.started_at)) this.foregroundPermit = null;
    this.binding = { pid: app.pid, window_id: selected.window_id, started_at: identity.started_at, path: identity.path };
    return { ...selected, started_at: identity.started_at };
  }

  async open() {
    return this.runExclusive(async () => {
      const running = (await this.apps()).filter(app => app.running && app.pid > 0);
      if (!running.length) {
        // Executable and arguments are never supplied by an MCP tool caller.
        await this.driver.call('launch_app', { path: this.config.roonPath });
        for (let attempt = 0; attempt < 6; attempt++) {
          await delay(500);
          if ((await this.apps()).some(app => app.running && app.pid > 0)) break;
        }
      }
      return { ok: true, snapshot: await this.capture() };
    });
  }

  async capture({ windowId, includeOcr = true } = {}) {
    const target = await this.resolveTarget({ windowId });
    const captureDir = path.join(this.config.dataDir, 'captures');
    await fs.mkdir(captureDir, { recursive: true });
    const id = `frame_${randomUUID()}`;
    const imagePath = path.join(captureDir, `${id}.png`);
    const result = unwrap(await this.driver.call('get_window_state', {
      pid: target.pid, window_id: target.window_id, screenshot_out_file: imagePath,
      max_elements: 1500, max_depth: 20,
    }));
    invariant(result.pid === target.pid && result.window_id === target.window_id,
      'CAPTURE_IDENTITY', 'The driver returned a capture for a different window.');
    const buffer = await fs.readFile(imagePath);
    const pixels = await this.decodeImage(buffer);
    let ocr = { available: false, error: 'not_requested', text: '', lines: [] };
    if (includeOcr) {
      try { ocr = await this.ocr(imagePath); }
      catch { ocr = { available: false, error: 'ocr_failed', text: '', lines: [] }; }
    }
    const bounds = target.bounds || { x: target.x, y: target.y, width: target.width, height: target.height };
    const elements = (result.elements || []).map(element => ({
      ...element,
      ...(element.frame ? { local_bounds: {
        x: element.frame.x - bounds.x, y: element.frame.y - bounds.y,
        width: element.frame.w, height: element.frame.h,
      } } : {}),
    }));
    this.latest = {
      id, observed_at: new Date(this.clock()).toISOString(), _observedMs: this.clock(),
      pid: target.pid, window_id: target.window_id, process_started_at: target.started_at,
      window_title: target.title, width: pixels.width, height: pixels.height, window_bounds: bounds,
      elements, elements_complete: result.elements_complete === true, ocr,
      accessibility_coverage: elements.every(e => !e.local_bounds || e.local_bounds.y < 35) ? 'window_chrome_only' : 'partial_or_full',
      driver_snapshot_id: result.snapshot_id,
      image_sha256: imageDigest(buffer), _imagePath: imagePath, _pixels: pixels,
    };
    // Keep bounded recent evidence; never touch files not generated by this MCP.
    const owned = (await fs.readdir(captureDir, { withFileTypes: true })).filter(entry => entry.isFile() && /^frame_[0-9a-f-]{36}\.png$/i.test(entry.name));
    if (owned.length > 80) {
      const aged = await Promise.all(owned.map(async entry => ({ path: path.join(captureDir, entry.name), mtime: (await fs.stat(path.join(captureDir, entry.name))).mtimeMs })));
      for (const entry of aged.sort((a, b) => a.mtime - b.mtime).slice(0, owned.length - 80)) {
        if (entry.path !== imagePath) await fs.unlink(entry.path);
      }
    }
    return this.latest;
  }

  async observe({ window_id, include_ocr = true } = {}) {
    return this.runExclusive(async () => ({ ok: true, snapshot: await this.capture({ windowId: window_id, includeOcr: include_ocr }) }));
  }

  requireFrame(id) {
    invariant(this.latest && this.latest.id === id, 'STALE_FRAME', 'Use the latest desktop_observe/action result. Frame tokens are single-observation bindings.');
    invariant(this.clock() - this.latest._observedMs <= this.config.snapshotTtlMs, 'EXPIRED_FRAME', 'This frame is too old. Observe again before sending input.');
    return this.latest;
  }

  target(frame, target) {
    invariant(target && typeof target === 'object', 'TARGET_REQUIRED', 'Provide one target from the observed screenshot or visible text.');
    let resolved;
    if (typeof target.text === 'string') resolved = resolveText(frame, target);
    else if (Number.isInteger(target.element_index)) {
      const element = frame.elements.find(e => e.element_index === target.element_index);
      invariant(element?.local_bounds, 'ELEMENT_NOT_FOUND', 'The element index is not in this frame.');
      resolved = { source: 'uia', text: element.label, element_index: element.element_index,
        x: element.local_bounds.x + element.local_bounds.width / 2, y: element.local_bounds.y + element.local_bounds.height / 2 };
    } else resolved = { ...validatePoint(target, frame), source: 'pixels' };
    validatePoint(resolved, frame);
    return resolved;
  }

  find({ frame_id, ...query }) {
    const frame = this.requireFrame(frame_id);
    return { ok: true, frame_id, matches: findText(frame, query), ocr_available: frame.ocr?.available === true };
  }

  async activate(request) {
    return this.runExclusive(async () => {
      invariant(this.config.allowForeground === true, 'FOREGROUND_DISABLED',
        'Foreground activation must be explicitly enabled in this MCP configuration.');
      invariant(typeof request.operation_id === 'string' && request.operation_id.length >= 4 && request.operation_id.length <= 160,
        'OPERATION_ID_REQUIRED', 'Supply a unique operation_id; reuse it only to retrieve the outcome of this exact activation.');
      const reservation = await this.journal.begin({
        operationId: request.operation_id,
        request: {
          action: { kind: 'bring_to_front' },
          frame_id: request.frame_id,
          user_authorized: request.user_authorized,
        },
        baseline: {
          frame_id: request.frame_id,
          pid: this.latest?.pid,
          window_id: this.latest?.window_id,
          process_started_at: this.latest?.process_started_at,
        },
      });
      if (reservation.replay) return {
        ok: true,
        replayed: true,
        operation: reservation.record || reservation,
        note: 'No foreground activation was repeated. Observe the current Roon window instead.',
      };

      let dispatched = false;
      let before;
      let target;
      try {
        before = this.requireFrame(request.frame_id);
        invariant(request.user_authorized === true, 'AUTHORIZATION_REQUIRED',
          'Bringing Roon to the foreground requires the user\'s explicit authorization.');
        invariant(this.config.allowForeground, 'FOREGROUND_DISABLED',
          'Foreground activation must be explicitly enabled in this MCP configuration.');
        // Do not consume or grant a permit: preserve an existing same-window
        // action permit only while its TTL and process generation remain valid.
        this.foregroundPermitFor(before);

        // A focus recovery is still an action: refresh the exact window after
        // checking the caller's frame and immediately before dispatching it.
        // Canvas drift is harmless here, but a new PID/generation/HWND is not.
        const current = await this.capture({ windowId: before.window_id, includeOcr: false });
        invariant(current.pid === before.pid && current.window_id === before.window_id && current.process_started_at === before.process_started_at,
          'WINDOW_GENERATION_CHANGED', 'Roon restarted or the observed window changed; no activation was sent.');
        this.foregroundPermitFor(current);
        target = {
          pid: current.pid,
          window_id: current.window_id,
          started_at: current.process_started_at,
        };

        await this.journal.transition(request.operation_id, 'dispatched', {
          method: 'bring_to_front',
          delivery_mode: 'foreground',
        });
        dispatched = true;
        const result = unwrap(await this.driver.call('bring_to_front', {
          pid: target.pid,
          window_id: target.window_id,
        }));
        const after = await this.capture({ windowId: target.window_id });
        invariant(after.pid === before.pid && after.window_id === before.window_id && after.process_started_at === before.process_started_at,
          'WINDOW_GENERATION_CHANGED', 'Roon restarted or the observed window changed after activation.');

        const focused = sameWindowHandle(result?.now_fg_hwnd, target.window_id);
        const state = focused ? 'confirmed' : 'unknown';
        await this.journal.transition(request.operation_id, state, {
          method: 'bring_to_front',
          delivery_mode: 'foreground',
          frame_id: after.id,
          image_sha256: after.image_sha256,
          focused,
          verification_scope: focused ? 'foreground_window' : 'needs_review',
        });
        const activation = {
          focused,
          ...(isWindowHandle(result?.previous_fg_hwnd) ? { previous_fg_hwnd: result.previous_fg_hwnd } : {}),
          ...(isWindowHandle(result?.now_fg_hwnd) ? { now_fg_hwnd: result.now_fg_hwnd } : {}),
        };
        return {
          ok: true,
          operation_id: request.operation_id,
          state,
          activation,
          snapshot: after,
          note: focused
            ? 'The configured Roon window is now foreground. No music data or playback state was changed.'
            : 'Activation was requested, but the driver did not confirm the observed Roon window as foreground. Inspect the returned frame.',
        };
      } catch (error) {
        if (dispatched) {
          try { await this.capture({ windowId: target?.window_id ?? before?.window_id }); }
          catch { this.latest = null; }
          const state = error.details?.dispatched === false ? 'refused' : 'unknown';
          await this.journal.transition(request.operation_id, state, {
            error_code: error.code || 'UNKNOWN',
            method: 'bring_to_front',
            delivery_mode: 'foreground',
            ...(this.latest?.id ? { frame_id: this.latest.id } : {}),
          });
        } else {
          await this.journal.transition(request.operation_id, 'refused', {
            error_code: error.code || 'INVALID_REQUEST',
            method: 'bring_to_front',
            delivery_mode: 'foreground',
          });
        }
        if (error instanceof DesktopError) {
          const actualDispatched = error.details?.dispatched === false ? false : dispatched;
          error.details = {
            ...error.details,
            operation_id: request.operation_id,
            journal_dispatched: dispatched,
            dispatched: actualDispatched,
          };
          throw error;
        }
        throw new DesktopError(dispatched ? 'ACTION_OUTCOME_UNKNOWN' : 'ACTION_REFUSED',
          dispatched
            ? 'The activation outcome is unknown. Inspect a fresh Roon frame; do not replay it.'
            : error.message,
          { operation_id: request.operation_id, journal_dispatched: dispatched, dispatched });
      }
    });
  }

  async act(request) {
    return this.runExclusive(async () => {
      invariant(this.config.allowInput === true, 'READ_ONLY_MODE',
        'Desktop input is disabled. A trusted local operator must set ROON_DESKTOP_ALLOW_INPUT=1 before using action or navigation tools.');
      invariant(typeof request.operation_id === 'string' && request.operation_id.length >= 4 && request.operation_id.length <= 160,
        'OPERATION_ID_REQUIRED', 'Supply a unique operation_id; reuse it only to retrieve the outcome of the exact same request.');
      const reservation = await this.journal.begin({ operationId: request.operation_id, request,
        baseline: { frame_id: request.frame_id, pid: this.latest?.pid, window_id: this.latest?.window_id, process_started_at: this.latest?.process_started_at } });
      if (reservation.replay) return { ok: true, replayed: true, operation: reservation.record || reservation,
        note: 'No input was repeated. Reconcile a dispatched/unknown outcome from fresh state.' };
      let dispatched = false;
      let before;
      let delivery;
      let actionDigest;
      try {
        before = this.requireFrame(request.frame_id);
        const action = request.action;
        invariant(['click', 'type', 'key', 'scroll', 'drag'].includes(action?.kind), 'ACTION_KIND', 'Unsupported desktop action.');
        const primary = action.target ? this.target(before, action.target) : null;
        const end = action.kind === 'drag' ? this.target(before, action.to) : null;
        if (['click', 'type', 'drag'].includes(action.kind)) invariant(primary, 'TARGET_REQUIRED', 'This action requires an observed target.');
        const targetLabel = primary?.text || this.labelAt(before, primary);
        const policy = validateIntent(request, targetLabel);
        let keys;
        if (action.kind === 'key') keys = validateKeys(action.keys, request);
        if (action.kind === 'type') validateText(action.text);
        validateModifiers(action.modifiers);
        if (action.kind === 'scroll') {
          invariant(['up', 'down', 'left', 'right'].includes(action.direction), 'INVALID_SCROLL', 'Choose a scroll direction.');
          invariant(Number.isInteger(action.amount ?? 3) && (action.amount ?? 3) >= 1 && (action.amount ?? 3) <= 20,
            'INVALID_SCROLL', 'Scroll amount must be between 1 and 20 ticks.');
        }
        delivery = request.delivery_mode || 'background';
        actionDigest = foregroundActionDigest({ intent: request.intent, action, primary, end, targetLabel, keys });
        if (delivery === 'foreground') {
          invariant(this.config.allowForeground, 'FOREGROUND_DISABLED', 'Foreground input must be explicitly enabled in this MCP configuration.');
          invariant(this.matchingForegroundPermit(actionDigest, before),
            'FOREGROUND_NOT_JUSTIFIED', 'Try background first. Foreground is available only after a driver refusal or reconciled background no-op.');
        }
        // Refresh the exact target immediately before input. Never reuse the
        // driver's cached element index/token across this refresh.
        const fresh = await this.capture({ includeOcr: false });
        invariant(fresh.pid === before.pid && fresh.window_id === before.window_id && fresh.process_started_at === before.process_started_at,
          'WINDOW_GENERATION_CHANGED', 'Roon restarted or the window changed; no input was sent.');
        const drift = compareScene(before._pixels, fresh._pixels, [primary, end].filter(Boolean));
        invariant(drift.stable, 'VIEW_CHANGED', 'The Roon view changed since the supplied frame. Inspect the new frame before trying a new operation.', { drift });
        // cua-driver 0.8.3 routes a requested background drag through global input.
        // Refuse it locally so the no-focus contract remains true; a scoped,
        // explicitly enabled foreground retry can use this freshly verified frame.
        if (delivery === 'background' && action.kind === 'drag') {
          this.issueForegroundPermit(actionDigest, fresh);
          throw new DesktopError('BACKGROUND_UNAVAILABLE',
            'Background drag is unavailable. Inspect the fresh frame before an explicit foreground retry.', { dispatched: false });
        }
        let targetArgs = primary ? { x: primary.x, y: primary.y } : {};
        if (primary?.source === 'uia') {
          const original = before.elements.find(e => e.element_index === primary.element_index);
          const matches = fresh.elements.filter(e => e.label === original.label && e.role === original.role &&
            e.local_bounds && Math.abs(e.local_bounds.x - original.local_bounds.x) < 3 && Math.abs(e.local_bounds.y - original.local_bounds.y) < 3);
          invariant(matches.length === 1, 'ELEMENT_CHANGED', 'The accessibility target changed. No input was sent.');
          targetArgs = { element_index: matches[0].element_index, ...(matches[0].element_token ? { element_token: matches[0].element_token } : {}) };
        }
        const args = { pid: fresh.pid, window_id: fresh.window_id, delivery_mode: delivery };
        let method;
        switch (action.kind) {
          case 'click': method = 'click'; Object.assign(args, targetArgs, { button: action.button || 'left', count: action.count || 1, modifier: action.modifiers || [] }); break;
          case 'type': method = 'type_text'; Object.assign(args, targetArgs, { text: action.text, delay_ms: 5 }); break;
          case 'key':
            method = keys.length === 1 ? 'press_key' : 'hotkey';
            Object.assign(args, targetArgs, keys.length === 1 ? { key: keys[0] } : { keys }); break;
          case 'scroll': method = 'scroll'; Object.assign(args, primary ? { x: primary.x, y: primary.y } : {}, { direction: action.direction, amount: action.amount ?? 3, by: action.by || 'line' }); break;
          case 'drag': method = 'drag'; Object.assign(args, { from_x: primary.x, from_y: primary.y, to_x: end.x, to_y: end.y, duration_ms: action.duration_ms ?? 700, modifier: action.modifiers || [] }); break;
        }
        await this.journal.transition(request.operation_id, 'dispatched', {
          method, delivery_mode: delivery, foreground_action_digest: actionDigest,
        });
        dispatched = true;
        if (delivery === 'foreground') this.foregroundPermit = null;
        let deliveryResult;
        try { deliveryResult = unwrap(await this.driver.call(method, args)); }
        catch (error) {
          if (delivery === 'background' && error.code === 'BACKGROUND_UNAVAILABLE') this.issueForegroundPermit(actionDigest, fresh);
          throw error;
        }
        await delay(200);
        const after = await this.capture();
        const verification = verifyText(after, request.expect);
        const imageChanged = before.image_sha256 !== after.image_sha256;
        // A positive, newly observable navigation result can be confirmed as a
        // UI transition. Music-data and audio writes always require semantic
        // evidence/caller reconciliation, never just a changed screenshot.
        const navigationConfirmed = request.intent === 'navigate' && imageChanged && verification.status === 'matched' && verifyText(before, request.expect).status !== 'matched';
        const state = navigationConfirmed ? 'confirmed' : 'unknown';
        await this.journal.transition(request.operation_id, state, { frame_id: after.id, image_sha256: after.image_sha256,
          ui_text: verification.status, image_changed: imageChanged, verification_scope: navigationConfirmed ? 'navigation_text' : 'needs_review',
          delivery_mode: delivery, foreground_action_digest: actionDigest });
        return { ok: true, operation_id: request.operation_id, state, policy,
          delivery: { mode: delivery, route: deliveryResult.route, effect: deliveryResult.effect || 'unverifiable' },
          foreground_impact: delivery === 'foreground' ? 'Windows focus may briefly switch to Roon.' : 'Background delivery requested.',
          ui_image_changed: imageChanged, verification,
          note: navigationConfirmed ? 'The requested navigation label became visible.' : 'Input was sent once. Inspect/re-read the result; semantic completion has not been asserted.',
          snapshot: after };
      } catch (error) {
        if (dispatched) {
          try { await this.capture(); } catch { this.latest = null; }
          const state = error.details?.dispatched === false || error.code === 'BACKGROUND_UNAVAILABLE' ? 'refused' : 'unknown';
          await this.journal.transition(request.operation_id, state, {
            error_code: error.code || 'UNKNOWN', frame_id: this.latest?.id,
            ...(delivery ? { delivery_mode: delivery } : {}),
            ...(actionDigest ? { foreground_action_digest: actionDigest } : {}),
          });
        } else {
          await this.journal.transition(request.operation_id, 'refused', {
            error_code: error.code || 'INVALID_REQUEST',
            ...(delivery ? { delivery_mode: delivery } : {}),
            ...(actionDigest ? { foreground_action_digest: actionDigest } : {}),
          });
        }
        if (error instanceof DesktopError) {
          const actualDispatched = error.details?.dispatched === false ? false : dispatched;
          error.details = {
            ...error.details,
            operation_id: request.operation_id,
            journal_dispatched: dispatched,
            dispatched: actualDispatched,
          };
          throw error;
        }
        throw new DesktopError(dispatched ? 'ACTION_OUTCOME_UNKNOWN' : 'ACTION_REFUSED',
          dispatched ? 'The operation may have reached Roon; inspect fresh state and do not replay it.' : error.message,
          { operation_id: request.operation_id, dispatched });
      }
    });
  }

  labelAt(frame, point) {
    if (!point) return '';
    return (frame.ocr?.lines || []).filter(line => line.bounds && point.x >= line.bounds.x - 8 && point.y >= line.bounds.y - 5 &&
      point.x <= line.bounds.x + line.bounds.width + 8 && point.y <= line.bounds.y + line.bounds.height + 5).map(line => line.text).join(' ');
  }

  async verify(expectation) {
    return this.runExclusive(async () => {
      const snapshot = await this.capture();
      return { ok: true, verification: verifyText(snapshot, expectation), snapshot };
    });
  }

  async reconcile({ operation_id, frame_id, outcome, evidence }) {
    return this.runExclusive(async () => {
      const frame = this.requireFrame(frame_id);
      invariant(['confirmed', 'unchanged'].includes(outcome), 'INVALID_RECONCILIATION', 'Only reconcile a result you actually observed.');
      invariant(evidence && ['visual', 'roon_api'].includes(evidence.source) && typeof evidence.summary === 'string' && evidence.summary.length >= 12,
        'EVIDENCE_REQUIRED', 'Supply the observed end-state evidence. A delivery receipt is not completion evidence.');
      const operation = await this.journal.get(operation_id);
      invariant(operation && ['unknown', 'dispatched'].includes(operation.state), 'RECONCILIATION_STATE', 'Only unresolved dispatched operations can be reconciled.');
      if (operation.baseline?.pid !== undefined) invariant(operation.baseline.pid === frame.pid && operation.baseline.window_id === frame.window_id,
        'RECONCILIATION_WINDOW', 'The evidence must be from the operation\'s Roon window.');
      if (operation.baseline?.process_started_at !== undefined) invariant(operation.baseline.process_started_at === frame.process_started_at,
        'RECONCILIATION_GENERATION', 'Roon restarted after this operation; the current view cannot confirm the old process generation.');
      const actionDigest = backgroundFallbackDigest(operation);
      const result = await this.journal.transition(operation_id, outcome, { frame_id, image_sha256: frame.image_sha256,
        evidence_source: evidence.source, verification_scope: 'caller_reported_end_state' });
      if (outcome === 'unchanged' && actionDigest) this.issueForegroundPermit(actionDigest, frame);
      return { ok: true, operation: result, confirmed_by: 'caller_reported_evidence', note: 'The caller remains responsible for checking the full playlist/queue identity or saved audio values.' };
    });
  }

  async close() {
    await this.serial;
    try { await this.driver.close?.(); }
    finally { this.foregroundPermit = null; }
  }
}

export function publicSnapshot(snapshot) {
  if (!snapshot) return null;
  return Object.fromEntries(Object.entries(snapshot).filter(([key]) => !key.startsWith('_')));
}
