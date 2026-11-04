import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceLedger } from '../control-plane/ledger.js';
import { registerInventoryResource } from './resource-inventory.js';
import { prepareBudgetedBurstReadyLadders } from './burst-auto-wire-ladder.js';
import { createFakeCloudVm } from '../ux-sim/fake-cloud-vm.js';

const HOUR = 3_600_000;
const now = Date.parse('2026-11-03T12:00:00Z');
const imageDigest = `sha256:${'b'.repeat(64)}`;
const input = {
  requestId: 'wire', owner: 'OPT', now, imageDigest,
  pressures: { gate: { queued: 2, blocked: 0 }, implementation: { queued: 1, blocked: 0 }, execution: { queued: 0, blocked: 0 } },
  hourlyCostKrw: { gate: 100_000, implementation: 200_000, execution: 300_000 },
  ttlHours: 2 as const, maxMachinesPerPurpose: 2,
};

test('S1 wires affordable budget plans into the production burst ladder planner', () => {
  const root = mkdtempSync(join(tmpdir(), 'burst-wire-s1-'));
  try {
    const fleet = createFakeCloudVm();
    const result = prepareBudgetedBurstReadyLadders(input, {
      ledger: new ResourceLedger(root),
      prepare: (plan) => fleet.createFromImage({ id: plan.requestId, imageDigest: plan.imageDigest, hourlyCost: 100, stopAfterAt: plan.stopAfterAt }),
    });
    expect(result.decision.status).toBe('planned');
    expect(result.ladderPlans.map(({ purpose, requestId, prepareAt, admissionAt }) => [purpose, requestId, prepareAt, admissionAt]))
      .toEqual([
        ['gate', 'wire-gate-1', now, now + HOUR],
        ['gate', 'wire-gate-2', now, now + HOUR],
        ['implementation', 'wire-implementation-1', now, now + HOUR],
      ]);
    expect(result.ladderPlans).toHaveLength(result.decision.plans.reduce((sum, plan) => sum + plan.count, 0));
    expect(result.prepared).toHaveLength(3);
    expect(fleet.events().filter((event) => event.type === 'create-from-image')).toHaveLength(3);
    expect(new ResourceLedger(root).list({ kind: 'fleet-resource' }, now)).toHaveLength(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('S2 records an unaffordable decision and returns no ladder plans for preparation', () => {
  const root = mkdtempSync(join(tmpdir(), 'burst-wire-s2-'));
  try {
    const ledger = new ResourceLedger(root);
    registerInventoryResource({ id: 'spent', machine: 'gcp1', name: 'spent', provider: 'gcp', ownerSeat: 'OPT', role: 'gate', purpose: 'previous usage', hourlyCost: 200_000, startSignedAt: now - 10 * HOUR }, ledger, now);
    const fleet = createFakeCloudVm();
    const result = prepareBudgetedBurstReadyLadders({ ...input, requestId: 'denied', ttlHours: 4 }, {
      ledger,
      prepare: (plan) => fleet.createFromImage({ id: plan.requestId, imageDigest: plan.imageDigest, hourlyCost: 100, stopAfterAt: plan.stopAfterAt }),
    });
    expect(result.decision.status).toBe('budget-blocked');
    expect(result.ladderPlans).toEqual([]);
    expect(result.prepared).toEqual([]);
    expect(fleet.events()).toEqual([]);
    expect(ledger.list({ kind: 'universe' }, now).filter((row) => row.attrs.type === 'burst-auto-budget-decision'))
      .toMatchObject([{ attrs: { status: 'budget-blocked', realResourcesCreated: 0 } }]);
    expect(ledger.list({ kind: 'fleet-resource' }, now)).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
