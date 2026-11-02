import { expect, test } from 'bun:test';
import { podDeathAfterPartialScenario } from './fault-pod-death.js';
import { withSimClock } from './fake-clock.js';
import { simulateGridChaos, type GridChaosEvent, type GridChaosLedger, type GridChaosTopology } from './grid-chaos-driver.js';

function topology(): GridChaosTopology {
  const makeHost = (gridId: string, hostId: string) => ({
    id: hostId,
    sessions: [1, 2].map((index) => ({
      id: `${hostId}-session-${index}`,
      leaseId: `${gridId}-${hostId}-lease-${index}`,
      podDeathScenario: podDeathAfterPartialScenario({
        job: `${hostId}-job-${index}`,
        runId: `${gridId}-${hostId}-run-${index}`,
      }),
    })),
  });
  return {
    headquartersGridId: 'G0',
    grids: [
      { id: 'G0', hosts: [makeHost('G0', 'mbp'), makeHost('G0', 'node-b')] },
      { id: 'G1', hosts: [makeHost('G1', 'aws1'), makeHost('G1', 'aws2')] },
      { id: 'G2', hosts: [makeHost('G2', 'gcp1'), makeHost('G2', 'gcp2')] },
    ],
  };
}

function recordingLedger(input: GridChaosTopology): { ledger: GridChaosLedger; events: GridChaosEvent[]; leases: Map<string, 'active' | 'lost'> } {
  const leases = new Map(input.grids.flatMap((grid) => grid.hosts.flatMap((host) => host.sessions.map((session) => [session.id, session.leaseId] as const))));
  const events: GridChaosEvent[] = [];
  const state = new Map<string, 'active' | 'lost'>([...leases.values()].map((leaseId) => [leaseId, 'active']));
  return {
    events,
    leases: state,
    ledger: {
      applyLoss(event) {
        events.push(event);
        const affectedLeaseIds = event.affectedSessionIds.map((sessionId) => leases.get(sessionId)!);
        for (const leaseId of affectedLeaseIds) state.set(leaseId, 'lost');
        return affectedLeaseIds;
      },
    },
  };
}

test('grid chaos: 10 seeds deterministically inject monkey, gorilla, and kong into the ledger', async () => {
  const epoch = Date.parse('2026-11-02T00:00:00.000Z');
  const orders = new Set<string>();
  await withSimClock(epoch, async (clock) => {
    for (let seed = 1; seed <= 10; seed++) {
      const input = topology();
      const firstLedger = recordingLedger(input);
      const first = simulateGridChaos({ seed, topology: input, ledger: firstLedger.ledger, clock });
      clock.setTime(epoch);
      const secondLedger = recordingLedger(input);
      const second = simulateGridChaos({ seed, topology: input, ledger: secondLedger.ledger, clock });
      clock.setTime(epoch);
      const reordered: GridChaosTopology = {
        headquartersGridId: input.headquartersGridId,
        grids: [...input.grids].reverse().map((grid) => ({
          ...grid,
          hosts: [...grid.hosts].reverse().map((host) => ({ ...host, sessions: [...host.sessions].reverse() })),
        })),
      };
      const reorderedLedger = recordingLedger(reordered);
      const reorderedResult = simulateGridChaos({ seed, topology: reordered, ledger: reorderedLedger.ledger, clock });

      expect(first).toEqual(second);
      expect(first).toEqual(reorderedResult);
      expect(first.events.map((event) => event.attack).sort()).toEqual(['gorilla', 'kong', 'monkey']);
      expect(first.events).toEqual(firstLedger.events.map((event, index) => ({
        ...event,
        affectedLeaseIds: first.events[index]!.affectedLeaseIds,
      })));
      expect(first.duplicateLeaseLosses).toEqual([]);
      expect(new Set(first.events.flatMap((event) => event.affectedLeaseIds)).size)
        .toBe(first.events.reduce((count, event) => count + event.affectedLeaseIds.length, 0));
      expect(first.events.every((event) => event.podDeathObservations.length === event.affectedSessionIds.length
        && event.podDeathObservations.every((observation) => observation.source === 'partial-live'))).toBe(true);
      const expectedLostLeases = new Set(first.events.flatMap((event) => event.affectedLeaseIds));
      for (const [leaseId, state] of firstLedger.leases) {
        expect(state).toBe(expectedLostLeases.has(leaseId) ? 'lost' : 'active');
      }

      const byAttack = new Map(first.events.map((event) => [event.attack, event]));
      const monkey = byAttack.get('monkey')!;
      const gorilla = byAttack.get('gorilla')!;
      const kong = byAttack.get('kong')!;
      expect(monkey.targetGridId).not.toBe('G0');
      expect(monkey.targetHostIds).toHaveLength(1);
      expect(['host', 'session']).toContain(monkey.scope);
      expect(gorilla.targetGridId).not.toBe('G0');
      expect(gorilla.targetHostIds).toHaveLength(2);
      expect(kong.targetGridId).toBe('G0');
      expect(kong.targetHostIds).toHaveLength(2);
      expect(first.events.map((event) => event.atMs)).toEqual([epoch, epoch + 1, epoch + 2]);
      orders.add(first.events.map((event) => event.attack).join(','));
      clock.setTime(epoch);
    }
  });
  expect(orders.size).toBeGreaterThan(1);
});

test('grid chaos: rejects invalid seeds and a topology without a separate worker grid', () => {
  const input = topology();
  const ledger = recordingLedger(input);
  const clock = { now: () => 0, tick: () => {}, setTime: () => {}, pendingTimers: () => 0 };
  expect(() => simulateGridChaos({ seed: -1, topology: input, ledger: ledger.ledger, clock })).toThrow('unsigned 32-bit integer');
  expect(() => simulateGridChaos({ seed: 0x1_0000_0000, topology: input, ledger: ledger.ledger, clock })).toThrow('unsigned 32-bit integer');
  expect(() => simulateGridChaos({ seed: 1, topology: { headquartersGridId: 'G0', grids: [input.grids[0]!, input.grids[1]!] }, ledger: ledger.ledger, clock }))
    .toThrow('at least two worker grids');
  expect(ledger.events).toEqual([]);
});

test('grid chaos: rejects a missing Pod-death fixture before mutating the ledger', () => {
  const input = topology();
  Reflect.set(input.grids[1]!.hosts[0]!.sessions[0]!, 'podDeathScenario', undefined);
  const ledger = recordingLedger(input);
  const clock = { now: () => 0, tick: () => {}, setTime: () => {}, pendingTimers: () => 0 };
  expect(() => simulateGridChaos({ seed: 1, topology: input, ledger: ledger.ledger, clock }))
    .toThrow('requires a pod-death fixture');
  expect(ledger.events).toEqual([]);
  expect([...ledger.leases.values()].every((state) => state === 'active')).toBe(true);
});
