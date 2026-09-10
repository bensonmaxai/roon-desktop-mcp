import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let checked = 0;
for (const directory of ['src', 'scripts', 'tests']) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.mjs')) {
      execFileSync(process.execPath, ['--check', path.join(root, directory, entry.name)], { stdio: 'pipe', windowsHide: true });
      checked++;
    }
  }
}
console.log(`Syntax checked ${checked} JavaScript modules.`);
