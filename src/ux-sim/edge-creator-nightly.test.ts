import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  edgeCreatorFailureCellId,
  runEdgeCreatorNightly,
  startEdgeCreatorNightlyScheduler,
  type EdgeCreatorNightlyResult,
} from './edge-creator-nightly.js';
import { EDGE_CREATOR_INCIDENT_SEEDS, generateEdgeCreatorPlan } from './edge-creator.js';

test('nightly simulation turns each failed invariant into a stable, targetable checklist cell', async () => {
  const created: Array<{ version: string; id: string; title: string; owner: string }> = [];
  const result = await runEdgeCreatorNightly({
    version: () => '0.3.8',
    runM2: async () => ({ runId: 'm2-fail', status: 'failed', executedIncidentIds: ['E1'], invariantEvidence: {
      E1: { seedInvariant: 'completed-receipts-survive-interruption', passed: false },
    } }),
    runE5: async () => ({
      runId: 'e5-fail', verdict: 'red', invariantViolations: ['I2-retry-not-repeated'], interruptedStatus: 'running',
      resumedStatus: 'failed', baselineTerminal: 'done', resumedTerminal: 'failed', baselineStatus: 'done',
      baselineAppendCount: 1, baselineRepairCalls: 1, appendCount: 1, sourceReceiptPreserved: true,
      sourceReceiptBefore: {}, sourceReceiptAfter: {}, repairCallsByIdempotencyKey: {}, effectsByIdempotencyKey: {},
      runNodeExecutionCount: Number.NaN, declaredRunNodeExecutionLimit: Number.NaN,
      perRunTimeoutMs: 10_000, // 출처: #35989 E5 subprocess bound
    }),
    ensureCell: (cell) => { created.push(cell); return true; },
  });

  expect(result.status).toBe('red');
  expect(result.failures.map(({ key }) => key)).toEqual([
    'E1:completed-receipts-survive-interruption', 'E5:I2-retry-not-repeated',
  ]);
  expect(created).toHaveLength(2);
  expect(created[0]).toMatchObject({ version: '0.3.8', owner: 'OPC', title: expect.stringContaining('대상 경로: src/ux-sim/edge-creator.ts') });
  expect(created[0]?.id).toBe(edgeCreatorFailureCellId('E1:completed-receipts-survive-interruption'));
  expect(created[1]?.title).toContain('E5 observed evidence:');
  expect(created[1]?.title).toContain('runId=e5-fail');
  expect(created[1]?.title).toContain('resumedTerminal=failed');
  expect(created[1]?.title).toContain('runNodeExecutionCount=NaN');
  expect(result.cellRecordingComplete).toBe(true);
});

test('E5 verdict fallback cell preserves measured execution evidence', async () => {
  const created: string[] = [];
  await runEdgeCreatorNightly({
    runM2: async () => ({ runId: 'm2-done', status: 'done', executedIncidentIds: [], invariantEvidence: {} }),
    runE5: async () => ({
      runId: 'e5-fail', verdict: 'red', invariantViolations: [], interruptedStatus: 'running', resumedStatus: 'failed',
      baselineTerminal: 'done', resumedTerminal: 'failed', baselineStatus: 'done', baselineAppendCount: 2,
      baselineRepairCalls: 1, appendCount: 2, sourceReceiptPreserved: true, sourceReceiptBefore: {}, sourceReceiptAfter: {},
      repairCallsByIdempotencyKey: {}, effectsByIdempotencyKey: {}, runNodeExecutionCount: 3,
      declaredRunNodeExecutionLimit: 2, perRunTimeoutMs: 10_000,
    }),
    ensureCell: ({ title }) => { created.push(title); return true; },
  });
  expect(created).toHaveLength(1);
  expect(created[0]).toContain('violation=none-reported');
  expect(created[0]).toContain('resumedTerminal=failed');
  expect(created[0]).toContain('runNodeExecutionCount=3');
});

test('nightly scheduler is due once per timezone day and retries a run whose failures did not get cells', async () => {
  const root = mkdtempSync(join(tmpdir(), 'edge-creator-nightly-test-'));
  try {
    const statePath = join(root, 'state.json');
    let now = new Date('2026-11-08T16:59:00.000Z'); // 01:59 KST
    let runs = 0;
    let failCellRecording = true;
    const pendingSeen: string[][] = [];
    const failure = { key: 'E1:broken', incidentId: 'E1', invariant: 'broken', summary: 'broken', detail: 'fixture' };
    const run = async (pendingFailures: readonly { key: string }[] = []): Promise<EdgeCreatorNightlyResult> => {
      runs += 1;
      pendingSeen.push(pendingFailures.map(({ key }) => key));
      return { status: 'red', version: '0.3.8', plan: null, m2: null, e5: null,
        failures: [failure], unrecordedFailures: failCellRecording ? [failure] : [],
        checklistCellIds: failCellRecording ? [] : ['SIM-EDGE-NIGHTLY-E1'], cellRecordingComplete: !failCellRecording };
    };
    const start = () => startEdgeCreatorNightlyScheduler({
      enabled: true, runOnStart: false, timeZone: 'Asia/Seoul', statePath, now: () => now, run,
      setIntervalImpl: (() => 1) as unknown as typeof setInterval,
      clearIntervalImpl: () => {}, onError: () => {},
    });
    const first = start();
    await first.tickNow();
    expect(runs).toBe(0);

    now = new Date('2026-11-08T17:00:00.000Z'); // 02:00 KST
    await first.tickNow();
    expect(runs).toBe(1);
    expect(first.diagnostics()).toMatchObject({ lastRunDay: null });
    failCellRecording = false;
    await first.tickNow();
    expect(runs).toBe(2);
    expect(pendingSeen[1]).toEqual(['E1:broken']);
    expect(first.diagnostics()).toMatchObject({ lastRunDay: '2026-11-09' });
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ schema: 1, lastRunDay: '2026-11-09', pendingFailures: [] });
    await first.tickNow();
    expect(runs).toBe(2);
    first.stop();

    const restarted = start();
    await restarted.tickNow();
    expect(runs).toBe(2);
    now = new Date('2026-11-09T17:00:00.000Z');
    await restarted.tickNow();
    expect(runs).toBe(3);
    restarted.stop();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('disabled nightly scheduler creates no timer and does not execute', async () => {
  let timers = 0;
  let runs = 0;
  const scheduler = startEdgeCreatorNightlyScheduler({
    enabled: false, run: async () => { runs += 1; return { status: 'green', version: '0.3.8', plan: null, m2: null, e5: null, failures: [], unrecordedFailures: [], checklistCellIds: [], cellRecordingComplete: true }; },
    setIntervalImpl: (() => { timers += 1; return 1; }) as unknown as typeof setInterval,
    clearIntervalImpl: () => {},
  });
  await scheduler.tickNow();
  expect(timers).toBe(0);
  expect(runs).toBe(0);
  expect(scheduler.diagnostics()).toMatchObject({ enabled: false, lastRunDay: null });
  scheduler.stop();
});

test('scheduler migrates the prior day-only state without rerunning that day', async () => {
  const root = mkdtempSync(join(tmpdir(), 'edge-creator-nightly-legacy-'));
  try {
    const statePath = join(root, 'state.json');
    writeFileSync(statePath, JSON.stringify({ schema: 1, day: '2026-11-09', status: 'red', checklistCellIds: ['existing'] }));
    let runs = 0;
    const scheduler = startEdgeCreatorNightlyScheduler({
      enabled: true, runOnStart: false, timeZone: 'Asia/Seoul', statePath,
      now: () => new Date('2026-11-08T18:00:00.000Z'), run: async () => {
        runs += 1;
        return { status: 'green', version: '0.3.8', plan: null, m2: null, e5: null,
          failures: [], unrecordedFailures: [], checklistCellIds: [], cellRecordingComplete: true };
      },
      setIntervalImpl: (() => 1) as unknown as typeof setInterval,
      clearIntervalImpl: () => {}, onError: () => {},
    });
    await scheduler.tickNow();
    expect(runs).toBe(0);
    expect(scheduler.diagnostics()).toMatchObject({ lastRunDay: '2026-11-09' });
    scheduler.stop();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('current incident seed catalog remains the nightly run input', () => {
  expect(generateEdgeCreatorPlan(EDGE_CREATOR_INCIDENT_SEEDS).coveredIncidentIds).toEqual(
    EDGE_CREATOR_INCIDENT_SEEDS.map((seed) => seed.incidentId).sort(),
  );
});
