import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopError } from './errors.mjs';

export async function withDesktopLock(dataDir, callback) {
  await fs.mkdir(dataDir, { recursive: true });
  const lockDir = path.join(dataDir, 'desktop.lock');
  const ownerFile = path.join(lockDir, 'owner.json');
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(ownerFile, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try {
        if ((await fs.lstat(lockDir)).isSymbolicLink()) throw new Error('unexpected link');
        owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
      } catch { throw new DesktopError('DESKTOP_BUSY', 'Another controller is acquiring the Roon desktop lock. Try again after it finishes.'); }
      let alive = true;
      try { process.kill(owner.pid, 0); }
      catch (probeError) { if (probeError.code === 'ESRCH') alive = false; }
      if (alive || attempt > 0) throw new DesktopError('DESKTOP_BUSY', 'Another Roon desktop operation is active. No input was sent.');
      // Only our own tiny lock directory, and only a confirmed dead owner.
      await fs.unlink(ownerFile);
      await fs.rmdir(lockDir);
    }
  }
  try { return await callback(); }
  finally {
    let owner;
    try { owner = JSON.parse(await fs.readFile(ownerFile, 'utf8')); } catch { /* preserve uncertain state */ }
    if (owner?.token === token) {
      await fs.unlink(ownerFile);
      await fs.rmdir(lockDir);
    }
  }
}
