// RESOURCE-OPT-STEWARD (SIM-STEWARD-AB-1125 FU 7·8·9) — the matching table is worked by the steward, not by OP.
//
// S: #40073 sent OP the whole hourly table (38 rows; 3% needed OP) and only at :05, so an idle hand waited 23 min (median).
// C: every assign/pregate/judge row is computable from ledgers; OP is needed only where the steward is refused.
// Q: what reaches OP, and how fast does an idle seat get work?
// A: the steward runs every 10 min and on a seat-idle event (idle ≥ 5 min): assign rows go through `eln seat assign`
//    (SeatAssign · #40072 — its writer check refuses a cell whose paths a live PR writes), pregate rows become one request
//    mail to the PR's author, judge rows one mail to the judge seat. A refusal is recorded (cell-wide for a live writer /
//    unknown cell, else the pair) and the table is rebuilt so the idle seat falls through to the next candidate cell
//    (FU 8). Only refused rows reach OP — once per (cell · refusal code) until the refusal ages out (FU 9).
//
// 세 얼굴: 관측 = `resource steward-assigned | steward-refused | steward-routine | steward-exceptions` log events ·
//          인지 = assign/pregate/judge rows are the steward's; a refusal is the only exception ·
//          수복과 인계 = SeatAssign unavailable (L2 not installed) → `unavailable`: the caller falls back to the full-table
//          assignment turn (#40073), so nothing is silently dropped.
import type { MatchingRow, MatchingTable } from './matching-table.js';
import { rowLine, summaryLine } from './matching-table.js';

export type StewardAssignResult = { ok: true } | { ok: false; code?: string; reason: string };
type AssignRow = Extract<MatchingRow, { kind: 'assign' }>;
type PregateRow = Extract<MatchingRow, { kind: 'pregate' }>;
type JudgeRow = Extract<MatchingRow, { kind: 'judge' }>;

/** Refusal codes that make the CELL unassignable for every seat (not only this pair). */
export const STEWARD_CELL_WIDE_CODES: readonly string[] = ['live-writer', 'unknown-cell', 'closed-cell', 'off-target'];
/** SEAT-ASSIGN-GUARD (11-27): SeatAssign's own guards. Off-target = the cell is not in the target release (cell-wide);
 *  rate-folded = that row was oscillation or an over-cap repeat (the cell became a pull hint). Neither is an exception for
 *  OP. ASSIGN-CAP-POLICY (11-27 10:4x): a fold no longer ends the run — distinct cells to fresh idle hands still pass. */
export const STEWARD_SILENT_CODES: readonly string[] = ['off-target', 'rate-folded'];
/** SeatAssign answered «not installed» — the steward cannot act; the caller falls back to the full table. */
export const STEWARD_UNAVAILABLE = 'unavailable';
/** A refusal is retried (and may be raised again) after this long — the writer may have landed. */
export const STEWARD_REFUSAL_TTL_MS = 2 * 60 * 60_000;
const MAX_PASSES = 4;
/** STEWARD-RX-CURRENT-PLAN — at most this many exception rows reach OP per digest (one digest per pulse). */
export const STEWARD_MAX_EXCEPTIONS = 5;

export interface StewardDeps {
  /** Build the matching table with these refusals excluded (no LLM · ledgers). null = not the HQ seat / nothing readable. */
  build(refused: ReadonlyArray<{ cell: string; seat?: string }>): Promise<MatchingTable | null>;
  /** `eln seat assign <seat> <cell> --version <table version>` — SeatAssign's own checks (writer · coordinator) decide.
   *  STEWARD-RX-CURRENT-PLAN: the table's version (PLAN `status: current`) is passed so SeatAssign reads the same board. */
  assign(row: AssignRow, version: string): Promise<StewardAssignResult>;
  /** One pregate request mail to the PR author (routine). */
  requestPregate?(row: PregateRow): Promise<boolean> | boolean;
  /** One mail to the judge seat for an aged judge row (routine). */
  requestJudge?(row: JudgeRow): Promise<boolean> | boolean;
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface StewardException { row: AssignRow; code: string; reason: string }

export interface StewardOutcome {
  /** The last table built (after every fall-through). */
  table: MatchingTable | null;
  assigned: Array<{ seat: string; cell: string }>;
  routine: string[];
  /** New exceptions only (dedupe by cell · code). Empty = nothing for OP. */
  exceptions: StewardException[];
  /** SeatAssign is not installed — the caller opens the full table instead. */
  unavailable: boolean;
}

export interface Steward {
  run(reason: string): Promise<StewardOutcome>;
  /** Refusals currently excluding cells/pairs (observation · tests). */
  refusals(): ReadonlyArray<{ cell: string; seat?: string; code: string; at: number }>;
}

export function createSteward(deps: StewardDeps): Steward {
  const now = deps.now ?? Date.now;
  const log = (event: string, data: Record<string, unknown>): void => { try { deps.log?.(event, data); } catch { /* fail-open */ } };
  const refused = new Map<string, { cell: string; seat?: string; code: string; at: number }>();
  const raised = new Map<string, number>();
  // STEWARD-RX-CURRENT-PLAN — a (cell · seat) pair already raised to OP is never raised again (OP rejected or acted).
  const raisedPairs = new Set<string>();
  const pregateSent = new Set<string>();
  const judgeSent = new Set<string>();

  const prune = (): void => {
    const t = now();
    for (const [key, r] of refused) if (t - r.at > STEWARD_REFUSAL_TTL_MS) refused.delete(key);
    for (const [key, at] of raised) if (t - at > STEWARD_REFUSAL_TTL_MS) raised.delete(key);
  };

  return {
    refusals: () => [...refused.values()],
    async run(reason) {
      prune();
      const outcome: StewardOutcome = { table: null, assigned: [], routine: [], exceptions: [], unavailable: false };
      for (let pass = 0; pass < MAX_PASSES; pass += 1) {
        const table = await deps.build([...refused.values()].map((r) => ({ cell: r.cell, ...(r.seat ? { seat: r.seat } : {}) })));
        outcome.table = table;
        if (!table) return outcome;
        let refusedThisPass = false;
        for (const row of table.rows) {
          if (row.kind !== 'assign') continue;
          let res: StewardAssignResult;
          try { res = await deps.assign(row, table.version); } catch (error) { res = { ok: false, code: 'error', reason: String(error).slice(0, 200) }; }
          if (res.ok) {
            outcome.assigned.push({ seat: row.seat, cell: row.cell });
            log('steward-assigned', { seat: row.seat, cell: row.cell, trigger: reason });
            continue;
          }
          const code = res.code ?? 'refused';
          if (code === STEWARD_UNAVAILABLE) { outcome.unavailable = true; log('steward-unavailable', { reason: res.reason }); return outcome; }
          const cellWide = STEWARD_CELL_WIDE_CODES.includes(code);
          const key = cellWide ? row.cell : `${row.cell}|${row.seat}`;
          refused.set(key, { cell: row.cell, ...(cellWide ? {} : { seat: row.seat }), code, at: now() });
          refusedThisPass = true;
          log('steward-refused', { seat: row.seat, cell: row.cell, code, reason: res.reason.slice(0, 200) });
          if (STEWARD_SILENT_CODES.includes(code)) continue;
          const raiseKey = `${row.cell}|${code}`;
          const pairKey = `${row.cell.toUpperCase()}|${row.seat.toUpperCase()}`;
          if (raised.has(raiseKey) || raisedPairs.has(pairKey)) continue;
          if (outcome.exceptions.length >= STEWARD_MAX_EXCEPTIONS) { log('steward-exception-capped', { seat: row.seat, cell: row.cell, code }); continue; }
          raised.set(raiseKey, now()); raisedPairs.add(pairKey); outcome.exceptions.push({ row, code, reason: res.reason });
        }
        if (!refusedThisPass) break; // nothing new excluded: same rows next build
      }
      const table = outcome.table;
      for (const row of table?.rows ?? []) {
        if (row.kind === 'pregate') {
          const key = `${row.pr}-${row.head}`;
          if (pregateSent.has(key) || !deps.requestPregate) continue;
          try { if (await deps.requestPregate(row)) { pregateSent.add(key); outcome.routine.push(row.id); } } catch (error) { log('steward-routine-failed', { row: row.id, error: String(error).slice(0, 200) }); }
        } else if (row.kind === 'judge') {
          if (judgeSent.has(row.cell) || !deps.requestJudge) continue;
          try { if (await deps.requestJudge(row)) { judgeSent.add(row.cell); outcome.routine.push(row.id); } } catch (error) { log('steward-routine-failed', { row: row.id, error: String(error).slice(0, 200) }); }
        }
      }
      if (outcome.routine.length) log('steward-routine', { rows: outcome.routine, trigger: reason });
      log('steward-exceptions', { count: outcome.exceptions.length, assigned: outcome.assigned.length, trigger: reason });
      return outcome;
    },
  };
}

/** The exceptions as a table for the assignment gate: only the refused rows, ids RX-n. */
export function exceptionsAsTable(base: MatchingTable, exceptions: readonly StewardException[]): MatchingTable {
  return { ...base, rows: exceptions.map((e, index) => ({ ...e.row, id: `RX-${index + 1}` })) };
}

/** OP's turn input: only what the steward could not resolve, each with SeatAssign's refusal. */
export function formatExceptionPrompt(table: MatchingTable, exceptions: readonly StewardException[]): string {
  return [
    `[resource-opt] steward exceptions — ${exceptions.length} assignment${exceptions.length === 1 ? '' : 's'} the steward could not make (everything else was assigned or requested automatically)`,
    summaryLine(table.summary),
    'Contract — every row ends this turn with an action whose tool call carries the row id, or a reply line "RX-n reject: <reason>".',
    'Rows:',
    ...exceptions.map((e, index) => `${rowLine({ ...e.row, id: `RX-${index + 1}` })} — refused: ${e.code} · ${e.reason.slice(0, 160)}`),
  ].join('\n');
}
