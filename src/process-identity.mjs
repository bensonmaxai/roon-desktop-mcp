import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DesktopError, invariant } from './errors.mjs';

const run = promisify(execFile);
export async function processIdentity(pid, runner = run) {
  invariant(Number.isInteger(pid) && pid > 0, 'INVALID_PID', 'The process id must come from the Roon app resolver.');
  try {
    const { stdout } = await runner(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', fileURLToPath(new URL('../scripts/process-identity.ps1', import.meta.url)), '-TargetProcessId', String(pid),
    ], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 5000, maxBuffer: 32_000 });
    const identity = JSON.parse(stdout.replace(/^\uFEFF/u, ''));
    invariant(identity.pid === pid && identity.path && identity.started_at, 'PROCESS_IDENTITY', 'Incomplete process identity.');
    return identity;
  } catch (error) {
    if (error instanceof DesktopError) throw error;
    throw new DesktopError('PROCESS_IDENTITY', 'Could not verify the selected Roon executable and process start time.');
  }
}
