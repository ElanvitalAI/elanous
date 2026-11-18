import { debug } from '../../debug/log.js';
import type { TurnEventOutcome } from '../../turn-capsule/contract.js';

/** Observability history only. Waiting and in-flight events remain owned by the bus. */
export interface CompletedTurnEvent {
  id: string;
  outcome: TurnEventOutcome;
  turnId?: string;
  capsuleId?: string;
}

// Source: TURN-CAPSULE-EVENTS §3 C5, the external event ledger's 200-entry limit.
export const TURN_EVENT_HISTORY_CAP = 200;

export function createTurnEventRing(options: {
  log?: (name: string, data: Record<string, unknown>) => void;
} = {}) {
  const rows: CompletedTurnEvent[] = [];
  let start = 0;
  let evicted = 0;
  const log = options.log ?? ((name, data) => debug.log('turn-life', name, data));
  return {
    record(entry: CompletedTurnEvent): boolean {
      if (entry.outcome !== 'responded') return false;
      const copy = { ...entry };
      if (rows.length < TURN_EVENT_HISTORY_CAP) rows.push(copy);
      else {
        const removed = rows[start]!;
        rows[start] = copy;
        start = (start + 1) % TURN_EVENT_HISTORY_CAP;
        evicted++;
        try {
          log('event-history-evicted', { eventId: removed.id, turnId: removed.turnId, capsuleId: removed.capsuleId, evicted });
        } catch { /* observation cannot change event delivery */ }
      }
      return true;
    },
    snapshot(): { rows: CompletedTurnEvent[]; evicted: number } {
      return { rows: [...rows.slice(start), ...rows.slice(0, start)].map(row => ({ ...row })), evicted };
    },
  };
}
