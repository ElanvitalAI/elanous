import { expect, test } from 'bun:test';
import { simulateBackendTierProfiles } from './backend-tier-device.js';

test('backend tier simulation distinguishes estimates, unknowns, and installed engines', () => {
  const results = simulateBackendTierProfiles();
  expect(results.map(({ name, tier }) => [name, tier])).toEqual([
    ['unknown-memory', 'T0'], ['small-host', 'T0'], ['t1-ready', 'T1'],
    ['t2-ready', 'T2'], ['low-available', 'T0'],
  ]);
  expect(results[0]?.reasons.join(' ')).toContain('측정');
  expect(results[2]?.engines).toEqual([]);
  expect(results[3]?.engines).toEqual(['Colima']);
  expect(results[4]?.reasons.join(' ')).toContain('가용');
});
