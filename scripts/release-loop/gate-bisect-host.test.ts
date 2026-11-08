import { expect, test } from 'bun:test';
import { GATE_BISECT_ALTERNATE_POOLS, selectGateBisectAlternatePool } from './gate-node.js';

test('timeout regression remeasurement falls back to gcp2 and aws3 when primary alternates are in the gate pool', () => {
  expect(GATE_BISECT_ALTERNATE_POOLS.map(({ host }) => host)).toEqual(['node-c', 'mshq', 'gcp2', 'aws3']);
  expect(selectGateBisectAlternatePool(new Set(['node-c', 'mshq']))).toEqual({ host: 'gcp2', pool: 'pool-gcp2@gcp2:1' });
  expect(selectGateBisectAlternatePool(new Set(['node-c', 'mshq', 'gcp2']))).toEqual({ host: 'aws3', pool: 'pool-aws3@aws3:1' });
  expect(selectGateBisectAlternatePool(new Set(['node-c', 'mshq', 'gcp2', 'aws3']))).toBeUndefined();
});
