import { expect, test } from 'bun:test';
import { createSupplyProbes } from './probes.js';

test('pool and parent samples retain unknown measurements rather than inventing free capacity', async () => {
  const probes = createSupplyProbes({
    podPoolSpec: () => 'pool-node-b@node-b:4',
    parentHosts: () => [{ host: 'node-b', cwd: '/repo', approvalCapacity: 3 }],
    readCost: () => ({ used: null, limit: null, currency: null }),
    readHostCredentials: () => ({ hosts: [] }),
    occupancy: () => ({ 'pool-node-b': { occupied: null, reason: 'api-unavailable' } }),
    parentCapacity: () => null,
  });
  expect(await probes.pool()).toEqual({ members: [{ context: 'pool-node-b', occupied: null, capacity: 4 }] });
  expect(await probes.parentHosts()).toEqual({ hosts: [{ host: 'node-b', approvalCapacity: 3, active: null, headroom: null }] });
});
