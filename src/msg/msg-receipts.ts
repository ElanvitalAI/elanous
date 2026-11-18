// ── SEAT-INBOX B1-C — 영수증 상태기 (내부 문서 `SEAT-INBOX-PROTOCOL` §4) ──
//
// 덧붙이기만 하는 표 `msg_receipts` 와 그 위의 «앞으로만» 전이. 근거는 구조 행동뿐이다(A205 · R-SIG):
//   posted    = MsgStore.post 커밋(원장)
//   delivered = 받는 자리 입력 큐에 notice{msgId} 항목이 생김(Next TUI) · 클래식 대시보드는 주입 턴이 열림
//   seen      = 그 큐 항목이 status delivered 로 전이(모델 맥락에 들어감) · 클래식은 그 턴 다음 경계
//   accepted · rejected · done = B2(계획 원장 구독). 여기는 API 와 명시 CLI(`eln msg receipt`)만.
// 답의 문장을 읽어 상태를 세우는 길은 없다.
//
// 호환 쓰기(§4c): seen → msg_message_acks(acked) · done → msg_message_acks(done). 그래서 `eln msg list`
// (미ack 숨김) · messageStatus · 감시기 mail-missed 가 그대로 돈다.
// 관측: debug.log('msg', 'msg.receipt.<state>', {msgId, from, to, intent, at, …}) — 본문은 싣지 않는다.

import type { Database } from 'bun:sqlite';
import { debug } from '../debug/log.js';

export const RECEIPT_STATES = ['posted', 'delivered', 'seen', 'accepted', 'rejected', 'done', 'expired', 'overdue'] as const;
export type ReceiptState = typeof RECEIPT_STATES[number];

/** Who wrote the row — a structural actor name, never derived from message text. */
export type ReceiptSource = 'ledger' | 'tui-queue' | 'tui-mail-wake' | 'dashboard-inbox' | 'cli' | 'cli-ack' | 'tool-ack' | 'plan';

export interface ReceiptInput {
  messageId: number;
  /** One concrete recipient (seat). `posted` uses the message address itself (may be ALL · group). */
  recipient: string;
  state: ReceiptState;
  source: ReceiptSource;
  planItemId?: string;
  queueItemId?: string;
  reason?: string;
  evidence?: string;
}

export interface Receipt {
  id: number;
  messageId: number;
  recipient: string;
  /** Sender of the original message (joined from msg_messages) — the subscriber key for `--from`. */
  from: string;
  state: ReceiptState;
  source: ReceiptSource;
  planItemId?: string;
  queueItemId?: string;
  reason?: string;
  evidence?: string;
  at: string;
}

export type ReceiptRecordOutcome =
  | { recorded: true; receipt: Receipt }
  /** Forward-only: an equal/lower state, or anything after a terminal state, changes nothing. */
  | { recorded: false; reason: 'not-forward' | 'unknown-message'; current: ReceiptState | null };

export const MSG_RECEIPTS_SCHEMA = `CREATE TABLE IF NOT EXISTS msg_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES msg_messages(id),
      recipient TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('posted','delivered','seen','accepted','rejected','done','expired','overdue')),
      plan_item_id TEXT,
      queue_item_id TEXT,
      reason TEXT,
      evidence TEXT,
      at TEXT NOT NULL,
      source TEXT NOT NULL,
      UNIQUE(message_id, recipient, state)
    );
    CREATE INDEX IF NOT EXISTS idx_msg_receipts_message ON msg_receipts(message_id, id);`;

/** Progress rank. `overdue` is an annotation (§4a «상태 아님») and never moves the current state. */
const RANK: Readonly<Record<Exclude<ReceiptState, 'overdue'>, number>> = {
  posted: 0, delivered: 1, seen: 2, accepted: 3, rejected: 4, done: 4, expired: 4,
};
const TERMINAL: ReadonlySet<ReceiptState> = new Set(['rejected', 'done', 'expired']);

/**
 * `--until` stop rule (#38244 REVIEW-1 ②): a receipt «reaches» `until` when it is that state, a later one in the order
 * posted < delivered < seen < accepted < rejected|done|expired, or any terminal state — so skipping `seen`
 * (delivered → done) still ends a follow. `overdue` is an annotation: it only matches itself.
 */
export function receiptReaches(state: ReceiptState, until: ReceiptState): boolean {
  if (state === until) return true;
  if (state === 'overdue' || until === 'overdue') return false;
  return TERMINAL.has(state) || RANK[state] >= RANK[until];
}

/** The furthest state among recorded rows (ignoring `overdue`), or null when none. */
export function currentReceiptState(states: readonly ReceiptState[]): ReceiptState | null {
  let best: ReceiptState | null = null;
  for (const state of states) {
    if (state === 'overdue') continue;
    if (best !== null && TERMINAL.has(best)) continue;
    if (best === null || TERMINAL.has(state) || RANK[state] > RANK[best as Exclude<ReceiptState, 'overdue'>]) best = state;
  }
  return best;
}

/** Pure transition rule (§4a): forward only · nothing after terminal · `expired` only before `delivered`. */
export function receiptTransitionAllowed(current: ReceiptState | null, next: ReceiptState): boolean {
  if (current !== null && TERMINAL.has(current)) return false;
  if (next === 'overdue') return true;
  if (current === null) return true;
  if (next === 'expired') return RANK[current as Exclude<ReceiptState, 'overdue'>] < RANK.delivered;
  return RANK[next] > RANK[current as Exclude<ReceiptState, 'overdue'>];
}

/**
 * §1b «옛 행» table: a message with no `intent` takes it from the transport `kind`. The ledger write and read
 * paths (`MsgStore.insertMessage` · `fromRow`) and this module's events all use this one rule.
 */
export function legacyIntent(kind: string | undefined | null): 'request' | 'decision' | 'info' | 'alert' {
  // A kind that already is one of the four intents keeps it (B1-A write/read paths share this one rule).
  if (kind === 'request' || kind === 'decision' || kind === 'info' || kind === 'alert') return kind;
  if (kind === 'question' || kind === 'ask') return 'request';
  if (kind === 'supervisor') return 'alert';
  return 'info';
}

export function isReceiptState(value: string): value is ReceiptState {
  return (RECEIPT_STATES as readonly string[]).includes(value);
}

export function hasReceiptTable(db: Database): boolean {
  return (db.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'msg_receipts'").get() as { count: number }).count > 0;
}

interface ReceiptRow {
  id: number; message_id: number; recipient: string; sender: string; state: ReceiptState; source: ReceiptSource;
  plan_item_id: string | null; queue_item_id: string | null; reason: string | null; evidence: string | null; at: string;
}

function fromReceiptRow(row: ReceiptRow): Receipt {
  return {
    id: row.id, messageId: row.message_id, recipient: row.recipient, from: row.sender, state: row.state, source: row.source,
    ...(row.plan_item_id === null ? {} : { planItemId: row.plan_item_id }),
    ...(row.queue_item_id === null ? {} : { queueItemId: row.queue_item_id }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.evidence === null ? {} : { evidence: row.evidence }),
    at: row.at,
  };
}

const SELECT_RECEIPT = `SELECT r.id, r.message_id, r.recipient, m.sender AS sender, r.state, r.source, r.plan_item_id, r.queue_item_id,
  r.reason, r.evidence, r.at FROM msg_receipts r JOIN msg_messages m ON m.id = r.message_id`;

type ReceiptMessage = { recipient: string; kind: string | null; intent: string | null };

/** Body-free observation line. `intent` = the B1-A column, or the §1b table for a v1 row (NULL intent). */
function emitReceiptEvent(receipt: Receipt, message: ReceiptMessage): void {
  try {
    debug.log('msg', `msg.receipt.${receipt.state}`, {
      msgId: receipt.messageId, receiptId: receipt.id, from: receipt.from, to: receipt.recipient, address: message.recipient,
      intent: message.intent ?? legacyIntent(message.kind), at: receipt.at, source: receipt.source,
      ...(receipt.planItemId === undefined ? {} : { planItemId: receipt.planItemId }),
      ...(receipt.queueItemId === undefined ? {} : { queueItemId: receipt.queueItemId }),
      ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
      ...(receipt.evidence === undefined ? {} : { evidence: receipt.evidence }),
    });
  } catch { /* observability is fail-open; the receipt row is already durable */ }
}

/**
 * Append one receipt if it moves the (message, recipient) pair forward. Runs in one immediate transaction so
 * two writers cannot both pass the forward check. Compat ack rows are written in the same transaction.
 */
export function recordReceiptOn(db: Database, input: ReceiptInput, now: () => Date,
  /** Inside a caller's transaction: hand the event over instead of emitting, so it leaves only after that commit. */
  opts: { deferEvent?: (emit: () => void) => void } = {}): ReceiptRecordOutcome {
  if (!Number.isSafeInteger(input.messageId) || input.messageId < 1) throw new Error('message ID must be a positive integer');
  if (!isReceiptState(input.state)) throw new Error(`invalid receipt state: ${String(input.state)}`);
  if (input.state === 'rejected' && !input.reason?.trim()) throw new Error('rejected needs a reason');
  // §4a 불변식 9 — 근거 없는 done 은 done 이 아니다.
  if (input.state === 'done' && !input.evidence?.trim()) throw new Error('done needs evidence');
  const outcome = db.transaction((): { outcome: ReceiptRecordOutcome; message?: ReceiptMessage } => {
    const message = db.query('SELECT recipient, kind, intent FROM msg_messages WHERE id = ?').get(input.messageId) as ReceiptMessage | null;
    if (message === null) return { outcome: { recorded: false, reason: 'unknown-message', current: null } };
    const states = (db.query('SELECT state FROM msg_receipts WHERE message_id = ? AND recipient = ?')
      .all(input.messageId, input.recipient) as Array<{ state: ReceiptState }>).map(row => row.state);
    const current = currentReceiptState(states);
    if (states.includes(input.state) || !receiptTransitionAllowed(current, input.state)) {
      return { outcome: { recorded: false, reason: 'not-forward', current } };
    }
    const at = now().toISOString();
    const result = db.query(`INSERT INTO msg_receipts(message_id, recipient, state, plan_item_id, queue_item_id, reason, evidence, at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.messageId, input.recipient, input.state, input.planItemId ?? null,
      input.queueItemId ?? null, input.reason ?? null, input.evidence ?? null, at, input.source);
    // §4c 호환 쓰기 — seen 은 acked 를 «없을 때만»(done 을 되감지 않는다), done 은 done 으로 올린다.
    if ((input.state === 'seen' || input.state === 'done') && input.recipient !== 'ALL' && !input.recipient.startsWith('group:')) {
      db.query(`INSERT INTO msg_message_acks(message_id, recipient, status) VALUES (?, ?, ?)
        ON CONFLICT(message_id, recipient) DO ${input.state === 'done' ? "UPDATE SET status = 'done'" : 'NOTHING'}`)
        .run(input.messageId, input.recipient, input.state === 'done' ? 'done' : 'acked');
    }
    const row = db.query(`${SELECT_RECEIPT} WHERE r.id = ?`).get(Number(result.lastInsertRowid)) as ReceiptRow;
    return { outcome: { recorded: true, receipt: fromReceiptRow(row) }, message };
  }).immediate();
  if (outcome.outcome.recorded && outcome.message) {
    const { receipt } = outcome.outcome;
    const message = outcome.message;
    if (opts.deferEvent) opts.deferEvent(() => emitReceiptEvent(receipt, message));
    else emitReceiptEvent(receipt, message);
  }
  return outcome.outcome;
}

export interface ReceiptQuery {
  messageId?: number;
  /** Original sender seat — «내가 보낸 우편의 영수증». */
  from?: string;
  /** Exclusive receipt id cursor. */
  afterId?: number;
  limit?: number;
}

/** Receipts in append order. A ledger opened before the migration simply has none. */
export function listReceiptsOn(db: Database, query: ReceiptQuery = {}): Receipt[] {
  if (!hasReceiptTable(db)) return [];
  const after = query.afterId ?? 0;
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('receipt cursor must be a nonnegative safe integer');
  const limit = query.limit ?? 1000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be between 1 and 1000');
  const where = ['r.id > ?'];
  const params: Array<string | number> = [after];
  if (query.messageId !== undefined) { where.push('r.message_id = ?'); params.push(query.messageId); }
  if (query.from !== undefined) { where.push('m.sender = ?'); params.push(query.from); }
  return (db.query(`${SELECT_RECEIPT} WHERE ${where.join(' AND ')} ORDER BY r.id ASC LIMIT ?`).all(...params, limit) as ReceiptRow[])
    .map(fromReceiptRow);
}

export function latestReceiptIdOn(db: Database): number {
  if (!hasReceiptTable(db)) return 0;
  return (db.query('SELECT COALESCE(MAX(id), 0) AS id FROM msg_receipts').get() as { id: number }).id;
}

/** Does this receipt match a subscription (`--msg <id>` and/or `--from <seat>`)? */
export function receiptMatches(receipt: Receipt, filter: { messageId?: number; from?: string }): boolean {
  if (filter.messageId !== undefined && receipt.messageId !== filter.messageId) return false;
  if (filter.from !== undefined && receipt.from !== filter.from) return false;
  return true;
}

/** One human line — states and ids only, never the body. */
export function formatReceipt(receipt: Receipt): string {
  const extra = [
    receipt.queueItemId === undefined ? null : `queue ${receipt.queueItemId}`,
    receipt.planItemId === undefined ? null : `plan ${receipt.planItemId}`,
    receipt.reason === undefined ? null : `reason ${receipt.reason}`,
    receipt.evidence === undefined ? null : `evidence ${receipt.evidence}`,
  ].filter((part): part is string => part !== null);
  return `msg:${receipt.messageId} ${receipt.from}→${receipt.recipient} ${receipt.state} · ${receipt.at} · ${receipt.source}${extra.length ? ` · ${extra.join(' · ')}` : ''}`;
}
