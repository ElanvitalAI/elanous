import type { LogStore } from '../../mss/logging/log-store.js';

const CATEGORY = 'pod.reuse';
const EVENTS = ['return-decision', 'clean-failed', 'quarantine-failed'] as const;

export interface WarmReuseStats {
  observedLeases: number;
  returned: number;
  quarantined: number;
  unresolved: number;
  cleanupFailureLeases: number;
  quarantineFailureLeases: number;
  unidentifiableEvents: number;
  quarantineReasons: Record<string, number>;
}

interface LeaseObservation {
  returned: boolean;
  quarantined: boolean;
  cleanFailed: boolean;
  quarantineFailed: boolean;
  reasons: Set<string>;
}

function parseData(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function leaseKey(data: Record<string, unknown>): string | null {
  if (typeof data.workerId !== 'string' || !data.workerId
    || typeof data.podUid !== 'string' || !data.podUid
    || typeof data.leaseId !== 'string' || !data.leaseId
    || !Number.isSafeInteger(data.generation) || (data.generation as number) < 1) return null;
  return JSON.stringify([data.workerId, data.podUid, data.leaseId, data.generation]);
}

/** Summarize final return dispositions by the full fenced lease identity; duplicate log sinks do not inflate counts. */
export function summarizeWarmReuseStats(rows: readonly { event: string; data: string | null }[]): WarmReuseStats {
  const leases = new Map<string, LeaseObservation>();
  let unidentifiableEvents = 0;
  for (const row of rows) {
    if (!(EVENTS as readonly string[]).includes(row.event)) continue;
    const data = parseData(row.data);
    const id = data && leaseKey(data);
    if (!data || !id) { unidentifiableEvents++; continue; }
    const observation = leases.get(id) ?? {
      returned: false, quarantined: false, cleanFailed: false, quarantineFailed: false, reasons: new Set<string>(),
    };
    if (row.event === 'return-decision') {
      if (data.outcome === 'returned') observation.returned = true;
      if (data.outcome === 'quarantined') observation.quarantined = true;
    }
    if (row.event === 'clean-failed') observation.cleanFailed = true;
    if (row.event === 'quarantine-failed') observation.quarantineFailed = true;
    if (typeof data.reason === 'string' && data.reason) observation.reasons.add(data.reason);
    leases.set(id, observation);
  }

  const quarantineReasons: Record<string, number> = {};
  let returned = 0, quarantined = 0, unresolved = 0, cleanupFailureLeases = 0, quarantineFailureLeases = 0;
  for (const row of leases.values()) {
    if (row.returned !== row.quarantined) {
      if (row.returned) returned++;
      else quarantined++;
    } else unresolved++;
    if (row.cleanFailed) cleanupFailureLeases++;
    if (row.quarantineFailed) quarantineFailureLeases++;
    if (row.quarantined && !row.returned) for (const reason of row.reasons)
      quarantineReasons[reason] = (quarantineReasons[reason] ?? 0) + 1;
  }
  return { observedLeases: leases.size, returned, quarantined, unresolved,
    cleanupFailureLeases, quarantineFailureLeases, unidentifiableEvents, quarantineReasons };
}

/** Read all structured SI child-return observations from one logs.db; missing rows never imply reuse success. */
export function readWarmReuseStats(store: Pick<LogStore, 'queryAll'>): WarmReuseStats {
  const rows = store.queryAll({ exactCategories: [CATEGORY], events: [...EVENTS] });
  return summarizeWarmReuseStats(rows.map(row => ({ event: row.event, data: row.data })));
}
