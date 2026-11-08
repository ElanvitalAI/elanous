import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairLandingEventFromGhJson } from './gate-repair-node.js';
import { RepairLandingHeadMismatchError, RepairLandingRecoveryExhaustedError, waitForRepairPrLanded } from './repair-pr-landed.js';

const event = { schema: 1 as const, prNumber: 80421, repairRunId: 'repair-run-recover', head: 'a'.repeat(40),
  mergeSha: 'b'.repeat(40), base: 'main', mergedAt: '2026-11-07T00:00:00.000Z' };

test('accepts only a same-run PR confirmed merged into main during receipt recovery', () => {
  const common = { title: 'RLA-GATE-REPAIR repair-run-recover 0.3.7: src/release/test.ts', headRefOid: event.head,
    baseRefName: 'main', mergeCommit: { oid: event.mergeSha }, mergedAt: event.mergedAt };
  expect(repairLandingEventFromGhJson(JSON.stringify({ ...common, state: 'OPEN' }), event.prNumber, event.repairRunId)).toBeUndefined();
  expect(repairLandingEventFromGhJson(JSON.stringify({ ...common, state: 'MERGED' }), event.prNumber, event.repairRunId)).toEqual(event);
  expect(() => repairLandingEventFromGhJson(JSON.stringify({ ...common, state: 'MERGED', baseRefName: 'release' }),
    event.prNumber, event.repairRunId)).toThrow('missing its head, main base');
  expect(() => repairLandingEventFromGhJson(JSON.stringify({ ...common, state: 'MERGED', title: 'other PR' }),
    event.prNumber, event.repairRunId)).toThrow('title/run identity mismatch');
});

test('repairs a missing landing receipt from the merged PR and publishes it for the waiting run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'repair-pr-landed-recover-'));
  let attempts = 0;
  try {
    const recovered = await waitForRepairPrLanded(event.prNumber, { root, repairRunId: event.repairRunId,
      recoveryIntervalMs: 2, recover: async () => {
        attempts++;
        if (attempts === 1) throw new Error('transient GitHub query failure');
        return event;
      } });
    expect(recovered).toEqual(event);
    expect(attempts).toBe(2);
    expect(await Bun.file(join(root, 'release', 'repair-pr-landings', `${event.prNumber}.json`)).json()).toEqual(event);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('exhausted landing recovery rejects so the graph can enter its HITL recovery node', async () => {
  const root = mkdtempSync(join(tmpdir(), 'repair-pr-landed-exhausted-'));
  let attempts = 0;
  try {
    await expect(waitForRepairPrLanded(event.prNumber, { root, repairRunId: event.repairRunId,
      recoveryIntervalMs: 2, maxRecoveryFailures: 2, recover: async () => {
        attempts++;
        throw new Error('persistent GitHub query failure');
      } })).rejects.toThrow('landing recovery exhausted after 2 attempts');
    expect(attempts).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects a recovered receipt with a different inspected head before persisting it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'repair-pr-landed-wrong-head-'));
  let attempts = 0;
  try {
    await expect(waitForRepairPrLanded(event.prNumber, { root, repairRunId: event.repairRunId, expectedHead: 'c'.repeat(40),
      recoveryIntervalMs: 2, maxRecoveryFailures: 2, recover: async () => { attempts++; return event; } }))
      .rejects.toBeInstanceOf(RepairLandingHeadMismatchError);
    expect(attempts).toBe(1);
    expect(await Bun.file(join(root, 'release', 'repair-pr-landings', `${event.prNumber}.json`)).exists()).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('retries watcher setup failures and exhausts into the HITL recovery disposition', async () => {
  const root = mkdtempSync(join(tmpdir(), 'repair-pr-landed-watcher-failure-'));
  let watchAttempts = 0;
  let recoveryAttempts = 0;
  try {
    await expect(waitForRepairPrLanded(event.prNumber, { root, repairRunId: event.repairRunId,
      recoveryIntervalMs: 2, maxRecoveryFailures: 2,
      watchDirectory: () => { watchAttempts++; throw new Error('injected receipt watcher filesystem error'); },
      recover: async () => { recoveryAttempts++; return undefined; },
    })).rejects.toBeInstanceOf(RepairLandingRecoveryExhaustedError);
    expect(watchAttempts).toBeGreaterThanOrEqual(2);
    expect(recoveryAttempts).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
