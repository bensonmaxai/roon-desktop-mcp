import assert from 'node:assert/strict';
import test from 'node:test';

import { validateIntent, validateKeys } from '../src/policy.mjs';
import { DesktopError } from '../src/errors.mjs';

function expectCode(code) {
  return (error) => error instanceof DesktopError && error.code === code;
}

test('a destructive confirmation must identify the same visible target', () => {
  assert.throws(
    () => validateIntent({
      intent: 'delete',
      user_authorized: true,
      confirmation: 'Remove the archive playlist',
    }, 'Remove the road-trip playlist'),
    expectCode('CONFIRMATION_MISMATCH'),
  );
});

test('Windows and system key shortcuts are denied before delivery', () => {
  assert.throws(
    () => validateKeys(['win', 'r'], { intent: 'navigate', user_authorized: false }),
    expectCode('KEY_DENIED'),
  );
  assert.throws(
    () => validateKeys(['meta', 'l'], { intent: 'navigate', user_authorized: false }),
    expectCode('KEY_DENIED'),
  );
});

test('authentication controls remain denied after whitespace normalization and in compound labels', () => {
  for (const label of ['Change password', 'Manage Account', 'Sign in', '檢視帳戶資訊', '取消授權']) {
    assert.throws(() => validateIntent({ intent: 'edit', user_authorized: true }, label), expectCode('MANUAL_ONLY'));
  }
});
