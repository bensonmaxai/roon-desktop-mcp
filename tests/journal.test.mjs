import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OperationJournal } from '../src/journal.mjs';

async function createJournal(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'roon-operation-journal-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  let time = 1_700_000_000_000;
  return {
    dataDir,
    journal: new OperationJournal({ dataDir, clock: () => ++time, ...options }),
  };
}

test('persists a Unicode/path-like operation id as a hashed reservation without raw request content', async t => {
  const { dataDir, journal } = await createJournal(t);
  const operationId = '../播放清單/demo-profile/operation-01';
  const request = {
    actionKind: 'playlist.add',
    playlistName: '不要寫進 journal 的私人清單名',
    typedText: 'private text must never be persisted',
    optional: undefined,
  };

  const first = await journal.begin({
    operationId,
    request,
    baseline: { snapshotGeneration: 12, window: { generation: 'roon-window-4' }, ocrText: 'do not retain' },
  });
  assert.equal(first.replay, false);
  assert.equal(first.record.state, 'prepared');
  assert.equal(first.record.request.actionKind, 'playlist.add');
  assert.match(first.record.request.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(first.record.baseline, { snapshotGeneration: 12, windowGeneration: 'roon-window-4' });

  const restarted = new OperationJournal({ dataDir });
  const replay = await restarted.begin({
    operationId,
    request: {
      typedText: 'private text must never be persisted',
      actionKind: 'playlist.add',
      playlistName: '不要寫進 journal 的私人清單名',
    },
  });
  assert.equal(replay.replay, true);
  assert.equal(replay.automaticReplayAllowed, false);
  assert.equal(replay.record.operationId, operationId);

  const files = await readdir(path.join(dataDir, 'operations'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^[a-f0-9]{64}\.json$/u);
  const stored = await readFile(path.join(dataDir, 'operations', files[0]), 'utf8');
  assert.doesNotMatch(stored, /私人清單|private text|do not retain/u);
});

test('rejects a changed request for an existing operation id', async t => {
  const { journal } = await createJournal(t);
  await journal.begin({ operationId: 'same-id', request: { actionKind: 'queue.remove', item: 'one' } });

  await assert.rejects(
    journal.begin({ operationId: 'same-id', request: { actionKind: 'queue.remove', item: 'two' } }),
    error => error?.code === 'OPERATION_REQUEST_MISMATCH',
  );
});

test('accepts the controller action envelope and retains only its safe reconciliation baseline', async t => {
  const { journal } = await createJournal(t);
  const request = {
    operation_id: 'controller-envelope',
    frame_id: 'frame-7',
    intent: 'Click the visible library tab',
    user_authorized: true,
    delivery_mode: 'background',
    expect: { contains: ['Library'] },
    action: { kind: 'click', target: { x: 200, y: 120 } },
  };
  const begun = await journal.begin({
    operationId: 'controller-envelope',
    request,
    baseline: { frame_id: 'frame-7', pid: 1234, window_id: 'window-2', process_started_at: 1700000000000 },
  });
  assert.equal(begun.record.request.actionKind, 'click');
  assert.deepEqual(begun.record.baseline, {
    frame_id: 'frame-7', pid: 1234, window_id: 'window-2', process_started_at: 1700000000000,
  });

  await journal.transition('controller-envelope', 'dispatched', { method: 'click', delivery_mode: 'background' });
  const unknown = await journal.transition('controller-envelope', 'unknown', {
    frame_id: 'frame-7', image_sha256: 'b'.repeat(64), ui_text: 'not_matched', image_changed: true,
    verification_scope: 'needs_review', raw_text: 'do not retain',
  });
  assert.deepEqual(unknown.evidence, {
    frameId: 'frame-7', imageSha256: 'b'.repeat(64), uiText: 'not_matched', imageChanged: true,
    verificationScope: 'needs_review',
  });
});

test('atomically reserves simultaneous duplicate begins and filters undefined request fields', async t => {
  const { dataDir } = await createJournal(t);
  const first = new OperationJournal({ dataDir });
  const second = new OperationJournal({ dataDir });
  const request = { actionKind: 'playlist.create', name: 'new-list', optional: undefined };

  const results = await Promise.all([
    first.begin({ operationId: 'parallel', request }),
    second.begin({ operationId: 'parallel', request: { name: 'new-list', actionKind: 'playlist.create' } }),
  ]);
  assert.deepEqual(results.map(result => result.replay).sort(), [false, true]);
  assert.equal((await first.list()).length, 1);
});

test('enforces a configured journal capacity while preserving an existing-id replay at full capacity', async t => {
  const { dataDir, journal } = await createJournal(t, { maxOperations: 1 });
  const request = { actionKind: 'playlist.create', name: 'kept-reservation' };
  await journal.begin({ operationId: 'kept-reservation', request });
  const refused = await journal.transition('kept-reservation', 'refused', { reason: 'user_declined' });
  assert.equal(refused.state, 'refused');

  await assert.rejects(
    journal.begin({ operationId: 'blocked-reservation', request: { actionKind: 'playlist.create', name: 'blocked' } }),
    error => error?.code === 'JOURNAL_CAPACITY_EXCEEDED',
  );

  const replay = await new OperationJournal({ dataDir, maxOperations: 1 }).begin({
    operationId: 'kept-reservation', request,
  });
  assert.equal(replay.replay, true);
  assert.equal(replay.automaticReplayAllowed, false);
  assert.equal(replay.record.state, 'refused');
  assert.equal(replay.record.history.length, 2);
  assert.equal((await journal.list()).length, 1);
});

test('serializes concurrent capacity allocations from separate journal instances', async t => {
  const { dataDir } = await createJournal(t);
  const first = new OperationJournal({ dataDir, maxOperations: 1 });
  const second = new OperationJournal({ dataDir, maxOperations: 1 });
  const results = await Promise.allSettled([
    first.begin({ operationId: 'concurrent-first', request: { actionKind: 'queue.add' } }),
    second.begin({ operationId: 'concurrent-second', request: { actionKind: 'queue.add' } }),
  ]);

  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected?.reason?.code, 'JOURNAL_CAPACITY_EXCEEDED');
  assert.equal((await first.list()).length, 1);
});

test('lists only the newest records across bounded read batches', async t => {
  const { journal } = await createJournal(t, { maxOperations: 24 });
  for (let index = 0; index < 20; index += 1) {
    await journal.begin({
      operationId: `batch-operation-${index}`,
      request: { actionKind: 'queue.add', index },
    });
  }

  const records = await journal.list({ limit: 3 });
  assert.deepEqual(records.map(record => record.operationId), [
    'batch-operation-19', 'batch-operation-18', 'batch-operation-17',
  ]);
});

test('fails closed for oversized records and legacy operation directories over capacity', async t => {
  const { dataDir, journal } = await createJournal(t, { maxOperations: 2 });
  await journal.begin({ operationId: 'bounded-record', request: { actionKind: 'queue.add' } });
  await writeFile(journal.operationPath('bounded-record'), 'x'.repeat(64 * 1024 + 1), 'utf8');
  await assert.rejects(journal.get('bounded-record'), error => error?.code === 'JOURNAL_RECORD_TOO_LARGE');

  const legacy = new OperationJournal({ dataDir, maxOperations: 2 });
  await writeFile(legacy.operationPath('legacy-one'), '{}', { flag: 'wx', mode: 0o600 });
  await writeFile(legacy.operationPath('legacy-two'), '{}', { flag: 'wx', mode: 0o600 });
  await assert.rejects(legacy.list(), error => error?.code === 'JOURNAL_CAPACITY_EXCEEDED');
  await assert.rejects(
    legacy.begin({ operationId: 'legacy-blocked', request: { actionKind: 'queue.add' } }),
    error => error?.code === 'JOURNAL_CAPACITY_EXCEEDED',
  );
});

test('caps traversal while ignoring unrelated operation-directory files', async t => {
  const { dataDir, journal } = await createJournal(t, { maxOperations: 1 });
  await journal.ensureOperationsDir();
  const operationsDir = path.join(dataDir, 'operations');
  await Promise.all(Array.from({ length: 66 }, (_, index) =>
    writeFile(path.join(operationsDir, `unrelated-${index}.tmp`), 'ignored', { flag: 'wx', mode: 0o600 })));

  await assert.rejects(journal.list(), error => error?.code === 'JOURNAL_DIRECTORY_LIMIT_EXCEEDED');
});

test('validates the configured operation capacity range', () => {
  const defaultJournal = new OperationJournal({ dataDir: path.join(os.tmpdir(), 'default-journal-capacity') });
  assert.equal(defaultJournal.maxOperations, 10_000);
  assert.throws(
    () => new OperationJournal({ dataDir: path.join(os.tmpdir(), 'invalid-journal-capacity'), maxOperations: 0 }),
    error => error?.code === 'JOURNAL_CONFIG',
  );
  assert.throws(
    () => new OperationJournal({ dataDir: path.join(os.tmpdir(), 'invalid-journal-capacity'), maxOperations: 100_001 }),
    error => error?.code === 'JOURNAL_CONFIG',
  );
});

test('does not automatically replay dispatched or unknown actions and allows explicit reconciliation', async t => {
  const { dataDir, journal } = await createJournal(t);
  const operationId = 'crash-after-dispatch';
  const request = { actionKind: 'playlist.remove', target: 'track-1' };
  await journal.begin({ operationId, request });
  const dispatched = await journal.transition(operationId, 'dispatched', { status: 'input_delivered', snapshotGeneration: 7 });
  assert.equal(dispatched.attempts, 1);

  const afterCrash = await new OperationJournal({ dataDir }).begin({ operationId, request });
  assert.equal(afterCrash.replay, true);
  assert.equal(afterCrash.automaticReplayAllowed, false);
  assert.equal(afterCrash.requiresReconciliation, true);
  assert.equal(afterCrash.record.state, 'dispatched');

  await journal.transition(operationId, 'unknown', { reason: 'driver_timeout' });
  const unknownReplay = await journal.begin({ operationId, request });
  assert.equal(unknownReplay.record.state, 'unknown');
  assert.equal(unknownReplay.requiresReconciliation, true);

  await assert.rejects(
    journal.transition(operationId, 'confirmed'),
    error => error?.code === 'TRANSITION_EVIDENCE_REQUIRED',
  );
  const confirmed = await journal.transition(operationId, 'confirmed', {
    verification: 'fresh_manifest_match',
    manifestSha256: 'a'.repeat(64),
    rawText: 'never written',
  });
  assert.equal(confirmed.state, 'confirmed');
  assert.deepEqual(confirmed.evidence, {
    verification: 'fresh_manifest_match',
    manifestSha256: 'a'.repeat(64),
  });
  await assert.rejects(
    journal.transition(operationId, 'refused', { reason: 'too_late' }),
    error => error?.code === 'JOURNAL_TRANSITION_INVALID',
  );
});

test('recovers a lock left by a crashed owner and reconciles without replaying input', async t => {
  const { dataDir, journal } = await createJournal(t);
  const operationId = 'crashed-lock-after-dispatch';
  const request = { actionKind: 'playlist.remove', target: 'track-2' };
  await journal.begin({ operationId, request });
  await journal.transition(operationId, 'dispatched', {
    status: 'input_delivered', delivery_mode: 'background', snapshotGeneration: 9,
  });

  const lockPath = `${journal.operationPath(operationId)}.lock`;
  const child = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { randomUUID } from 'node:crypto';
     import { open } from 'node:fs/promises';
     const handle = await open(process.argv.at(-1), 'wx', 0o600);
     await handle.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID(), createdAt: Date.now() }), 'utf8');
     await handle.sync();
     process.exit(0);`,
    lockPath,
  ], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const crashedOwner = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.notEqual(crashedOwner.pid, process.pid);

  const restarted = new OperationJournal({ dataDir });
  const replay = await restarted.begin({ operationId, request });
  assert.equal(replay.replay, true);
  assert.equal(replay.automaticReplayAllowed, false);
  assert.equal(replay.requiresReconciliation, true);
  assert.equal(replay.record.state, 'dispatched');
  assert.equal(replay.record.attempts, 1);

  const unknown = await restarted.transition(operationId, 'unknown', { reason: 'driver_timeout' });
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.attempts, 1);
  const reconciled = await restarted.transition(operationId, 'unchanged', {
    verification: 'fresh_frame_unchanged', reconciled: true,
  });
  assert.equal(reconciled.state, 'unchanged');
  assert.equal(reconciled.attempts, 1);
  await assert.rejects(readFile(lockPath, 'utf8'), error => error?.code === 'ENOENT');
});

test('does not remove a valid lock owned by a live process', async t => {
  const { journal } = await createJournal(t);
  const operationId = 'live-operation-owner';
  await journal.begin({ operationId, request: { actionKind: 'queue.reorder' } });
  const lockPath = `${journal.operationPath(operationId)}.lock`;
  const owner = { pid: process.pid, token: 'live-owner-token', createdAt: Date.now() };
  await writeFile(lockPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });

  await assert.rejects(
    journal.transition(operationId, 'dispatched', { status: 'input_sent' }),
    error => error?.code === 'JOURNAL_BUSY',
  );
  assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), owner);
});

test('supports refusal before or after dispatch and reports immutable terminal states', async t => {
  const { journal } = await createJournal(t);
  await journal.begin({ operationId: 'validate-refusal', request: { actionKind: 'dsp.filter.configure' } });
  const refusedBeforeDispatch = await journal.transition('validate-refusal', 'refused', { reason: 'validation_failed' });
  assert.equal(refusedBeforeDispatch.state, 'refused');

  await journal.begin({ operationId: 'background-refusal', request: { actionKind: 'queue.reorder' } });
  await journal.transition('background-refusal', 'dispatched', { status: 'input_sent' });
  const refusedAfterDispatch = await journal.transition('background-refusal', 'refused', { reason: 'background_unavailable' });
  assert.equal(refusedAfterDispatch.state, 'refused');
  assert.equal(refusedAfterDispatch.attempts, 1);
  assert.equal((await journal.get('missing-operation')), null);
});
