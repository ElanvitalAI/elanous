import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { LogDietGuard } from '../debug/log-diet.js';
import { LogStore, StoreSink } from '../mss/logging/log-store.js';
import { replayDebugNoise24h } from './debug-noise-top30.js';

test('production debug.log to isolated logs.db: 24h noise falls while judgment events survive', () => {
  const baseline = replayDebugNoise24h(false);
  const dieted = replayDebugNoise24h(true);
  const tick = (rows: typeof baseline.top30) => rows.find(row => row.key === 'tox.loop/tick')?.count;
  expect(tick(baseline.top30)).toBe(720);
  expect(tick(dieted.top30)).toBe(24);
  expect(dieted.top30.find(row => row.key === 'log.diet/suppressed')?.count).toBe(24);
  expect(dieted.rowCount).toBeLessThan(baseline.rowCount);
  expect(dieted.payloadBytes).toBeLessThan(baseline.payloadBytes);
  expect(dieted.logsDbBytes).toBeLessThan(baseline.logsDbBytes);
  expect(dieted.protectedCounts).toEqual(baseline.protectedCounts);
  expect(Object.values(dieted.protectedCounts)).toEqual([24, 24, 24, 24, 24]);
  console.log(JSON.stringify({ device: 'MD-UX-SIM-DEBUG-NOISE-TOP30-TS', catalogVersion: 2,
    deviceCatalogVersion: 32, window: 'simulated-24h', baseline, dieted }));
});

test('replay sends zero synthetic rows to an already registered sink and keeps its guard', () => {
  const root = mkdtempSync(join(tmpdir(), 'debug-noise-existing-sink-'));
  const store = new LogStore(join(root, 'logs.db'), { instance: 'existing' });
  const sink = new StoreSink(store, 'existing', { installExitHandlers: false });
  const unregister = debug.registerSink(sink);
  const guard = new LogDietGuard();
  const previous = debug.setLogDietGuard(guard);
  try {
    replayDebugNoise24h(false);
    replayDebugNoise24h(true);
    sink.flush();
    const rows = store.queryAll({ surfaces: ['existing'] });
    expect(rows.filter(row => row.category === 'tox.loop' || row.category === 'log.diet'
      || row.data?.includes('debug-noise-sim'))).toHaveLength(0);
    expect(debug.setLogDietGuard(guard)).toBe(guard);
  } finally {
    debug.setLogDietGuard(previous);
    unregister();
    sink.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
