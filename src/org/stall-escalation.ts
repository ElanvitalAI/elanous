import type { Checklist, ChecklistItem } from '../release-loop/checklist.js';
import { parseOwner } from '../release-loop/checklist.js';
import type { SeatLoopConfig } from '../user-config.js';

export interface StallEscalation {
  item: ChecklistItem;
  from: string;
  to: string;
  stalledMin: number;
  /** Stable start of this uninterrupted stall interval (independent of the observation clock). */
  startedAt: string;
  reason: 'red' | 'blocked';
}

/** A missing parent is intentional: OP has no automatic escalation destination. */
export const DEFAULT_STALL_PARENTS: Readonly<Record<string, string>> = { MK: 'OP', TC: 'OP', UX: 'OP' };
export const DEFAULT_RED_MINUTES = 30;
export const DEFAULT_BLOCKED_MINUTES = 60;

function stallReason(item: ChecklistItem): StallEscalation['reason'] | null {
  if (item.status === 'red') return 'red';
  return item.status === 'yellow' && item.disposition === 'block' ? 'blocked' : null;
}

/** Find the beginning of the current uninterrupted red/blocked interval, not the most recent evidence edit. */
function stallStart(item: ChecklistItem, history: Checklist['history'], reason: StallEscalation['reason']): number {
  const changes = history.filter((entry) => entry.id === item.id && (entry.field === 'status' || entry.field === 'disposition'))
    .filter((entry) => Number.isFinite(Date.parse(entry.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  let status = item.status;
  let disposition = item.disposition;
  for (const entry of changes) {
    const current = status === 'red' ? 'red' : status === 'yellow' && disposition === 'block' ? 'blocked' : null;
    if (entry.field === 'status') status = entry.from as ChecklistItem['status'];
    else disposition = entry.from as ChecklistItem['disposition'];
    const previous = status === 'red' ? 'red' : status === 'yellow' && disposition === 'block' ? 'blocked' : null;
    if (current === reason && previous !== reason) return Date.parse(entry.at);
  }
  return Date.parse(item.updatedAt);
}

/** Pure checklist snapshot judgment. Age is measured in minutes against the injected clock. */
export function findStalls(checklist: Checklist, config: SeatLoopConfig = { mode: 'off' }, now: Date = new Date()): StallEscalation[] {
  const nowMs = now.getTime();
  const parents = { ...DEFAULT_STALL_PARENTS, ...config.stall?.parents };
  const results: StallEscalation[] = [];
  for (const item of checklist.items) {
    const reason = stallReason(item);
    if (!reason || !item.owner) continue;
    let from: string;
    try { from = parseOwner(item.owner).seat; } catch { continue; }
    const to = parents[from];
    if (!to || to === from) continue;
    const start = stallStart(item, checklist.history, reason);
    if (!Number.isFinite(start) || start > nowMs) continue;
    const stalledMin = (nowMs - start) / 60_000;
    const threshold = reason === 'red' ? config.stall?.redMinutes ?? DEFAULT_RED_MINUTES
      : config.stall?.blockedMinutes ?? DEFAULT_BLOCKED_MINUTES;
    if (stalledMin < threshold) continue;
    results.push({ item, from, to, stalledMin, startedAt: new Date(start).toISOString(), reason });
  }
  return results;
}
