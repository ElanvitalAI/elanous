import { inspectCodexRotation, readCachedGrokQuota } from '../oauth/codex-account-store.js';
import { readParentHostCapacity, type ParentHostConfig } from '../task-agent/parent-host.js';
import { measureMemberOccupancy, parsePodPool } from '../task-orchestrator/surfaces/pod-pool.js';
import type { SupplyProbes, SupplyValues } from './snapshot.js';

/** Host credential and cost transports are caller-owned: this module never transfers secret material. */
export interface SupplyProbeDependencies {
  podPoolSpec: () => string | null;
  parentHosts: () => readonly ParentHostConfig[];
  readCost: () => Promise<SupplyValues['cost']> | SupplyValues['cost'];
  readHostCredentials: () => Promise<SupplyValues['hostCredentials']> | SupplyValues['hostCredentials'];
  inspectCodex?: typeof inspectCodexRotation;
  grokQuota?: typeof readCachedGrokQuota;
  occupancy?: typeof measureMemberOccupancy;
  parentCapacity?: typeof readParentHostCapacity;
}

/** Existing provider and pool readers are projected to the no-secret supply contract. */
export function createSupplyProbes(deps: SupplyProbeDependencies): SupplyProbes {
  return {
    codex: () => {
      const state = (deps.inspectCodex ?? inspectCodexRotation)();
      return { accounts: state.candidates.map(candidate => ({
        name: candidate.name,
        usedPercent: candidate.usedPercent ?? null,
        signalAt: state.observedAtByHome[candidate.home] === undefined ? null : new Date(state.observedAtByHome[candidate.home]).toISOString(),
        available: state.freshByHome[candidate.home] !== true ? null : candidate.reached === true ? false : null,
      })) };
    },
    grok: () => ({ quota: (deps.grokQuota ?? readCachedGrokQuota)(), observedAt: null }),
    cost: deps.readCost,
    pool: () => {
      const spec = deps.podPoolSpec();
      if (!spec) throw new Error('pool-unconfigured');
      const members = parsePodPool(spec);
      const measured = (deps.occupancy ?? measureMemberOccupancy)(members);
      return { members: members.map(member => ({
        context: member.context, occupied: measured[member.context]?.occupied ?? null, capacity: member.capacity,
      })) };
    },
    hostCredentials: deps.readHostCredentials,
    parentHosts: () => ({ hosts: deps.parentHosts().map(host => {
      const measurement = (deps.parentCapacity ?? readParentHostCapacity)(host);
      return {
        host: host.host,
        approvalCapacity: host.approvalCapacity ?? 1,
        active: measurement?.active ?? null,
        headroom: measurement?.approvalHeadroom ?? null,
      };
    }) }),
  };
}
