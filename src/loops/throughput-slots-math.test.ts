import { expect, test } from 'bun:test';
import { decideThroughput, type ThroughputSnapshot } from './throughput-controller.js';

const snapshot: ThroughputSnapshot = {
  now: '2026-11-27T00:00:00.000Z', version: '0.3.38', targets: { landsPerH: 10, greensPerH: 10 },
  landsLastHour: 1, graphLandsLastHour: 1, greensLastHour: 10, judgeReady: [], landsWithoutCell: 0,
  land: { readyToLand: 12, slots: 4, mode: 'live', lastTickAgeMin: 2, avgTickMin: 5.2 },
  churn: [], openPrs: [], awaitingPregate: [], receipts: [], pregateHosts: [],
  hands: { free: [], holdingIdle: [], working: 12 }, frozen: [], readyCells: 20,
};

test('ample slots capacity with a large queue is not a slots bottleneck', () => {
  const v = decideThroughput(snapshot);
  expect(v.measured.ceilingLandsPerH).toBe(46.2);
  expect(v.active.some(c => c.kind === 'land-slots')).toBe(false);
  expect(v.lever.what).not.toContain('4 → 2');
});

test('capacity below target recommends a strict increase, never a decrease or a tick', () => {
  const v = decideThroughput({ ...snapshot, land: { ...snapshot.land!, avgTickMin: 30 } });
  expect(v.measured.ceilingLandsPerH).toBe(8);
  expect(v.binding.kind).toBe('land-slots');
  expect(v.lever.what).toContain('4 → 5');
  expect(v.lever.commands).toEqual(['eln config set land.graph.slots 5']);
});

test('compares unrounded capacity at the exact target and just below it', () => {
  const at = decideThroughput({ ...snapshot, land: { ...snapshot.land!, avgTickMin: 24 } });
  const below = decideThroughput({ ...snapshot, land: { ...snapshot.land!, avgTickMin: 24.01 } });
  expect(at.active.some(c => c.kind === 'land-slots')).toBe(false);
  expect(below.measured.ceilingLandsPerH).toBe(10);
  expect(below.active.some(c => c.kind === 'land-slots')).toBe(true);
});

test('unknown or invalid tick capacity does not claim a slots bottleneck', () => {
  for (const avgTickMin of [null, 0, -1, Infinity]) {
    const v = decideThroughput({ ...snapshot, land: { ...snapshot.land!, avgTickMin } });
    expect(v.measured.ceilingLandsPerH).toBeNull();
    expect(v.active.some(c => c.kind === 'land-slots')).toBe(false);
  }
});
