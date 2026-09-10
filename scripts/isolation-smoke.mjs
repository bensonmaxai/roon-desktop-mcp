import assert from 'node:assert/strict';
import { RoonDesktopController } from '../src/controller.mjs';
import { runtimeConfig } from '../src/runtime.mjs';

// Live, read-only check: closing one private CUA proxy must not terminate the
// other controller's session. No UI input or anonymous-session APIs are used.
const config = runtimeConfig();
const first = new RoonDesktopController(config);
const second = new RoonDesktopController(config);
try {
  const statuses = await Promise.all([first.status(), second.status()]);
  assert.ok(statuses.every(status => status.running));
  await first.close();
  const surviving = await second.observe({ include_ocr: false });
  assert.equal(surviving.ok, true);
  assert.ok(surviving.snapshot.width > 0 && surviving.snapshot.height > 0);
  process.stdout.write(`${JSON.stringify({ ok: true, controllers: 2,
    closed_proxy_did_not_end_peer: true, image: {
      width: surviving.snapshot.width, height: surviving.snapshot.height,
    }, ui_inputs: 0 })}\n`);
} finally {
  await Promise.allSettled([first.close(), second.close()]);
}
