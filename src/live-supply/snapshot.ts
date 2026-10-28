/** Runtime resource facts shared by later harness decisions. No credential values enter this ledger. */
export const SUPPLY_AXES = ['codex', 'grok', 'cost', 'pool', 'hostCredentials', 'parentHosts'] as const;
export type SupplyAxis = typeof SUPPLY_AXES[number];

export interface SupplyValues {
  codex: { accounts: Array<{ name: string; usedPercent: number | null; signalAt: string | null; available: boolean | null }> };
  grok: { quota: 'usable' | 'exhausted' | 'unknown'; observedAt: string | null };
  cost: { used: number | null; limit: number | null; currency: string | null };
  pool: { members: Array<{ context: string; occupied: number | null; capacity: number | null }> };
  hostCredentials: { hosts: Array<{ host: string; grokExpiry: 'healthy' | 'expiring' | 'unknown'; grokExpiresAt: string | null; claude5hUsed: number | null; claude7dUsed: number | null; claude5hResetAt: string | null; claude7dResetAt: string | null }> };
  parentHosts: { hosts: Array<{ host: string; approvalCapacity: number | null; active: number | null; headroom: number | null }> };
}

export type SupplySourceStatus = 'measured' | 'stale' | 'unknown';
export interface SupplySourceState {
  status: SupplySourceStatus;
  observedAt: string | null;
  reason: string | null;
}

export interface LiveSupplySnapshot {
  version: 1;
  sequence: number;
  observedAt: string;
  expiresAt: string;
  sources: Record<SupplyAxis, SupplySourceState>;
  values: Partial<SupplyValues>;
}

export interface SupplyEvent {
  kind: 'supply.changed' | 'supply.unmeasured';
  sequence: number;
  axis: SupplyAxis;
  from: SupplySourceStatus | string;
  to: SupplySourceStatus | string;
  reason: string | null;
  observedAt: string;
}

export type SupplyProbes = { [K in SupplyAxis]: () => Promise<SupplyValues[K]> | SupplyValues[K] };
