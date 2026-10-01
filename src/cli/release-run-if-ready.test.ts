import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { releaseReadiness, type ReleaseReadiness } from '../../scripts/release-loop/release-readiness.js';
import { runReleaseIfReady } from './release-run-if-ready.js';

const version = '0.2.7';
const gate = { ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] };
const ready = (): ReleaseReadiness => ({ ready: true, reason: 'ready', details: gate });

async function fixture(check: (root: string, lock: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'release-if-ready-'));
  try { await check(root, join(root, 'release', version, 'run.lock')); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('blocked checklist skips the graph and names red, undecided and blocked ids in the readiness observation', async () => fixture(async (root, lock) => {
  let calls = 0;
  const events: Array<{ category: string; reason: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, reason, data) => { events.push({ category, reason, data }); });
  try {
    const result = await runReleaseIfReady(version, { ledgerRoot: root,
      readiness: () => ({ ready: false, reason: 'checklist-blocked', details: { ...gate, ok: false, red: ['K1'], undecided: ['K2'], blocked: ['K3'] } }),
      run: async () => { calls++; return 'graph'; } });
    expect(result).toEqual({ skipped: true, reason: 'checklist-blocked', detail: 'K1, K2, K3' });
    expect(calls).toBe(0);
    expect(existsSync(lock)).toBe(false);
    expect(events).toContainEqual({ category: 'release-loop.readiness', reason: 'checklist-blocked', data: { version, detail: 'K1, K2, K3' } });
  } finally { log.mockRestore(); }
}));

test('publishedAt prevents the graph even when the release has no lock', async () => fixture(async (root, lock) => {
  let calls = 0;
  const result = await runReleaseIfReady(version, { ledgerRoot: root,
    readiness: () => ({ ready: false, reason: 'already-published', details: '2026-10-01T01:00:00Z' }),
    run: async () => { calls++; return 'graph'; } });
  expect(result).toEqual({ skipped: true, reason: 'already-published', detail: '2026-10-01T01:00:00Z' });
  expect(calls).toBe(0);
  expect(existsSync(lock)).toBe(false);
}));

test('graph sees exclusive lock with pid and startedAt; both completion and exception remove it', async () => fixture(async (root, lock) => {
  const now = () => new Date('2026-10-04T04:10:00Z');
  const deps = { ledgerRoot: root, readiness: ready, pid: 427, now };
  expect(await runReleaseIfReady(version, { ...deps, run: async () => {
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toEqual({ pid: 427, startedAt: '2026-10-04T04:10:00.000Z' });
    return 'done';
  } })).toEqual({ skipped: false, result: 'done' });
  expect(existsSync(lock)).toBe(false);
  await expect(runReleaseIfReady(version, { ...deps, run: async () => {
    expect(existsSync(lock)).toBe(true);
    throw new Error('graph failed');
  } })).rejects.toThrow('graph failed');
  expect(existsSync(lock)).toBe(false);
}));

test('two concurrent ready entrants call the graph only once; existing lock is never removed by the loser', async () => fixture(async (root, lock) => {
  let calls = 0;
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const running = new Promise<void>((resolve) => { entered = resolve; });
  const first = runReleaseIfReady(version, { ledgerRoot: root, readiness: ready, run: async () => { calls++; entered(); await waiting; return 'first'; } });
  await running;
  expect(existsSync(lock)).toBe(true);
  const second = await runReleaseIfReady(version, { ledgerRoot: root, readiness: ready, run: async () => { calls++; return 'second'; } });
  expect(second).toEqual({ skipped: true, reason: 'already-running', detail: 'run.lock already exists' });
  expect(existsSync(lock)).toBe(true);
  expect(calls).toBe(1);
  release();
  expect(await first).toEqual({ skipped: false, result: 'first' });
  expect(existsSync(lock)).toBe(false);
}));

test('a delayed preflight rechecks publishedAt after acquiring the lock, not the stale ready result', async () => fixture(async (root, lock) => {
  let resume!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  const atPreflight = new Promise<void>((resolve) => { entered = resolve; });
  let graphCalls = 0;
  let checks = 0;
  const second = runReleaseIfReady(version, { ledgerRoot: root,
    readiness: async (_version, options) => {
      checks++;
      if (checks === 1) { entered(); await paused; return ready(); }
      expect(options?.isPidAlive?.(process.pid)).toBe(false);
      return releaseReadiness(version, { ledgerRoot: root, checklist: () => gate, ...options });
    },
    run: async () => { graphCalls++; return 'second'; } });
  await atPreflight;
  const first = await runReleaseIfReady(version, { ledgerRoot: root, readiness: ready, run: async () => {
    graphCalls++;
    writeFileSync(join(root, 'release', version, 'release.json'), JSON.stringify({ publishedAt: '2026-10-04T04:10:00Z' }));
    return 'first';
  } });
  expect(first).toEqual({ skipped: false, result: 'first' });
  expect(existsSync(lock)).toBe(false);
  resume();
  expect(await second).toEqual({ skipped: true, reason: 'already-published', detail: '2026-10-04T04:10:00Z' });
  expect(checks).toBe(2);
  expect(graphCalls).toBe(1);
  expect(existsSync(lock)).toBe(false);
}));

test('a checklist blocked after preflight is rechecked under lock and skips the graph', async () => fixture(async (root, lock) => {
  let checks = 0;
  let graphCalls = 0;
  const result = await runReleaseIfReady(version, { ledgerRoot: root,
    readiness: (_version, options) => {
      checks++;
      if (!options) return ready();
      expect(options.isPidAlive?.(process.pid)).toBe(false);
      return { ready: false, reason: 'checklist-blocked', details: { ...gate, ok: false, red: ['K16'] } };
    },
    run: async () => { graphCalls++; return 'graph'; } });
  expect(result).toEqual({ skipped: true, reason: 'checklist-blocked', detail: 'K16' });
  expect(checks).toBe(2);
  expect(graphCalls).toBe(0);
  expect(existsSync(lock)).toBe(false);
}));

test('a recheck exception also releases the acquired lock', async () => fixture(async (root, lock) => {
  await expect(runReleaseIfReady(version, { ledgerRoot: root,
    readiness: (_version, options) => {
      if (options) throw new Error('recheck failed');
      return ready();
    },
    run: async () => { throw new Error('must not run'); } })).rejects.toThrow('recheck failed');
  expect(existsSync(lock)).toBe(false);
}));

test('pre-existing lock is not overwritten or deleted', async () => fixture(async (root, lock) => {
  await runReleaseIfReady(version, { ledgerRoot: root, readiness: ready, run: async () => 'initial' });
  writeFileSync(lock, 'owned elsewhere');
  const result = await runReleaseIfReady(version, { ledgerRoot: root, readiness: ready, run: async () => { throw new Error('must not run'); } });
  expect(result).toMatchObject({ skipped: true, reason: 'already-running' });
  expect(readFileSync(lock, 'utf8')).toBe('owned elsewhere');
}));
