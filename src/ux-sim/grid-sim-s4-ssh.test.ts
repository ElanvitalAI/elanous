import { describe, expect, test } from 'bun:test';
import { buildGridData } from '../nexus/api/grid.js';
import { withSimClock } from './fake-clock.js';
import { createFakeSsh } from './fake-ssh.js';
import { createGridLedger } from './grid-ledger.js';

const START = Date.parse('2026-11-02T09:00:00.000Z');
const caps = { trainShards: 4, gatePods: 4, taPods: 2, taParents: 2, remoteGateSlots: 2 };

describe('GRID-SIM-S4-SSH', () => {
  test('gcp1 banner saturation makes the lease unmeasured without a mismatch strike', async () => {
    await withSimClock(START, (clock) => {
      const ledger = createGridLedger({ now: () => clock.now(), heartbeatTtlMs: 60_000 });
      ledger.registerGrid({ id: 'G1', hosts: [{ host: 'gcp1', capacity: 25 }], caps });
      const lease = ledger.createLease({ fp: 'fp_grid_s4_gcp1', grid: 'G1', host: 'gcp1', lane: 'gate',
        mission: { cell: 'GRID-SIM-S4-SSH', pr: 34303, goalId: 'S4/ssh-saturation' } });

      const saturated = createFakeSsh({ hosts: { gcp1: {
        activeSessions: 20, maxStartups: 25, bannerTimeoutAt: 20, bannerDelayMs: 5_000, bannerTimeoutMs: 2_000,
      } }, clock });
      const startedAt = clock.now();
      let measurementCalls = 0;
      const data = buildGridData({ poolSpec: () => 'gcp1:25', measure: (members) => {
        measurementCalls++;
        const member = members.find(({ context }) => context === 'gcp1');
        if (!member) throw new Error('gcp1 missing from configured measurement pool');
        const attempt = saturated.ssh(member.context, 'read-grid-lease', 30_000);
        if (attempt.rc !== 0) throw new Error(attempt.output);
        return { members: [{ context: member.context, capacity: member.capacity, running: 1, pending: 0,
          unleasedRunning: 0, memoryLimitBytes: null, allocatableMemoryBytes: null,
          allocatableCpuMillicores: null, availableMemoryByNodeBytes: null, reason: null }] };
      } });
      expect(clock.now() - startedAt).toBe(2_000);
      expect(measurementCalls).toBe(1);
      expect(saturated.calls).toEqual([{ host: 'gcp1', script: 'read-grid-lease', activeSessions: 20, limitMs: 30_000 }]);

      const observed = ledger.resourceSummary('G1', data).hosts[0]!;
      expect(observed).toMatchObject({ host: 'gcp1', ledgerLeases: 1, measurement: 'unmeasured',
        observedOccupied: null, difference: null, reason: 'Error: ssh: banner exchange timeout for gcp1' });
      // Grid summaries only produce a mismatch signal when both sides were measured.
      expect(observed.difference).toBeNull();
      expect(ledger.who({ host: 'gcp1' }).leases).toMatchObject([{ state: 'active', lease }]);
    });
  });
});
