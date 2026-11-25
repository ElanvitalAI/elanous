/**
 * Delegation facts read from the mail ledger — shared by the receiver's router (seat-mail-turn-policy `delegated-result`)
 * and the sender-side back-pressure gate (post-discipline G · RAIL30 ①), so both sides agree on «this answers my ask».
 *   replyToOwn    — mail `replyTo` was sent by `seat`
 *   cellDelegated — `seat` sent mail naming `cell:<id>` in the last 14 days (it assigned or owns that cell)
 * Read-only SQL on the ledger · a missing column (old ledger) reads as «no».
 */
import { SEAT_MAIL_RESULT_REF_PREFIXES } from '../tui/seat-mail-turn-policy.js';

interface LedgerDb {
  query(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
}

const CELL_LOOKBACK_MS = 14 * 24 * 60 * 60_000;

export interface DelegationFacts {
  replyToOwn(replyTo: number, seat: string): boolean;
  cellDelegated(cells: readonly string[], seat: string): boolean;
}

export function ledgerDelegationFacts(db: LedgerDb, now: () => number = Date.now): DelegationFacts {
  return {
    replyToOwn: (replyTo, seat) => {
      const row = db.query('SELECT sender FROM msg_messages WHERE id = ?').get(replyTo) as { sender?: string } | null;
      return typeof row?.sender === 'string' && row.sender.trim().toUpperCase() === seat.trim().toUpperCase();
    },
    cellDelegated: (cells, seat) => {
      const cols = db.query("SELECT name FROM pragma_table_info('msg_messages')").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'refs_json')) return false;
      const since = new Date(now() - CELL_LOOKBACK_MS).toISOString();
      const q = db.query('SELECT 1 AS hit FROM msg_messages WHERE created_at >= ? AND UPPER(sender) = ? AND refs_json LIKE ? LIMIT 1');
      return cells.some((cell) => q.get(since, seat.trim().toUpperCase(), `%${JSON.stringify(`cell:${cell}`)}%`) !== null);
    },
  };
}

/**
 * RAIL30 ① — does a post to `to` answer `to`'s own ask? A reply to a mail `to` sent, or a result/pr/receipt ref for a
 * `cell:` that `to` owns or assigned. Fail-open to «no» (the post is then judged by the other urgent rules).
 */
export function answersReceiverAsk(facts: DelegationFacts | undefined, post: { to: string; replyTo?: number | null; refs?: readonly string[] | null }): boolean {
  if (!facts) return false;
  try {
    if (typeof post.replyTo === 'number' && post.replyTo > 0 && facts.replyToOwn(post.replyTo, post.to)) return true;
  } catch { /* fail-open */ }
  const refs = post.refs ?? [];
  if (!SEAT_MAIL_RESULT_REF_PREFIXES.some((prefix) => refs.some((r) => r.startsWith(prefix)))) return false;
  const cells = refs.filter((r) => r.startsWith('cell:')).map((r) => r.slice('cell:'.length).trim()).filter(Boolean);
  if (cells.length === 0) return false;
  try { return facts.cellDelegated(cells, post.to); } catch { return false; }
}
