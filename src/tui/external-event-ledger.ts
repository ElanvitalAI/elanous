/**
 * ELN-EXTERNAL-EVENTS-BETWEEN-TURNS — one row per external event:
 * received, then injected, then handled. A miss is a received row that
 * never reaches handled. The count is the number the seat can report.
 * Append-only. A full book first evicts its oldest HANDLED row (a finished event is no miss and no
 * longer needs the book); only a book full of unhandled rows refuses a new id.
 * (11-25 04:4x OP deaf: a long session hit 200 handled rows and every later notice was refused.)
 */

/** SEAT-QUEUE-CAPACITY (CEO 11-25): 200 → 1000 rows (small id/timestamp rows · in-memory) — a full-day coordinator
 *  session must not refuse events because of unhandled backlog. */
export const EXTERNAL_EVENT_LEDGER_CAP = 1000;

export type ExternalEventKind = 'mail' | 'wakeup' | 'child-exit' | 'graph-end';

export type ExternalEventPhase = 'received' | 'injected' | 'handled';

export interface ExternalEventRow {
  id: string;
  kind: ExternalEventKind;
  source: string;
  receivedAt: number;
  injectedAt: number | null;
  handledAt: number | null;
}

export type ExternalEventRefuseReason = 'duplicate' | 'full';

export type ExternalEventReceiveResult =
  | { ok: true; row: ExternalEventRow }
  | { ok: false; reason: ExternalEventRefuseReason };

export interface ExternalEventMissReport {
  /** Rows still waiting at a turn boundary. In-flight rows are not included. */
  rows: readonly ExternalEventRow[];
  /** Refused arrivals (duplicate or full) plus the waiting rows. */
  count: number;
  refused: number;
}

export interface ExternalEventLedger {
  receive(input: { id: string; kind: ExternalEventKind; source: string; at: number }): ExternalEventReceiveResult;
  inject(id: string, at: number): ExternalEventRow | null;
  handle(id: string, at: number): ExternalEventRow | null;
  rows(): readonly ExternalEventRow[];
  /**
   * Turn-end tally. A row counts only when it is still unhandled and not
   * currently injected (in flight). Refused arrivals are added so a full
   * book cannot report zero misses.
   */
  missed(inFlightIds?: readonly string[]): ExternalEventMissReport;
}

export function createExternalEventLedger(cap = EXTERNAL_EVENT_LEDGER_CAP): ExternalEventLedger {
  const rows: ExternalEventRow[] = [];
  const byId = new Map<string, ExternalEventRow>();
  let refused = 0;
  const find = (id: string): ExternalEventRow | null => byId.get(id) ?? null;
  return {
    receive(input) {
      if (byId.has(input.id)) {
        refused += 1;
        return { ok: false, reason: 'duplicate' };
      }
      if (rows.length >= cap) {
        const done = rows.findIndex((row) => row.handledAt !== null);
        if (done >= 0) {
          byId.delete(rows[done]!.id);
          rows.splice(done, 1);
        }
      }
      if (rows.length >= cap) {
        refused += 1;
        return { ok: false, reason: 'full' };
      }
      const row: ExternalEventRow = {
        id: input.id,
        kind: input.kind,
        source: input.source,
        receivedAt: input.at,
        injectedAt: null,
        handledAt: null,
      };
      rows.push(row);
      byId.set(row.id, row);
      return { ok: true, row };
    },
    inject(id, at) {
      const row = find(id);
      if (!row || row.injectedAt !== null) return null;
      row.injectedAt = at;
      return row;
    },
    handle(id, at) {
      const row = find(id);
      if (!row || row.injectedAt === null || row.handledAt !== null) return null;
      row.handledAt = at;
      return row;
    },
    rows: () => rows,
    missed(inFlightIds = []) {
      const flying = new Set(inFlightIds);
      const waiting = rows.filter((row) => row.handledAt === null && !flying.has(row.id));
      return { rows: waiting, refused, count: waiting.length + refused };
    },
  };
}
