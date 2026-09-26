// GET /v1/terminals must not re-run queryRunningRuns on every poll.
// The injected function is the only running-runs source — no ledger is read.

import { describe, expect, test } from 'bun:test';
import { createRunningRunsCache, handleTerminalsList, RUNNING_RUNS_CACHE_TTL_MS, type SubjectRunningRunsSummary } from '../src/nexus/api/terminals.js';
import type { RunningRunsResult } from '../src/self-implement/running-runs.js';
import type { MetaApiOpts } from '../src/nexus/api/meta-api.js';

const opts: MetaApiOpts = { noAuth: true };

function bareReq(url = 'http://localhost/v1/terminals'): Request {
  return new Request(url);
}

function runningRunsResult(marker: string): RunningRunsResult {
  return { marker, entries: [] } as unknown as RunningRunsResult;
}

function listDeps(
  queryRunningRuns: (options: { includeTest?: boolean }) => RunningRunsResult,
  now: () => number,
) {
  return {
    ptyManifestTargets: () => [{ name: 'current', dbPath: '/tmp/elanous-terminals-cache-test.db' }],
    listPtyManifestRows: () => [],
    listPtyManifestRowsAt: () => [],
    isProcessAlive: () => false,
    listPty: () => [],
    reapDeadPtyManifest: () => 0,
    purgeClosedPtyManifest: () => 0,
    reapStalePtyManifest: () => 0,
    reapOrphanedOwnedPtyManifest: () => 0,
    getDefaultLogStore: () => null,
    queryRunningRuns,
    now,
  };
}

async function bodyOf(res: Response): Promise<{ runningRuns: SubjectRunningRunsSummary; runningRunsAgeMs: number | null }> {
  const text = await res.text();
  if (res.status !== 200) throw new Error(`status ${res.status}: ${text}`);
  return JSON.parse(text) as { runningRuns: SubjectRunningRunsSummary; runningRunsAgeMs: number | null };
}

describe('GET /v1/terminals running-runs cache', () => {
  test('two calls inside 15s invoke the injected queryRunningRuns once and expose ageMs', async () => {
    let calls = 0;
    let now = 1_000_000;
    const seen: boolean[] = [];
    const queryRunningRuns = (options: { includeTest?: boolean }) => {
      calls += 1;
      seen.push(options.includeTest === true);
      return runningRunsResult('once');
    };
    const deps = listDeps(queryRunningRuns, () => now);
    const first = await bodyOf(handleTerminalsList(bareReq(), opts, deps));
    now += 1_000;
    const second = await bodyOf(handleTerminalsList(bareReq(), opts, deps));
    expect(calls).toBe(1);
    expect(seen).toEqual([false]);
    expect(first.runningRuns).toEqual({ running: 0, 'probable-running': 0, countedStatuses: ['running', 'probable-running'] });
    expect(first.runningRunsAgeMs).toBe(0);
    expect(second.runningRunsAgeMs).toBe(1_000);
    expect(second.runningRuns).toEqual(first.runningRuns);
  });

  test('a call after the TTL expires invokes the injected queryRunningRuns again', async () => {
    let calls = 0;
    let now = 2_000_000;
    const queryRunningRuns = () => {
      calls += 1;
      return runningRunsResult(`gen-${calls}`);
    };
    const deps = listDeps(queryRunningRuns, () => now);
    await handleTerminalsList(bareReq(), opts, deps);
    now += RUNNING_RUNS_CACHE_TTL_MS;
    const after = await bodyOf(handleTerminalsList(bareReq(), opts, deps));
    expect(calls).toBe(2);
    expect(after.runningRunsAgeMs).toBe(0);
  });

  test('the same includeTest shares one in-flight computation', () => {
    let calls = 0;
    const cache = createRunningRunsCache({
      now: () => 3_000_000,
      queryRunningRuns: (options) => {
        calls += 1;
        if (calls === 1) cache(options);
        return runningRunsResult(options.includeTest ? 'test' : 'prod');
      },
    });
    const first = cache({ includeTest: true });
    const second = cache({ includeTest: true });
    expect(calls).toBe(1);
    expect(first.result).toBe(second.result);
    expect(first.ageMs).toBe(0);
    expect(second.ageMs).toBe(0);
  });

  test('a different includeTest is a different cache slot', async () => {
    let calls = 0;
    const now = () => 4_000_000;
    const seen: boolean[] = [];
    const queryRunningRuns = (options: { includeTest?: boolean }) => {
      calls += 1;
      seen.push(options.includeTest === true);
      return runningRunsResult(options.includeTest ? 'test' : 'prod');
    };
    const deps = listDeps(queryRunningRuns, now);
    await handleTerminalsList(bareReq(), opts, deps);
    await handleTerminalsList(bareReq('http://localhost/v1/terminals?includeTest=true'), opts, deps);
    await handleTerminalsList(bareReq(), opts, deps);
    expect(calls).toBe(2);
    expect(seen).toEqual([false, true]);
  });
});
