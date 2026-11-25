// COACH-CONTEXT-AUTO-INJECT — the coach action ledger (CEO 11-26 01:1x).
// S: the Claude OP coach acts outside eln OP (direct lands · config sets · mail fixes); eln OP never saw them, so it
//    repeated the coach's work or contradicted it. A hand-run script (coach-act.sh) wrote a per-day markdown file.
// C: a per-day file loses the thread at midnight, and nothing read it back into the OP turn.
// Q: where does a coach action go so the next OP turn sees exactly the new ones?
// A: one append-only JSONL under the instance root (`<root>/coach/actions.jsonl`). Each row is one short line written
//    with a single O_APPEND write (concurrent writers never interleave a row). A per-seat cursor (`cursor-<SEAT>.json`)
//    remembers the last row a turn showed, so the WORLD block carries the delta since the previous turn.
// Faces: observe = the ledger rows · judge = the WORLD block delta · heal = unreadable rows are skipped, never thrown.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface CoachAction {
  id: string;
  at: string;
  by: string;
  what: string;
  why: string;
  next: string;
  source: string;
}

/** One field is capped so a row stays one short write (atomic O_APPEND on a local filesystem). */
export const COACH_FIELD_MAX = 600;

const clip = (s: string): string => {
  const one = s.replace(/\s+/gu, ' ').trim();
  return one.length > COACH_FIELD_MAX ? `${one.slice(0, COACH_FIELD_MAX - 1)}…` : one;
};

export function coachDir(instanceRoot: string): string { return join(instanceRoot, 'coach'); }
export function coachLedgerPath(instanceRoot: string): string { return join(coachDir(instanceRoot), 'actions.jsonl'); }
export function coachCursorPath(instanceRoot: string, seat: string): string {
  return join(coachDir(instanceRoot), `cursor-${seat.toUpperCase().replace(/[^A-Z0-9_-]/gu, '_')}.json`);
}

export function appendCoachAction(path: string, input: { what: string; why?: string; next?: string; by?: string; source?: string; now?: Date }): CoachAction {
  const what = clip(input.what ?? '');
  if (!what) throw new Error('--what is required');
  const at = (input.now ?? new Date()).toISOString();
  const row: CoachAction = {
    id: `${at}-${process.pid}-${randomBytes(3).toString('hex')}`,
    at, by: clip(input.by ?? 'CLAUDE-OP') || 'CLAUDE-OP',
    what, why: clip(input.why ?? ''), next: clip(input.next ?? ''), source: clip(input.source ?? 'cli') || 'cli',
  };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`, { flag: 'a' });
  return row;
}

/** Every readable row, oldest first (by `at`, then file order). Missing file = []. */
export function readCoachActions(path: string): CoachAction[] {
  if (!existsSync(path)) return [];
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  const rows: Array<CoachAction & { n: number }> = [];
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Partial<CoachAction>;
      if (typeof r.id === 'string' && typeof r.at === 'string' && typeof r.what === 'string' && Number.isFinite(Date.parse(r.at))) {
        rows.push({ id: r.id, at: r.at, by: String(r.by ?? '?'), what: r.what, why: String(r.why ?? ''), next: String(r.next ?? ''), source: String(r.source ?? '?'), n: n++ });
      }
    } catch { /* a torn or foreign line is skipped */ }
  }
  rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.n - b.n);
  return rows.map(({ n: _n, ...r }) => r);
}

export interface CoachCursor { lastId: string | null; lastAt: string | null }

export function readCoachCursor(path: string): CoachCursor {
  try {
    const c = JSON.parse(readFileSync(path, 'utf8')) as Partial<CoachCursor>;
    return { lastId: typeof c.lastId === 'string' ? c.lastId : null, lastAt: typeof c.lastAt === 'string' ? c.lastAt : null };
  } catch { return { lastId: null, lastAt: null }; }
}

export function writeCoachCursor(path: string, cursor: CoachCursor): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cursor)}\n`);
  renameSync(tmp, path);
}

export interface CoachDelta {
  /** Rows after the cursor (new since the last turn). */
  fresh: number;
  /** The rows to show (newest last), at most `cap`. */
  shown: Array<CoachAction & { fresh: boolean }>;
  /** Fresh rows not shown (beyond the cap). */
  freshOmitted: number;
  /** Total rows in the ledger. */
  total: number;
}

/** The delta since the cursor: the latest `cap` rows, flagging the fresh ones; the overflow is counted, not listed. */
export function coachDelta(rows: readonly CoachAction[], cursor: CoachCursor, cap = 5): CoachDelta {
  let start = 0;
  if (cursor.lastId) {
    const i = rows.findIndex(r => r.id === cursor.lastId);
    if (i >= 0) start = i + 1;
    else if (cursor.lastAt) start = rows.filter(r => Date.parse(r.at) <= Date.parse(cursor.lastAt!)).length;
  }
  const fresh = rows.length - start;
  const shown = rows.slice(Math.max(0, rows.length - cap)).map((r, k, arr) => ({ ...r, fresh: rows.length - arr.length + k >= start }));
  return { fresh, shown, freshOmitted: Math.max(0, fresh - shown.filter(s => s.fresh).length), total: rows.length };
}
