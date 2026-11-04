import { expect, test } from 'bun:test';
import { podDeathAfterPartialScenario } from './fault-pod-death.js';
import { withSimClock } from './fake-clock.js';
import { simulateGridChaos, type GridChaosEvent, type GridChaosLedger, type GridChaosTopology } from './grid-chaos-driver.js';
import { createGridChaosLedgerAdapter, createGridLedger, type GridCaps } from './grid-ledger.js';

const epoch = Date.parse('2026-11-02T00:00:00.000Z');
const caps: GridCaps = { trainShards: 8, gatePods: 8, taPods: 8, taParents: 8, remoteGateSlots: 8 };
const sessionKinds = ['work', 'gop', 'nexus'] as const;
const hostCapacity = 10;

interface LeaseRow {
  readonly grid: string;
  readonly host: string;
  readonly sessionId: string;
  readonly leaseId: string;
}

interface GridLossCheckpoint {
  readonly attack: GridChaosEvent['attack'];
  readonly targetGridId: string;
  readonly targetHostIds: readonly string[];
  readonly affectedSessionIds: readonly string[];
  readonly affectedLeaseIds: readonly string[];
  readonly ledgerBefore: GridLedgerSnapshot;
  readonly ledgerAfter: GridLedgerSnapshot;
}

type GridLedger = ReturnType<typeof createGridLedger>;
type GridWhoSnapshot = ReturnType<GridLedger['who']>;
type GridSummarySnapshot = ReturnType<GridLedger['resourceSummary']>;

interface GridLedgerSnapshot {
  readonly topology: GridChaosTopology;
  readonly hosts: readonly GridWhoSnapshot[];
  readonly grids: readonly GridSummarySnapshot[];
}

function makeTopology(): { topology: GridChaosTopology; leases: LeaseRow[] } {
  const leases: LeaseRow[] = [];
  const grids = ['G0-HQ', 'G1-WORKER', 'G2-WORKER'].map((gridId) => ({
    id: gridId,
    hosts: [0, 1].map((hostIndex) => {
      const host = `${gridId}-host-${hostIndex}`;
      return {
        id: host,
        sessions: sessionKinds.map((kind) => {
          const sessionId = `${host}-${kind}`;
          const leaseId = `${sessionId}-lease`;
          leases.push({ grid: gridId, host, sessionId, leaseId });
          return {
            id: sessionId,
            processId: kind === 'nexus' ? `${host}-nexus-process` : `${host}-work-process`,
            leaseId,
            podDeathScenario: podDeathAfterPartialScenario({ job: `${sessionId}-job`, runId: `${sessionId}-run` }),
          };
        }),
      };
    }),
  }));
  return { topology: { headquartersGridId: 'G0-HQ', grids }, leases };
}

async function runGridLoss(seed: number, injectSummaryMetadataDrift = false): Promise<{
  result: ReturnType<typeof simulateGridChaos>;
  checkpoints: GridLossCheckpoint[];
  ledger: ReturnType<typeof createGridLedger>;
}> {
  return withSimClock(epoch, async (clock) => {
    const { topology, leases } = makeTopology();
    const ledger = createGridLedger({ now: clock.now });
    for (const grid of topology.grids) {
      ledger.registerGrid({ id: grid.id, hosts: grid.hosts.map(({ id }) => ({ host: id, capacity: hostCapacity })), caps });
    }
    for (const row of leases) {
      ledger.createLease({ fp: row.leaseId, grid: row.grid, host: row.host, lane: 'hand', mission: { goalId: 'GRID-SIM-S12-CHAOS' } });
    }

    const adapter = createGridChaosLedgerAdapter(ledger, topology);
    const checkpoints: GridLossCheckpoint[] = [];
    let driftGridId: string | undefined;
    const snapshotLedger = (): GridLedgerSnapshot => ({
      topology: JSON.parse(JSON.stringify(topology)) as GridChaosTopology,
      hosts: topology.grids.flatMap((grid) => grid.hosts.map(({ id }) => ledger.who({ host: id }))),
      grids: topology.grids.map((grid) => {
        const summary = ledger.resourceSummary(grid.id, {
          hq: { record: null, ageSeconds: null, expired: null, reason: null },
          members: grid.hosts.map(({ id }) => ({ context: id, capacity: grid.id === driftGridId ? hostCapacity + 1 : hostCapacity,
            running: 0, pending: 0, occupied: 0, reason: null })),
          poolReason: null,
        });
        if (grid.id === driftGridId) Reflect.set(summary, 'injectedGridMetadata', 'drift');
        return summary;
      }),
    });
    const observingLedger: GridChaosLedger = {
      applyLoss(event) {
        const ledgerBefore = snapshotLedger();
        const affectedLeaseIds = adapter.applyLoss(event);
        if (injectSummaryMetadataDrift && event.attack === 'gorilla') driftGridId = event.targetGridId;
        const ledgerAfter = snapshotLedger();
        driftGridId = undefined;
        checkpoints.push({
          attack: event.attack,
          targetGridId: event.targetGridId,
          targetHostIds: [...event.targetHostIds],
          affectedSessionIds: [...event.affectedSessionIds],
          affectedLeaseIds: [...affectedLeaseIds],
          ledgerBefore,
          ledgerAfter,
        });
        return affectedLeaseIds;
      },
    };

    return { result: simulateGridChaos({ seed, topology, ledger: observingLedger, clock }), checkpoints, ledger };
  });
}

function expectTopologyUnchanged(checkpoint: GridLossCheckpoint): void {
  expect(JSON.stringify(checkpoint.ledgerAfter.topology)).toBe(JSON.stringify(checkpoint.ledgerBefore.topology));
}

function summaryNonLeaseMetadata(summary: GridSummarySnapshot) {
  const { hosts, ...gridMetadata } = summary;
  return {
    ...gridMetadata,
    hosts: hosts.map(({ ledgerLeases: _ledgerLeases, expiredLeases: _expiredLeases,
      byLane: _byLane, difference: _difference, ...hostMetadata }) => hostMetadata),
  };
}

function expectSummaryMetadataUnchanged(before: GridSummarySnapshot, after: GridSummarySnapshot): void {
  expect(JSON.stringify(summaryNonLeaseMetadata(after))).toBe(JSON.stringify(summaryNonLeaseMetadata(before)));
}

function expectGridAdmissionLimits(ledger: ReturnType<typeof createGridLedger>, gridId: string, hosts: readonly string[], seed: number): void {
  const lanes = [
    ['train', 'trainShards'], ['gate', 'gatePods'], ['ta', 'taPods'], ['parent', 'taParents'], ['remote-gate', 'remoteGateSlots'],
  ] as const;
  for (const [lane, capKey] of lanes) {
    const probeIds: string[] = [];
    for (let index = 0; index < caps[capKey]; index++) {
      const fp = `s12-probe-${seed}-${lane}-${index}`;
      ledger.createLease({ fp, grid: gridId, host: hosts[index % hosts.length]!, lane,
        mission: { goalId: 'GRID-SIM-S12-CAPS-PROBE' } });
      probeIds.push(fp);
    }
    expect(() => ledger.createLease({ fp: `s12-probe-${seed}-${lane}-overflow`, grid: gridId,
      host: hosts[0]!, lane, mission: { goalId: 'GRID-SIM-S12-CAPS-PROBE' } })).toThrow(`grid-capacity-exceeded:${capKey}`);
    for (const fp of probeIds) ledger.endLease(fp);
  }

  const host = hosts[0]!;
  const hostProbeIds: string[] = [];
  for (let index = 0; index < hostCapacity; index++) {
    const fp = `s12-probe-${seed}-host-${index}`;
    ledger.createLease({ fp, grid: gridId, host, lane: 'hand', mission: { goalId: 'GRID-SIM-S12-HOST-CAP-PROBE' } });
    hostProbeIds.push(fp);
  }
  expect(() => ledger.createLease({ fp: `s12-probe-${seed}-host-overflow`, grid: gridId,
    host, lane: 'hand', mission: { goalId: 'GRID-SIM-S12-HOST-CAP-PROBE' } })).toThrow('host-capacity-exceeded');
  for (const fp of hostProbeIds) ledger.endLease(fp);
}

test('GRID-SIM-S12: gorilla loss ends every target-grid work, GOP, and Nexus lease only', async () => {
  let sawPriorNonTargetLeaseLoss = false;
  let sawSharedProcessMonkey = false;
  for (let seed = 1; seed <= 10; seed++) {
    const first = await runGridLoss(seed);
    const replay = await runGridLoss(seed);
    expect(replay.result).toEqual(first.result);
    expect(replay.checkpoints).toEqual(first.checkpoints);
    expect(first.result.duplicateLeaseLosses).toEqual([]);

    const topology = makeTopology();
    expect(first.result.events.filter(({ attack }) => attack === 'gorilla')).toHaveLength(1);
    const gorillaEvent = first.result.events.find(({ attack }) => attack === 'gorilla')!;
    const monkeyEvent = first.result.events.find(({ attack }) => attack === 'monkey')!;
    const gorillaCheckpoint = first.checkpoints.find(({ attack }) => attack === 'gorilla')!;
    expect(monkeyEvent.scope).toBe('process');
    expect(monkeyEvent.targetProcessIds).toHaveLength(1);
    const targetSessions = topology.topology.grids.flatMap(({ hosts }) => hosts)
      .flatMap(({ sessions }) => sessions)
      .filter(({ processId }) => monkeyEvent.targetProcessIds.includes(processId));
    expect(monkeyEvent.targetProcessIds).toHaveLength(1);
    expect([...monkeyEvent.affectedSessionIds].sort()).toEqual(targetSessions.map(({ id }) => id).sort());
    const targetHost = topology.topology.grids.flatMap(({ hosts }) => hosts)
      .find(({ id }) => id === monkeyEvent.targetHostIds[0])!;
    const otherProcessSessions = targetHost.sessions.filter(({ processId }) => !monkeyEvent.targetProcessIds.includes(processId));
    expect(otherProcessSessions.length).toBeGreaterThan(0);
    expect(otherProcessSessions.every(({ leaseId }) => first.ledger.getLease(leaseId)?.endedAt === undefined)).toBe(true);
    sawSharedProcessMonkey ||= targetSessions.length === 2;
    const isTargetHost = (snapshot: GridWhoSnapshot): boolean =>
      'host' in snapshot.selector && gorillaEvent.targetHostIds.includes(snapshot.selector.host);
    sawPriorNonTargetLeaseLoss ||= gorillaCheckpoint.ledgerBefore.hosts.some((host) =>
      !isTargetHost(host) && host.leases.some(({ state }) => state === 'ended'));
    const targetHosts = topology.leases.filter(({ grid }) => grid === gorillaEvent.targetGridId).map(({ host }) => host);
    const expectedSessionIds = topology.leases.filter(({ grid }) => grid === gorillaEvent.targetGridId).map(({ sessionId }) => sessionId);
    const expectedLeaseIds = topology.leases.filter(({ grid }) => grid === gorillaEvent.targetGridId).map(({ leaseId }) => leaseId);

    expect(gorillaEvent.scope).toBe('grid');
    expect(gorillaEvent.targetGridId).not.toBe('G0-HQ');
    expect([...gorillaEvent.targetHostIds].sort()).toEqual([...new Set(targetHosts)].sort());
    expect([...gorillaEvent.affectedSessionIds].sort()).toEqual(expectedSessionIds.sort());
    expect([...gorillaCheckpoint.affectedLeaseIds].sort()).toEqual(expectedLeaseIds.sort());
    expectTopologyUnchanged(gorillaCheckpoint);
    const selectorHost = (snapshot: GridWhoSnapshot): string => {
      if (!('host' in snapshot.selector)) throw new Error('grid-loss snapshot must use a host selector');
      return snapshot.selector.host;
    };
    const beforeHost = new Map(gorillaCheckpoint.ledgerBefore.hosts.map((host) => [selectorHost(host), host]));
    for (const afterHost of gorillaCheckpoint.ledgerAfter.hosts) {
      const hostId = selectorHost(afterHost);
      const before = beforeHost.get(hostId)!;
      if (gorillaEvent.targetHostIds.includes(hostId)) {
        expect(afterHost.leases).toHaveLength(before.leases.length);
        for (const [index, afterLease] of afterHost.leases.entries()) {
          const beforeLease = before.leases[index]!;
          expect(beforeLease.state).toBe('active');
          expect(afterLease.state).toBe('ended');
          const { endedAt: _beforeEndedAt, ...beforeMetadata } = beforeLease.lease;
          const { endedAt: _afterEndedAt, ...afterMetadata } = afterLease.lease;
          expect(beforeMetadata).toEqual(afterMetadata);
          expect(_beforeEndedAt).toBeUndefined();
          expect(typeof _afterEndedAt).toBe('string');
        }
      } else {
        expect(afterHost).toEqual(before);
      }
    }
    const beforeGrid = new Map(gorillaCheckpoint.ledgerBefore.grids.map((grid) => [grid.grid, grid]));
    for (const afterGrid of gorillaCheckpoint.ledgerAfter.grids) {
      if (afterGrid.grid !== gorillaEvent.targetGridId) {
        expect(JSON.stringify(afterGrid)).toBe(JSON.stringify(beforeGrid.get(afterGrid.grid)));
      } else {
        const before = beforeGrid.get(afterGrid.grid)!;
        expectSummaryMetadataUnchanged(before, afterGrid);
        for (let index = 0; index < afterGrid.hosts.length; index++) {
          const afterHost = afterGrid.hosts[index]!;
          const beforeHost = before.hosts[index]!;
          expect(beforeHost.ledgerLeases).toBe(sessionKinds.length);
          expect(beforeHost.expiredLeases).toBe(0);
          expect(beforeHost.byLane.hand).toBe(sessionKinds.length);
          expect(Object.values(beforeHost.byLane).reduce((sum, count) => sum + count, 0)).toBe(sessionKinds.length);
          expect(beforeHost.observedOccupied).toBe(0);
          expect(beforeHost.difference).toBe(beforeHost.observedOccupied! - beforeHost.ledgerLeases);
          expect(afterHost.ledgerLeases).toBe(0);
          expect(afterHost.expiredLeases).toBe(0);
          expect(Object.values(afterHost.byLane).every((count) => count === 0)).toBe(true);
          expect(afterHost.difference).toBe(afterHost.observedOccupied! - afterHost.ledgerLeases);
        }
      }
    }
    expectGridAdmissionLimits(first.ledger, gorillaEvent.targetGridId, targetHosts, seed);
  }
  expect(sawPriorNonTargetLeaseLoss).toBe(true);
  expect(sawSharedProcessMonkey).toBe(true);
});

test('GRID-SIM-S12 detects unknown grid-level summary metadata drift injected at the ledger adapter boundary', async () => {
  const run = await runGridLoss(1, true);
  const checkpoint = run.checkpoints.find(({ attack }) => attack === 'gorilla')!;
  const before = checkpoint.ledgerBefore.grids.find(({ grid }) => grid === checkpoint.targetGridId)!;
  const after = checkpoint.ledgerAfter.grids.find(({ grid }) => grid === checkpoint.targetGridId)!;
  expect(() => expectSummaryMetadataUnchanged(before, after)).toThrow();
});
