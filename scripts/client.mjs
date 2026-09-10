import readline from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency, runtimeConfig } from '../src/runtime.mjs';

const config = runtimeConfig();
const [{ Client }, { StdioClientTransport }] = await Promise.all([
  dependency('@modelcontextprotocol/sdk/client/index.js'), dependency('@modelcontextprotocol/sdk/client/stdio.js'),
]);
const client = new Client({ name: 'roon-desktop-local-client', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], env: process.env, stderr: 'pipe' });
transport.stderr?.on('data', chunk => process.stderr.write(chunk));
await client.connect(transport);
process.stdout.write('Ready. Send one JSON {name,arguments} per line; {"exit":true} closes this client.\n');
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line);
      if (request.exit) break;
      const result = await client.callTool({ name: request.name, arguments: request.arguments || {} }, undefined, { timeout: 90_000 });
      const output = result.structuredContent || { content: result.content.filter(c => c.type === 'text') };
      const frame = output.snapshot;
      const image = result.content.find(c => c.type === 'image');
      if (frame && image) {
        const imageDir = path.join(config.dataDir, 'client-captures');
        await fs.mkdir(imageDir, { recursive: true });
        if (!/^frame_[0-9a-f-]{36}$/i.test(frame.id)) throw new Error('Invalid returned frame id.');
        const imagePath = path.join(imageDir, `${frame.id}.png`);
        await fs.writeFile(imagePath, Buffer.from(image.data, 'base64'));
        // Keep the protocol transcript useful without echoing account text on
        // the General settings page. Inspect the actual captured image locally.
        output.snapshot = { id: frame.id, observed_at: frame.observed_at, width: frame.width, height: frame.height,
          accessibility_coverage: frame.accessibility_coverage, ocr_available: frame.ocr?.available,
          ocr_line_count: frame.ocr?.lines?.length || 0, image_path: imagePath };
      }
      process.stdout.write(`${JSON.stringify(output)}\n`);
    } catch (error) { process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`); }
  }
} finally {
  lines.close();
  await client.close();
}
