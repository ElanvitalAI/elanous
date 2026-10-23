// N02/N07: exercise the production release scheduler against an isolated ledger and injected clock/faults.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { rejudgeTick } from '../steward/rejudge-tick.js';
import { collectOverview, readSchedulerExecutionRows, type CollectDeps, type SchedulerExecutionObservation } from '../ops/overview-collect.js';
import { bindingResource } from '../ops/overview.js';
import { LogStore } from '../mss/logging/log-store.js';
import type { ResourceView } from '../control-plane/ledger.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRehearsalTick, spawnHardRehearsalGate, type RehearsalDeps } from './rehearsal.js';
import type { ReleaseSchedule } from './release-schedule.js';

const SHA = '1234567890abcdef';
const cut = Date.parse('2026-10-10T13:00:00Z');
const schedule = { version: '0.2.23', cutAt: new Date(cut).toISOString(), publishAt: new Date(cut + 150 * 60_000).toISOString() } as ReleaseSchedule;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function replay() {
  const root = mkdtempSync(join(tmpdir(), 'mock-clock-window-'));
  roots.push(root);
  const gateCalls: Array<{ id: string; sha: string; root: string }> = [];
  const rcCalls: Array<{ version: string; selection: { shards?: number; remote?: string } }> = [];
  const notices: string[] = [];
  const clock = { at: new Date(cut - 24 * 60 * 60_000) };
  const deps: RehearsalDeps = {
    now: () => clock.at, schedules: () => [schedule], hardIntervalHours: 12,
    shardPlan: () => ({ shards: 4, testFiles: 12, gatePlanShards: 4, resources: { cpus: 16, freeBytes: 12e9, totalBytes: 24e9 }, unmeasured: null }),
    git: (args) => ({ rc: 0, stdout: args[0] === 'rev-parse' ? `${SHA}\n` : '' }),
    leakCheck: () => ({ status: 0 }),
    hardGate: async (_version, _checkout, sha, ledgerRoot, id) => {
      gateCalls.push({ id, sha, root: ledgerRoot });
      return { outcome: 'ok', commit: sha, executor: 'pod', introduced: [], preexisting: 0 };
    },
    lightRc: async (version, _checkout, selection) => {
      rcCalls.push({ version, selection: { ...selection } });
      return { version, base: 'abc', measuredCommit: SHA, worktreeHead: SHA, importerTests: 0, unmeasured: null, introduced: 0, preexisting: 0, unclassified: 0, alwaysInclude: 1, alwaysIncludeMissing: [], shards: selection.shards ?? 4, remote: selection.remote ?? '', gateExitCode: 0, ok: true };
    },
    notify: (text) => { notices.push(text); },
  };
  const tick = () => runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: true, remote: 'node-b' }, deps);
  const readStamp = (step: string) => JSON.parse(readFileSync(join(root, 'release', schedule.version, 'rehearsal', `${step}.json`), 'utf8'));
  return { root, clock, deps, gateCalls, rcCalls, notices, tick, readStamp };
}

test('N07: production scheduler replays 24h/12h/5h ticks and persists each step only once', async () => {
  const h = replay();
  expect((await h.tick()).status).toBe('not-yet');
  expect(h.gateCalls).toHaveLength(0);
  h.clock.at = new Date(cut - 12 * 60 * 60_000);
  await h.tick();
  expect(h.readStamp('hard-mid')).toMatchObject({ outcome: 'ok', sha: SHA, hardGate: { commit: SHA, executor: 'pod' } });
  h.clock.at = new Date(cut - 5 * 60 * 60_000);
  await h.tick();
  expect(h.readStamp('hard-5h')).toMatchObject({ outcome: 'ok', sha: SHA, hardGate: { commit: SHA, executor: 'pod' } });
  await h.tick(); // same tick must not launch a second gate
  expect(h.gateCalls).toHaveLength(2);
  expect(new Set(h.gateCalls.map(call => call.id)).size).toBe(2);
  expect(h.gateCalls.every(call => call.sha === SHA && call.root === h.root)).toBe(true);
  h.clock.at = new Date(cut - 150 * 60_000);
  await h.tick();
  expect(h.readStamp('rc-150m')).toMatchObject({ outcome: 'ok', sha: SHA, result: { measuredCommit: SHA, worktreeHead: SHA, remote: 'node-b', gateExitCode: 0 } });
  expect(h.readStamp('rc-7h')).toMatchObject({ outcome: 'superseded' });
  await h.tick();
  expect(h.rcCalls).toHaveLength(1);
  expect(h.rcCalls).toMatchObject([{ version: schedule.version, selection: { remote: 'node-b', shards: 4 } }]);
});

test('N07: production rc-7h actually runs before a later hard-5h supersedes it', async () => {
  const h = replay();
  h.clock.at = new Date(cut - 7 * 60 * 60_000);
  await h.tick();
  expect(h.readStamp('rc-7h')).toMatchObject({ outcome: 'ok', sha: SHA, result: { measuredCommit: SHA, worktreeHead: SHA, remote: 'node-b', gateExitCode: 0 } });
  await h.tick();
  expect(h.rcCalls).toMatchObject([{ version: schedule.version, selection: { remote: 'node-b', shards: 4 } }]);
  expect(h.gateCalls).toHaveLength(0);
  h.clock.at = new Date(cut - 5 * 60 * 60_000);
  await h.tick();
  expect(h.readStamp('hard-5h')).toMatchObject({ outcome: 'ok', sha: SHA, hardGate: { commit: SHA, executor: 'pod' } });
  expect(h.readStamp('rc-7h')).toMatchObject({ outcome: 'ok', sha: SHA });
  await h.tick();
  expect(h.rcCalls).toHaveLength(1);
  expect(h.gateCalls).toMatchObject([{ sha: SHA, root: h.root }]);
});

test('N07/N02: production overview brackets 1h/24h events and fails soft on absent LogStore ledger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mock-overview-window-'));
  roots.push(root);
  const now = Date.parse('2026-10-10T13:00:00Z');
  const rows: SchedulerExecutionObservation[] = [
    { ts_ms: now - 24 * 3_600_000 - 1, data: '{"via":"crontab"}' }, // outside 24h
    { ts_ms: now - 23 * 3_600_000, data: '{"via":"crontab"}' },
    { ts_ms: now - 3_600_000 - 1, data: '{"via":"fabric"}' }, // outside 1h, inside 24h
    { ts_ms: now - 30 * 60_000, data: '{"via":"crontab"}' },
    { ts_ms: now - 10 * 60_000, data: '{"via":"fabric"}' },
  ];
  const machine = (name: string, freeGb: number): ResourceView => ({
    id: `machine-${name}`, kind: 'machine', machine: name, name, owner: 'test',
    attrs: { load: { loadAvg: [8, 8, 8], cpuCount: 8, freeMem: freeGb * 1024 ** 3, totalMem: 64 * 1024 ** 3, observedAt: now } },
    observedAt: now, ttlMs: 3_600_000, ageMs: 0, expired: false,
  });
  const resources = [machine('first', 40), machine('second', 5)];
  const db = join(root, 'schedule-logs.db');
  const writer = new LogStore(db, { instance: 'mock-window' });
  try {
    writer.insertBatch(rows.map(row => ({
      rec: { ts: new Date(row.ts_ms).toISOString(), category: 'schedule.run', event: 'completed', data: JSON.parse(row.data!) },
      surface: 'cli',
    })));
  } finally { writer.close(); }
  const readSchedulerRuns = (since: number, until: number) => readSchedulerExecutionRows(db, since, until);
  const deps: CollectDeps = {
    listSchedules: () => [], readSchedulerRuns,
    listChecklist: (version) => ({ version, released: '', dev: '', history: [], items: [] }),
    readRuns: () => [], readCards: () => [], ledger: () => resources, poolSpec: () => null,
    ps: () => '', gitLog: () => ({ lines: [], observedAt: new Date(now).toISOString() }),
  };
  const opts = { sinceMs: 3_600_000, sinceLabel: '최근 1h', now, root, seatEraDir: root };
  const first = await collectOverview(opts, deps);
  expect(first.schedulerMetrics?.value).toEqual({ scheduleRuns: 2, bunLaunches: 1, bunLaunchesLast24h: 2 });
  expect(first.schedulerMetrics?.source).toContain('schedule.run');
  expect(first.schedulerMetrics?.status).toBe('ok');
  expect(bindingResource(first)?.label).toBe('second 메모리');
  resources[1] = machine('second', 60);
  const rebalanced = await collectOverview(opts, deps);
  expect(bindingResource(rebalanced)?.label).toBe('first 메모리');
  const missingDb = join(root, 'absent-logs.db');
  const failed = await collectOverview(opts, { ...deps, readSchedulerRuns: (since, until) =>
    readSchedulerExecutionRows(missingDb, since, until), // production reader rejects absent ledger
  });
  expect(failed.schedulerMetrics).toMatchObject({ status: 'unmeasured', value: null });
  expect(failed.schedulerMetrics?.reason).toBeTruthy();
});

test('N02: real timed-out gate subprocess leaves evidence identity and later ticks do not rewrite the verdict', async () => {
  const h = replay();
  h.clock.at = new Date(cut - 12 * 60 * 60_000);
  let gateRuns = 0;
  h.deps.hardGate = async (_v, _checkout, sha, ledgerRoot, runId) => {
    gateRuns++;
    expect(sha).toBe(SHA);
    return spawnHardRehearsalGate({
      binary: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'],
      checkout: process.cwd(), ledgerRoot,
      logPath: join(ledgerRoot, 'release', schedule.version, 'rehearsal', `${runId}.log`),
      timeoutMs: 50, sha,
    });
  };
  const first = await h.tick();
  expect(first.status).toBe('due');
  const recorded = h.readStamp('hard-mid');
  expect(recorded).toMatchObject({ outcome: 'error', step: 'hard-mid', sha: SHA,
    measurementGap: { cause: expect.stringContaining('ETIMEDOUT'), runId: recorded.hardGateRunId, evidence: recorded.hardGateLog },
  });
  expect(readFileSync(recorded.hardGateLog, 'utf8')).toContain('ETIMEDOUT');
  expect(h.notices).toHaveLength(1);
  expect(gateRuns).toBe(1);
  h.deps.hardGate = async () => { throw new Error('second invocation is forbidden'); };
  await h.tick();
  expect(h.readStamp('hard-mid')).toEqual(recorded);
  expect(gateRuns).toBe(1);
  expect(h.notices).toHaveLength(1);
});

test('N02: unreadable steward stamp is not mistaken for a successful run; repair retries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mock-stamp-read-fault-'));
  roots.push(root);
  const stampPath = join(root, 'stamp.json');
  const pendingPath = join(root, 'pending.json');
  // EISDIR is a deterministic read fault even under root, unlike chmod-based permission tests.
  mkdirSync(stampPath);
  let runs = 0;
  const events: Array<{ event: string; decision: string }> = [];
  const deps = {
    now: () => new Date('2026-10-10T01:00:00Z'), config: () => ({ rejudgeEveryMinutes: 60 }),
    stampPath, pendingPath, load: () => 0,
    run: async () => { runs++; return { code: 0, stdout: '[]\n', stderr: '', timedOut: false }; },
    log: (event: string, data: { decision: string }) => { events.push({ event, decision: data.decision }); },
  };
  const failed = await rejudgeTick(deps);
  expect(failed.decision).toBe('failed');
  expect(failed.reason).toMatch(/directory|EISDIR/);
  expect(runs).toBe(0);
  expect(events).toMatchObject([{ decision: 'failed' }]);
  rmdirSync(stampPath);
  writeFileSync(stampPath, '{corrupt-json');
  const corrupt = await rejudgeTick(deps);
  expect(corrupt.decision).toBe('failed');
  expect(corrupt.reason).toBeTruthy();
  expect(readFileSync(stampPath, 'utf8')).toBe('{corrupt-json');
  for (const payload of ['{}', '{"startedAt":"not-a-date"}']) {
    writeFileSync(stampPath, payload);
    const invalid = await rejudgeTick(deps);
    expect(invalid.decision).toBe('failed');
    expect(invalid.reason).toContain('invalid steward stamp startedAt');
    expect(readFileSync(stampPath, 'utf8')).toBe(payload);
  }
  expect(runs).toBe(0);
  rmSync(stampPath);
  expect((await rejudgeTick(deps)).decision).toBe('ran');
  expect(runs).toBe(1);
  expect(JSON.parse(readFileSync(stampPath, 'utf8')).startedAt).toBe('2026-10-10T01:00:00.000Z');
});

test('N02: unwritable steward stamp fails soft without launching; repair retries in same isolated state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mock-ledger-fault-'));
  roots.push(root);
  const stampPath = join(root, 'stamp.json');
  const savedStampPath = join(root, 'saved-stamp.json');
  const pendingPath = join(root, 'pending.json');
  writeFileSync(stampPath, JSON.stringify({ startedAt: '2026-10-09T00:00:00.000Z' }));
  let runs = 0;
  let reads = 0;
  const deps = {
    now: () => new Date('2026-10-10T01:00:00Z'), config: () => ({ rejudgeEveryMinutes: 60 }),
    load: () => {
      // rejudgeTick reads the previous stamp before it calls load(). Now turn only the write target
      // into a directory: EISDIR is deterministic even for root, without blocking the earlier read.
      reads++;
      if (reads === 1) { renameSync(stampPath, savedStampPath); mkdirSync(stampPath); }
      return 0;
    },
    stampPath, pendingPath, run: async () => { runs++; return { code: 0, stdout: '[]\n', stderr: '', timedOut: false }; },
    log: () => {},
  };
  const failed = await rejudgeTick(deps);
  expect(failed.decision).toBe('failed');
  expect(reads).toBe(1); // load() is reached only after the production reader consumed the stamp
  expect(failed.reason).toMatch(/directory|EISDIR/);
  expect(readFileSync(savedStampPath, 'utf8')).toContain('2026-10-09');
  expect(runs).toBe(0);
  rmdirSync(stampPath);
  renameSync(savedStampPath, stampPath);
  const retried = await rejudgeTick(deps);
  expect(retried.decision).toBe('ran');
  expect(runs).toBe(1);
  expect(JSON.parse(readFileSync(stampPath, 'utf8')).startedAt).toBe('2026-10-10T01:00:00.000Z');
});

test('N07: an isolated 24h/1h/three-tick clock replays production steward cadence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mock-steward-window-'));
  roots.push(root);
  const stampPath = join(root, 'steward', 'rejudge-tick.json');
  const pendingPath = join(root, 'steward', 'resync-pending.json');
  const clock = { at: new Date('2026-10-10T00:00:00Z') };
  let runs = 0;
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const deps = {
    now: () => clock.at,
    config: () => ({ rejudgeEveryMinutes: 60, rejudgeMaxLoad: 10 }),
    load: () => 1,
    stampPath, pendingPath,
    run: async () => { runs++; return { code: 0, stdout: '[{"card":"fixed-card","decision":"pr-not-open"}]\n', stderr: '', timedOut: false }; },
    log: (event: string, data: Record<string, unknown>) => { events.push({ event, data }); },
  };
  expect((await rejudgeTick(deps)).decision).toBe('ran');
  expect((await rejudgeTick(deps)).decision).toBe('not-due');
  clock.at = new Date(clock.at.getTime() + 60 * 60_000);
  expect((await rejudgeTick(deps)).decision).toBe('ran');
  clock.at = new Date(clock.at.getTime() + 24 * 60 * 60_000);
  expect((await rejudgeTick(deps)).decision).toBe('ran');
  expect(runs).toBe(3);
  expect(events.filter(row => row.data.decision === 'ran').map(row => row.data.cards)).toEqual([1, 1, 1]);
  expect(JSON.parse(readFileSync(stampPath, 'utf8')).startedAt).toBe(clock.at.toISOString());
});
