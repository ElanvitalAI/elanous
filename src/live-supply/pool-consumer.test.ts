import { expect, test } from 'bun:test';
import { narrowPodRecommendationFromSupply } from '../harness/dispatch-backpressure.js';
import { SUPPLY_AXES, type LiveSupplySnapshot } from './snapshot.js';

const NOW = Date.parse('2026-10-26T12:00:00Z');
function poolSnapshot(): LiveSupplySnapshot {
  return {
    version: 1, sequence: 2, observedAt: '2026-10-26T11:59:00Z', expiresAt: '2026-10-26T12:01:00Z',
    sources: Object.fromEntries(SUPPLY_AXES.map(axis => [axis, {
      status: axis === 'pool' ? 'measured' : 'unknown', observedAt: axis === 'pool' ? '2026-10-26T11:59:00Z' : null,
      reason: null,
    }])) as LiveSupplySnapshot['sources'],
    values: { pool: { members: [{ context: 'pool-node-b', capacity: 8, occupied: 7 }] } },
  };
}

test('fresh matching pool can narrow but never raise direct admission', () => {
  const members = [{ context: 'pool-node-b', capacity: 8 }];
  expect(narrowPodRecommendationFromSupply(6, members, poolSnapshot(), NOW)).toBe(1);
  expect(narrowPodRecommendationFromSupply(0, members, poolSnapshot(), NOW)).toBe(0);
});

test('stale, unknown occupancy and changed pool spec retain direct admission', () => {
  const members = [{ context: 'pool-node-b', capacity: 8 }];
  const expired = poolSnapshot();
  expired.expiresAt = '2026-10-26T11:59:59Z';
  expect(narrowPodRecommendationFromSupply(6, members, expired, NOW)).toBe(6);
  const unknown = poolSnapshot();
  unknown.values.pool!.members[0]!.occupied = null;
  expect(narrowPodRecommendationFromSupply(6, members, unknown, NOW)).toBe(6);
  expect(narrowPodRecommendationFromSupply(6, [{ context: 'pool-node-b', capacity: 9 }], poolSnapshot(), NOW)).toBe(6);
});

test('duplicate or additional sampled pool members retain direct admission', () => {
  const members = [{ context: 'pool-node-b', capacity: 8 }, { context: 'pool-wsl', capacity: 8 }];
  const duplicate = poolSnapshot();
  duplicate.values.pool!.members = [
    { context: 'pool-node-b', capacity: 8, occupied: 0 },
    { context: 'pool-node-b', capacity: 8, occupied: 8 },
    { context: 'pool-wsl', capacity: 8, occupied: 8 },
  ];
  expect(narrowPodRecommendationFromSupply(6, members, duplicate, NOW)).toBe(6);
  const additional = poolSnapshot();
  additional.values.pool!.members.push({ context: 'pool-other', capacity: 8, occupied: 8 });
  expect(narrowPodRecommendationFromSupply(6, [{ context: 'pool-node-b', capacity: 8 }], additional, NOW)).toBe(6);
});
