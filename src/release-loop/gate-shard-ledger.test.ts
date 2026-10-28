import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendGateShardLedger, gateShardLedgerPath, latestGateShardLedger, readGateShardLedger, type GateShardLedgerRow } from './gate-shard-ledger.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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
