import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { DesktopError, invariant } from './errors.mjs';

const execFileAsync = promisify(execFile);
export const DRIVER_METHODS = new Set([
  'list_apps', 'list_windows', 'launch_app', 'get_window_state',
  'bring_to_front', 'click', 'type_text', 'set_value', 'press_key', 'hotkey', 'scroll', 'drag',
]);
const READ_METHODS = new Set(['list_apps', 'list_windows', 'get_window_state']);

export class CuaDriver {
  constructor({ executable, timeoutMs = 25_000, runner = execFileAsync }) {
    invariant(typeof executable === 'string' && path.isAbsolute(executable),
      'DRIVER_CONFIG', 'ROON_DESKTOP_DRIVER must be the absolute path to the installed cua-driver executable.');
    this.executable = executable;
    this.timeoutMs = timeoutMs;
    this.runner = runner;
  }

  async call(method, args = {}) {
    invariant(DRIVER_METHODS.has(method), 'DRIVER_METHOD_DENIED', 'This adapter does not expose that driver method.');
    let stdout, stderr;
    try {
      ({ stdout, stderr } = await this.runner(this.executable, ['call', method, JSON.stringify(args)], {
        encoding: 'utf8', windowsHide: true, shell: false,
        timeout: this.timeoutMs, maxBuffer: 16 * 1024 * 1024,
      }));
    } catch (error) {
      // A timed-out input might already have reached Roon. Never replay it.
      throw new DesktopError(READ_METHODS.has(method) ? 'DRIVER_UNAVAILABLE' : 'ACTION_OUTCOME_UNKNOWN',
        `Driver ${method} did not return a usable result; observe again before deciding what to do.`,
        { method, timed_out: !!error.killed, dispatched: !READ_METHODS.has(method) });
    }
    invariant(!/daemon proxy.*failed|running ['"].*['"] in-process/i.test(stderr || ''),
      READ_METHODS.has(method) ? 'DRIVER_DAEMON_UNREACHABLE' : 'ACTION_OUTCOME_UNKNOWN',
      'The shared Windows driver is unreachable. Its in-process fallback is unsafe for snapshot-bound input.',
      { method, dispatched: !READ_METHODS.has(method), recovery: 'Run this MCP with access to the existing interactive desktop driver; do not repeatedly retry input.' });
    let result;
    try { result = JSON.parse(stdout); }
    catch {
      throw new DesktopError(READ_METHODS.has(method) ? 'DRIVER_PROTOCOL' : 'ACTION_OUTCOME_UNKNOWN',
        'The Windows driver returned invalid JSON.', { method, dispatched: !READ_METHODS.has(method) });
    }
    if (result?.isError || result?.error || result?.status === 'refused' || result?.refusal) {
      const printable = JSON.stringify(result);
      const backgroundUnavailable = /background_unavailable/i.test(printable);
      const sessionEnded = result?.refusal?.code === 'session_ended';
      throw new DesktopError(sessionEnded ? 'DRIVER_SESSION_ENDED' : backgroundUnavailable ? 'BACKGROUND_UNAVAILABLE' : 'DRIVER_REJECTED',
        sessionEnded ? 'The Windows driver session ended. Establish an isolated new controller session; do not treat this as an absent Roon app.' :
        backgroundUnavailable
          ? 'Roon refused background delivery. A fresh observation and explicit foreground retry are required.'
          : `The Windows driver rejected ${method}.`,
        { method, dispatched: !READ_METHODS.has(method) && !backgroundUnavailable && !sessionEnded,
          driver_error: redactDriverError(result) });
    }
    return result;
  }
}

function redactDriverError(result) {
  // Do not mirror arbitrary helper stdout, paths, account text or image payloads.
  const error = result?.error;
  if (typeof error === 'object' && error !== null) return { code: error.code || 'driver_error' };
  return { code: /background_unavailable/i.test(JSON.stringify(result)) ? 'background_unavailable' : 'driver_error' };
}
