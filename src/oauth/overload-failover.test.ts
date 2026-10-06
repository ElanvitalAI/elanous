// #24256 superseded — launch failover reads only llm.call/outcome rows that
// a real fetchApiWithRetry wrote. Injecting a fake sample is not the verdict.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LogStore } from '../mss/logging/log-store.js';
import { debug } from '../debug/log.js';
import {
  applyOverloadFailoverToChild,
  decideOverloadFailoverLaunch,
  outcomesFromCallRows,
  readLlmCallOutcomes,
} from './overload-failover.js';
import {
  fetchApiWithRetry,
  OverloadFailoverError,
  setLlmCallOutcomeWriterForTesting,
} from '../session-runtime/retry-api.js';
import { decideRetry, OVERLOAD_FAILOVER_STREAK } from '../session-runtime/retry-policy.js';
import {
  applyLaunchOverloadFailover,
  setLaunchOverloadOutcomesForTesting,
} from './overload-failover-launch.js';

const dirs: string[] = [];

afterEach(() => {
  setLaunchOverloadOutcomesForTesting(undefined);
  setLlmCallOutcomeWriterForTesting(undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(): LogStore {
  const dir = mkdtempSync(join(tmpdir(), 'overload-failover-'));
  dirs.push(dir);
  return new LogStore(join(dir, 'logs.db'));
}

function armStore(store: LogStore): void {
  setLlmCallOutcomeWriterForTesting((row) => {
    store.insertBatch([{
      rec: { ts: new Date().toISOString(), category: 'llm.call', event: 'outcome', data: row },
      surface: 'llm',
    }]);
  });
}

function overloadResponse(status = 503): Response {
  return new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status });
}

describe('overload failover — real llm.call outcomes (#24256 superseded)', () => {
  test('three real overload responses switch the next child to grok', async () => {
    const store = tempDb();
    armStore(store);
    const original = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return overloadResponse(503);
    }) as unknown as typeof fetch;
    try {
      for (let i = 0; i < 3; i++) {
        await fetchApiWithRetry('https://example.test/v1/responses', { method: 'POST' }, {
          provider: 'codex', errorPrefix: 'Codex API', maxAttempts: 1,
        }).catch(() => undefined);
      }
    } finally {
      globalThis.fetch = original;
    }
    expect(fetches).toBe(3);
    const outcomes = readLlmCallOutcomes({ dbPath: store.path, open: () => store });
    expect(outcomes.map((row) => ({ provider: row.provider, status: row.status, kind: row.kind }))).toEqual([
      { provider: 'codex', status: 503, kind: '5xx' },
      { provider: 'codex', status: 503, kind: '5xx' },
      { provider: 'codex', status: 503, kind: '5xx' },
    ]);
    const decision = decideOverloadFailoverLaunch({
      codexExplicit: false,
      provider: 'openai-codex',
      model: 'gpt-test',
      outcomes,
    });
    expect(decision.switched).toBe(true);
    expect(decision.provider).toBe('grok');
    expect(decision.why).toBe('streak');
    store.close();
  });

  test('a 400 from the same call path does not switch', async () => {
    const store = tempDb();
    armStore(store);
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('nope', { status: 400 })) as unknown as typeof fetch;
    try {
      for (let i = 0; i < 3; i++) {
        await fetchApiWithRetry('https://example.test/v1/responses', { method: 'POST' }, {
          provider: 'codex', errorPrefix: 'Codex API', maxAttempts: 1,
        }).catch(() => undefined);
      }
    } finally {
      globalThis.fetch = original;
    }
    const outcomes = readLlmCallOutcomes({ dbPath: store.path, open: () => store });
    store.close();
    expect(outcomes.every((row) => row.kind === 'other' && row.status === 400)).toBe(true);
    const decision = decideOverloadFailoverLaunch({
      codexExplicit: false,
      provider: 'openai-codex',
      outcomes,
    });
    expect(decision.switched).toBe(false);
    expect(decision.why).toBe('below-streak');
  });

  test('explicit codex does not switch', () => {
    const outcomes = Array.from({ length: OVERLOAD_FAILOVER_STREAK }, () => ({
      provider: 'codex', status: 503, kind: '5xx' as const,
    }));
    const decision = decideOverloadFailoverLaunch({
      codexExplicit: true,
      provider: 'openai-codex',
      model: 'pinned',
      outcomes,
    });
    expect(decision).toMatchObject({ switched: false, why: 'explicit-codex', provider: 'openai-codex', model: 'pinned' });
  });

  test('recovery of N ok responses keeps the next launch on codex', async () => {
    const store = tempDb();
    armStore(store);
    const original = globalThis.fetch;
    let status = 503;
    globalThis.fetch = (async () => new Response('ok', { status })) as unknown as typeof fetch;
    try {
      for (let i = 0; i < 3; i++) {
        await fetchApiWithRetry('https://example.test/v1/responses', { method: 'POST' }, {
          provider: 'codex', errorPrefix: 'Codex API', maxAttempts: 1,
        }).catch(() => undefined);
      }
      status = 200;
      for (let i = 0; i < OVERLOAD_FAILOVER_STREAK; i++) {
        await fetchApiWithRetry('https://example.test/v1/responses', { method: 'POST' }, {
          provider: 'codex', errorPrefix: 'Codex API', maxAttempts: 1,
        });
      }
    } finally {
      globalThis.fetch = original;
    }
    const outcomes = readLlmCallOutcomes({ dbPath: store.path, open: () => store });
    store.close();
    const decision = decideOverloadFailoverLaunch({
      codexExplicit: false,
      provider: 'openai-codex',
      outcomes,
    });
    expect(decision.switched).toBe(false);
    expect(decision.why).toBe('recovered');
    expect(decision.provider).toBe('openai-codex');
  });

  test('applyLaunchOverloadFailover reads the real rows and moves only an unpinned child', async () => {
    const store = tempDb();
    armStore(store);
    const original = globalThis.fetch;
    globalThis.fetch = (async () => overloadResponse(503)) as unknown as typeof fetch;
    try {
      for (let i = 0; i < 3; i++) {
        await fetchApiWithRetry('https://example.test/v1/responses', { method: 'POST' }, {
          provider: 'codex', errorPrefix: 'Codex API', maxAttempts: 1,
        }).catch(() => undefined);
      }
    } finally {
      globalThis.fetch = original;
    }
    setLaunchOverloadOutcomesForTesting(() => readLlmCallOutcomes({ dbPath: store.path, open: () => store }));
    const moved = applyLaunchOverloadFailover(undefined, {});
    expect(moved?.provider).toBe('grok');
    const explicit = applyLaunchOverloadFailover(
      { provider: 'openai-codex', model: 'gpt-test', source: 'flag' },
      { provider: 'codex' },
    );
    expect(explicit?.provider).toBe('openai-codex');
    const pinned = applyLaunchOverloadFailover(
      { provider: 'openai-codex', model: 'gpt-test', source: 'config' },
      { codexPinned: true },
    );
    expect(pinned?.provider).toBe('openai-codex');
    store.close();
  });

  test('k overload responses with a remaining fallback throw before another retry', async () => {
    const original = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return overloadResponse(503);
    }) as unknown as typeof fetch;
    setLlmCallOutcomeWriterForTesting(() => undefined);
    let thrown: unknown;
    try {
      await fetchApiWithRetry('https://example.test/v1/responses', { method: 'POST' }, {
        provider: 'codex',
        errorPrefix: 'Codex API',
        maxAttempts: 8,
        remainingFallbacks: 1,
      });
    } catch (err) {
      thrown = err;
    } finally {
      globalThis.fetch = original;
    }
    expect(thrown).toBeInstanceOf(OverloadFailoverError);
    expect(fetches).toBe(OVERLOAD_FAILOVER_STREAK);
    expect(fetches).toBeLessThan(8);
  });

  test('a 400 with remaining fallbacks does not switch provider', async () => {
    const original = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response('bad', { status: 400 });
    }) as unknown as typeof fetch;
    setLlmCallOutcomeWriterForTesting(() => undefined);
    let thrown: unknown;
    try {
      await fetchApiWithRetry('https://example.test/v1/responses', { method: 'POST' }, {
        provider: 'codex',
        errorPrefix: 'Codex API',
        maxAttempts: 4,
        remainingFallbacks: 1,
      });
    } catch (err) {
      thrown = err;
    } finally {
      globalThis.fetch = original;
    }
    expect(thrown).not.toBeInstanceOf(OverloadFailoverError);
    expect(fetches).toBeGreaterThan(0);
  });

  test('decideRetry: overload streak switches once, 400 never does', () => {
    const overload = Object.assign(new Error('overloaded'), { status: 503, code: '503' });
    expect(decideRetry(overload, {
      attempt: 0, doomStatus: 'normal', remainingFallbacks: 1, overloadStreak: OVERLOAD_FAILOVER_STREAK,
    }).action).toBe('switch-provider');
    expect(decideRetry(overload, {
      attempt: 0, doomStatus: 'normal', remainingFallbacks: 1, overloadStreak: 1,
    }).action).toBe('retry');
    expect(decideRetry(overload, {
      attempt: 0, doomStatus: 'normal', remainingFallbacks: 0, overloadStreak: 9,
    }).action).toBe('retry');
    const bad = Object.assign(new Error('bad request'), { status: 400, code: '400' });
    expect(decideRetry(bad, {
      attempt: 0, doomStatus: 'normal', remainingFallbacks: 2, overloadStreak: 9,
    }).action).not.toBe('switch-provider');
  });

  test('rate-limit streak also switches the child', () => {
    const applied = applyOverloadFailoverToChild(undefined, {
      codexExplicit: false,
      defaultProvider: 'openai-codex',
      outcomes: Array.from({ length: 3 }, () => ({ provider: 'codex', status: 429, kind: 'rate-limit' as const })),
    });
    expect(applied.decision.switched).toBe(true);
    expect(applied.selection?.provider).toBe('grok');
  });
});

test('rows in the same millisecond keep insertion order (store returns newest first)', () => {
  const row = (id: number, kind: string, status: number) => ({
    id, ts_ms: 1_000, category: 'llm.call', event: 'outcome', data: JSON.stringify({ provider: 'codex', status, kind }),
  });
  // Store order: ts_ms DESC, id DESC — the newest row (id 3, ok) comes first.
  const outcomes = outcomesFromCallRows([row(3, 'ok', 200), row(2, 'overloaded', 503), row(1, 'overloaded', 503)]);
  expect(outcomes.map((o) => o.kind)).toEqual(['overloaded', 'overloaded', 'ok']);
});

test('one call writes exactly one llm.call/outcome row (the debug trace is not a second sample)', async () => {
  const store = tempDb();
  armStore(store);
  const traced: string[] = [];
  const off = debug.registerSink({ name: 'outcome-dup-probe', emit: (record) => { if (record.category === 'llm.call') traced.push(record.event); } });
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
  try {
    await fetchApiWithRetry('https://example.test/v1/responses', { method: 'POST' }, { provider: 'codex', errorPrefix: 'Codex API', maxAttempts: 1 });
  } finally {
    globalThis.fetch = original;
    off();
  }
  const outcomes = readLlmCallOutcomes({ dbPath: store.path, open: () => store });
  store.close();
  expect(outcomes).toHaveLength(1);
  expect(traced).not.toContain('outcome');
});

