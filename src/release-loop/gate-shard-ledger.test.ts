import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendGateShardLedger, appendGateShardLedgerBatch, appendGateShardLedgerForGate, appendGateShardLifecycleState, gateShardFilesCovered, gateShardLedgerBatchComplete, gateShardLedgerBatchReusable, gateShardLedgerPath, latestGateShardLedger, latestGateShardLedgerAttempts, readGateShardLedger, type GateShardLedgerRow } from './gate-shard-ledger.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('a recovered parent is complete only when retry shards cover its exact file map', () => {
  expect(gateShardFilesCovered(['src/a.test.ts', 'src/b.test.ts'], ['src/a.test.ts', 'src/b.test.ts'])).toBe(true);
  expect(gateShardFilesCovered(['src/a.test.ts', 'src/b.test.ts'], ['src/a.test.ts'])).toBe(false);
  expect(gateShardFilesCovered(['src/a.test.ts', 'src/b.test.ts'], ['src/a.test.ts', 'src/a.test.ts'])).toBe(false);
  expect(gateShardFilesCovered(['src/a.test.ts'], ['src/a.test.ts', 'src/unexpected.test.ts'])).toBe(false);
});

test('a live reader sees each attempt and keeps the latest attributed result', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-shard-ledger-')); roots.push(root);
  const path = gateShardLedgerPath('0.2.40', root);
  const pending: GateShardLedgerRow = {
    v: 1, version: '0.2.40', phase: 'cut', shardId: 'pod-0', files: ['src/a.test.ts'],
    host: null, executor: 'pod', imageDigest: null, commit: 'a'.repeat(40), envFingerprint: 'b'.repeat(64),
    startedAt: null, endedAt: null, observedAt: '2026-10-27T00:00:00.000Z', state: 'pending', rc: null,
    pass: null, fail: null, errors: null, ran: null, failureIds: null, errorIds: null,
    attribution: 'unmeasured', logPath: null, junitPath: null, stopReason: null, attemptId: null,
  };
  appendGateShardLedger(path, pending);
  expect(readGateShardLedger(path)?.rows[0]?.state).toBe('pending');
  appendGateShardLedger(path, { ...pending, host: 'node-b', state: 'running', startedAt: '2026-10-27T00:01:00.000Z', attemptId: 'attempt-1' });
  appendGateShardLedger(path, { ...pending, host: 'node-b', state: 'done', rc: 1, pass: 3, fail: 1, errors: 0, ran: 4,
    failureIds: ['src/a.test.ts > fails'], errorIds: [], attribution: 'complete',
    startedAt: '2026-10-27T00:01:00.000Z', endedAt: '2026-10-27T00:02:00.000Z', attemptId: 'attempt-1',
    logPath: '/tmp/pod-0.log', junitPath: '/tmp/pod-0.junit.xml' });
  const read = readGateShardLedger(path)!;
  expect(read.rows).toHaveLength(3);
  expect(read.malformed).toBe(0);
  expect(latestGateShardLedger(read.rows)[0]?.failureIds).toEqual(['src/a.test.ts > fails']);
});

test('stop intent and confirmed terminal state are appended to the operator ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-shard-ledger-stop-')); roots.push(root);
  const path = gateShardLedgerPath('0.3.8', root);
  const running: GateShardLedgerRow = {
    v: 1, version: '0.3.8', phase: 'cut', shardId: 'pod-0', files: ['src/a.test.ts'],
    host: 'minim5', executor: 'pod', imageDigest: null, commit: 'a'.repeat(40), envFingerprint: 'b'.repeat(64),
    startedAt: '2026-11-09T00:00:00Z', endedAt: null, observedAt: '2026-11-09T00:00:00Z', state: 'running', rc: null,
    pass: null, fail: null, errors: null, ran: null, failureIds: null, errorIds: null,
    attribution: 'unmeasured', logPath: null, junitPath: null, stopReason: null, attemptId: 'attempt-0',
  };
  appendGateShardLedger(path, running);
  appendGateShardLedger(path, { ...running, invocationId: 'newer-invocation', state: 'done', attemptId: 'newer-attempt', endedAt: '2026-11-09T00:03:00Z' });
  const attemptIds = new Map([['pod-0', 'attempt-0']]);
  expect(appendGateShardLifecycleState(path, ['pod-0'], 'stop-requested', '2026-11-09T00:01:00Z', null, attemptIds)).toEqual([]);
  expect(latestGateShardLedgerAttempts(readGateShardLedger(path)!.rows, attemptIds).get('pod-0'))
    .toMatchObject({ state: 'stop-requested', endedAt: null, stopReason: 'graph-run-stop-requested', attemptId: 'attempt-0' });
  expect(appendGateShardLifecycleState(path, ['pod-0'], 'failed', '2026-11-09T00:02:00Z', '2026-11-09T00:02:00Z', attemptIds)).toEqual([]);
  const rows = readGateShardLedger(path)!.rows;
  expect(latestGateShardLedgerAttempts(rows, attemptIds).get('pod-0')).toMatchObject({ state: 'failed', endedAt: '2026-11-09T00:02:00Z', attemptId: 'attempt-0' });
  expect(rows.filter((row) => row.attemptId === 'newer-attempt')).toHaveLength(1);
  expect(rows.find((row) => row.attemptId === 'newer-attempt')).toMatchObject({ state: 'done' });
  expect(appendGateShardLifecycleState(path, ['pod-0'], 'failed', '2026-11-09T00:02:00Z', '2026-11-09T00:02:00Z')).toEqual(['pod-0: missing attempt identity']);
});

test('a remote gate fails closed when the HQ shard ledger cannot be written', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-shard-ledger-remote-')); roots.push(root);
  const file = join(root, 'not-a-directory');
  writeFileSync(file, 'occupied');
  const path = join(file, 'shard-ledger.jsonl');
  const row: GateShardLedgerRow = {
    v: 1, version: '0.2.40', phase: 'cut', shardId: 'pod-0', files: ['src/a.test.ts'],
    host: 'gcp1', executor: 'pod', imageDigest: null, commit: 'a'.repeat(40), envFingerprint: 'b'.repeat(64),
    startedAt: null, endedAt: null, observedAt: '2026-10-27T00:00:00.000Z', state: 'pending', rc: null,
    pass: null, fail: null, errors: null, ran: null, failureIds: null, errorIds: null,
    attribution: 'unmeasured', logPath: null, junitPath: null, stopReason: null, attemptId: null,
  };
  expect(appendGateShardLedgerForGate(path, row, false)).toContain('EEXIST');
  expect(() => appendGateShardLedgerForGate(path, row, true)).toThrow();
});

test('remote completed shard rows append together and fail closed on write failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-shard-ledger-batch-')); roots.push(root);
  const path = gateShardLedgerPath('0.2.40', root);
  const row: GateShardLedgerRow = {
    v: 1, version: '0.2.40', phase: 'cut', shardId: 'pod-0', files: ['src/a.test.ts'],
    host: 'gcp1', executor: 'pod', imageDigest: 'sha256:' + 'c'.repeat(64), commit: 'a'.repeat(40), envFingerprint: 'b'.repeat(64),
    startedAt: '2026-10-27T00:01:00.000Z', endedAt: '2026-10-27T00:02:00.000Z', observedAt: '2026-10-27T00:02:01.000Z',
    state: 'done', rc: 0, pass: 1, fail: 0, errors: 0, ran: 1, failureIds: [], errorIds: [], attribution: 'complete',
    logPath: null, junitPath: null, stopReason: null, attemptId: 'attempt-1',
  };
  expect(appendGateShardLedgerBatch(path, [row, { ...row, shardId: 'pod-1', files: ['src/b.test.ts'] }], true)).toBeNull();
  const read = readGateShardLedger(path)!;
  expect(read.rows).toHaveLength(2);
  expect(new Set(read.rows.map((entry) => entry.batchId)).size).toBe(1);
  expect(read.rows.every((entry) => entry.state === 'done')).toBe(true);
  expect(read.rows.map((entry) => entry.shardId)).toEqual(['pod-0', 'pod-1']);
  expect(read.rows.every((entry) => entry.state === 'done')).toBe(true);
  expect(read.rows.every((entry) => entry.batchSize === 2)).toBe(true);
  expect(gateShardLedgerBatchComplete(read.rows, { batchId: read.rows[0]!.batchId!, version: row.version, commit: row.commit, phase: 'cut',
    observedAt: row.observedAt, shardIds: ['pod-0', 'pod-1'] })).toBe(true);
  expect(gateShardLedgerBatchComplete(read.rows, { batchId: 'a-previous-batch', version: row.version, commit: row.commit, phase: 'cut',
    observedAt: row.observedAt, shardIds: ['pod-0', 'pod-1'] })).toBe(false);
  const recoverablePath = gateShardLedgerPath('0.2.40', join(root, 'recoverable'));
  const recoverable = { ...row, attribution: 'unmeasured' as const, failureIds: null, errorIds: null,
    unmeasuredFiles: ['src/a.test.ts'], retryGroupId: 'attempt-1' };
  expect(appendGateShardLedgerBatch(recoverablePath, [recoverable, { ...row, shardId: 'pod-1', files: ['src/b.test.ts'] }], true)).toBeNull();
  const unrecovered = readGateShardLedger(recoverablePath)!;
  const unmeasuredBatch = { batchId: unrecovered.rows[0]!.batchId!, version: row.version, commit: row.commit,
    phase: 'cut' as const, observedAt: unrecovered.rows[0]!.observedAt, shardIds: ['pod-0', 'pod-1'] };
  expect(gateShardLedgerBatchComplete(unrecovered.rows, unmeasuredBatch)).toBe(true);
  expect(gateShardLedgerBatchReusable(unrecovered.rows, unmeasuredBatch)).toBe(false);
  expect(gateShardLedgerBatchComplete([...read.rows, { ...read.rows[0]!, version: '0.2.41', shardId: 'pod-extra',
    observedAt: '2026-10-27T00:02:02.000Z' }], { batchId: read.rows[0]!.batchId!, version: row.version, commit: row.commit, phase: 'cut',
    observedAt: row.observedAt, shardIds: ['pod-0', 'pod-1'] })).toBe(false);
  writeFileSync(path, `${JSON.stringify(read.rows[0])}\n`);
  const truncated = readGateShardLedger(path)!;
  expect(truncated.incompleteBatches).toEqual([read.rows[0]!.batchId!]);
  expect(gateShardLedgerBatchComplete(truncated.rows, { batchId: read.rows[0]!.batchId!, version: row.version, commit: row.commit, phase: 'cut',
    observedAt: row.observedAt, shardIds: ['pod-0', 'pod-1'] })).toBe(false);
  writeFileSync(path, JSON.stringify(read.rows[0]));
  const unterminated = readGateShardLedger(path)!;
  expect(unterminated.trailingPartial).toBe(true);
  expect(unterminated.malformed).toBe(0);
  expect(() => appendGateShardLedgerBatch(path, [row, { ...row, shardId: 'pod-1', files: ['src/b.test.ts'] }], true))
    .toThrow('unterminated JSONL row');
  expect(appendGateShardLedgerForGate(path, { ...row, shardId: 'pod-next' }, false)).toContain('unterminated JSONL row');
  const legacy = read.rows.map(({ batchSize: _batchSize, ...entry }) => entry);
  writeFileSync(path, `${legacy.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  const oldFormat = readGateShardLedger(path)!;
  expect(oldFormat.incompleteBatches).toEqual([]);
  expect(oldFormat.sizeUnknownBatches).toEqual([read.rows[0]!.batchId!]);
  writeFileSync(path, `${JSON.stringify(legacy[0])}\n${JSON.stringify(read.rows[1])}\n`);
  const mixedFormat = readGateShardLedger(path)!;
  expect(mixedFormat.incompleteBatches).toEqual([read.rows[0]!.batchId!]);
  expect(mixedFormat.sizeUnknownBatches).toEqual([]);
  expect(() => appendGateShardLedgerBatch(path, [row, { ...row, files: ['src/b.test.ts'] }], true)).toThrow('duplicate shard id');
  const blocked = join(root, 'occupied');
  writeFileSync(blocked, 'file');
  expect(() => appendGateShardLedgerBatch(join(blocked, 'ledger.jsonl'), [row], true)).toThrow();
});
