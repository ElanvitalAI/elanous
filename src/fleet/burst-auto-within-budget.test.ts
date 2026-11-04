import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceLedger } from '../control-plane/ledger.js';
import { registerInventoryResource } from './resource-inventory.js';
import { decideBurstWithinBudget } from './burst-auto-within-budget.js';

const HOUR = 3_600_000;
const imageDigest = `sha256:${'a'.repeat(64)}`;
const prices = { gate: 100_000, implementation: 200_000, execution: 300_000 } as const;
const demand = { gate: { queued: 2, blocked: 1 }, implementation: { queued: 1, blocked: 0 }, execution: { queued: 0, blocked: 3 } } as const;

test('S1 selects purpose-specific bounded plans, passes them to the real ladder seam, and persists one NEXUS decision', () => {
  const root = mkdtempSync(join(tmpdir(), 'burst-budget-s1-'));
  try {
    const ledger = new ResourceLedger(root); const now = Date.parse('2026-11-03T12:00:00Z');
    registerInventoryResource({ id: 'spent', machine: 'aws2', name: 'spent', provider: 'aws', ownerSeat: 'OPT', role: 'gate', purpose: 'previous usage', hourlyCost: 100, startSignedAt: now - 10 * HOUR }, ledger, now);
    const ladderCalls: unknown[] = [];
    const planner = (requests: readonly unknown[]) => { ladderCalls.push(...requests); return requests; };
    const decision = decideBurstWithinBudget({ requestId: 's1', owner: 'OPT', now, imageDigest, pressures: demand, hourlyCostKrw: prices, ttlHours: 2, maxMachinesPerPurpose: 2 }, { ledger, planLadder: planner });
    expect(decision.spentThisMonthKrw).toBe(1000);
    expect(decision.plans.map(({ purpose, count }) => [purpose, count])).toEqual([['gate', 2], ['implementation', 1], ['execution', 1]]);
    expect(ladderCalls).toHaveLength(4);
    expect(decideBurstWithinBudget({ requestId: 's1', owner: 'OPT', now, imageDigest, pressures: demand, hourlyCostKrw: prices, ttlHours: 2, maxMachinesPerPurpose: 2 }, { ledger, planLadder: planner })).toEqual(decision);
    expect(ladderCalls).toHaveLength(4);
    const next = decideBurstWithinBudget({ requestId: 's1-next', owner: 'OPT', now, imageDigest, pressures: demand, hourlyCostKrw: prices, ttlHours: 2, maxMachinesPerPurpose: 2 }, { ledger, planLadder: planner });
    expect(next.plans.map(({ purpose, count }) => [purpose, count])).toEqual([['gate', 2]]);
    const lastAffordable = decideBurstWithinBudget({ requestId: 's1-final', owner: 'OPT', now, imageDigest, pressures: demand, hourlyCostKrw: prices, ttlHours: 2, maxMachinesPerPurpose: 2 }, { ledger, planLadder: planner });
    expect(lastAffordable.status).toBe('budget-blocked'); expect(lastAffordable.plans).toEqual([]);
    expect(ladderCalls).toHaveLength(6);
    expect(ledger.list({ kind: 'universe' }, now).map(row => row.attrs.realResourcesCreated)).toEqual([0, 0, 0]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('S2 records a budget denial and starts no ladder plan when monthly spend leaves no room', () => {
  const root = mkdtempSync(join(tmpdir(), 'burst-budget-s2-'));
  try {
    const ledger = new ResourceLedger(root); const now = Date.parse('2026-11-03T12:00:00Z');
    registerInventoryResource({ id: 'spent', machine: 'gcp1', name: 'spent', provider: 'gcp', ownerSeat: 'OPT', role: 'gate', purpose: 'previous usage', hourlyCost: 200_000, startSignedAt: now - 10 * HOUR }, ledger, now);
    const ladderCalls: unknown[] = [];
    const decision = decideBurstWithinBudget({ requestId: 's2', owner: 'OPT', now, imageDigest, pressures: demand, hourlyCostKrw: prices, ttlHours: 4, maxMachinesPerPurpose: 2 }, { ledger, planLadder: requests => { ladderCalls.push(...requests); return requests; } });
    expect(decision.status).toBe('budget-blocked'); expect(decision.plans).toEqual([]); expect(ladderCalls).toEqual([]);
    expect(ledger.list({ kind: 'universe' }, now)[0]?.attrs.realResourcesCreated).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
