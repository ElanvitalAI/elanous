import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryRunningRuns } from './running-runs.js';
import { createRunningRunsBackground } from '../nexus/api/running-runs-background.js';

function fixture(count: number): { root: string; directory: string } {
  const root = mkdtempSync(join(tmpdir(), 'running-runs-cache-diagnosis-'));
  const directory = join(root, 'run-ledger');
  mkdirSync(directory);
  for (let n = 0; n < count; n += 1) {
    const runId = `run-00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
    writeFileSync(join(directory, `${runId}.jsonl`),
      `${JSON.stringify({ runId, event: 'run-status', timestamp: '2026-10-09T00:00:00Z', data: { runStatus: 'completed' } })}\n`);
  }
  return { root, directory };
}

function query(directory: string, noCache = false) {
  return queryRunningRuns({ noCache, caller: 'cache-diagnosis' }, {
    ledgerDirectories: () => [directory],
    ptyTargets: () => [],
    listPtyRefs: () => ({ refs: [], unreadable: [] }),
    readRunPhases: () => ({ events: [], targetCount: 0, unreadableTargets: [] }),
    observeQuery: () => {},
  });
}

function childQuery(root: string, directory: string): { pid: number; hits: number; misses: number; total: number } {
  const source = `import { queryRunningRuns } from './src/self-implement/running-runs.ts';
    const result = queryRunningRuns({ caller: 'cache-diagnosis-child' }, {
      ledgerDirectories: () => [process.env.DIAG_LEDGER_DIR],
      ptyTargets: () => [], listPtyRefs: () => ({ refs: [], unreadable: [] }),
      readRunPhases: () => ({ events: [], targetCount: 0, unreadableTargets: [] }),
      observeQuery: () => {},
    });
    console.log(JSON.stringify({ pid: process.pid, hits: result.ledger.cacheHits, misses: result.ledger.cacheMisses, total: result.total }));`;
  const child = Bun.spawnSync([process.execPath, '-e', source], {
    cwd: process.cwd(),
    env: { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_CONFIG_DIR: root, DIAG_LEDGER_DIR: directory },
    stdout: 'pipe', stderr: 'pipe',
  });
  if (child.exitCode !== 0) throw new Error(`diagnostic child exited ${child.exitCode}: ${child.stderr.toString()}`);
  return JSON.parse(child.stdout.toString().trim()) as { pid: number; hits: number; misses: number; total: number };
}

test('the real running-runs query reuses ledger facts in one process, not across fresh children', () => {
  const { root, directory } = fixture(3);
  try {
    const cold = query(directory);
    const warm = query(directory);
    const bypass = query(directory, true);
    const afterBypass = query(directory);
    const firstChild = childQuery(root, directory);
    const secondChild = childQuery(root, directory);
    expect([cold.ledger.cacheHits, cold.ledger.cacheMisses]).toEqual([0, 3]);
    expect([warm.ledger.cacheHits, warm.ledger.cacheMisses]).toEqual([3, 0]);
    expect([bypass.ledger.cacheHits, bypass.ledger.cacheMisses]).toEqual([0, 3]);
    expect([afterBypass.ledger.cacheHits, afterBypass.ledger.cacheMisses]).toEqual([3, 0]);
    expect([firstChild.hits, firstChild.misses, firstChild.total]).toEqual([0, 3, 0]);
    expect([secondChild.hits, secondChild.misses, secondChild.total]).toEqual([0, 3, 0]);
    expect(firstChild.pid).not.toBe(secondChild.pid);
    expect(cold.entries).toEqual(warm.entries);
    expect(cold.entries).toEqual([]);
    console.log(`CACHE_PROCESS_PROBE same-process=0/3,3/0 bypass=0/3 after-bypass=3/0 fresh-children=0/3,0/3 different-pid=true`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the daemon background reuses its result snapshot but starts a new query after expiry', async () => {
  const { root, directory } = fixture(3);
  let now = 1_000;
  const observations: Array<{ hits: number | undefined; misses: number | undefined }> = [];
  const background = createRunningRunsBackground(async () => {
    const result = query(directory);
    observations.push({ hits: result.ledger.cacheHits, misses: result.ledger.cacheMisses });
    return result;
  }, () => now, 15_000);
  try {
    expect(background.snapshot({})).toEqual({ result: null, ageMs: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    now += 5_000;
    expect(background.snapshot({}).ageMs).toBe(5_000);
    expect(observations).toEqual([{ hits: 0, misses: 3 }]);
    now += 15_000;
    expect(background.snapshot({}).result?.ledger.cacheMisses).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observations).toEqual([{ hits: 0, misses: 3 }, { hits: 3, misses: 0 }]);
    console.log('CACHE_DAEMON_SNAPSHOT_PROBE within-ttl-queries=1 expired-queries=2 same-process-refresh=3/0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a full scan above the old 5000-entry limit reuses mtime-checked ledger facts in the same process', () => {
  const { root, directory } = fixture(8_001);
  try {
    const cold = query(directory);
    const repeat = query(directory);
    const bypass = query(directory, true);
    expect([cold.ledger.cacheHits, cold.ledger.cacheMisses]).toEqual([0, 8_001]);
    expect([repeat.ledger.cacheHits, repeat.ledger.cacheMisses]).toEqual([8_001, 0]);
    expect([bypass.ledger.cacheHits, bypass.ledger.cacheMisses]).toEqual([0, 8_001]);
    expect([cold.total, repeat.total, bypass.total]).toEqual([0, 0, 0]);
    expect(repeat.entries).toEqual(cold.entries);
    console.log(`CACHE_CAPACITY_PROBE cold=0/8001 repeat=8001/0 noCache=0/8001 assessments=0`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
