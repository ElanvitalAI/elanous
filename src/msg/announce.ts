// ── ANNOUNCE-UPTAKE — 연방 공지가 자리에 «먹혔는지» 1급 관측 ──
//
// S: OP 가 연방 공지를 보내면 지금은 ack 만 보인다. 그 공지를 받아 행동을 바꿨는지(적용 한 줄 · 기억)는 로그와
//    기억 파일을 뒤져야 겨우 재구성된다. C: 단순 ack 는 «읽었다»일 뿐 «쓰겠다»가 아니다.
// Q: 공지 하나가 자리마다 어디까지 들어갔나? A: 공지(kind=announce · ref announce:<id>)마다 자리별 사건을
//    원장 표 `msg_announce_events` 에 남기고(같은 원장 · 같은 트랜잭션 계열), `eln announce status` 가 L0..L5 로 묶는다.
//
// 사건(구조 칸만 · 본문 판독 0):
//   delivered = 받는 자리에 delivered/started 영수증이 섰다(입력 큐에 올라감)
//   turn      = seen 이상 영수증 — 턴이 그 우편을 소화했다(outcome = 영수 상태)
//   applied   = 답장·ack 의 `apply` 칸(«적용:» 한 줄) — 문장 매칭이 아니라 명시 칸
//   memory    = 같은 턴 창에서 memory_save 가 불렸거나 announce_id 를 달고 불렸다(file = 기억 파일)
// 관측: debug.log('msg', 'announce.<event>', {announceId, seat, …}) — 본문은 싣지 않는다.

import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { debug } from '../debug/log.js';

export const ANNOUNCE_KIND = 'announce';
export const ANNOUNCE_SCOPES = ['federation', 'coordinators'] as const;
export type AnnounceScope = typeof ANNOUNCE_SCOPES[number];
export const ANNOUNCE_EVENTS = ['delivered', 'turn', 'applied', 'memory'] as const;
export type AnnounceEvent = typeof ANNOUNCE_EVENTS[number];

const ID_REF = 'announce:';
const SCOPE_REF = 'announce-scope:';
/** «같은 턴» 창 — 공지가 들어오거나 소화된 뒤 이 안에서 저장한 기억은 그 공지의 기억이다. */
export const ANNOUNCE_MEMORY_WINDOW_MS = 30 * 60_000;
/** 적용 한 줄 상한 — 한 줄 다짐이지 보고서가 아니다. */
export const ANNOUNCE_APPLY_MAX = 300;
const ANNOUNCE_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export const ANNOUNCE_EVENTS_SCHEMA = `CREATE TABLE IF NOT EXISTS msg_announce_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  announce_id TEXT NOT NULL,
  seat TEXT NOT NULL,
  event TEXT NOT NULL CHECK(event IN ('delivered','turn','applied','memory')),
  detail TEXT NOT NULL DEFAULT '',
  message_id INTEGER,
  at TEXT NOT NULL,
  UNIQUE(announce_id, seat, event, detail)
);
CREATE INDEX IF NOT EXISTS idx_msg_announce_events_seat_at ON msg_announce_events(seat, at);`;

/** Stable announce id: minute stamp ⊕ six hex of the body hash (same body in the same minute → same id). */
export function newAnnounceId(body: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 12);
  return `ann-${stamp}-${createHash('sha256').update(body).digest('hex').slice(0, 6)}`;
}

export function normalizeAnnounceId(raw: string): string {
  const id = raw.trim();
  if (!ANNOUNCE_ID_SHAPE.test(id)) throw new Error(`announce id must be 1-80 chars of [A-Za-z0-9._-]: ${JSON.stringify(raw)}`);
  return id;
}

export function normalizeAnnounceScope(raw: string | undefined): AnnounceScope {
  const scope = (raw ?? 'federation').trim().toLowerCase();
  if (!(ANNOUNCE_SCOPES as readonly string[]).includes(scope)) throw new Error(`announce scope must be ${ANNOUNCE_SCOPES.join(' | ')}`);
  return scope as AnnounceScope;
}

/** The refs an announce carries — the ledger keeps them in `refs_json` (no schema change to msg_messages). */
export function announceRefs(announceId: string, scope: AnnounceScope): string[] {
  return [`${ID_REF}${announceId}`, `${SCOPE_REF}${scope}`];
}

export function announceIdOf(refs: readonly string[] | undefined | null): string | null {
  const ref = refs?.find(item => item.startsWith(ID_REF));
  return ref === undefined ? null : ref.slice(ID_REF.length) || null;
}

export function announceScopeOf(refs: readonly string[] | undefined | null): AnnounceScope {
  const ref = refs?.find(item => item.startsWith(SCOPE_REF));
  const scope = ref?.slice(SCOPE_REF.length);
  return scope === 'coordinators' ? 'coordinators' : 'federation';
}

/**
 * The structured `apply` field (reply · ack). Null = no field. A label «적용:» at the front is dropped (the field
 * already says it is the apply line); the rest must be one nonempty line within ANNOUNCE_APPLY_MAX characters.
 */
export function parseApplyField(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new Error('apply must be a string');
  const line = raw.trim().replace(/^(적용|apply)\s*[:：]\s*/i, '').trim();
  if (!line) throw new Error('apply must be one nonempty line');
  if (/[\r\n]/.test(line)) throw new Error('apply must be a single line');
  if (line.length > ANNOUNCE_APPLY_MAX) throw new Error(`apply must be at most ${ANNOUNCE_APPLY_MAX} characters`);
  return line;
}

/** One rule block appended to an announce's seat-mail notice — what the seat owes beyond a bare ack. */
export function announceNoticeRule(messageId: number, announceId?: string | null): string {
  const idPart = announceId ? ` · announce_id=${announceId}` : '';
  return `[연방 공지 규칙${idPart}] 단순 ack 는 적용이 아니다. 답장(replyTo ${messageId}) 또는 ack 에 apply 칸으로 «적용:» 한 줄 — 앞으로 무엇을 다르게 할지 — 을 남긴다`
    + ` (MsgPost replyTo+apply · MsgAck ids+apply · eln msg post --reply-to ${messageId} --apply "<한 줄>").`
    + ` 이 공지로 행동이 바뀌면 같은 턴에 memory_save 로 기억을 남긴다${announceId ? `(announce_id=${announceId})` : ''}.`;
}

export interface AnnounceEventInput {
  announceId: string;
  seat: string;
  event: AnnounceEvent;
  /** turn → receipt outcome · applied → the apply line · memory → memory file · delivered → ''. */
  detail?: string;
  messageId?: number;
}

/** Insert one uptake event (idempotent per announce·seat·event·detail). Returns true when a new row was written. */
export function recordAnnounceEvent(db: Database, input: AnnounceEventInput, now: () => Date = () => new Date()): boolean {
  db.exec(ANNOUNCE_EVENTS_SCHEMA);
  const detail = input.detail ?? '';
  const result = db.query(`INSERT OR IGNORE INTO msg_announce_events(announce_id, seat, event, detail, message_id, at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(input.announceId, input.seat, input.event, detail, input.messageId ?? null, now().toISOString());
  const inserted = result.changes > 0;
  if (inserted) {
    try {
      const field = input.event === 'turn' ? { outcome: detail } : input.event === 'applied' ? { line: detail } : input.event === 'memory' ? { file: detail } : {};
      debug.log('msg', `announce.${input.event}`, { announceId: input.announceId, seat: input.seat, ...field,
        ...(input.messageId === undefined ? {} : { msgId: input.messageId }) });
    } catch { /* observability is fail-open; the row is durable */ }
  }
  return inserted;
}

function announceOfMessage(db: Database, messageId: number): { announceId: string; kind: string | null } | null {
  const row = db.query('SELECT kind, refs_json FROM msg_messages WHERE id = ?').get(messageId) as { kind: string | null; refs_json: string | null } | null;
  if (row === null || row.kind !== ANNOUNCE_KIND) return null;
  let refs: string[] = [];
  try { refs = row.refs_json ? JSON.parse(row.refs_json) as string[] : []; } catch { refs = []; }
  const announceId = announceIdOf(Array.isArray(refs) ? refs : []);
  return announceId === null ? null : { announceId, kind: row.kind };
}

const DELIVERED_STATES = new Set(['delivered', 'started']);
const TURN_STATES = new Set(['seen', 'accepted', 'rejected', 'done']);

/** Receipt funnel hook (recordReceiptOn): a forward receipt on an announce becomes delivered / turn. Never throws. */
export function noteAnnounceReceipt(db: Database, input: { messageId: number; recipient: string; state: string }, now: () => Date): void {
  if (!DELIVERED_STATES.has(input.state) && !TURN_STATES.has(input.state)) return;
  try {
    const announce = announceOfMessage(db, input.messageId);
    if (announce === null) return;
    recordAnnounceEvent(db, { announceId: announce.announceId, seat: input.recipient, messageId: input.messageId,
      ...(DELIVERED_STATES.has(input.state) ? { event: 'delivered' as const } : { event: 'turn' as const, detail: input.state }) }, now);
  } catch (error) {
    try { debug.log('msg', 'announce.record-failed', { msgId: input.messageId, seat: input.recipient, state: input.state, error: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
    catch { /* fail-open */ }
  }
}

/**
 * The `apply` field on a reply or an ack. `messageId` is the announce mail (the reply's `replyTo` · the acked id).
 * Returns the announce id, or null when that mail is not an announce (the caller warns; nothing is stored).
 */
export function recordAnnounceApply(db: Database, input: { seat: string; messageId: number; line: string; viaMessageId?: number }, now: () => Date = () => new Date()): string | null {
  const announce = announceOfMessage(db, input.messageId);
  if (announce === null) return null;
  recordAnnounceEvent(db, { announceId: announce.announceId, seat: input.seat, event: 'applied', detail: input.line,
    messageId: input.viaMessageId ?? input.messageId }, now);
  return announce.announceId;
}

/**
 * memory_save hook: the saved file counts for (a) the explicit announce id, and (b) every announce whose delivered or
 * turn event for this seat falls inside ANNOUNCE_MEMORY_WINDOW_MS («the same turn»). Returns the announce ids.
 */
export function recordAnnounceMemory(db: Database, input: { seat: string; file: string; announceId?: string | null }, now: () => Date = () => new Date()): string[] {
  db.exec(ANNOUNCE_EVENTS_SCHEMA);
  const since = new Date(now().getTime() - ANNOUNCE_MEMORY_WINDOW_MS).toISOString();
  const recent = (db.query(`SELECT DISTINCT announce_id FROM msg_announce_events WHERE seat = ? AND event IN ('delivered','turn') AND at >= ?`)
    .all(input.seat, since) as Array<{ announce_id: string }>).map(row => row.announce_id);
  const ids = [...new Set([...(input.announceId ? [input.announceId] : []), ...recent])];
  for (const announceId of ids) recordAnnounceEvent(db, { announceId, seat: input.seat, event: 'memory', detail: input.file }, now);
  return ids;
}
