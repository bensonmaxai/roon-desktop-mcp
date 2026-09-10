import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { invariant } from './errors.mjs';

export async function dependency(specifier) {
  const root = process.env.ROON_DESKTOP_DEPENDENCIES;
  if (!root) return import(specifier);
  invariant(path.isAbsolute(root), 'DEPENDENCY_CONFIG', 'ROON_DESKTOP_DEPENDENCIES must be an absolute directory.');
  const require = createRequire(path.join(root, 'package.json'));
  return import(pathToFileURL(require.resolve(specifier)).href);
}

export function runtimeConfig(env = process.env) {
  const dataDir = path.resolve(env.ROON_DESKTOP_DATA_DIR || path.join(env.LOCALAPPDATA || os.tmpdir(), 'Codex', 'RoonDesktopMCP'));
  invariant(!/(^|[\\/])OneDrive(?:[^\\/]*)?([\\/]|$)/i.test(dataDir), 'ONEDRIVE_RUNTIME',
    'Keep screenshots, journals and runtime state outside OneDrive. Set ROON_DESKTOP_DATA_DIR to a local directory.');
  const roonPath = env.ROON_DESKTOP_APP || path.join(env.LOCALAPPDATA || '', 'Roon', 'Application', 'Roon.exe');
  invariant(path.isAbsolute(roonPath) && path.basename(roonPath).toLowerCase() === 'roon.exe',
    'APP_CONFIG', 'ROON_DESKTOP_APP must identify the installed Roon.exe, not RoonServer or another app.');
  const maxOperations = env.ROON_DESKTOP_MAX_OPERATIONS === undefined ? 10_000 : Number(env.ROON_DESKTOP_MAX_OPERATIONS);
  invariant(Number.isInteger(maxOperations) && maxOperations >= 1 && maxOperations <= 100_000,
    'JOURNAL_CONFIG', 'ROON_DESKTOP_MAX_OPERATIONS must be an integer from 1 to 100000.');
  return {
    driverPath: env.ROON_DESKTOP_DRIVER,
    roonPath, dataDir,
    snapshotTtlMs: 120_000,
    allowInput: env.ROON_DESKTOP_ALLOW_INPUT === '1',
    allowForeground: env.ROON_DESKTOP_ALLOW_FOREGROUND === '1',
    maxOperations,
  };
}
