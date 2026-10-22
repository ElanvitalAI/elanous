import { afterEach, describe, expect, test } from 'bun:test';
import {
  _resetSelfAmbientCacheForTest,
  cachedSelfAmbientBaseParts,
  refreshSelfAmbientCache,
  SELF_AMBIENT_FRESH_MS,
  selfAmbientKeepWarmIntervalMs,
  SELF_AMBIENT_STALE_MAX_MS,
  type SelfAmbientCacheDeps,
} from './self-ambient-cache.js';

function harness(start = 1_000_000) {
  let now = start;
  let syncCalls = 0;
  let workerCalls = 0;
  const events: string[] = [];
  let workerResult: string[] = ['worker'];
  const deps: SelfAmbientCacheDeps = {
    now: () => now,
    computeSync: () => { syncCalls += 1; return [`sync-${syncCalls}`]; },
    computeInWorker: async () => { workerCalls += 1; return [...workerResult]; },
    universeKey: () => ({ stateRoot: '/state', selectedRoot: '/root' }),
    log: (_c, event) => { events.push(event); },
  };
  return {
    deps,
    advance: (ms: number) => { now += ms; },
    setWorkerResult: (r: string[]) => { workerResult = r; },
    get syncCalls() { return syncCalls; },
    get workerCalls() { return workerCalls; },
    events,
  };
}

describe('self-ambient cache (TUI turn path)', () => {
  afterEach(() => { _resetSelfAmbientCacheForTest(); });

  test('keep-warm cadence backs off after two idle minutes while retaining active freshness', () => {
    expect(selfAmbientKeepWarmIntervalMs(0)).toBe(25_000);
    expect(selfAmbientKeepWarmIntervalMs(119_999)).toBe(25_000);
    expect(selfAmbientKeepWarmIntervalMs(120_000)).toBe(8 * 60_000);
    expect(selfAmbientKeepWarmIntervalMs(10 * 60_000)).toBe(8 * 60_000);
  });

  test('a warmed cache serves the turn without a synchronous scan, fresh or stale', async () => {
    const h = harness();
    await refreshSelfAmbientCache(h.deps);
    expect(h.workerCalls).toBe(1);
    expect(cachedSelfAmbientBaseParts(h.deps)).toEqual(['worker']);
    h.advance(SELF_AMBIENT_FRESH_MS + 1);
    h.setWorkerResult(['worker-2']);
    expect(cachedSelfAmbientBaseParts(h.deps)).toEqual(['worker']);
    expect(h.syncCalls).toBe(0);
    expect(h.events).toContain('stale-hit');
  });

  test('an empty or too-old cache falls back to the synchronous scan (content preserved)', () => {
    const h = harness();
    expect(cachedSelfAmbientBaseParts(h.deps)).toEqual(['sync-1']);
    h.advance(SELF_AMBIENT_STALE_MAX_MS + 1);
    expect(cachedSelfAmbientBaseParts(h.deps)).toEqual(['sync-2']);
    expect(h.syncCalls).toBe(2);
  });

  test('a keep-warm tick leaves a young entry alone and refreshes an older one', async () => {
    const h = harness();
    await refreshSelfAmbientCache(h.deps);
    h.advance(10_000);
    await refreshSelfAmbientCache(h.deps, { ifOlderThanMs: 25_000 });
    expect(h.workerCalls).toBe(1);
    h.advance(20_000);
    await refreshSelfAmbientCache(h.deps, { ifOlderThanMs: 25_000 });
    expect(h.workerCalls).toBe(2);
  });

  test('a worker result never overwrites a newer synchronous computation (monotonic version, same ms)', async () => {
    const h = harness();
    let release!: (v: string[]) => void;
    const deps: SelfAmbientCacheDeps = {
      ...h.deps,
      computeInWorker: () => new Promise<string[]>(r => { release = r; }),
    };
    const refresh = refreshSelfAmbientCache(deps);
    // Same millisecond: a synchronous first-turn scan stores while the worker is in flight.
    const sync = cachedSelfAmbientBaseParts(deps);
    release(['older-worker']);
    await refresh;
    expect(cachedSelfAmbientBaseParts(deps)).toEqual(sync);
  });

  test('a failed worker is fail-soft and backs off', async () => {
    const h = harness();
    const deps: SelfAmbientCacheDeps = { ...h.deps, computeInWorker: async () => { throw new Error('boom'); } };
    await refreshSelfAmbientCache(deps);
    expect(h.events).toContain('worker-failed');
    await refreshSelfAmbientCache(deps);
    expect(h.events.filter(e => e === 'worker-failed').length).toBe(1);
  });
});
