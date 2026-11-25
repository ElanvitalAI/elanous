// RESOURCE-OPT-HOURLY (L1) — the assignment turn's end gate: a row closes only with an action or a reject reason.
//
// Reuses the turn-end outcome gate's pieces (goal-continue): this turn's session rows, «a state-changing call whose
// dispatch result succeeded», and the same internal-turn door to reopen. A row is
//   assigned = a succeeded state-changing tool call (mail post · non-read-only shell · SeatAssign …) whose arguments carry «RO-n»
//   rejected = «RO-n reject: <reason>» (reason ≥ 4 chars) in the reply or in such a call
// While a row is open the gate reopens the turn (cap 3); after the cap the remaining rows are recorded as unhandled.
// Three faces: observe = debug.log('resource', 'optimize', {idle, unowned, assigned, rejected, unhandled}) ⊕ last.json
// (Federation Board line) · recognize = the per-row disposition · heal = the reopened turn naming only the open rows.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from '../chat/internal-turn-contract.js';
import { isSucceededStateChange, type ProgressRow } from '../tui/input/goal-continue.js';
import { formatAssignmentPrompt, summaryLine, type MatchingTable } from './matching-table.js';

export const RESOURCE_OPT_REOPEN_CAP = 3;
/** A table older than this is closed (its rows unhandled) when the next one arrives. */
export const RESOURCE_OPT_TABLE_TTL_MS = 55 * 60_000;
/** Tools that count as an assignment action besides goal-continue's state-changing set (L2 SeatAssign when it lands). */
export const RESOURCE_OPT_EXTRA_TOOLS: ReadonlySet<string> = new Set(['seatassign', 'seat_assign', 'elscontrol']);

export type RowDisposition = { kind: 'assigned'; via: string } | { kind: 'rejected'; reason: string };

const ROW_TOKEN = /\bRO-(\d{1,3})\b/gu;
const REJECT = /\bRO-(\d{1,3})\b[^\n]{0,16}?(?:reject(?:ed)?|declined?|거절|보류)\s*[:：—-]\s*(\S[^\n]{3,})/giu;

/** Every string inside the call arguments, one per line (a JSON string argument is parsed first). */
function argsText(args: unknown): string {
  const out: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6) return;
    if (typeof value === 'string') {
      const text = value.trim();
      if (depth === 0 && text.startsWith('{')) { try { walk(JSON.parse(text), depth + 1); return; } catch { /* plain text */ } }
      out.push(value);
    } else if (Array.isArray(value)) value.forEach((item) => walk(item, depth + 1));
    else if (value && typeof value === 'object') Object.values(value).forEach((item) => walk(item, depth + 1));
  };
  walk(args, 0);
  return out.join('\n');
}

/** Rejects named in a text: id → reason. */
export function rejectsIn(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of text.matchAll(REJECT)) {
    const reason = match[2]!.trim().replace(/["'`)\]}]+$/u, '').trim();
    if (reason.length >= 4) out.set(`RO-${Number(match[1])}`, reason.slice(0, 200));
  }
  return out;
}

/**
 * Dispositions this turn produced for the given row ids. A reject wins over an action naming the same row in the same
 * call (a mail that says «RO-2 reject: …» is a reject). Rows not named stay absent.
 */
export function dispositionsOfTurn(rowIds: readonly string[], turn: { lines: readonly string[]; rows: readonly ProgressRow[] }): Map<string, RowDisposition> {
  const wanted = new Set(rowIds);
  const out = new Map<string, RowDisposition>();
  for (const row of turn.rows) {
    if (!isSucceededStateChange(row, RESOURCE_OPT_EXTRA_TOOLS)) continue;
    const text = argsText(row.toolArgs);
    const rejects = rejectsIn(text);
    for (const match of text.matchAll(ROW_TOKEN)) {
      const id = `RO-${Number(match[1])}`;
      if (!wanted.has(id) || out.has(id)) continue;
      const reason = rejects.get(id);
      out.set(id, reason ? { kind: 'rejected', reason } : { kind: 'assigned', via: row.toolName! });
    }
  }
  for (const [id, reason] of rejectsIn(turn.lines.join('\n'))) if (wanted.has(id) && !out.has(id)) out.set(id, { kind: 'rejected', reason });
  return out;
}

export interface ResourceOptRecord {
  at: string;
  closedAt: string;
  version: string;
  idle: number;
  unowned: number;
  stalled: number;
  prsWithoutReceipt: number;
  judgeQueue: number;
  rows: number;
  assigned: number;
  rejected: number;
  unhandled: number;
  reopened: number;
  /** Why the table closed: all rows disposed · reopen cap · replaced by the next table · no rows. */
  closedBy: 'complete' | 'cap' | 'expired' | 'empty';
  dispositions: Record<string, RowDisposition | { kind: 'unhandled' }>;
}

export const resourceOptDir = (hqRoot: string = join(homedir(), 'elanous-hq')): string => join(hqRoot, 'seat-state', 'OP', 'resource-opt');

export function writeResourceOptRecord(dir: string, record: ResourceOptRecord): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `last.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, join(dir, 'last.json'));
  appendFileSync(join(dir, 'history.jsonl'), `${JSON.stringify(record)}\n`);
}

export function readResourceOptRecord(dir: string): ResourceOptRecord | null {
  try { return JSON.parse(readFileSync(join(dir, 'last.json'), 'utf8')) as ResourceOptRecord; } catch { return null; }
}

/** Federation Board line: «⚙ Resource optimize 14:05 — idle 7 · unowned 4 · assigned 5 · rejected 2 · unhandled 0». */
export function resourceOptBoardLine(record: ResourceOptRecord | null): string | null {
  if (!record) return null;
  const at = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(record.at));
  return `⚙ Resource optimize ${at} — idle ${record.idle} · unowned ${record.unowned} · assigned ${record.assigned} · rejected ${record.rejected} · unhandled ${record.unhandled}${record.closedBy === 'cap' ? ' (reopen cap)' : record.closedBy === 'expired' ? ' (expired)' : ''}`;
}

export interface AssignmentGateDeps {
  startTurnIfIdle: (input: string, opts: StartTurnIfIdleOptions) => StartTurnIfIdleResult;
  now?: () => number;
  reopenCap?: number;
  /** Persist the closed table (default: last.json + history.jsonl under resourceOptDir()). */
  write?: (record: ResourceOptRecord) => void;
  notify?: (line: string) => void;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface AssignmentGate {
  /** The scheduler opened the assignment turn for this table. A table still open is closed first (expired). */
  open(table: MatchingTable): void;
  /** No rows: record the hour without a turn. */
  recordEmpty(table: MatchingTable): void;
  active(): MatchingTable | null;
  /** Every turn end while a table is open: collect dispositions from this turn's reply and tool rows. */
  noteTurnEnded(turn: { lines: readonly string[]; rows: readonly ProgressRow[] }): void;
  /** After a turn end: close when every row is disposed, else reopen (cap), else close as unhandled. */
  check(): { opened: boolean; reason: string };
  /** Close an open table whose age passed the TTL (the next hour is due). */
  expireIfStale(): void;
}

export function createAssignmentGate(deps: AssignmentGateDeps): AssignmentGate {
  const now = deps.now ?? Date.now;
  const cap = deps.reopenCap ?? RESOURCE_OPT_REOPEN_CAP;
  const log = deps.log ?? (() => {});
  const write = deps.write ?? ((record: ResourceOptRecord) => writeResourceOptRecord(resourceOptDir(), record));
  let table: MatchingTable | null = null;
  let done = new Map<string, RowDisposition>();
  let reopened = 0;

  const close = (closedBy: ResourceOptRecord['closedBy'], closing: MatchingTable): void => {
    const dispositions: ResourceOptRecord['dispositions'] = {};
    for (const row of closing.rows) dispositions[row.id] = done.get(row.id) ?? { kind: 'unhandled' };
    const values = Object.values(dispositions);
    const record: ResourceOptRecord = {
      at: new Date(closing.at).toISOString(), closedAt: new Date(now()).toISOString(), version: closing.version,
      idle: closing.summary.idle, unowned: closing.summary.unowned, stalled: closing.summary.stalled,
      prsWithoutReceipt: closing.summary.prsWithoutReceipt, judgeQueue: closing.summary.judgeQueue, rows: closing.rows.length,
      assigned: values.filter((d) => d.kind === 'assigned').length, rejected: values.filter((d) => d.kind === 'rejected').length,
      unhandled: values.filter((d) => d.kind === 'unhandled').length, reopened, closedBy, dispositions,
    };
    // The one observation line the trace asked for: resource.optimize {idle, unowned, assigned, rejected}.
    log('optimize', { idle: record.idle, unowned: record.unowned, assigned: record.assigned, rejected: record.rejected,
      unhandled: record.unhandled, rows: record.rows, reopened, closedBy, version: record.version });
    try { write(record); } catch (error) { log('record-write-failed', { error: String(error).slice(0, 200) }); }
    if (record.unhandled > 0) deps.notify?.(`⚙ Resource optimize closed with ${record.unhandled} unhandled row(s) (${closedBy})`);
    table = null;
    done = new Map();
    reopened = 0;
  };

  return {
    open(next) {
      if (table) close('expired', table);
      table = next;
      done = new Map();
      reopened = 0;
      log('opened', { rows: next.rows.length, summary: summaryLine(next.summary), version: next.version });
    },
    recordEmpty(next) {
      if (table) close('expired', table);
      table = next;
      close('empty', next);
    },
    active: () => table,
    noteTurnEnded(turn) {
      if (!table) return;
      const open = table.rows.map((row) => row.id).filter((id) => !done.has(id));
      for (const [id, disposition] of dispositionsOfTurn(open, turn)) done.set(id, disposition);
    },
    check() {
      if (!table) return { opened: false, reason: 'inactive' };
      const unhandled = table.rows.map((row) => row.id).filter((id) => !done.has(id));
      if (unhandled.length === 0) { close('complete', table); return { opened: false, reason: 'complete' }; }
      if (reopened >= cap) { close('cap', table); return { opened: false, reason: 'cap' }; }
      const result = deps.startTurnIfIdle(formatAssignmentPrompt(table, { reopen: { unhandled, round: reopened + 1, cap } }),
        { origin: 'goal-continue', reason: `resource-opt rows open: ${unhandled.length}` });
      if (!result.opened) { log('reopen-rejected', { reason: result.reason, unhandled: unhandled.length }); return { opened: false, reason: result.reason }; }
      reopened += 1;
      log('reopened', { round: reopened, unhandled, turnId: result.turnId });
      return { opened: true, reason: 'rows-open' };
    },
    expireIfStale() {
      if (table && now() - table.at >= RESOURCE_OPT_TABLE_TTL_MS) close('expired', table);
    },
  };
}
