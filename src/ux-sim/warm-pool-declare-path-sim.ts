import { parseMachinePoolDeclarations, type MachinePoolDeclaration } from '../resource-ledger/machine-pool-inventory.js';
import { activeResourcePools, declareResourcePool, readResourceLedger, resourcePoolsForMachine, type ResourceLedgerEvent } from '../resource-ledger/resource-ledger.js';

export interface WarmPoolDeclarePathSimulationResult {
  created: boolean;
  events: ResourceLedgerEvent[];
  activePools: MachinePoolDeclaration[];
  machinePools: MachinePoolDeclaration[];
}

/** Run the same validator, append-only ledger, and machine-scoped projection used by Nexus. */
export function simulateWarmPoolDeclaration(input: unknown, machine: string, ledgerPath: string,
  now = new Date('2026-11-09T00:00:00.000Z')): WarmPoolDeclarePathSimulationResult {
  const pool = parseMachinePoolDeclarations({ pools: [input] })[0]!;
  const created = declareResourcePool(pool, now, ledgerPath);
  const events = readResourceLedger(ledgerPath);
  return { created, events, activePools: activeResourcePools(events),
    machinePools: resourcePoolsForMachine(events, machine) };
}
