import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';

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

/** A decision process reads the collector's atomic pointer, never a partially appended JSONL row. */
export function loadLiveSupplySnapshot(directory = join(getElanousConfigDir(), 'live-supply')): LiveSupplySnapshot | null {
  try {
    const row: unknown = JSON.parse(readFileSync(join(directory, 'latest.json'), 'utf8'));
    if (!row || typeof row !== 'object') return null;
    const snapshot = row as Partial<LiveSupplySnapshot>;
    if (snapshot.version !== 1 || typeof snapshot.sequence !== 'number' || !Number.isSafeInteger(snapshot.sequence)
      || snapshot.sequence < 1 || !snapshot.sources || !snapshot.values) return null;
    if (typeof snapshot.observedAt !== 'string' || typeof snapshot.expiresAt !== 'string') return null;
    if (!SUPPLY_AXES.every(axis => {
      const source = snapshot.sources?.[axis];
      return source && (source.status === 'measured' || source.status === 'stale' || source.status === 'unknown')
        && (source.observedAt === null || typeof source.observedAt === 'string');
    })) return null;
    return snapshot as LiveSupplySnapshot;
  } catch { return null; }
}

export type FreshSupplyAxis<K extends SupplyAxis> =
  | { status: 'fresh'; sequence: number; observedAt: string; value: SupplyValues[K] }
  | { status: 'unavailable'; reason: 'missing' | 'expired' | 'unmeasured' };

/** Only a measured source within the snapshot TTL may influence a new launch. */
export function freshSupplyAxis<K extends SupplyAxis>(snapshot: LiveSupplySnapshot | null, axis: K, nowMs = Date.now()): FreshSupplyAxis<K> {
  if (!snapshot) return { status: 'unavailable', reason: 'missing' };
  const expiry = Date.parse(snapshot.expiresAt);
  const observed = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(expiry) || !Number.isFinite(observed) || observed > nowMs || expiry <= nowMs) {
    return { status: 'unavailable', reason: 'expired' };
  }
  const source = snapshot.sources[axis];
  const value = snapshot.values[axis];
  const sourceObservedAt = source.observedAt;
  const sourceObserved = typeof sourceObservedAt === 'string' ? Date.parse(sourceObservedAt) : Number.NaN;
  if (source.status !== 'measured' || value === undefined || typeof sourceObservedAt !== 'string' || !Number.isFinite(sourceObserved) || sourceObserved > nowMs) {
    return { status: 'unavailable', reason: 'unmeasured' };
  }
  if (sourceObserved + (expiry - observed) <= nowMs) return { status: 'unavailable', reason: 'expired' };
  return { status: 'fresh', sequence: snapshot.sequence, observedAt: sourceObservedAt, value: value as SupplyValues[K] };
}
