import { expect, test } from 'bun:test';
import { createDraftMetricsSource, parseDraftMetricsOutput } from './draft-metrics.js';
import type { CeoDraftMetrics } from './draft-metrics.js';

const METRICS: CeoDraftMetrics = { inventory: 168, oldestAgeHours: 119.2, needsOwner: 12, converted48h: 330, cohort48h: 701, conversion48h: 330 / 701, overlap: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('cold cache answers «measuring» without a value and starts exactly one collection for many reads', async () => {
  let calls = 0;
  const pending = deferred<CeoDraftMetrics>();
  const source = createDraftMetricsSource({ collect: () => { calls++; return pending.promise; }, now: () => 1_000 });
  for (let i = 0; i < 20; i++) expect(source.read()).toEqual({ state: 'measuring', metrics: null, measuredAt: null, refreshing: true, reason: null });
  expect(calls).toBe(1);
  pending.resolve(METRICS);
  await settle();
  expect(source.read()).toEqual({ state: 'ready', metrics: METRICS, measuredAt: new Date(1_000).toISOString(), refreshing: false, reason: null });
  expect(calls).toBe(1);
});

test('within the TTL page loads never collect; after it, one background refresh while the old value is served', async () => {
  let clock = 0;
  let calls = 0;
  const source = createDraftMetricsSource({ collect: async () => { calls++; return { ...METRICS, inventory: 100 + calls }; }, ttlMs: 600_000, now: () => clock });
  source.read();
  await settle();
  clock = 599_999;
  for (let i = 0; i < 50; i++) expect(source.read().metrics?.inventory).toBe(101);
  expect(calls).toBe(1);
  clock = 600_000;
  const stale = source.read();
  expect(stale).toMatchObject({ state: 'ready', refreshing: true, measuredAt: new Date(0).toISOString() });
  expect(stale.metrics?.inventory).toBe(101);
  expect(source.read().refreshing).toBe(true);
  await settle();
  expect(calls).toBe(2);
  expect(source.read()).toMatchObject({ state: 'ready', refreshing: false, metrics: { inventory: 102 } });
});

test('a failed first collection is «unavailable» (never zero) and retries only after the back-off', async () => {
  let clock = 0;
  let calls = 0;
  let fail = true;
  const source = createDraftMetricsSource({
    collect: async () => { calls++; if (fail) throw new Error('gh: HTTP 502'); return METRICS; },
    failureRetryMs: 120_000, now: () => clock,
  });
  source.read();
  await settle();
  clock = 119_999;
  expect(source.read()).toEqual({ state: 'unavailable', metrics: null, measuredAt: null, refreshing: false, reason: 'gh: HTTP 502' });
  expect(calls).toBe(1);
  fail = false;
  clock = 120_000;
  expect(source.read().state).toBe('measuring');
  await settle();
  expect(calls).toBe(2);
  expect(source.read()).toMatchObject({ state: 'ready', metrics: METRICS, reason: null });
});

test('a failed refresh keeps the previous value with its time and the reason', async () => {
  let clock = 0;
  let fail = false;
  const source = createDraftMetricsSource({
    collect: async () => { if (fail) throw new Error('timeout'); return METRICS; }, ttlMs: 10, failureRetryMs: 1_000, now: () => clock,
  });
  source.read();
  await settle();
  fail = true;
  clock = 10;
  source.read();
  await settle();
  clock = 20;
  expect(source.read()).toEqual({ state: 'ready', metrics: METRICS, measuredAt: new Date(0).toISOString(), refreshing: false, reason: 'timeout' });
});

test('CLI output parsing rejects anything that is not a complete metric row', () => {
  expect(parseDraftMetricsOutput(`warn\n${JSON.stringify({ repository: 'a/b', ...METRICS })}\n`)).toEqual(METRICS);
  expect(() => parseDraftMetricsOutput('')).toThrow('no JSON output');
  expect(() => parseDraftMetricsOutput(JSON.stringify({ ...METRICS, inventory: undefined }))).toThrow('malformed');
  expect(() => parseDraftMetricsOutput(JSON.stringify({ ...METRICS, needsOwner: -1 }))).toThrow('malformed');
});

test('overlap passes through the CLI parser into the ready cache; old or malformed overlap stays null without losing draft values', async () => {
  const overlap = { launches24h: 3, launched: 4, unmeasured: 0, sourceIncomplete: false,
    linked: 2, autoLanded: 2, autoRate: 1, secondSiblingMedianHours: 4.5, salvaged: 0, salvageUnmeasured: 0 };
  const source = createDraftMetricsSource({ collect: async () => parseDraftMetricsOutput(JSON.stringify({ ...METRICS, overlap })), now: () => 1_000 });
  source.read();
  await settle();
  expect(source.read()).toMatchObject({ state: 'ready', metrics: { ...METRICS, overlap } });
  expect(source.read().metrics?.overlap?.launches24h).toBe(3);
  for (const row of [{ ...METRICS, overlap: undefined }, { ...METRICS, overlap: { ...overlap, autoRate: '100%' } }]) {
    const parsed = parseDraftMetricsOutput(JSON.stringify(row));
    expect(parsed).toEqual(METRICS);
    const older = createDraftMetricsSource({ collect: async () => parsed, now: () => 1_000 });
    older.read();
    await settle();
    expect(older.read()).toMatchObject({ state: 'ready', metrics: { ...METRICS, overlap: null } });
  }
});
