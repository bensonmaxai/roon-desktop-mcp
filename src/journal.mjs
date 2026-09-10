import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, opendir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { DesktopError, invariant } from './errors.mjs';

const STATES = new Set(['prepared', 'dispatched', 'confirmed', 'unchanged', 'unknown', 'refused']);
const LEGAL_TRANSITIONS = Object.freeze({
  prepared: new Set(['dispatched', 'refused']),
  dispatched: new Set(['confirmed', 'unchanged', 'unknown', 'refused']),
  unknown: new Set(['confirmed', 'unchanged', 'refused']),
  confirmed: new Set(),
  unchanged: new Set(),
  refused: new Set(),
});
const ACTION_KIND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const EVIDENCE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const SENSITIVE_EVIDENCE_KEY = /(text|typed|screenshot|image|token|secret|password|account|email|path|payload|content|title|artist|version|query|track|playlist|file|url)/iu;
const OPERATION_RECORD_NAME_PATTERN = /^[a-f0-9]{64}\.json$/u;
const DEFAULT_MAX_OPERATIONS = 10_000;
const MAX_OPERATIONS = 100_000;
const MAX_RECORD_BYTES = 64 * 1024;
const DIRECTORY_ENTRY_SLACK = 64;
const RECORD_READ_BATCH_SIZE = 16;

/**
 * Durable reservation and outcome record for one potentially stateful desktop action.
 * The journal deliberately stores a request fingerprint, never the request payload.
 */
export class OperationJournal {
  constructor({ dataDir, clock = Date.now, maxOperations = DEFAULT_MAX_OPERATIONS } = {}) {
    invariant(typeof dataDir === 'string' && dataDir.trim().length > 0,
      'JOURNAL_CONFIG', 'OperationJournal requires a dedicated data directory.');
    invariant(typeof clock === 'function', 'JOURNAL_CONFIG', 'OperationJournal clock must be a function.');
    invariant(Number.isInteger(maxOperations) && maxOperations >= 1 && maxOperations <= MAX_OPERATIONS,
      'JOURNAL_CONFIG', 'OperationJournal maxOperations must be an integer from 1 to 100000.');
    this.dataDir = path.resolve(dataDir);
    this.operationsDir = path.join(this.dataDir, 'operations');
    this.clock = clock;
    this.maxOperations = maxOperations;
    this.maxDirectoryEntries = Math.min(MAX_OPERATIONS + DIRECTORY_ENTRY_SLACK,
      maxOperations + DIRECTORY_ENTRY_SLACK);
  }

  /**
   * Atomically reserves an operation id before any desktop input is sent.
   * A replay result is informational only: callers must not re-dispatch it.
   */
  async begin({ operationId, request, baseline = {} } = {}) {
    const id = validateOperationId(operationId);
    const requestSummary = summarizeRequest(request);
    const recordPath = this.operationPath(id);
    const baselineSummary = summarizeBaseline(baseline);
    await this.ensureOperationsDir();

    // The capacity lock serializes the check and reservation across journal instances.
    return this.withOperationLock(this.capacityLockPath(), async () => {
      const existing = await readExistingRecord(recordPath);
      if (existing) return this.replayExisting(id, requestSummary, existing);

      if (!await this.hasOperationCapacity()) throw journalCapacityError(this.maxOperations);

      const now = this.now();
      const record = {
        version: 1,
        operationId: id,
        request: requestSummary,
        baseline: baselineSummary,
        state: 'prepared',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        evidence: {},
        history: [{ state: 'prepared', at: now }],
      };

      try {
        await writeExclusive(recordPath, JSON.stringify(record));
        return replayResult(false, record);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw journalWriteError(error);
      }

      // Preserve a reservation created by an older process that did not hold the capacity lock.
      const raced = await readRecord(recordPath);
      return this.replayExisting(id, requestSummary, raced);
    });
  }

  /**
   * Records a state transition after fresh observation. Terminal states are immutable.
   */
  async transition(operationId, state, evidence = {}) {
    const id = validateOperationId(operationId);
    invariant(STATES.has(state), 'JOURNAL_STATE_INVALID', 'The requested operation state is invalid.');
    const recordPath = this.operationPath(id);
    await this.ensureOperationsDir();

    return this.withOperationLock(recordPath, async () => {
      const record = await readRecord(recordPath, { missingCode: 'OPERATION_NOT_FOUND' });
      const legal = LEGAL_TRANSITIONS[record.state];
      invariant(legal?.has(state), 'JOURNAL_TRANSITION_INVALID',
        'That operation state cannot transition to the requested state.', { from: record.state, to: state });

      if (state === 'dispatched') {
        invariant(record.attempts === 0, 'OPERATION_ATTEMPT_EXHAUSTED',
          'This operation was already dispatched once and must be reconciled instead of retried.');
      }

      const safeEvidence = sanitizeEvidence(evidence);
      if (record.state === 'unknown') {
        invariant(Object.keys(safeEvidence).length > 0, 'TRANSITION_EVIDENCE_REQUIRED',
          'Reconciling an unknown operation requires explicit safe evidence.');
      }

      const at = this.now();
      const next = {
        ...record,
        state,
        attempts: state === 'dispatched' ? 1 : record.attempts,
        updatedAt: at,
        evidence: safeEvidence,
        history: [...record.history, { state, at, ...(Object.keys(safeEvidence).length > 0 ? { evidence: safeEvidence } : {}) }],
      };
      await atomicReplace(recordPath, JSON.stringify(next));
      return next;
    });
  }

  async get(operationId) {
    const id = validateOperationId(operationId);
    const recordPath = this.operationPath(id);
    try {
      const record = await readRecord(recordPath);
      invariant(record.operationId === id, 'JOURNAL_CORRUPT',
        'The operation journal contains an invalid operation reservation.');
      return record;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async list({ limit = 20 } = {}) {
    invariant(Number.isInteger(limit) && limit > 0 && limit <= 100,
      'JOURNAL_LIMIT_INVALID', 'Journal list limit must be an integer from 1 to 100.');
    const topRecords = [];
    let batch = [];
    for await (const recordPath of this.operationRecordPaths()) {
      batch.push(recordPath);
      if (batch.length === RECORD_READ_BATCH_SIZE) {
        await mergeTopRecords(topRecords, batch, limit);
        batch = [];
      }
    }
    if (batch.length > 0) await mergeTopRecords(topRecords, batch, limit);
    return topRecords;
  }

  operationPath(operationId) {
    return path.join(this.operationsDir, `${sha256(operationId)}.json`);
  }

  capacityLockPath() {
    return path.join(this.operationsDir, '.capacity');
  }

  async ensureOperationsDir() {
    try {
      await mkdir(this.operationsDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw journalWriteError(error);
    }
  }

  now() {
    const value = this.clock();
    invariant(typeof value === 'number' && Number.isFinite(value),
      'JOURNAL_CLOCK_INVALID', 'OperationJournal clock must return a finite timestamp.');
    return Math.trunc(value);
  }

  replayExisting(id, requestSummary, existing) {
    invariant(existing.operationId === id, 'JOURNAL_CORRUPT',
      'The operation journal contains an invalid operation reservation.');
    if (existing.request.sha256 !== requestSummary.sha256) {
      throw new DesktopError('OPERATION_REQUEST_MISMATCH',
        'That operation id was already reserved for a different request. Create a new operation id.');
    }
    return replayResult(true, existing);
  }

  async hasOperationCapacity() {
    let count = 0;
    for await (const ignoredPath of this.operationRecordPaths()) {
      count += 1;
      if (count >= this.maxOperations) return false;
    }
    return true;
  }

  async *operationRecordPaths() {
    let directory;
    try {
      directory = await opendir(this.operationsDir, { bufferSize: RECORD_READ_BATCH_SIZE });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    let entriesSeen = 0;
    let recordCount = 0;
    for await (const entry of directory) {
      entriesSeen += 1;
      if (entriesSeen > this.maxDirectoryEntries) throw journalDirectoryLimitError();
      if (!entry.isFile() || !OPERATION_RECORD_NAME_PATTERN.test(entry.name)) continue;

      recordCount += 1;
      if (recordCount > this.maxOperations) throw journalCapacityError(this.maxOperations);
      yield path.join(this.operationsDir, entry.name);
    }
  }

  async withOperationLock(recordPath, operation) {
    const lockPath = `${recordPath}.lock`;
    const token = randomUUID();
    let handle;
    let contentionAttempts = 0;
    let staleLocksRecovered = 0;
    while (contentionAttempts < 8) {
      try {
        handle = await open(lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), 'utf8');
          await handle.sync();
        } catch (error) {
          await handle.close().catch(() => {});
          handle = undefined;
          await unlink(lockPath).catch(() => {});
          throw journalWriteError(error);
        }
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw journalWriteError(error);
        if (staleLocksRecovered === 0 && await recoverDeadOperationLock(lockPath)) {
          staleLocksRecovered += 1;
          continue;
        }
        contentionAttempts += 1;
        if (contentionAttempts < 8) await delay(5 * contentionAttempts);
      }
    }
    if (!handle) {
      throw new DesktopError('JOURNAL_BUSY',
        'Another process is recording this operation. Observe its result instead of retrying input.');
    }

    try {
      return await operation();
    } finally {
      await handle.close().catch(() => {});
      const owner = await readOperationLockOwner(lockPath);
      if (owner?.token === token) await unlink(lockPath).catch(() => {});
    }
  }
}

function replayResult(replay, record) {
  return {
    replay,
    record,
    // No existing reservation is ever an authorization to send desktop input again.
    automaticReplayAllowed: false,
    requiresReconciliation: record.state === 'dispatched' || record.state === 'unknown',
  };
}

async function readExistingRecord(filePath) {
  try {
    return await readRecord(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function mergeTopRecords(topRecords, recordPaths, limit) {
  const records = await Promise.all(recordPaths.map(recordPath => readRecord(recordPath)));
  topRecords.push(...records);
  topRecords.sort(compareRecordsByUpdatedAt);
  if (topRecords.length > limit) topRecords.length = limit;
}

function compareRecordsByUpdatedAt(left, right) {
  return right.updatedAt - left.updatedAt || left.operationId.localeCompare(right.operationId);
}

function journalCapacityError(maxOperations) {
  return new DesktopError('JOURNAL_CAPACITY_EXCEEDED',
    `Operation journal capacity of ${maxOperations} records is exhausted. Historical operation records are retained for replay safety.`);
}

function journalDirectoryLimitError() {
  return new DesktopError('JOURNAL_DIRECTORY_LIMIT_EXCEEDED',
    'The operation journal directory exceeds its bounded traversal limit. Do not send desktop input until it is repaired.');
}

function validateOperationId(operationId) {
  invariant(typeof operationId === 'string' && operationId.trim().length > 0 && operationId.length <= 512,
    'OPERATION_ID_INVALID', 'Operation id must be a non-empty string no longer than 512 characters.');
  return operationId;
}

function summarizeRequest(request) {
  invariant(isPlainObject(request), 'JOURNAL_REQUEST_INVALID',
    'Operation request must be a plain object with an action kind.');
  const nestedActionKind = isPlainObject(request.action) ? request.action.kind : undefined;
  const actionKind = request.actionKind ?? request.action_kind ?? request.kind ?? request.type ??
    (typeof request.action === 'string' ? request.action : nestedActionKind);
  invariant(typeof actionKind === 'string' && ACTION_KIND_PATTERN.test(actionKind), 'JOURNAL_ACTION_INVALID',
    'Operation request must provide a short identifier-like action kind.');
  const canonical = canonicalJson(request);
  return { sha256: sha256(canonical), actionKind };
}

function summarizeBaseline(baseline) {
  if (!isPlainObject(baseline)) return {};
  const summary = {};
  const snapshotGeneration = firstSafeGeneration([
    baseline.snapshotGeneration,
    baseline.snapshot_generation,
    baseline.generation,
    baseline.snapshot?.generation,
  ]);
  const windowGeneration = firstSafeGeneration([
    baseline.windowGeneration,
    baseline.window_generation,
    baseline.window?.generation,
  ]);
  const frameId = firstSafeGeneration([baseline.frame_id, baseline.frameId]);
  const windowId = firstSafeGeneration([baseline.window_id, baseline.windowId]);
  const pid = firstSafeNumber([baseline.pid]);
  const processStartedAt = firstSafeTimestamp([baseline.process_started_at, baseline.processStartedAt]);
  if (snapshotGeneration !== undefined) summary.snapshotGeneration = snapshotGeneration;
  if (windowGeneration !== undefined) summary.windowGeneration = windowGeneration;
  // Keep the controller's snake_case identity fields so a restarted process can reconcile safely.
  if (frameId !== undefined) summary.frame_id = frameId;
  if (windowId !== undefined) summary.window_id = windowId;
  if (pid !== undefined) summary.pid = pid;
  if (processStartedAt !== undefined) summary.process_started_at = processStartedAt;
  return summary;
}

function firstSafeGeneration(values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
    if (typeof value === 'string' && CODE_PATTERN.test(value)) return value;
  }
  return undefined;
}

function firstSafeNumber(values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  }
  return undefined;
}

function firstSafeTimestamp(values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/u.test(value) && Number.isFinite(Date.parse(value))) return value;
  }
  return undefined;
}

function sanitizeEvidence(evidence) {
  invariant(isPlainObject(evidence), 'JOURNAL_EVIDENCE_INVALID',
    'Operation evidence must be a small plain object.');
  const output = {};
  const aliases = {
    snapshotGeneration: 'snapshotGeneration', snapshot_generation: 'snapshotGeneration',
    windowGeneration: 'windowGeneration', window_generation: 'windowGeneration',
    status: 'status', result: 'result', code: 'code',
    reasonCode: 'reasonCode', reason_code: 'reasonCode', reason: 'reasonCode', verification: 'verification',
    source: 'source', actionKind: 'actionKind', action_kind: 'actionKind',
    method: 'method', delivery_mode: 'deliveryMode', deliveryMode: 'deliveryMode',
    frame_id: 'frameId', frameId: 'frameId',
    image_sha256: 'imageSha256', imageSha256: 'imageSha256',
    ui_text: 'uiText', uiText: 'uiText', image_changed: 'imageChanged', imageChanged: 'imageChanged',
    verification_scope: 'verificationScope', verificationScope: 'verificationScope',
    error_code: 'errorCode', errorCode: 'errorCode',
    evidence_source: 'evidenceSource', evidenceSource: 'evidenceSource',
    matched: 'matched', changed: 'changed', observed: 'observed',
    manualConfirmed: 'manualConfirmed', manual_confirmed: 'manualConfirmed', reconciled: 'reconciled',
    targetCount: 'targetCount', target_count: 'targetCount',
    manifestCount: 'manifestCount', manifest_count: 'manifestCount',
    position: 'position', positionBefore: 'positionBefore', positionAfter: 'positionAfter',
    manifestSha256: 'manifestSha256', manifest_sha256: 'manifestSha256',
  };
  for (const [key, value] of Object.entries(evidence).slice(0, 16)) {
    const outputKey = aliases[key];
    if (!outputKey) {
      if (isSafeEvidenceKey(key) && isSafeEvidenceValue(value)) output[key] = value;
      continue;
    }
    if (outputKey === 'snapshotGeneration' || outputKey === 'windowGeneration') {
      const generation = firstSafeGeneration([value]);
      if (generation !== undefined) output[outputKey] = generation;
    } else if (outputKey === 'manifestSha256' || outputKey === 'imageSha256') {
      if (typeof value === 'string' && SHA256_PATTERN.test(value)) output[outputKey] = value;
    } else if (['matched', 'changed', 'observed', 'manualConfirmed', 'reconciled', 'imageChanged'].includes(outputKey)) {
      if (typeof value === 'boolean') output[outputKey] = value;
    } else if (['targetCount', 'manifestCount', 'position', 'positionBefore', 'positionAfter'].includes(outputKey)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) output[outputKey] = Math.trunc(value);
    } else if (typeof value === 'string' && CODE_PATTERN.test(value)) {
      output[outputKey] = value;
    }
  }
  return output;
}

function canonicalJson(value, seen = new WeakSet()) {
  if (value === undefined) return undefined;
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    invariant(Number.isFinite(value), 'JOURNAL_REQUEST_INVALID',
      'Operation request cannot contain non-finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    invariant(!seen.has(value), 'JOURNAL_REQUEST_INVALID', 'Operation request cannot contain circular data.');
    seen.add(value);
    const result = `[${value.filter(item => item !== undefined).map(item => canonicalJson(item, seen)).join(',')}]`;
    seen.delete(value);
    return result;
  }
  if (isPlainObject(value)) {
    invariant(!seen.has(value), 'JOURNAL_REQUEST_INVALID', 'Operation request cannot contain circular data.');
    seen.add(value);
    const result = `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(',')}}`;
    seen.delete(value);
    return result;
  }
  throw new DesktopError('JOURNAL_REQUEST_INVALID',
    'Operation request must contain JSON-compatible plain data only.');
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeEvidenceKey(key) {
  return EVIDENCE_KEY_PATTERN.test(key) && !SENSITIVE_EVIDENCE_KEY.test(key);
}

function isSafeEvidenceValue(value) {
  return (typeof value === 'boolean') ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0) ||
    (typeof value === 'string' && (CODE_PATTERN.test(value) || SHA256_PATTERN.test(value)));
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function writeExclusive(filePath, contents) {
  assertRecordSize(contents);
  const handle = await open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicReplace(filePath, contents) {
  assertRecordSize(contents);
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
  } catch (error) {
    throw journalWriteError(error);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
  }
}

async function readRecord(filePath, { missingCode } = {}) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let contents;
    try {
      contents = await readBoundedRecord(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT' && missingCode) {
        throw new DesktopError(missingCode, 'The requested operation was not found.');
      }
      throw error;
    }
    try {
      const record = JSON.parse(contents);
      validateRecord(record);
      return record;
    } catch (error) {
      if (error instanceof DesktopError) throw error;
      if (attempt === 7) {
        throw new DesktopError('JOURNAL_CORRUPT',
          'The operation journal record is incomplete or corrupted. Do not replay the desktop action.');
      }
      await delay(5 * (attempt + 1));
    }
  }
  throw new DesktopError('JOURNAL_CORRUPT', 'The operation journal record is incomplete or corrupted.');
}

function assertRecordSize(contents) {
  invariant(typeof contents === 'string' && Buffer.byteLength(contents, 'utf8') <= MAX_RECORD_BYTES,
    'JOURNAL_RECORD_TOO_LARGE', 'Operation journal records cannot exceed 64 KiB.');
}

async function readBoundedRecord(filePath) {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const before = await handle.stat();
    invariant(before.isFile() && Number.isSafeInteger(before.size) && before.size >= 0,
      'JOURNAL_CORRUPT', 'The operation journal record is invalid.');
    invariant(before.size <= MAX_RECORD_BYTES, 'JOURNAL_RECORD_TOO_LARGE',
      'Operation journal records cannot exceed 64 KiB.');

    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    invariant(offset === bytes.length && after.size === before.size,
      'JOURNAL_CORRUPT', 'The operation journal record changed during reading. Do not replay the desktop action.');
    return bytes.toString('utf8');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readOperationLockOwner(lockPath) {
  try {
    const metadata = await lstat(lockPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    const owner = JSON.parse(await readFile(lockPath, 'utf8'));
    if (!isPlainObject(owner) || !Number.isInteger(owner.pid) || owner.pid <= 0 ||
      typeof owner.token !== 'string' || !CODE_PATTERN.test(owner.token) ||
      typeof owner.createdAt !== 'number' || !Number.isFinite(owner.createdAt) || owner.createdAt < 0) return null;
    return owner;
  } catch {
    return null;
  }
}

async function recoverDeadOperationLock(lockPath) {
  const owner = await readOperationLockOwner(lockPath);
  if (!owner) return false;

  let dead = false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') dead = true;
  }
  if (!dead) return false;

  // Re-read the owner immediately before removal. A live or replaced lock is preserved.
  const confirmed = await readOperationLockOwner(lockPath);
  if (!confirmed || confirmed.pid !== owner.pid || confirmed.token !== owner.token ||
    confirmed.createdAt !== owner.createdAt) return false;
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

function validateRecord(record) {
  invariant(isPlainObject(record) && record.version === 1 && typeof record.operationId === 'string',
    'JOURNAL_CORRUPT', 'The operation journal record is invalid.');
  invariant(STATES.has(record.state) && Number.isInteger(record.attempts) && record.attempts >= 0 && record.attempts <= 1,
    'JOURNAL_CORRUPT', 'The operation journal record is invalid.');
  invariant(isPlainObject(record.request) && SHA256_PATTERN.test(record.request.sha256) &&
    typeof record.request.actionKind === 'string' && ACTION_KIND_PATTERN.test(record.request.actionKind),
  'JOURNAL_CORRUPT', 'The operation journal record is invalid.');
  invariant(Array.isArray(record.history) && record.history.length > 0,
    'JOURNAL_CORRUPT', 'The operation journal record is invalid.');
}

function journalWriteError(error) {
  if (error instanceof DesktopError) return error;
  return new DesktopError('JOURNAL_WRITE_FAILED',
    'The operation journal could not persist its reservation or outcome. Do not send desktop input until it is available.');
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
