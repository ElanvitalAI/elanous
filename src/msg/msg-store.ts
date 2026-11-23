import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { validateProvenance, type Provenance } from '../provenance/provenance.js';
import { hasReceiptTable, latestReceiptIdOn, TERMINAL_RECEIPT_STATES, legacyIntent, listReceiptsOn, MSG_RECEIPTS_SCHEMA, recordReceiptOn, type Receipt, type ReceiptInput, type ReceiptQuery, type ReceiptRecordOutcome, type ReceiptSource, type ReceiptState } from './msg-receipts.js';
import { recordReceiptClock } from '../hq/msg-receipt-clock-sink.js';
import { appendLedgerEvent } from './ledger-events.js';

export interface MessageEnvelope {
  from: string;
  to: string;
  body: string;
  kind?: string;
  replyTo?: number;
  expiresAt?: string;
  priority?: number;
  supersedes?: number;
  provenance?: Provenance;
  intent?: 'request' | 'decision' | 'info' | 'alert';
  refs?: string[];
  deadlineAt?: string;
  /** A217 request contract: the completion condition («done = …») a request names with its `deadlineAt`. */
  doneWhen?: string;
  needsAck?: boolean;
  crownDirective?: string;
  /** SEAT-INBOX-PROTOCOL §1b: explicit structural origin; derived from the sender when absent. */
  origin?: MessageOrigin;
}

/**
 * SEAT-INBOX-PROTOCOL §1b: structural message origin — the person/seat/tool/system source of a
 * message. Value range matches #38108 TUI `from.kind` exactly: `human` (a person), `agent` (a
 * seat's agent body), `tool` (a tool author such as TA), `system` (hooks and infrastructure).
 */
export interface MessageOrigin {
  kind: 'human' | 'agent' | 'system' | 'tool';
  seat?: string;
  delegatedByCrown?: boolean;
}

export interface Message extends MessageEnvelope {
  id: number;
  createdAt: string;
  /** SCHEMA-V2 row version (2 from mf2 on; rows predating it read as 1). */
  schemaVersion?: number;
  /** Populated by every read path when the kind is known. Absent when the sender matches no
   *  known kind and the caller did not supply origin (unknown is not asserted as system). */
  origin?: MessageOrigin;
  /** ELN-MSG-POST-IDEMPOTENT: this post matched a stored one (same sender · recipient · body within the dedupe window);
   *  no row was written and this is the stored message. Only ever set on a `post` result. */
  deduped?: true;
  /** SEAT-MAIL #16 — on a deduped `post` result: how many times this mail has now been sent (the first row's counter,
   *  this suppressed send included), when the last repeat arrived, and why it was suppressed. */
  repeatCount?: number;
  lastRepeatAt?: string;
  repeatReason?: string;
  /** SEAT-MAIL #24 — on a sender-entrance `post` result (dedupe on): the original message ID this reply auto-acked
   *  for the replying seat. One per-message ack row; the cursor never moves. Absent when the original is not
   *  addressed to the replying seat (ALL · group · another seat) and on every opted-out entrance (`--no-dedupe`,
   *  programmatic producers). */
  autoAcked?: number;
}

/** ELN-MSG-POST-IDEMPOTENT — default dedupe window. Justification: the 11-18 JUD retry loop re-sent one report 13 times
 *  over 5 min 16 s (#87715…#87739). SEAT-MAIL #16 (OP decision 11-19): 30 min — a mail with no explicit origin-key that
 *  repeats with the same sender · normalized body · evidence sha · structural metadata inside 30 min is a repeat, not a
 *  new report (a standing report that carries a new evidence sha or a changed body still goes through). `ELANOUS_MSG_DEDUPE_WINDOW_MS` (0 = off)
 *  or the store option overrides it. Only sender entrances opt in (`msg post` — `--no-dedupe` skips it — and the MsgPost
 *  tool); programmatic producers keep exact append. */
export const MSG_DEDUPE_WINDOW_MS = 30 * 60_000;

function resolveDedupeWindowMs(option: number | undefined): number {
  if (option !== undefined && Number.isFinite(option) && option >= 0) return option;
  const raw = process.env.ELANOUS_MSG_DEDUPE_WINDOW_MS;
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : MSG_DEDUPE_WINDOW_MS;
}

/** SEAT-MAIL #16 — the repeat comparison's body: trimmed, every space/tab run folded to one space (line breaks and
 *  other separators stay — a body that differs in them is a different mail). */
export function normalizeRepeatBody(body: string): string {
  return body.replace(/[ \t]+/g, ' ').trim();
}

/** SEAT-MAIL #16 — the evidence sha of a send: the first sha-shaped (7-40 hex) token inside its refs, lower-cased;
 *  '' when there is none (a missing sha compares as empty). */
export function repeatEvidenceSha(refs: readonly string[] | undefined): string {
  for (const ref of refs ?? []) {
    const match = /(?<![0-9a-zA-Z])[0-9a-fA-F]{7,40}(?![0-9a-zA-Z])/.exec(ref);
    if (match) return match[0].toLowerCase();
  }
  return '';
}

/** The idempotency key's body part — hex sha256 of the exact UTF-8 body. */
export function messageBodySha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** Busy wait for every connection this module opens (writers and read-only readers alike). */
export const MSG_BUSY_TIMEOUT_MS = 5_000;

export interface UnreadRecipient {
  recipient: string;
  count: number;
}

export const SEAT_ALIASES: Readonly<Record<string, string>> = {
  S: 'OP', OP: 'OP', COO: 'OP',
  T: 'MK', MK: 'MK', CMO: 'MK',
  O: 'TC', TC: 'TC', CTO: 'TC',
  F: 'UX', UX: 'UX', CXO: 'UX',
};

/** Normalize historic role names to the current seats; leave other valid seats usable. */
export function canonicalSeatId(value: string): string {
  if (typeof value !== 'string') throw new TypeError('seat must be a string');
  const seat = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{0,63}$/.test(seat)) throw new Error('invalid seat ID');
  return Object.hasOwn(SEAT_ALIASES, seat) ? SEAT_ALIASES[seat]! : seat;
}

/**
 * SEAT-INBOX-PROTOCOL §1b back-compat across the known range only. A sender naming a registered
 * seat (alias or canonical) is that seat's agent body; a HUMAN-family sender is a person; TA/TOOL
 * senders are tool authors. Anything else is unknown — never asserted as agent or system.
 */
export function deriveMessageFromKind(sender: string): 'human' | 'agent' | 'tool' | null {
  const seat = sender.trim().toUpperCase();
  if (Object.hasOwn(SEAT_ALIASES, seat)) return 'agent';
  if (seat === 'HUMAN' || seat.startsWith('HUMAN-') || seat === 'PERSON' || seat === 'USER') return 'human';
  if (seat === 'TA' || seat.startsWith('TA-') || seat === 'TOOL' || seat.startsWith('TOOL-')) return 'tool';
  return null;
}

/** Structural origin for a sender-derived row. Unknown names stay unknown (no invented kind). */
function derivedOrigin(sender: string): MessageOrigin | undefined {
  const kind = deriveMessageFromKind(sender);
  if (kind === null) return undefined;
  return { kind, seat: sender };
}

/** Normalize the public message address syntax while keeping seat IDs backward compatible. */
export function canonicalMessageAddress(value: string): string {
  if (typeof value !== 'string') throw new TypeError('message address must be a string');
  const address = value.trim();
  if (/^seat:/i.test(address)) return canonicalSeatId(address.slice(address.indexOf(':') + 1));
  if (/^group:/i.test(address)) {
    const name = address.slice(address.indexOf(':') + 1).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) throw new Error('invalid group name');
    return name === 'all' ? 'ALL' : `group:${name}`;
  }
  const session = /^session:([A-Za-z0-9_.-]{1,128})$/i.exec(address);
  if (session) return `session:${session[1]}`;
  const pane = /^pane:([A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+)$/i.exec(address)
    ?? /^([A-Za-z0-9_.-]+:p[0-9]+)$/i.exec(address);
  if (pane) return `pane:${pane[1]}`;
  const seatPane = /^([A-Za-z][A-Za-z0-9_-]{0,63})\/([A-Za-z0-9_.-]+)$/.exec(address);
  if (seatPane) return `${canonicalSeatId(seatPane[1]! )}/${seatPane[2]}`;
  return canonicalSeatId(address);
}

function canonicalGroupAddress(value: string): string {
  const address = canonicalMessageAddress(/^group:/i.test(value.trim()) ? value : `group:${value}`);
  if (!address.startsWith('group:')) throw new Error('group address must be group:<name>');
  return address;
}

/** Check untrusted input before opening the DB or executing a write. */
export function validateMessageEnvelope(input: unknown): MessageEnvelope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('message must be an object');
  const record = input as Record<string, unknown>;
  const fromAddress = canonicalMessageAddress(record.from as string);
  // MSG-FILTERS-RELAX: a sub-seat (`MK/graphics`), pane or session address may send — the reply goes back to that same
  // address. Only ALL and group:* stay refused: they name many readers, not one sender.
  if (fromAddress.startsWith('group:')) throw new Error('sender must be a seat');
  const from = fromAddress;
  const to = canonicalMessageAddress(record.to as string);
  if (from === 'ALL') throw new Error('ALL cannot send messages');
  if (from.startsWith('group:')) throw new Error('sender must be a seat');
  if (typeof record.body !== 'string' || !record.body.trim()) throw new Error('message body must be nonempty');
  // MSG-FILTERS-RELAX: any kind tag is accepted and stored (trimmed, lowercased); an empty tag is the same as none.
  const kind = record.kind === undefined || record.kind === null ? undefined : String(record.kind).trim().toLowerCase() || undefined;
  const replyTo = record.replyTo;
  if (replyTo !== undefined && (typeof replyTo !== 'number' || !Number.isSafeInteger(replyTo) || replyTo < 1)) {
    throw new Error('replyTo must be a positive integer message ID');
  }
  if (record.expiresAt !== undefined && (typeof record.expiresAt !== 'string' || !Number.isFinite(Date.parse(record.expiresAt)))) throw new Error('expiresAt must be an ISO timestamp');
  if (record.priority !== undefined && (typeof record.priority !== 'number' || !Number.isFinite(record.priority))) throw new Error('priority must be a finite number');
  if (record.supersedes !== undefined && (typeof record.supersedes !== 'number' || !Number.isSafeInteger(record.supersedes) || record.supersedes < 1)) throw new Error('supersedes must be a positive message ID');
  if (record.provenance !== undefined && !validateProvenance(record.provenance)) throw new Error('invalid message provenance');
  // MSG-FILTERS-RELAX: an unknown intent is not a refusal — the ledger column only holds the four canonical intents
  // (schema CHECK), so it is stored as `info` and the caller's word is kept as an `intent:<word>` ref.
  const rawIntent = record.intent === undefined || record.intent === null ? undefined : String(record.intent).trim().toLowerCase() || undefined;
  const intent = rawIntent === undefined || ['request', 'decision', 'info', 'alert'].includes(rawIntent) ? rawIntent : 'info';
  // MSG-FILTERS-RELAX: a single ref or non-string refs are kept as strings; an empty list is the same as none.
  const refs = [
    ...(record.refs === undefined || record.refs === null ? []
      : (Array.isArray(record.refs) ? record.refs : [record.refs]).map(item => String(item)).filter(item => item.trim() !== '')),
    ...(rawIntent !== undefined && rawIntent !== intent ? [`intent:${rawIntent}`] : []),
  ];
  if (record.deadlineAt !== undefined && (typeof record.deadlineAt !== 'string' || !Number.isFinite(Date.parse(record.deadlineAt)))) throw new Error('deadlineAt must be an ISO timestamp');
  if (record.needsAck !== undefined && typeof record.needsAck !== 'boolean') throw new Error('needsAck must be a boolean');
  // MSG-FILTERS-RELAX: no length cap on the completion condition; an empty one is the same as none.
  const doneWhen = typeof record.doneWhen === 'string' && record.doneWhen.trim() ? record.doneWhen.trim() : undefined;
  const crownDirective = record.crownDirective === undefined || record.crownDirective === null ? undefined : String(record.crownDirective).trim() || undefined;
  if (record.origin !== undefined && (typeof record.origin !== 'object' || record.origin === null || Array.isArray(record.origin)
      || !['human', 'agent', 'system', 'tool'].includes((record.origin as { kind?: unknown }).kind as string))) throw new Error('origin.kind must be human, agent, system, or tool');
  // MSG-FILTERS-RELAX: an unknown field is ignored (and logged), never a refused message.
  const unknownFields = Object.keys(record).filter(key => !['from', 'to', 'body', 'kind', 'replyTo', 'expiresAt', 'priority', 'supersedes', 'provenance', 'intent', 'refs', 'deadlineAt', 'doneWhen', 'needsAck', 'crownDirective', 'origin'].includes(key));
  if (unknownFields.length > 0) {
    try { debug.log('msg', 'msg.envelope.unknown-fields-ignored', { fields: unknownFields }, { level: 'warn' }); } catch { /* observability is fail-open */ }
  }
  return {
    from, to, body: record.body,
    ...(kind === undefined ? {} : { kind }),
    ...(replyTo === undefined ? {} : { replyTo }),
    ...(record.expiresAt === undefined ? {} : { expiresAt: normalizeExpiry(record.expiresAt as string) }),
    ...(record.priority === undefined ? {} : { priority: record.priority as number }),
    ...(record.supersedes === undefined ? {} : { supersedes: record.supersedes as number }),
    ...(record.provenance === undefined ? {} : { provenance: Object.freeze({ ...(record.provenance as Provenance) }) }),
    ...(intent === undefined ? {} : { intent: intent as MessageEnvelope['intent'] }),
    ...(refs.length === 0 ? {} : { refs }),
    ...(record.deadlineAt === undefined ? {} : { deadlineAt: record.deadlineAt as string }),
    ...(doneWhen === undefined ? {} : { doneWhen }),
    ...(record.needsAck === undefined ? {} : { needsAck: record.needsAck as boolean }),
    ...(crownDirective === undefined ? {} : { crownDirective }),
    ...(record.origin === undefined ? {} : { origin: normalizeMessageOrigin(record.origin as Record<string, unknown>, from) }),
  };
}

function normalizeMessageOrigin(value: Record<string, unknown>, sender: string): MessageOrigin {
  const kind = value.kind as MessageOrigin['kind'];
  // MSG-FILTERS-RELAX: seat mail between one operator's seats is not a security boundary — a sender that differs from
  // the real caller is stored, and origin.seat records that caller instead of refusing the message.
  const seat = typeof value.seat === 'string' && value.seat.trim() ? value.seat.trim() : sender;
  // An omitted seat carries the sender, so a reread does not differ.
  // false is a real value (the public type allows it) and must survive a reread, not be dropped.
  return { kind, seat,
    ...(typeof value.delegatedByCrown === 'boolean' ? { delegatedByCrown: value.delegatedByCrown } : {}) };
}

function normalizeExpiry(value: string): string {
  const normalized = new Date(value).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(normalized)) throw new Error('expiresAt must be within years 0000 through 9999');
  return normalized;
}

function validCursor(cursor: number): number {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor must be a nonnegative safe integer');
  return cursor;
}

function hasGroupMembershipTable(db: Database): boolean {
  return (db.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'msg_group_memberships'")
    .get() as { count: number }).count > 0;
}
function hasMessageAckTable(db: Database): boolean {
  return (db.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'msg_message_acks'").get() as { count: number }).count > 0;
}
function hasEnvelopeMetadata(db: Database): boolean {
  return (db.query("SELECT COUNT(*) AS count FROM pragma_table_info('msg_messages') WHERE name = 'expires_at'").get() as { count: number }).count > 0;
}
function envelopeMetaSql(db: Database, qualified: boolean): string {
  return hasEnvelopeMetadata(db)
    ? (qualified ? 'm.expires_at, m.priority, m.supersedes' : 'expires_at, priority, supersedes')
    : 'NULL AS expires_at, NULL AS priority, NULL AS supersedes';
}

/** The unread set's WHERE (cursor · expiry · ack · direct/ALL/group) and its bound parameters — one definition for every unread read. */
function unreadWhereOn(db: Database, to: string, after?: number): { where: string; params: Array<string | number> } {
  const hasAcks = hasMessageAckTable(db);
  const hasMetadata = hasEnvelopeMetadata(db);
  const hasGroups = hasGroupMembershipTable(db);
  const ackClause = hasAcks ? 'AND NOT EXISTS (SELECT 1 FROM msg_message_acks a WHERE a.message_id=m.id AND a.recipient=?)' : '';
  const expiryClause = hasMetadata ? "AND (m.expires_at IS NULL OR julianday(m.expires_at) > julianday('now'))" : '';
  const groupClause = hasGroups ? ` OR EXISTS (
        SELECT 1 FROM msg_group_memberships gm WHERE gm.address = m.recipient AND gm.seat = ?
          AND m.id > gm.joined_after_id AND (gm.left_after_id IS NULL OR m.id <= gm.left_after_id)
      )` : '';
  return {
    where: `m.id > ${after === undefined ? 'COALESCE((SELECT last_id FROM msg_cursors WHERE recipient = ?), 0)' : '?'}
      ${expiryClause} ${ackClause}
      AND (m.recipient = ? OR (m.recipient = 'ALL' AND m.sender <> ?)${groupClause})`,
    params: [after ?? to, ...(hasAcks ? [to] : []), to, to, ...(hasGroups ? [to] : [])],
  };
}

/**
 * MSG-LEDGER-RETENTION-INDEX ② — 미읽음 팔(direct · ALL 방송 · group:*): UNION SELECT 로 나눈다.
 * 각 팔은 (recipient, id, sender, expires_at) 커버 색인을 타고 들어가 OR 절 전수 행 훑기가 없다.
 * UNION 은 id 가 팔마다 배타적이라(수신자가 단일값) 중복 제거 비용 없이 legacy OR 술어와 동치다.
 */
export function unreadArmsOn(db: Database, to: string, after?: number): { sql: string; params: Array<string | number> } {
  const recipient = canonicalMessageAddress(to);
  if (recipient === 'ALL') throw new Error('ALL is a broadcast topic, not a recipient');
  const hasAcks = hasMessageAckTable(db);
  const hasMetadata = hasEnvelopeMetadata(db);
  const hasGroups = hasGroupMembershipTable(db);
  const expiry = hasMetadata ? "AND (m.expires_at IS NULL OR julianday(m.expires_at) > julianday('now'))" : '';
  const ack = hasAcks ? 'AND NOT EXISTS (SELECT 1 FROM msg_message_acks a WHERE a.message_id = m.id AND a.recipient = ?)' : '';
  const bound = after === undefined ? 'COALESCE((SELECT last_id FROM msg_cursors WHERE recipient = ?), 0)' : '?';
  const boundParams: Array<string | number> = after === undefined ? [recipient] : [after];
  const arms = [
    `SELECT m.id AS id, m.created_at AS created_at FROM msg_messages m
      WHERE m.id > ${bound} AND m.recipient = ? ${expiry} ${ack}`,
    `SELECT m.id AS id, m.created_at AS created_at FROM msg_messages m
      WHERE m.recipient = 'ALL' AND m.sender <> ? AND m.id > ${bound} ${expiry} ${ack}`,
  ];
  const params: Array<string | number> = [
    ...boundParams, recipient, ...(hasAcks ? [recipient] : []),
    recipient, ...boundParams, ...(hasAcks ? [recipient] : []),
  ];
  if (hasGroups) {
    arms.push(`SELECT m.id AS id, m.created_at AS created_at FROM msg_messages m
      JOIN msg_group_memberships gm ON gm.address = m.recipient AND gm.seat = ?
      WHERE m.id > gm.joined_after_id AND (gm.left_after_id IS NULL OR m.id <= gm.left_after_id)
        AND m.id > ${bound} ${expiry} ${ack}`);
    params.push(recipient, ...boundParams, ...(hasAcks ? [recipient] : []));
  }
  return { sql: arms.join(' UNION '), params };
}

/**
 * Who the unread set came from, when that is one agent seat (ELN-SEAT-SAY · MSG-SOURCE-HIERARCHY): every unread row has
 * the same sender and its structural kind is `agent` (B1-A `from_kind`, or the §1b sender-shape rule for a v1 row).
 * Mixed senders, a non-agent sender, or no unread → null (the waker then says «system», never a guess).
 */
export interface UnreadSource {
  seat: string; intent?: string; latestId: number;
  /** The latest message's A217 due. */
  deadlineAt?: string;
  /** The unread messages themselves, oldest first — what that seat actually wrote (MSG-SOURCE-HIERARCHY: shown under its head). */
  messages: ReadonlyArray<{ id: number; body: string }>;
}

function unreadSourceOn(db: Database, to: string): UnreadSource | null {
  const { where, params } = unreadWhereOn(db, to);
  const fromKind = columnPresent(db, 'from_kind') ? 'm.from_kind' : 'NULL';
  const intent = columnPresent(db, 'intent') ? 'm.intent' : 'NULL';
  const deadline = columnPresent(db, 'deadline_at') ? 'm.deadline_at' : 'NULL';
  // MSG-RECEIPTS-FOLLOWUP ③ (#84659 A③): decide on sender · kind first — bodies are read only for a batch that IS one agent seat.
  const rows = db.query(`SELECT m.id AS id, m.sender AS sender, m.kind AS kind, ${fromKind} AS from_kind, ${intent} AS intent, ${deadline} AS deadline_at
    FROM msg_messages m WHERE ${where} ORDER BY m.id DESC LIMIT 1001`)
    .all(...params) as Array<{ id: number; sender: string; kind: string | null; from_kind: string | null; intent: string | null; deadline_at: string | null }>;
  const latest = rows[0];
  if (latest === undefined || rows.length > 1000) return null;
  const kindOf = (row: typeof latest) => row.from_kind ?? derivedOrigin(row.sender)?.kind ?? null;
  if (rows.some(row => row.sender !== latest.sender || kindOf(row) !== 'agent')) return null;
  const ids = rows.map(row => row.id);
  const bodies = new Map((db.query(`SELECT id, body FROM msg_messages WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ id: number; body: string }>)
    .map(row => [row.id, row.body] as const));
  return { seat: latest.sender, intent: latest.intent ?? legacyIntent(latest.kind), latestId: latest.id,
    ...(latest.deadline_at ? { deadlineAt: latest.deadline_at } : {}),
    messages: rows.map(row => ({ id: row.id, body: bodies.get(row.id) ?? '' })).reverse() };
}

/** Unread count ⊕ newest unread ID for one recipient (same predicate as `unreadCountOn`). */
function unreadSummaryOn(db: Database, to: string): { count: number; maxId: number | null } {
  // MSG-LEDGER-RETENTION-INDEX ② — 요약/badge 경로도 같은 UNION 팔 술어로 센다(커버 색인만 탄다).
  const arms = unreadArmsOn(db, to);
  const row = db.query(`SELECT COUNT(*) AS count, MAX(id) AS max_id FROM (${arms.sql})`)
    .get(...arms.params) as { count: number; max_id: number | null };
  return { count: row.count, maxId: row.max_id ?? null };
}

function unreadCountOn(db: Database, to: string): number {
  // MSG-LEDGER-RETENTION-INDEX ② — UNION 팔로 센다(각 팔은 (recipient, id) 커버 색인만 탄다).
  const arms = unreadArmsOn(db, to);
  return (db.query(`SELECT COUNT(*) AS count FROM (${arms.sql})`).get(...arms.params) as { count: number }).count;
}

interface MessageRow {
  id: number;
  sender: string;
  recipient: string;
  body: string;
  kind: string | null;
  reply_to: number | null;
  created_at: string;
  expires_at?: string | null;
  priority?: number | null;
  supersedes?: number | null;
  provenance_json?: string | null;
  from_kind?: 'human' | 'agent' | 'system' | 'tool' | null;
  intent?: 'request' | 'decision' | 'info' | 'alert' | null;
  refs_json?: string | null;
  deadline_at?: string | null;
  done_when?: string | null;
  needs_ack?: number | null;
  crown_directive?: string | null;
  schema_version?: number | null;
  body_ref_json?: string | null;
  origin_seat?: string | null;
  origin_delegated?: number | null;
}

function fromRow(row: MessageRow): Message {
  // v1 rows (NULL intent/needs_ack) normalize per SEAT-INBOX-PROTOCOL §5: needsAck NULL→false,
  // intent NULL→the §1b legacy-kind table (`legacyIntent`: the four values keep themselves · question/ask→request ·
  // supervisor→alert · the rest→info).
  const intent = row.intent ?? legacyIntent(row.kind);
  const origin = messageOriginFromRow(row);
  return { id: row.id, from: row.sender, to: row.recipient, body: row.body,
    ...(row.kind === null ? {} : { kind: row.kind }),
    ...(row.reply_to == null ? {} : { replyTo: row.reply_to }),
    ...(row.expires_at == null ? {} : { expiresAt: row.expires_at }),
    ...(row.priority == null ? {} : { priority: row.priority }),
    ...(row.supersedes == null ? {} : { supersedes: row.supersedes }),
    intent,
    ...(parseStoredRefs(row.refs_json) ? { refs: parseStoredRefs(row.refs_json)! } : {}),
    ...(row.deadline_at == null ? {} : { deadlineAt: row.deadline_at }),
    ...(row.done_when == null ? {} : { doneWhen: row.done_when }),
    needsAck: row.needs_ack === 1,
    ...(row.crown_directive == null ? {} : { crownDirective: row.crown_directive }),
    ...(parseStoredProvenance(row.provenance_json) ? { provenance: parseStoredProvenance(row.provenance_json)! } : {}),
    ...(origin ? { origin } : {}),
    schemaVersion: row.schema_version ?? 1,
    createdAt: row.created_at };
}

/**
 * Stored from_kind wins across the §1b four-value range; a NULL/absent value (v1 ledgers before
 * the column existed) falls back to deriving agent|system from the sender. A stored crown_directive
 * marks §1 crown delegation on any kind; human/agent/tool origins carry the sender as their seat.
 */
function messageOriginFromRow(row: MessageRow): MessageOrigin | undefined {
  const stored = row.from_kind;
  const known = stored === 'human' || stored === 'agent' || stored === 'system' || stored === 'tool';
  if (!known && stored != null) return undefined;
  const derived = known ? null : deriveMessageFromKind(row.sender);
  if (!known && derived === null) return undefined;
  const kind = (known ? stored : derived) as MessageOrigin['kind'];
  // undefined = the column is absent (pre-origin ledger). null = the writer omitted the seat.
  // Both keep the sender: a system row's seat is the sender too, and a migration NULL is not
  // "the writer omitted the seat".
  const seat = row.origin_seat == null ? row.sender : row.origin_seat;
  const delegated = row.origin_delegated === 1 || (row.origin_delegated == null && !!row.crown_directive);
  const delegatedFalse = row.origin_delegated === 0;
  return { kind,
    ...(seat ? { seat } : {}),
    ...(delegated ? { delegatedByCrown: true } : {}),
    ...(delegatedFalse ? { delegatedByCrown: false } : {}) };
}

function parseStoredRefs(json: string | null | undefined): string[] | undefined {
  if (!json) return undefined;
  try {
    const value: unknown = JSON.parse(json);
    if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value as string[];
  } catch { /* corrupt refs metadata is unknown */ }
  return undefined;
}

function parseStoredProvenance(json: string | null | undefined): Provenance | undefined {
  if (json) {
    try { const value: unknown = JSON.parse(json); if (validateProvenance(value)) return value; } catch { /* corrupt or legacy metadata is unknown */ }
  }
  return undefined;
}

/** SQLite owns both append order and per-recipient acknowledgement progress. */
export class MsgStore {
  readonly db: Database;
  private readonly dbPath: string;
  private readonly clock: () => Date;
  private readonly dedupeWindowMs: number;
  /** posted-receipt events held until the outermost write transaction commits (dropped on rollback). */
  private pendingPostedEvents: Array<() => void> = [];
  private postedEventDepth = 0;
  /** MSG-LEDGER-ARCHIVE-THREAD-READ-FU ③ — 읽기 폴백 보관 원장(옵션 · 지연 오픈 · 읽기 전용). */
  private readonly archivePathOption: string | null = null;
  private archiveDb: Database | null = null;

  /** ELS-SERVER-EVENT-HUB-NO-DB-POLL — one best-effort sidecar line beside a COMMITTED ledger write; ':memory:' is exempt. */
  private emitLedgerEvent(kind: 'post' | 'ack' | 'receipt' | 'group'): void {
    if (this.dbPath === ':memory:') return;
    appendLedgerEvent(this.dbPath, kind);   // never throws — the ledger write is the fact, this line is a courtesy
  }

  /**
   * SEAT-INBOX B1-C (#38194 REVIEW-1 ①②): run one message write as a single immediate transaction so the message
   * INSERT and its posted receipt commit or roll back together (a failed post never leaves a stored message behind,
   * so a retry cannot store it twice), and emit `msg.receipt.posted` only after that commit.
   *
   * TRANSACTION-REVIEW #38917 ①: a caller may catch a nested write's failure, so the failure must not leak that
   * attempt's partial writes (message + receipts) into the caller's still-open transaction — a nested write runs
   * under a savepoint that rolls back on error, and the events this attempt queued are dropped with it.
   */
  private withPostedEvents<T>(write: () => T): T {
    this.postedEventDepth += 1;
    const savepoint = `msg_posted_events_${this.postedEventDepth}`;
    const nested = this.db.inTransaction;
    const queuedAtEntry = this.pendingPostedEvents.length;
    let result: T;
    if (nested) this.db.exec(`SAVEPOINT ${savepoint}`);
    try { result = nested ? write() : this.db.transaction(write).immediate(); }
    catch (error) {
      if (nested) {
        try { this.db.exec(`ROLLBACK TO ${savepoint}`); } catch { /* the failing write already unwound this savepoint */ }
        try { this.db.exec(`RELEASE ${savepoint}`); } catch { /* savepoint already gone */ }
        this.pendingPostedEvents.length = queuedAtEntry;
      }
      this.postedEventDepth -= 1;
      if (this.postedEventDepth === 0) this.pendingPostedEvents = [];
      throw error;
    }
    if (nested) this.db.exec(`RELEASE ${savepoint}`);
    this.postedEventDepth -= 1;
    if (this.postedEventDepth === 0 && !this.db.inTransaction) {
      const events = this.pendingPostedEvents;
      this.pendingPostedEvents = [];
      for (const emit of events) emit();
    }
    return result;
  }

  // A read-only SSE connection may outlive another process's in-place migration.
  private get hasReplyTo(): boolean {
    return (this.db.query(`SELECT COUNT(*) AS count FROM pragma_table_info('msg_messages') WHERE name = 'reply_to'`)
      .get() as { count: number }).count > 0;
  }

  private get hasProvenance(): boolean {
    return (this.db.query(`SELECT COUNT(*) AS count FROM pragma_table_info('msg_messages') WHERE name = 'provenance_json'`)
      .get() as { count: number }).count > 0;
  }

  private get hasFromKind(): boolean {
    return (this.db.query(`SELECT COUNT(*) AS count FROM pragma_table_info('msg_messages') WHERE name = 'from_kind'`)
      .get() as { count: number }).count > 0;
  }

  private get hasGroupMemberships(): boolean {
    return (this.db.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'msg_group_memberships'")
      .get() as { count: number }).count > 0;
  }

  private readWithSchema<T>(read: (hasReplyTo: boolean, hasGroupMemberships: boolean, hasProvenance: boolean, hasFromKind: boolean) => T): T {
    // The schema projection and rows must share one SQLite snapshot. Otherwise a writer can
    // migrate between them and a reader could advance past a reply with its link erased.
    // v2/origin columns are projected inside the same transaction by v2Select.
    return this.db.transaction(() => read(this.hasReplyTo, this.hasGroupMemberships, this.hasProvenance, this.hasFromKind)).deferred();
  }

  constructor(path: string = defaultMsgStorePath(), options: { readOnly?: boolean; now?: () => Date; dedupeWindowMs?: number; busyTimeoutMs?: number; archivePath?: string } = {}) {
    this.clock = options.now ?? (() => new Date());
    this.dbPath = path;
    this.dedupeWindowMs = resolveDedupeWindowMs(options.dedupeWindowMs);
    this.archivePathOption = options.archivePath ?? null;
    if (options.readOnly && (path === ':memory:' || !existsSync(path))) throw new Error('message ledger unavailable for read-only SSE service');
    if (!options.readOnly && path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = options.readOnly ? new Database(path, { readonly: true }) : new Database(path);
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? MSG_BUSY_TIMEOUT_MS))}`);
    if (!options.readOnly) this.db.exec(`CREATE TABLE IF NOT EXISTS msg_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      body TEXT NOT NULL,
      kind TEXT,
      reply_to INTEGER,
      created_at TEXT NOT NULL,
      provenance_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_msg_messages_recipient_id ON msg_messages(recipient, id);
    CREATE INDEX IF NOT EXISTS idx_msg_messages_created_at_id ON msg_messages(created_at, id);
    CREATE TABLE IF NOT EXISTS msg_cursors (
      recipient TEXT PRIMARY KEY,
      last_id INTEGER NOT NULL DEFAULT 0 CHECK(last_id >= 0)
    );
    CREATE TABLE IF NOT EXISTS msg_message_acks (message_id INTEGER NOT NULL REFERENCES msg_messages(id), recipient TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('acked','done')), PRIMARY KEY(message_id, recipient));
    CREATE TABLE IF NOT EXISTS msg_provenance (
      provenance_key TEXT PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES msg_messages(id)
    );
    CREATE TABLE IF NOT EXISTS msg_ta_delivery (
      request_id INTEGER PRIMARY KEY REFERENCES msg_messages(id),
      status TEXT NOT NULL CHECK(status IN ('pending', 'delivered'))
    );
      CREATE TABLE IF NOT EXISTS msg_ta_claim (
      request_id INTEGER PRIMARY KEY REFERENCES msg_messages(id),
      token TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS msg_groups (
      address TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS msg_group_memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL REFERENCES msg_groups(address),
      seat TEXT NOT NULL,
      joined_after_id INTEGER NOT NULL DEFAULT 0 CHECK(joined_after_id >= 0),
      left_after_id INTEGER CHECK(left_after_id IS NULL OR left_after_id >= joined_after_id)
    );
    CREATE INDEX IF NOT EXISTS idx_msg_group_memberships_seat_interval ON msg_group_memberships(seat, joined_after_id, left_after_id);`);
    // SEAT-INBOX B1-C — 영수증 표(덧붙이기만). 옛 바이너리는 이 표를 모르므로 읽기에 영향 0.
    if (!options.readOnly) this.db.exec(MSG_RECEIPTS_SCHEMA);
    if (!options.readOnly) this.db.exec(`CREATE TABLE IF NOT EXISTS msg_group_all_budget (
      sender TEXT NOT NULL,
      hour_start TEXT NOT NULL,
      broadcast_count INTEGER NOT NULL CHECK(broadcast_count BETWEEN 1 AND 2),
      summary_id INTEGER REFERENCES msg_messages(id),
      PRIMARY KEY(sender, hour_start)
    );`);
    // Serialize the schema check and ALTER across processes opening an old ledger at once. ELN-MSG-POST-IDEMPOTENT busy
    // review: every writable open used to take this IMMEDIATE (RESERVED) lock even when nothing was missing — one extra
    // writer per `msg post` / receipt write against ~30 polling seats. A current ledger now skips it after one read.
    if (!options.readOnly && this.needsMigration()) this.db.transaction(() => {
      const replyToColumn = (this.db.query(`SELECT COUNT(*) AS count FROM pragma_table_info('msg_messages') WHERE name = 'reply_to'`)
        .get() as { count: number }).count;
      if (replyToColumn === 0) this.db.exec('ALTER TABLE msg_messages ADD COLUMN reply_to INTEGER');
      const columns = new Set((this.db.query('PRAGMA table_info(msg_messages)').all() as { name: string }[]).map(row => row.name));
      if (!columns.has('expires_at')) this.db.exec('ALTER TABLE msg_messages ADD COLUMN expires_at TEXT');
      if (!columns.has('priority')) this.db.exec('ALTER TABLE msg_messages ADD COLUMN priority REAL');
      if (!columns.has('supersedes')) this.db.exec('ALTER TABLE msg_messages ADD COLUMN supersedes INTEGER');
      if (!columns.has('provenance_json')) this.db.exec('ALTER TABLE msg_messages ADD COLUMN provenance_json TEXT');
      if (!columns.has('from_kind')) this.db.exec('ALTER TABLE msg_messages ADD COLUMN from_kind TEXT');
      if (!columns.has('crown_directive')) this.db.exec('ALTER TABLE msg_messages ADD COLUMN crown_directive TEXT');
      if (!columns.has('intent')) this.db.exec("ALTER TABLE msg_messages ADD COLUMN intent TEXT CHECK(intent IN ('request','decision','info','alert'))");
      if (!columns.has('refs_json')) this.db.exec('ALTER TABLE msg_messages ADD COLUMN refs_json TEXT');
      if (!columns.has('body_ref_json')) this.db.exec('ALTER TABLE msg_messages ADD COLUMN body_ref_json TEXT');
      if (!columns.has('deadline_at')) this.db.exec('ALTER TABLE msg_messages ADD COLUMN deadline_at TEXT');
      if (!columns.has('needs_ack')) this.db.exec('ALTER TABLE msg_messages ADD COLUMN needs_ack INTEGER');
      if (!columns.has('schema_version')) this.db.exec('ALTER TABLE msg_messages ADD COLUMN schema_version INTEGER');
      if (!columns.has('origin_seat')) {
        this.db.exec('ALTER TABLE msg_messages ADD COLUMN origin_seat TEXT');
        // Pre-origin rows have no stored seat. Filling sender for every kind, including system,
        // keeps a later read from treating the migration NULL as "the writer omitted the seat".
        this.db.exec('UPDATE msg_messages SET origin_seat = sender WHERE origin_seat IS NULL');
      }
      if (!columns.has('origin_delegated')) this.db.exec('ALTER TABLE msg_messages ADD COLUMN origin_delegated INTEGER');
      // A217 — request completion condition (additive · old binaries ignore it).
      if (!columns.has('done_when')) this.db.exec('ALTER TABLE msg_messages ADD COLUMN done_when TEXT');
      // ELN-MSG-POST-IDEMPOTENT — the body part of the sender idempotency key. Rows written before it stay NULL;
      // the dedupe lookup compares their body directly, so a retry that straddles the upgrade still collapses.
      if (!columns.has('body_sha256')) this.db.exec('ALTER TABLE msg_messages ADD COLUMN body_sha256 TEXT');
      // MF3: the per-attempt token a sender writes with its INSERT, so recovery can identify its own commit.
      if (!columns.has('post_attempt')) this.db.exec('ALTER TABLE msg_messages ADD COLUMN post_attempt TEXT');
      // SEAT-MAIL #16 — repeat counter on the first row (NULL = sent once) and when the last suppressed repeat arrived.
      if (!columns.has('repeat_count')) this.db.exec('ALTER TABLE msg_messages ADD COLUMN repeat_count INTEGER');
      if (!columns.has('last_repeat_at')) this.db.exec('ALTER TABLE msg_messages ADD COLUMN last_repeat_at TEXT');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_msg_messages_reply_to ON msg_messages(reply_to, id)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_msg_messages_dedupe ON msg_messages(sender, recipient, created_at)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_msg_messages_post_attempt ON msg_messages(post_attempt)');
      // OP #127483/#127509 — mail-watch firstReplyAfter point lookup (reply thread rows only).
      // JUD-B #127659: NOT in the base schema above — a pre-reply_to legacy ledger would hit
      // "no such column" before this block adds the column; the column comes first here.
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_msg_messages_reply_sender_id ON msg_messages(reply_to, sender, id)');
      // MSG-LEDGER-RETENTION-INDEX ② — unread arm covering index: every arm (direct · ALL · group)
      // searches (recipient, id) and filters sender/expiry inside the index — no row pread off the b-tree.
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_msg_messages_unread_cover ON msg_messages(recipient, id, sender, expires_at, created_at)');
    }).immediate();
  }

  /** Columns and indexes the IMMEDIATE migration block above adds; when all exist, opening needs no write lock. */
  private needsMigration(): boolean {
    const columns = new Set((this.db.query('PRAGMA table_info(msg_messages)').all() as { name: string }[]).map(row => row.name));
    const wanted = ['reply_to', 'expires_at', 'priority', 'supersedes', 'provenance_json', 'from_kind', 'crown_directive', 'intent',
      'refs_json', 'body_ref_json', 'deadline_at', 'needs_ack', 'schema_version', 'origin_seat', 'origin_delegated', 'done_when', 'body_sha256',
      'post_attempt', 'repeat_count', 'last_repeat_at'];
    if (wanted.some(name => !columns.has(name))) return true;
    const indexes = new Set((this.db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'msg_messages'").all() as { name: string }[])
      .map(row => row.name));
    return !indexes.has('idx_msg_messages_reply_to') || !indexes.has('idx_msg_messages_dedupe') || !indexes.has('idx_msg_messages_post_attempt') || !indexes.has('idx_msg_messages_reply_sender_id') || !indexes.has('idx_msg_messages_unread_cover');
  }

  /**
   * ELN-MSG-POST-IDEMPOTENT ⊕ SEAT-MAIL #16 — the newest stored message posted at or after `sinceIso` that this send
   * repeats: same sender and recipient, same normalized body, same evidence sha (missing = ''), and the same structural
   * metadata (replyTo · intent · deadline · needsAck · kind · priority). Runs inside the caller's IMMEDIATE transaction
   * when called from `post`, so two concurrent identical posts serialize and the second finds the first.
   */
  findRecentPost(input: MessageEnvelope, sinceIso: string): Message | null {
    const from = canonicalMessageAddress(input.from);
    const to = canonicalMessageAddress(input.to);
    const ids = this.db.query('SELECT id FROM msg_messages WHERE sender = ? AND recipient = ? AND created_at >= ? ORDER BY id DESC')
      .all(from, to, sinceIso) as { id: number }[];
    const intent = input.intent ?? legacyIntent(input.kind);
    const want = {
      body: normalizeRepeatBody(input.body), evidence: repeatEvidenceSha(input.refs), replyTo: input.replyTo ?? null, intent,
      deadlineAt: input.deadlineAt ?? null, needsAck: input.needsAck ?? (intent === 'request' || intent === 'decision'),
      kind: input.kind ?? null, priority: input.priority ?? null,
    };
    for (const { id } of ids) {
      const stored = this.getMessage(id);
      if (stored === null) continue;
      if (normalizeRepeatBody(stored.body) === want.body && repeatEvidenceSha(stored.refs) === want.evidence
        && (stored.replyTo ?? null) === want.replyTo && (stored.intent ?? legacyIntent(stored.kind)) === want.intent
        && (stored.deadlineAt ?? null) === want.deadlineAt && (stored.needsAck === true) === want.needsAck
        && (stored.kind ?? null) === want.kind && (stored.priority ?? null) === want.priority) return stored;
    }
    return null;
  }

  /** SEAT-MAIL #16 — a suppressed repeat is not silent: bump the first row's counter and last time, return it with why. */
  private recordRepeat(existing: Message, windowMs: number): Message {
    const at = new Date().toISOString();
    const row = this.db.query(`UPDATE msg_messages SET repeat_count = COALESCE(repeat_count, 1) + 1, last_repeat_at = ?
      WHERE id = ? RETURNING repeat_count`).get(at, existing.id) as { repeat_count: number } | null;
    const repeatCount = row?.repeat_count ?? 2;
    const minutes = Math.round(windowMs / 60_000);
    const repeatReason = `repeat of #${existing.id} (×${repeatCount} · same sender/body/evidence sha/meta within ${minutes} min · no new row)`;
    return { ...existing, deduped: true as const, repeatCount, lastRepeatAt: at, repeatReason };
  }

  append(input: MessageEnvelope): Message { return this.post(input); }

  /** Append once for a coordination comment, task failure, or decided notification. */
  appendWithProvenance(input: MessageEnvelope, provenanceKey: string): Message {
    // MSG-FILTERS-RELAX: any nonempty key without whitespace names one logical message (no prefix allowlist).
    if (typeof provenanceKey !== 'string' || !/^\S{1,512}$/.test(provenanceKey)) {
      throw new Error('invalid message provenance key');
    }
    const msg = validateMessageEnvelope(input);
    // Integrity kept: a known family's key names its recipient in the third part — one key, one recipient.
    if (/^(?:coord|ta-failure|decision|release-event|rla-held-event|rla-command-reply|rla-question-reply):[^:]+:[^:]+$/.test(provenanceKey)
      && provenanceKey.split(':')[2] !== msg.to) {
      throw new Error('provenance recipient does not match message recipient');
    }
    return this.withPostedEvents(() => {
      const meta = envelopeMetaSql(this.db, true);
      const fromKindSql = columnPresent(this.db, 'from_kind') ? 'm.from_kind' : 'NULL AS from_kind';
      const existing = this.db.query(`SELECT m.id, m.sender, m.recipient, m.body, m.kind, m.reply_to, m.created_at, ${meta}, m.provenance_json, ${fromKindSql}, ${v2Select(this.db, true)}
        FROM msg_provenance p JOIN msg_messages m ON m.id = p.message_id WHERE p.provenance_key = ?`)
        .get(provenanceKey) as MessageRow | null;
      if (existing) return fromRow(existing);
      if (msg.to.startsWith('group:') && !this.db.query('SELECT 1 FROM msg_groups WHERE address = ?').get(msg.to)) {
        throw new Error(`group not found: ${msg.to}`);
      }
      const message = this.insertMessage(msg);
      this.db.query('INSERT INTO msg_provenance(provenance_key, message_id) VALUES (?, ?)')
        .run(provenanceKey, message.id);
      if (msg.to === 'ALL') {
        try { debug.log('msg.broadcast-budget', 'provenance-exempt', { recipient: msg.to, count: 1, messageId: message.id, provenanceKey }); }
        catch { /* observability is fail-open; preserve the idempotent event */ }
      }
      return message;
    });
  }

  private insertMessage(input: MessageEnvelope, attemptToken?: string): Message {
    const msg = validateMessageEnvelope(input);
    // ③ 이행된 원문에도 답장은 된다 — 운영 miss 일 때 보관 원장에 원문이 있으면 유효한 답장 대상이다.
    if (msg.replyTo !== undefined && this.db.query('SELECT 1 FROM msg_messages WHERE id = ?').get(msg.replyTo) === null
      && this.archivedMessagesWhere('id = ?', [msg.replyTo], 1).length === 0) {
      throw new Error(`reply target not found: #${msg.replyTo}`);
    }
    const createdAt = new Date().toISOString();
    if (msg.supersedes !== undefined && !this.db.query('SELECT 1 FROM msg_messages WHERE id = ?').get(msg.supersedes)) throw new Error(`superseded message not found: #${msg.supersedes}`);
    // §5 canonical intent (v2 rows never store NULL): absent intent maps through the §1b legacy-kind table —
    // identical to the v1 read-path normalization (`fromRow`).
    const intent: MessageEnvelope['intent'] = msg.intent ?? legacyIntent(msg.kind);
    // needsAck default (SEAT-INBOX-PROTOCOL B1-A, doc-settled): request·decision → true, info·alert → false.
    const needsAck = msg.needsAck ?? (intent === 'request' || intent === 'decision');
    const baseOrigin = msg.origin ?? derivedOrigin(msg.from);
    // A crown directive is crown delegation even when the caller omitted the flag (mf3).
    const origin = baseOrigin && msg.crownDirective && baseOrigin.delegatedByCrown !== true
      ? { ...baseOrigin, delegatedByCrown: true as const }
      : baseOrigin;
    const fromKind = origin?.kind ?? null;
    const result = this.db.query(`INSERT INTO msg_messages(sender, recipient, body, kind, reply_to, created_at, expires_at, priority, supersedes, provenance_json, from_kind, intent, refs_json, deadline_at, needs_ack, crown_directive, schema_version, body_ref_json, origin_seat, origin_delegated, done_when, body_sha256, post_attempt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(msg.from, msg.to, msg.body, msg.kind ?? null, msg.replyTo ?? null, createdAt, msg.expiresAt ?? null, msg.priority ?? null, msg.supersedes ?? null, msg.provenance ? JSON.stringify(msg.provenance) : null, fromKind, intent, msg.refs ? JSON.stringify(msg.refs) : null, msg.deadlineAt ?? null, needsAck ? 1 : 0, msg.crownDirective ?? null, 2, null, origin?.seat ?? null, origin?.delegatedByCrown === undefined ? null : (origin.delegatedByCrown ? 1 : 0), msg.doneWhen ?? null, messageBodySha256(msg.body), attemptToken ?? null);
    const id = Number(result.lastInsertRowid);
    // SEAT-INBOX B1-C §4a — posted = 원장 커밋. 수신자 칸은 주소 그대로(ALL · group 포함).
    recordReceiptOn(this.db, { messageId: id, recipient: msg.to, state: 'posted', source: 'ledger' }, () => new Date(createdAt),
      { deferEvent: emit => { this.pendingPostedEvents.push(emit); } });
    // ELS-SERVER-EVENT-HUB-NO-DB-POLL — the sidecar line waits with the posted receipts: emitted only past the
    // outermost commit, dropped with a rollback (withPostedEvents drains this queue after the commit).
    this.pendingPostedEvents.push(() => this.emitLedgerEvent('post'));
    return { id, ...msg, intent, needsAck, ...(origin ? { origin } : {}), schemaVersion: 2, createdAt };
  }

  /**
   * SEAT-INBOX B1-C — one forward-only receipt for (message, recipient). The recipient must be a concrete seat
   * except for `posted`. Compat ack rows are written with it (§4c). Structured callers only — never text.
   */
  recordReceipt(input: ReceiptInput): ReceiptRecordOutcome {
    const recipient = canonicalMessageAddress(input.recipient);
    if (input.state !== 'posted' && (recipient === 'ALL' || recipient.startsWith('group:'))) throw new Error('receipt recipient must be one seat');
    if (input.state !== 'posted' && this.getMessage(input.messageId) !== null && this.messageStatus(recipient, input.messageId) === null)
      throw new Error(`message #${input.messageId} is not addressed to ${recipient}`);
    // [seat-mail #14 wiring] seen/done 3계기 clock — 이 깔때기 하나가 CLI·TUI·도구 전 경로를 커버한다.
    // orphan guard(unknown id 미기록)·fail-soft는 sink 안. clock upsert는 멱등이라 이중 기록 무해.
    // [JUD must=1 수리] recordReceiptOn 이 throw(done needs evidence 등)하면 clock 에 doneAt 이 남으면 안 된다 —
    // 검증·기록이 성공한 뒤에만 clock 을 남긴다(순서: receipt 먼저, clock 나중).
    const receipt = recordReceiptOn(this.db, { ...input, recipient }, this.clock);
    if (input.state === 'seen' || input.state === 'done')
      recordReceiptClock(this.db, { messageId: input.messageId, recipient, event: input.state });
    // ELS-SERVER-EVENT-HUB-NO-DB-POLL — emitted only past a committed write (inside a caller's transaction the
    // caller's own completion point emits; any one complete line wakes the full recompute).
    if (!this.db.inTransaction) this.emitLedgerEvent('receipt');
    return receipt;
  }

  /**
   * A217 — requests nobody has seen: intent=request ⊕ needsAck to one seat, posted inside [postedAfter, postedBefore],
   * with no `seen`-or-later receipt and no ack (explicit or cursor). One query · newest first · SQL LIMIT, so stale
   * requests to a retired or mistyped seat (outside the window) never crowd out a fresh one (#38198 REVIEW-2 ①).
   */
  listUnseenRequests(query: { postedBefore: Date; postedAfter: Date; limit?: number;
    /**
     * SEAT-MAIL-ACK-SLA: `seen` (default) = nobody has seen it · `ack` = nobody has DECIDED it (accepted · rejected · done ·
     * expired) — a seen or hand-acked request still counts, because the SLA asks for accept/reject with a reason.
     */
    stage?: 'seen' | 'ack';
    /** Page below this id (newest first) — callers that need every row walk pages instead of stopping at `limit` (#38361 Terra ③). */
    beforeId?: number }): Array<{ message: Message; recipient: string; current: ReceiptState | null }> {
    const ackStage = query.stage === 'ack';
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be between 1 and 1000');
    if (!columnPresent(this.db, 'intent') || !columnPresent(this.db, 'needs_ack')) return [];
    const receipts = hasReceiptTable(this.db);
    const acks = hasMessageAckTable(this.db);
    const meta = envelopeMetaSql(this.db, true);
    const fromKindSql = columnPresent(this.db, 'from_kind') ? 'm.from_kind' : 'NULL AS from_kind';
    const rows = this.db.query(`SELECT m.id, m.sender, m.recipient, m.body, m.kind, m.reply_to, m.created_at, ${meta}, m.provenance_json, ${fromKindSql}, ${v2Select(this.db, true)},
        ${receipts ? `(SELECT r.state FROM msg_receipts r WHERE r.message_id = m.id AND r.recipient = m.recipient AND r.state IN (${ackStage ? "'posted','delivered','seen'" : "'posted','delivered'"}) ORDER BY r.id DESC LIMIT 1)` : 'NULL'} AS receipt_state
      FROM msg_messages m
      WHERE m.intent = 'request' AND m.needs_ack = 1 AND m.recipient <> 'ALL' AND m.recipient NOT LIKE 'group:%'
        AND m.created_at >= ? AND m.created_at <= ?
        ${query.beforeId === undefined ? '' : `AND m.id < ${Math.trunc(query.beforeId)}`}
        ${ackStage ? '' : 'AND m.id > COALESCE((SELECT c.last_id FROM msg_cursors c WHERE c.recipient = m.recipient), 0)'}
        ${acks ? `AND NOT EXISTS (SELECT 1 FROM msg_message_acks a WHERE a.message_id = m.id AND a.recipient = m.recipient${ackStage ? " AND a.status = 'done'" : ''})` : ''}
        ${receipts ? `AND NOT EXISTS (SELECT 1 FROM msg_receipts r WHERE r.message_id = m.id AND r.recipient = m.recipient AND r.state IN (${ackStage ? '' : "'seen',"}'accepted','rejected','done','expired'))` : ''}
      ORDER BY m.id DESC LIMIT ?`).all(query.postedAfter.toISOString(), query.postedBefore.toISOString(), limit) as Array<MessageRow & { receipt_state: ReceiptState | null }>;
    return rows.map(row => ({ message: fromRow(row), recipient: row.recipient, current: row.receipt_state }));
  }

  /**
   * SEAT-MAIL-ACK-SLA alert ledger (#38361 Terra ①②): one row per (request, late seat, stage, alert target) that was SENT.
   * Separate from the overdue receipt — a `--mark` run or the other stage never consumes an alert — and written in the
   * same transaction as the alert mail, so a target whose post failed has no row and a rerun retries only that target.
   * Post one SLA alert unless that (request, seat, stage, target) was already alerted. Returns the alert, or null when it was sent before. */
  postSlaAlertOnce(key: { messageId: number; recipient: string; stage: string; target: string }, envelope: MessageEnvelope): Message | null {
    return this.withPostedEvents(() => {
      this.db.exec(MSG_SLA_ALERTS_SCHEMA);
      const sent = this.db.query('SELECT 1 FROM msg_sla_alerts WHERE message_id = ? AND recipient = ? AND stage = ? AND target = ?')
        .get(key.messageId, key.recipient, key.stage, key.target);
      if (sent) return null;
      const alert = this.post(envelope);
      this.db.query('INSERT INTO msg_sla_alerts (message_id, recipient, stage, target, alert_id, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(key.messageId, key.recipient, key.stage, key.target, alert.id, this.clock().toISOString());
      return alert;
    });
  }

  /** Newest receipt id (0 when none or before migration) — the SSE receipt scan starts here. */
  latestReceiptId(): number { return latestReceiptIdOn(this.db); }

  /** Receipts in append order, filtered by message and/or original sender. */
  listReceipts(query: ReceiptQuery = {}): Receipt[] {
    return listReceiptsOn(this.db, { ...query, ...(query.from === undefined ? {} : { from: canonicalSeatId(query.from) }) });
  }

  /** `dedupe: true` = the sender idempotency key applies (see {@link MSG_DEDUPE_WINDOW_MS}). */
  post(input: MessageEnvelope, options: { dedupe?: boolean; attemptToken?: string } = {}): Message {
    const message = validateMessageEnvelope(input);
    // ELN-MSG-POST-IDEMPOTENT — the lookup and the insert share one IMMEDIATE transaction on EVERY branch (a seat,
    // `group:`, `ALL`): a concurrent identical post waits for this one and then finds it (no unique index can express
    // «within N minutes»). Sender entrances (`msg post`, MsgPost) opt in; programmatic producers keep exact append.
    const windowMs = options.dedupe === true ? this.dedupeWindowMs : 0;
    const recent = (): Message | null => windowMs > 0
      ? this.findRecentPost(message, new Date(Date.now() - windowMs).toISOString())
      : null;
    const insert = (envelope: MessageEnvelope): Message => this.insertMessage(envelope, options.attemptToken);
    let posted: Message = this.withPostedEvents((): Message => {
      if (message.to.startsWith('group:')) {
        if (!this.db.query('SELECT 1 FROM msg_groups WHERE address = ?').get(message.to)) throw new Error(`group not found: ${message.to}`);
        const existing = recent();
        return existing === null ? insert(message) : this.recordRepeat(existing, windowMs);
      }
      if (message.to !== 'ALL') {
        const existing = recent();
        return existing === null ? insert(message) : this.recordRepeat(existing, windowMs);
      }
      // ALL: a retried identical broadcast is the same logical send — it returns the stored row.
      const existing = recent();
      if (existing !== null) return this.recordRepeat(existing, windowMs);
      // MSG-FILTERS-RELAX: the old 2-per-hour broadcast cap folded the 3rd broadcast into a summary and lost its body.
      // Every broadcast is stored now; the budget table stays only so older binaries keep opening the ledger.
      return insert(message);
    });
    if (posted.deduped) {
      try { debug.log('msg', 'msg.post.deduped', { msgId: posted.id, from: posted.from, to: posted.to, windowMs, repeatCount: posted.repeatCount }, { level: 'warn' }); }
      catch { /* observability is fail-open */ }
    }
    // SEAT-MAIL #24 — a sender-entrance reply (options.dedupe === true: `msg post` — `--no-dedupe` skips it — and the
    // MsgPost tool; the same boundary as #16 dedupe) auto-acks the original for the replying seat: one per-message
    // ack row (the original leaves that seat's unread set) while every cursor stays untouched (#89448 — an ack never
    // moves a cursor). Only an original addressed to the replying seat qualifies (original.to === message.from); ALL
    // broadcasts, group mail and other seats' mail are naturally excluded. A failed auto-ack is a warn, never a post
    // failure — the reply is already stored.
    if (options.dedupe === true && message.replyTo !== undefined) {
      try {
        // ③ 원문이 보관돼도 auto-ack 은 남는다 — 조회만 폴백(쓰기는 운영 원장).
        const liveOriginal = this.getMessage(message.replyTo);
        const original = liveOriginal ?? this.archivedMessagesWhere('id = ?', [message.replyTo], 1)[0] ?? null;
        if (original !== null && original.to === message.from) {
          if (liveOriginal !== null) this.ackMessage(message.from, message.replyTo, 'acked');
          else this.ackArchivedOriginal(message.from, message.replyTo, 'acked');
          posted = { ...posted, autoAcked: message.replyTo };
        }
      } catch (error) {
        try { debug.log('msg', 'msg.post.auto-ack-failed', { msgId: posted.id, replyTo: message.replyTo, from: message.from, error: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
        catch { /* observability is fail-open */ }
      }
    }
    return posted;
  }

  /**
   * ELN-MSG-POST-IDEMPOTENT MF4 — the message stored under a provenance (origin) key, or null. The `--origin-key` path is
   * idempotent BY THAT KEY (appendWithProvenance returns the existing row), so recovery after an ambiguous write may
   * claim success through it: the key names one logical message by contract, whichever attempt stored it.
   */
  findByProvenanceKey(provenanceKey: string): Message | null {
    const row = this.db.query('SELECT message_id FROM msg_provenance WHERE provenance_key = ?').get(provenanceKey) as { message_id: number } | null;
    return row === null ? null : this.getMessage(row.message_id);
  }

  /**
   * #38516 r3 MF2 — recovery on the `--origin-key` path. The write may have failed BEFORE its own validation ran, so the
   * stored row under the key is this send only if it is the same sender → recipient; otherwise null (the caller reports
   * the original write error — never another recipient's row as this send's success).
   */
  findByProvenanceKeyFor(provenanceKey: string, input: Pick<MessageEnvelope, 'from' | 'to'>): Message | null {
    const found = this.findByProvenanceKey(provenanceKey);
    if (found === null) return null;
    return found.from === canonicalSeatId(input.from) && found.to === canonicalSeatId(input.to) ? found : null;
  }

  /**
   * ELN-MSG-POST-IDEMPOTENT MF3 — the row THIS attempt committed, by the token written in the same INSERT. Recovery after
   * an ambiguous write error only claims success through this: an older identical row never stands in for a send that
   * was not stored.
   */
  findPostByAttempt(attemptToken: string): Message | null {
    const columns = new Set((this.db.query('PRAGMA table_info(msg_messages)').all() as { name: string }[]).map(row => row.name));
    if (!columns.has('post_attempt')) return null;
    const row = this.db.query('SELECT id FROM msg_messages WHERE post_attempt = ? ORDER BY id DESC LIMIT 1').get(attemptToken) as { id: number } | null;
    return row === null ? null : this.getMessage(row.id);
  }

  createGroup(name: string, owner: string): string {
    const address = canonicalGroupAddress(name.startsWith('group:') ? name : `group:${name}`);
    const seat = canonicalSeatId(owner);
    const created = this.db.transaction(() => {
      this.db.query('INSERT INTO msg_groups(address) VALUES (?)').run(address);
      this.db.query('INSERT INTO msg_group_memberships(address, seat, joined_after_id) VALUES (?, ?, ?)')
        .run(address, seat, this.latestId());
      return address;
    }).immediate();
    this.emitLedgerEvent('group');
    return created;
  }

  joinGroup(group: string, member: string): boolean {
    const address = canonicalGroupAddress(group);
    const seat = canonicalSeatId(member);
    const joined = this.db.transaction(() => {
      if (!this.db.query('SELECT 1 FROM msg_groups WHERE address = ?').get(address)) throw new Error(`group not found: ${address}`);
      const existing = this.db.query('SELECT 1 FROM msg_group_memberships WHERE address = ? AND seat = ? AND left_after_id IS NULL')
        .get(address, seat);
      if (existing) return false;
      this.db.query('INSERT INTO msg_group_memberships(address, seat, joined_after_id) VALUES (?, ?, ?)')
        .run(address, seat, this.latestId());
      return true;
    }).immediate();
    if (joined) this.emitLedgerEvent('group');
    return joined;
  }

  leaveGroup(group: string, member: string): boolean {
    const address = canonicalGroupAddress(group);
    const seat = canonicalSeatId(member);
    const left = this.db.transaction(() => {
      const result = this.db.query(`UPDATE msg_group_memberships SET left_after_id = ?
        WHERE id = (SELECT id FROM msg_group_memberships WHERE address = ? AND seat = ? AND left_after_id IS NULL ORDER BY id DESC LIMIT 1)`)
        .run(this.latestId(), address, seat);
      return result.changes > 0;
    }).immediate();
    if (left) this.emitLedgerEvent('group');
    return left;
  }

  listGroups(member: string): string[] {
    const seat = canonicalSeatId(member);
    return (this.db.query('SELECT DISTINCT address FROM msg_group_memberships WHERE seat = ? AND left_after_id IS NULL ORDER BY address')
      .all(seat) as Array<{ address: string }>).map(row => row.address);
  }

  isGroupDelivery(message: Message, recipient: string): boolean {
    const seat = canonicalSeatId(recipient);
    return message.to.startsWith('group:') && Boolean(this.db.query(`SELECT 1 FROM msg_group_memberships
      WHERE address = ? AND seat = ? AND ? > joined_after_id AND (left_after_id IS NULL OR ? <= left_after_id)`)
      .get(message.to, seat, message.id, message.id));
  }

  /** Delivery state is separate from the single linked reply; an uncertain send keeps its claim. */
  taDeliveryStatus(requestId: number): 'pending' | 'delivered' | null {
    return (this.db.query('SELECT status FROM msg_ta_delivery WHERE request_id = ?').get(requestId) as { status: 'pending' | 'delivered' } | null)?.status ?? null;
  }

  setTaDeliveryStatus(requestId: number, status: 'pending' | 'delivered'): void {
    this.db.query(`INSERT INTO msg_ta_delivery(request_id, status) VALUES (?, ?)
      ON CONFLICT(request_id) DO UPDATE SET status = excluded.status`).run(requestId, status);
  }

  /** A short DB transaction grants one sender the external delivery. An abandoned claim stays ambiguous. */
  claimTaDelivery(requestId: number): string | null {
    return this.db.transaction(() => {
      if (this.taDeliveryStatus(requestId) !== 'pending') return null;
      const previous = this.db.query('SELECT 1 FROM msg_ta_claim WHERE request_id = ?').get(requestId);
      if (previous) return null;
      const token = randomUUID();
      this.db.query('INSERT INTO msg_ta_claim(request_id, token) VALUES (?, ?)').run(requestId, token);
      return token;
    }).immediate();
  }

  taDeliveryClaimState(requestId: number): 'none' | 'held' {
    return this.db.query('SELECT 1 FROM msg_ta_claim WHERE request_id = ?').get(requestId) ? 'held' : 'none';
  }

  /** Only the active sender may settle or report its own attempt; stale failures cannot overwrite success.
    * The claim cleanup runs after the settle commits and is fail-open: a cleanup failure must not flip
    * a durable settle into a reported failure — the stale claim keeps blocking rival claims while the
    * owner may re-settle, so the leftover row only narrows retries instead of losing the stored reply. */
  settleTaDelivery(requestId: number, token: string, replyBody: string, delivered: boolean): boolean {
    const settled = this.db.transaction(() => {
      const owner = this.db.query('SELECT token FROM msg_ta_claim WHERE request_id = ?').get(requestId) as { token: string } | null;
      if (owner?.token !== token || this.taDeliveryStatus(requestId) === 'delivered') return false;
      if (delivered) this.setTaDeliveryStatus(requestId, 'delivered');
      this.updateTaReply(requestId, replyBody);
      return true;
    }).immediate();
    if (settled) {
      try { this.db.query('DELETE FROM msg_ta_claim WHERE request_id = ? AND token = ?').run(requestId, token); }
      catch (error) { console.error(`msg: ta claim cleanup failed after settle — request #${requestId}; the claim stays held`, error); }
    }
    return settled;
  }

  /** Keep the claim after any transport/settlement exception: publication may already have happened. */
  markTaDeliveryUnknown(requestId: number, token: string, replyBody: string): boolean {
    return this.db.transaction(() => {
      const owner = this.db.query('SELECT token FROM msg_ta_claim WHERE request_id = ?').get(requestId) as { token: string } | null;
      if (owner?.token !== token || this.taDeliveryStatus(requestId) === 'delivered') return false;
      this.updateTaReply(requestId, replyBody);
      return true;
    }).immediate();
  }

  /** Settle only the TA reply reserved for this request; never create a second reply. */
  updateTaReply(requestId: number, body: string): void {
    const changed = this.db.query(`UPDATE msg_messages SET body = ? WHERE id = (
      SELECT id FROM msg_messages WHERE reply_to = ? AND sender = 'TA' ORDER BY id ASC LIMIT 1
    ) AND sender = 'TA'`).run(body, requestId);
    if (changed.changes !== 1) throw new Error(`TA reply missing: #${requestId}`);
  }

  /** Messages strictly after the supplied cursor, ordered by durable insertion ID. */
  /** `includeAcked`: history reading — messages acknowledged one by one (or marked seen, §4c compat ack) stay in the list. */
  listByRecipient(recipient: string, after: number = 0, limit: number = 100, opts: { includeAcked?: boolean } = {}): Message[] {
    const to = canonicalMessageAddress(recipient);
    if (to === 'ALL') throw new Error('ALL is a topic, not a recipient');
    validCursor(after);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be between 1 and 1000');
    return this.readWithSchema((hasReplyTo, hasGroupMemberships, hasProvenance, hasFromKind) => {
      const hasAcks = hasMessageAckTable(this.db);
      const hasMetadata = hasEnvelopeMetadata(this.db);
      const groupClause = hasGroupMemberships ? ` OR EXISTS (
        SELECT 1 FROM msg_group_memberships gm WHERE gm.address = m.recipient AND gm.seat = ?
          AND m.id > gm.joined_after_id AND (gm.left_after_id IS NULL OR m.id <= gm.left_after_id)
      )` : '';
      const acksJoin = hasAcks ? 'LEFT JOIN msg_message_acks a ON a.message_id=m.id AND a.recipient=?' : '';
      const ackFilter = hasAcks && !opts.includeAcked ? 'AND a.message_id IS NULL' : '';
      const expiryFilter = hasMetadata ? "AND (m.expires_at IS NULL OR julianday(m.expires_at) > julianday('now'))" : '';
      const metadata = hasMetadata ? 'm.expires_at, m.priority, m.supersedes' : 'NULL AS expires_at, NULL AS priority, NULL AS supersedes';
      const provenance = hasProvenance ? 'm.provenance_json' : 'NULL AS provenance_json';
      const params = [...(hasAcks ? [to] : []), after, to, to, ...(hasGroupMemberships ? [to] : []), limit];
      return (this.db.query(`SELECT m.id, m.sender, m.recipient, m.body, m.kind, ${hasReplyTo ? 'm.reply_to' : 'NULL AS reply_to'}, m.created_at, ${metadata}, ${provenance}, ${hasFromKind ? 'm.from_kind' : 'NULL AS from_kind'}, ${v2Select(this.db, true)} FROM msg_messages m ${acksJoin}
        WHERE m.id > ? ${expiryFilter} ${ackFilter} AND (m.recipient = ? OR (m.recipient = 'ALL' AND m.sender <> ?)${groupClause}) ORDER BY m.id ASC LIMIT ?`)
        .all(...params) as MessageRow[]).map(fromRow);
    });
  }

  /** One message by durable ID, or null when absent. */
  getMessage(messageId: number): Message | null {
    if (!Number.isSafeInteger(messageId) || messageId < 1) throw new Error('message ID must be a positive integer');
    return this.readWithSchema((hasReplyTo, _groups, hasProvenance, hasFromKind) => {
      const metadata = hasEnvelopeMetadata(this.db) ? 'expires_at, priority, supersedes' : 'NULL AS expires_at, NULL AS priority, NULL AS supersedes';
      const provenance = hasProvenance ? 'provenance_json' : 'NULL AS provenance_json';
      const row = this.db.query(`SELECT id, sender, recipient, body, kind, ${hasReplyTo ? 'reply_to' : 'NULL AS reply_to'}, created_at, ${metadata}, ${provenance}, ${hasFromKind ? 'from_kind' : 'NULL AS from_kind'}, ${v2Select(this.db, false)} FROM msg_messages
        WHERE id = ?`).get(messageId) as MessageRow | null;
      return row === null ? null : fromRow(row);
    });
  }

  messageStatus(recipient: string, messageId: number): 'delivered' | 'acked' | 'done' | null {
    const to = canonicalMessageAddress(recipient);
    if (!Number.isSafeInteger(messageId) || messageId < 1) throw new Error('message ID must be a positive integer');
    const hasAcks = hasMessageAckTable(this.db);
    const hasGroups = hasGroupMembershipTable(this.db);
    const ackProjection = hasAcks ? '(SELECT status FROM msg_message_acks WHERE message_id=m.id AND recipient=?)' : 'NULL';
    const groupEligibility = hasGroups ? ` OR EXISTS (SELECT 1 FROM msg_group_memberships gm WHERE gm.address=m.recipient AND gm.seat=?
      AND m.id>gm.joined_after_id AND (gm.left_after_id IS NULL OR m.id<=gm.left_after_id))` : '';
    const row = this.db.query(`SELECT m.recipient, m.sender, ${ackProjection} AS explicit_status, COALESCE(c.last_id,0) AS cursor_id FROM msg_messages m
      LEFT JOIN msg_cursors c ON c.recipient=? WHERE m.id=?
      AND (m.recipient=? OR (m.recipient='ALL' AND m.sender<>?)${groupEligibility})`)
      .get(...[...(hasAcks ? [to] : []), to, messageId, to, to, ...(hasGroups ? [to] : [])]) as { recipient: string; sender: string; explicit_status: 'acked' | 'done' | null; cursor_id: number } | null;
    if (!row) return null;
    return row.explicit_status ?? (messageId <= row.cursor_id ? 'acked' : 'delivered');
  }

  // MSG-LEDGER-ARCHIVE-THREAD-READ-FU ③ — 보관 이행 뒤에도 원문에 답장하고 스레드를 온전히 읽는 읽기 폴백.
  // 쓰기(답장 INSERT·영수·ack)는 운영 원장에만 둔다: 보관 원장은 읽기 전용이고, «이동 행은 운영 store 의
  // getMessage → null» 이행 계약(#39606)은 그대로다. 폴백은 운영 원장이 대상을 못 찾은 읽기 경로에만 든다 —
  // 보관 원장 부재·훼손은 빈 결과로 내려 운영 조회를 깨지 않는다(fail-soft).
  private get archiveReader(): Database | null {
    if (this.archivePathOption === null) return null;
    if (this.archiveDb === null) {
      if (!existsSync(this.archivePathOption)) return null;
      // JUD-B #39635 mustFix: 보관 원장은 운영 조회의 보강 자료일 뿐 — 열기(busyTimeout PRAGMA 포함)가
      // 실패하는 파일(훼손·권한·잠금)은 폴백 없음(null)로 내려 listReplies/listThread 를 깨지 않는다(fail-soft).
      try {
        this.archiveDb = new Database(this.archivePathOption, { readonly: true });
        this.archiveDb.exec(`PRAGMA busy_timeout = ${MSG_BUSY_TIMEOUT_MS}`);
      } catch {
        this.archiveDb = null;
        return null;
      }
    }
    return this.archiveDb;
  }

  /** 보관 원장의 행 읽기 — 스키마 판정은 보관 원장 스스로에게 묻는다(운영과 열 구성이 다를 수 있다). */
  private archivedMessagesWhere(where: string, params: Array<string | number>, limit: number): Message[] {
    const db = this.archiveReader;
    if (db === null) return [];
    try {
      if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'msg_messages'").get() === null) return [];
      const metadata = hasEnvelopeMetadata(db) ? 'expires_at, priority, supersedes' : 'NULL AS expires_at, NULL AS priority, NULL AS supersedes';
      const provenance = columnPresent(db, 'provenance_json') ? 'provenance_json' : 'NULL AS provenance_json';
      const fromKind = columnPresent(db, 'from_kind') ? 'from_kind' : 'NULL AS from_kind';
      const replyTo = columnPresent(db, 'reply_to') ? 'reply_to' : 'NULL AS reply_to';
      const rows = db.query(`SELECT id, sender, recipient, body, kind, ${replyTo}, created_at, ${metadata}, ${provenance}, ${fromKind}, ${v2Select(db, false)}
        FROM msg_messages WHERE ${where} ORDER BY id ASC LIMIT ?`).all(...params, limit) as MessageRow[];
      return rows.map(fromRow);
    } catch {
      return [];
    }
  }

  /** 스레드 끝점(id·reply_to)의 보관 원장 조회 — 운영 miss 시에만 불린다. */
  private archivedThreadTarget(messageId: number): { id: number; reply_to: number | null } | null {
    const db = this.archiveReader;
    if (db === null) return null;
    try {
      if (!columnPresent(db, 'reply_to')) {
        const bare = db.query('SELECT id FROM msg_messages WHERE id = ?').get(messageId) as { id: number } | null;
        return bare === null ? null : { id: bare.id, reply_to: null };
      }
      return db.query('SELECT id, reply_to FROM msg_messages WHERE id = ?').get(messageId) as { id: number; reply_to: number | null } | null;
    } catch {
      return null;
    }
  }

  /** 스레드 루트의 보관 행 — 루트와 답장 양쪽에서 보관 행을 모은다. */
  private archivedThreadRows(rootId: number, after: number, limit: number): Message[] {
    const db = this.archiveReader;
    if (db === null) return [];
    // JUD-B #39635 mustFix: 스키마 조회(columnPresent)도 보강 읽기의 일부 — 실패는 빈 결과로 내린다.
    let hasReplyTo = false;
    try { hasReplyTo = columnPresent(db, 'reply_to'); } catch { return []; }
    return this.archivedMessagesWhere(
      `id > ? AND (id = ? ${hasReplyTo ? 'OR reply_to = ?' : ''})`,
      hasReplyTo ? [after, rootId, rootId] : [after, rootId], limit);
  }

  /** 운영 행이 우선인 id 오름차순 병합 — 같은 id 가 양쪽에 살면(충돌 잔존) 운영 행으로 읽는다. */
  private static mergeById(live: Message[], archived: Message[], limit: number): Message[] {
    if (archived.length === 0) return live;
    const merged = new Map(live.map(message => [message.id, message]));
    for (const message of archived) if (!merged.has(message.id)) merged.set(message.id, message);
    return [...merged.values()].sort((a, b) => a.id - b.id).slice(0, limit);
  }

  /** Replies pointing at the supplied message, ordered by durable insertion ID. */
  listReplies(messageId: number, limit: number = 100, afterId: number = 0): Message[] {
    if (!Number.isSafeInteger(messageId) || messageId < 1) throw new Error('message ID must be a positive integer');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be between 1 and 1000');
    validCursor(afterId);
    return this.readWithSchema((hasReplyTo, _groups, hasProvenance, hasFromKind) => {
      const live = hasReplyTo
        ? (this.db.query(`SELECT id, sender, recipient, body, kind, reply_to, created_at, ${envelopeMetaSql(this.db, false)}, ${hasProvenance ? 'provenance_json' : 'NULL AS provenance_json'}, ${hasFromKind ? 'from_kind' : 'NULL AS from_kind'}, ${v2Select(this.db, false)} FROM msg_messages
          WHERE reply_to = ? AND id > ? ORDER BY id ASC LIMIT ?`).all(messageId, afterId, limit) as MessageRow[]).map(fromRow)
        : [];
      // ③ 답장까지 이행된 스레드도 같은 호출로 — 보관 행을 합친다(운영 행 우선 · id 오름차순).
      return MsgStore.mergeById(live, this.archivedMessagesWhere('reply_to = ? AND id > ?', [messageId, afterId], limit), limit);
    });
  }

  /** A request and its direct replies, in insertion order, independent of recipient cursors. */
  listThread(messageId: number, after: number = 0, limit: number = 100): Message[] {
    if (!Number.isSafeInteger(messageId) || messageId < 1) throw new Error('message ID must be a positive integer');
    validCursor(after);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be between 1 and 1000');
    return this.readWithSchema((hasReplyTo, _groups, hasProvenance, hasFromKind) => {
      const target = this.db.query(`SELECT id, ${hasReplyTo ? 'reply_to' : 'NULL AS reply_to'} FROM msg_messages WHERE id = ?`)
        .get(messageId) as { id: number; reply_to: number | null } | null;
      // ③ 운영에 없는 스레드 끝점은 보관 원장에서 본다 — 원문이 이행돼도 스레드는 예외 없이 온전하다.
      const resolved = target ?? this.archivedThreadTarget(messageId);
      if (resolved === null) throw new Error(`message not found: #${messageId}`);
      const rootId = resolved.reply_to ?? resolved.id;
      const live = (this.db.query(`SELECT id, sender, recipient, body, kind, ${hasReplyTo ? 'reply_to' : 'NULL AS reply_to'}, created_at, ${envelopeMetaSql(this.db, false)}, ${hasProvenance ? 'provenance_json' : 'NULL AS provenance_json'}, ${hasFromKind ? 'from_kind' : 'NULL AS from_kind'}, ${v2Select(this.db, false)} FROM msg_messages
        WHERE id > ? AND (id = ? ${hasReplyTo ? 'OR reply_to = ?' : ''}) ORDER BY id ASC LIMIT ?`)
        .all(...(hasReplyTo ? [after, rootId, rootId, limit] : [after, rootId, limit])) as MessageRow[]).map(fromRow);
      return MsgStore.mergeById(live, this.archivedThreadRows(rootId, after, limit), limit);
    });
  }

  list(recipient: string, after: number = 0, limit: number = 100, opts: { includeAcked?: boolean } = {}): Message[] {
    return this.listByRecipient(recipient, after, limit, opts);
  }

  /** One ordered scan for every SSE subscriber; recipient filtering happens in the server. */
  listAfter(after: number, limit: number = 1000): Message[] {
    validCursor(after);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be between 1 and 1000');
    return this.readWithSchema((hasReplyTo, _groups, hasProvenance, hasFromKind) => (this.db.query(`SELECT id, sender, recipient, body, kind, ${hasReplyTo ? 'reply_to' : 'NULL AS reply_to'}, created_at, ${envelopeMetaSql(this.db, false)}, ${hasProvenance ? 'provenance_json' : 'NULL AS provenance_json'}, ${hasFromKind ? 'from_kind' : 'NULL AS from_kind'}, ${v2Select(this.db, false)} FROM msg_messages
      WHERE id > ? ORDER BY id ASC LIMIT ?`).all(after, limit) as MessageRow[]).map(fromRow));
  }

  /** Read a half-open UTC timestamp window for periodic message-mirror summaries. */
  listCreatedBetween(start: string, end: string): Message[] {
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error('invalid message time window');
    return this.readWithSchema((hasReplyTo, _groups, hasProvenance, hasFromKind) => (this.db.query(`SELECT id, sender, recipient, body, kind,
      ${hasReplyTo ? 'reply_to' : 'NULL AS reply_to'}, created_at, ${envelopeMetaSql(this.db, false)}, ${hasProvenance ? 'provenance_json' : 'NULL AS provenance_json'}, ${hasFromKind ? 'from_kind' : 'NULL AS from_kind'}, ${v2Select(this.db, false)} FROM msg_messages
      WHERE created_at >= ? AND created_at < ? ORDER BY id ASC`).all(new Date(startMs).toISOString(), new Date(endMs).toISOString()) as MessageRow[]).map(fromRow));
  }

  latestId(): number {
    return (this.db.query('SELECT COALESCE(MAX(id), 0) AS id FROM msg_messages').get() as { id: number }).id;
  }

  getCursor(recipient: string): number {
    const to = canonicalMessageAddress(recipient);
    if (to === 'ALL') throw new Error('ALL is a topic, not a recipient');
    return (this.db.query('SELECT last_id FROM msg_cursors WHERE recipient = ?').get(to) as { last_id: number } | null)?.last_id ?? 0;
  }

  /** Atomically reject future IDs and keep concurrent or stale acknowledgements from rewinding. */
  advanceCursor(recipient: string, cursor: number): number {
    const to = canonicalMessageAddress(recipient);
    if (to === 'ALL') throw new Error('ALL is a topic, not a recipient');
    validCursor(cursor);
    const result = this.db.query(`INSERT INTO msg_cursors(recipient, last_id)
      SELECT ?, ? WHERE ? <= (SELECT COALESCE(MAX(id), 0) FROM msg_messages)
      ON CONFLICT(recipient) DO UPDATE SET last_id = MAX(msg_cursors.last_id, excluded.last_id)`)
      .run(to, cursor, cursor);
    if (result.changes === 0) throw new Error('cursor exceeds the latest message ID');
    // ELS-SERVER-EVENT-HUB-NO-DB-POLL — emitted only past a committed write (inside a caller's transaction the
    // caller's own completion point emits; any one complete line wakes the full recompute).
    if (!this.db.inTransaction) this.emitLedgerEvent('ack');
    return this.getCursor(to);
  }

  ack(recipient: string, cursor: number): number { return this.advanceCursor(recipient, cursor); }

  /**
   * Cursor ack. The CLI hand-ack of #38305 also leaves «seen» for every message it moves past (unacknowledged · after the
   * cursor · ≤ through) in one transaction — a terminal's human eyes are the eyes-on evidence. The agent's MsgAck tool
   * (#122460 · CX-16 postland 실측 2026-11-21) moves the cursor only: a tool call is not processing, «seen» is the answered
   * turn's receipt (tui-queue, queueItemId-bound) — the tool-ack seen the 11-18 rule added was stamped before the answer
   * (seen 영수 queueItemId 공백 · 정답 턴의 queue 결속 seen 은 not-forward 로 밀림). A failed receipt is a warn and never
   * changes the ack.
   */
  ackThroughSeen(recipient: string, through: number, source: Extract<ReceiptSource, 'cli-ack' | 'tool-ack'>): number {
    const moved = this.db.transaction(() => {
      // #122460 — a tool call is not processing: the agent's MsgAck advances the cursor and leaves the seen receipt to
      // the turn that answers the message.
      if (source !== 'cli-ack') return this.ack(recipient, through);
      const HAND_ACK_SEEN_MAX = 1000; // Source: #38305 REVIEW ③ — the same bound as listByRecipient's page
      const page = this.listByRecipient(recipient, this.getCursor(recipient), HAND_ACK_SEEN_MAX);
      const passing = page.filter(message => message.id <= through).map(message => message.id);
      if (page.length === HAND_ACK_SEEN_MAX && page.every(message => message.id <= through)) {
        try { debug.log('msg.receipt-writer', 'hand-ack-seen-truncated', { recipient, through, marked: passing.length, source }, { level: 'warn' }); }
        catch { /* observability is fail-open */ }
      }
      const moved = this.ack(recipient, through);
      for (const id of passing) {
        try { this.recordReceipt({ messageId: id, recipient, state: 'seen', source }); }
        catch (error) {
          try { debug.log('msg.receipt-writer', 'record-failed', { msgId: id, recipient, state: 'seen', source, error: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
          catch { /* observability is fail-open */ }
        }
      }
      return moved;
    }).immediate();
    // ELS-SERVER-EVENT-HUB-NO-DB-POLL — the cursor move and the seen receipts are visible only now: one line wakes the recompute.
    this.emitLedgerEvent('ack');
    return moved;
  }

  /** ③ 보관된 원문에 대한 자리 한정 ack — 운영 원장에 ack 행만 남긴다(보관 원장은 읽기 전용). */
  private ackArchivedOriginal(recipient: string, messageId: number, status: 'acked' | 'done'): void {
    const to = canonicalMessageAddress(recipient);
    if (to === 'ALL') throw new Error('ALL is a topic, not a recipient');
    if (!Number.isSafeInteger(messageId) || messageId < 1) throw new Error('message ID must be a positive integer');
    this.db.query(`INSERT INTO msg_message_acks(message_id, recipient, status) VALUES (?, ?, ?)
      ON CONFLICT(message_id,recipient) DO UPDATE SET status=excluded.status`).run(messageId, to, status);
  }

  /** Acknowledge exactly one delivered message for its recipient without moving past siblings. */
  ackMessage(recipient: string, messageId: number, status: 'acked' | 'done' = 'acked'): boolean {    const to = canonicalMessageAddress(recipient);
    if (to === 'ALL') throw new Error('ALL is a topic, not a recipient');
    if (!Number.isSafeInteger(messageId) || messageId < 1) throw new Error('message ID must be a positive integer');
    if (status !== 'acked' && status !== 'done') throw new Error('status must be acked or done');
    const result = this.db.query(`INSERT INTO msg_message_acks(message_id, recipient, status)
      SELECT id, ?, ? FROM msg_messages WHERE id=? AND (recipient=? OR (recipient='ALL' AND sender<>?) OR EXISTS (
        SELECT 1 FROM msg_group_memberships gm WHERE gm.address=msg_messages.recipient AND gm.seat=?
          AND msg_messages.id>gm.joined_after_id AND (gm.left_after_id IS NULL OR msg_messages.id<=gm.left_after_id)))
      ON CONFLICT(message_id,recipient) DO UPDATE SET status=excluded.status`)
      .run(to, status, messageId, to, to, to);
    if (!result.changes) throw new Error(`message not found for ${to}: #${messageId}`);
    if (!this.db.inTransaction) this.emitLedgerEvent('ack');
    return true;
  }

  /** A batch either acknowledges every requested message or none, without moving the cursor. */
  ackMessages(recipient: string, ids: readonly number[]): void {
    if (!ids.length) throw new Error('at least one message ID is required');
    this.db.transaction(() => { for (const id of ids) this.ackMessage(recipient, id); }).immediate();
    if (!this.db.inTransaction) this.emitLedgerEvent('ack');
  }

  unreadCount(recipient: string): number {
    const to = canonicalMessageAddress(recipient);
    if (to === 'ALL') throw new Error('ALL is a topic, not a recipient');
    return unreadCountOn(this.db, to);
  }

  /**
   * MSG-RECEIPT-IMPLIES-ACK ② — the seat counter («[미읽음 총 N통]»): unread mail that still needs this seat. Same unread
   * set as {@link unreadCount} (cursor · per-id ack · expiry), narrowed to ACTIONABLE rows: needsAck, or intent
   * request · decision · alert; and no terminal receipt (accepted · rejected · done · expired) for this recipient.
   * Info mail never counts — it is read, not handled.
   */
  actionableUnreadCount(recipient: string): number {
    const to = canonicalMessageAddress(recipient);
    if (to === 'ALL') throw new Error('ALL is a topic, not a recipient');
    const arms = unreadArmsOn(this.db, to);
    const intentSql = columnPresent(this.db, 'intent') ? 'm.intent' : 'NULL';
    const needsAckSql = columnPresent(this.db, 'needs_ack') ? 'm.needs_ack' : 'NULL';
    // A row without a stored intent reads the legacy kind the same way legacyIntent() does.
    const actionable = `(COALESCE(${needsAckSql}, 0) = 1 OR COALESCE(${intentSql}, CASE
        WHEN m.kind IN ('request', 'question', 'ask') THEN 'request' WHEN m.kind = 'decision' THEN 'decision'
        WHEN m.kind IN ('alert', 'supervisor') THEN 'alert' ELSE 'info' END) IN ('request', 'decision', 'alert'))`;
    const terminal = hasReceiptTable(this.db)
      ? `AND NOT EXISTS (SELECT 1 FROM msg_receipts r WHERE r.message_id = m.id AND r.recipient = ?
          AND r.state IN (${TERMINAL_RECEIPT_STATES.map(state => `'${state}'`).join(', ')}))`
      : '';
    return (this.db.query(`SELECT COUNT(*) AS count FROM (${arms.sql}) u JOIN msg_messages m ON m.id = u.id
      WHERE ${actionable} ${terminal}`).get(...arms.params, ...(terminal ? [to] : [])) as { count: number }).count;
  }

  /**
   * MSG-RECEIPT-IMPLIES-ACK ③ — one-shot backfill (`eln msg ack --to <seat> --receipted`): per-id ack every message this
   * recipient already has a terminal receipt for (done → done, the rest → acked). Idempotent: an existing ack is kept
   * (never downgraded). Returns the ids newly acked, oldest first.
   */
  ackReceipted(recipient: string): number[] {
    const to = canonicalMessageAddress(recipient);
    if (to === 'ALL' || to.startsWith('group:')) throw new Error('receipted ack needs one seat');
    if (!hasReceiptTable(this.db)) return [];
    const ids = this.db.transaction((): number[] => {
      const rows = this.db.query(`SELECT r.message_id AS id, MAX(r.state = 'done') AS done FROM msg_receipts r
        JOIN msg_messages m ON m.id = r.message_id
        WHERE r.recipient = ? AND r.state IN (${TERMINAL_RECEIPT_STATES.map(state => `'${state}'`).join(', ')})
          AND NOT EXISTS (SELECT 1 FROM msg_message_acks a WHERE a.message_id = r.message_id AND a.recipient = ?)
        GROUP BY r.message_id ORDER BY r.message_id ASC`).all(to, to) as Array<{ id: number; done: number }>;
      const insert = this.db.query(`INSERT INTO msg_message_acks(message_id, recipient, status) VALUES (?, ?, ?)
        ON CONFLICT(message_id, recipient) DO NOTHING`);
      for (const row of rows) insert.run(row.id, to, row.done ? 'done' : 'acked');
      return rows.map(row => row.id);
    }).immediate();
    if (ids.length > 0) this.emitLedgerEvent('ack');
    return ids;
  }

  /** Count the same unacknowledged, unexpired recipient set as list(), strictly after an explicit ID. */
  unreadCountAfter(recipient: string, after: number): number {
    const to = canonicalMessageAddress(recipient);
    if (to === 'ALL') throw new Error('ALL is a topic, not a recipient');
    validCursor(after);
    // ③ UNION 팔(direct · ALL · group)을 탄다 — 기존 OR 술어(unreadWhereOn)는 커버 색인을 못 타고 전수 행을 훑는다.
    const arms = unreadArmsOn(this.db, to, after);
    return (this.db.query(`SELECT COUNT(*) AS count FROM (${arms.sql})`).get(...arms.params) as { count: number }).count;
  }

  unreadRecipients(): UnreadRecipient[] {
    const hasGroups = this.hasGroupMemberships;
    const hasAcks = hasMessageAckTable(this.db);
    const hasMetadata = hasEnvelopeMetadata(this.db);
    const membershipRecipients = hasGroups ? ' UNION SELECT seat FROM msg_group_memberships' : '';
    const ackFilter = hasAcks ? 'AND NOT EXISTS (SELECT 1 FROM msg_message_acks a WHERE a.message_id=m.id AND a.recipient=r.recipient)' : '';
    const expiryFilter = hasMetadata ? "AND (m.expires_at IS NULL OR julianday(m.expires_at)>julianday('now'))" : '';
    const groupClause = hasGroups ? ` OR EXISTS (
          SELECT 1 FROM msg_group_memberships gm WHERE gm.address = m.recipient AND gm.seat = r.recipient
            AND m.id > gm.joined_after_id AND (gm.left_after_id IS NULL OR m.id <= gm.left_after_id)
        )` : '';
    return this.db.query(`WITH recipients(recipient) AS (
        SELECT 'OP' UNION SELECT 'MK' UNION SELECT 'TC' UNION SELECT 'UX'
        UNION SELECT recipient FROM msg_messages WHERE recipient <> 'ALL' AND recipient NOT LIKE 'group:%'
        UNION SELECT recipient FROM msg_cursors WHERE recipient <> 'ALL'
        ${membershipRecipients}
      )
      SELECT r.recipient AS recipient, COUNT(m.id) AS count
      FROM recipients r
      LEFT JOIN msg_cursors c ON c.recipient = r.recipient
      JOIN msg_messages m ON m.id > COALESCE(c.last_id, 0)
        ${expiryFilter} ${ackFilter}
        AND (m.recipient = r.recipient OR (m.recipient = 'ALL' AND m.sender <> r.recipient)${groupClause})
      GROUP BY r.recipient ORDER BY r.recipient ASC`).all() as UnreadRecipient[];
  }

  unread(): UnreadRecipient[] { return this.unreadRecipients(); }

  close(): void {
    this.archiveDb?.close();
    this.archiveDb = null;
    this.db.close();
  }
}

/** SEAT-MAIL-ACK-SLA sent-alert ledger — additive table, created on the first alert (old binaries never read it). */
export const MSG_SLA_ALERTS_SCHEMA = `CREATE TABLE IF NOT EXISTS msg_sla_alerts (
  message_id INTEGER NOT NULL, recipient TEXT NOT NULL, stage TEXT NOT NULL, target TEXT NOT NULL,
  alert_id INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY (message_id, recipient, stage, target))`;

export function defaultMsgStorePath(): string { return join(elanousStateRoot(), 'msg', 'messages.db'); }
export function openMsgStore(path?: string, options: { archivePath?: string } = {}): MsgStore { return new MsgStore(path, options); }
export function openMsgStoreReadOnly(path?: string, options: { archivePath?: string } = {}): MsgStore { return new MsgStore(path, { ...options, readOnly: true }); }

/** Observe one recipient without creating a store or advancing its acknowledgement. */
export function readUnreadCount(recipient: string, path: string = defaultMsgStorePath()): number | null {
  const to = canonicalMessageAddress(recipient);
  if (to === 'ALL') throw new Error('ALL is a topic, not a recipient');
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  // Without a busy wait a reader fails at once while any writer commits (11-18: «database is locked» every few seconds).
  db.exec(`PRAGMA busy_timeout = ${MSG_BUSY_TIMEOUT_MS}`);
  try { return unreadCountOn(db, to); }
  finally { db.close(); }
}

/** Observe one recipient's unread count ⊕ newest unread ID (read-only · no cursor change). null = ledger absent («모름»). */
export function readUnreadSummary(recipient: string, path: string = defaultMsgStorePath()): { count: number; maxId: number | null } | null {
  const to = canonicalMessageAddress(recipient);
  if (to === 'ALL') throw new Error('ALL is a topic, not a recipient');
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  db.exec(`PRAGMA busy_timeout = ${MSG_BUSY_TIMEOUT_MS}`);
  try { return unreadSummaryOn(db, to); }
  finally { db.close(); }
}

/** Unread mail badge for the els ls listing (OP #100208 · cell 6): count + oldest unacked waiting time. */
export interface UnreadMailBadge {
  count: number;
  /** ISO timestamp of the oldest unread message (최장 대기 anchor) — null when count = 0. */
  oldestCreatedAt: string | null;
}

/** Read-only unread badge summary for one seat (els ls 결합용) — absent ledger = null. */
export function readUnreadMailBadge(recipient: string, path: string = defaultMsgStorePath()): UnreadMailBadge | null {
  const to = canonicalMessageAddress(recipient);
  if (to === 'ALL') throw new Error('ALL is a topic, not a recipient');
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  db.exec(`PRAGMA busy_timeout = ${MSG_BUSY_TIMEOUT_MS}`);
  try {
    const { where, params } = unreadWhereOn(db, to);
    const row = db.query(`SELECT COUNT(*) AS count, MIN(m.created_at) AS oldest_created_at FROM msg_messages m WHERE ${where}`)
      .get(...params) as { count: number; oldest_created_at: string | null };
    return { count: row.count, oldestCreatedAt: row.oldest_created_at ?? null };
  } finally { db.close(); }
}

// 출처: JUD #39000 FU — els ls 경로의 우편 DB 대기 상한(잠긴 원장에 pane×5s 로 서버 스레드를 막지 않게).
export const UNREAD_BADGE_BUSY_TIMEOUT_MS = 100;

/**
 * Unread badges for several seats in ONE read-only open (JUD #39000 FU): `els ls` asks once per listing, not once
 * per pane, and waits at most UNREAD_BADGE_BUSY_TIMEOUT_MS on a locked ledger. Absent ledger, a busy/locked ledger
 * or a seat that cannot be a recipient → null for that seat; never throws.
 */
export function readUnreadMailBadges(
  recipients: Iterable<string>,
  path: string = defaultMsgStorePath(),
  busyTimeoutMs: number = UNREAD_BADGE_BUSY_TIMEOUT_MS,
): Map<string, UnreadMailBadge | null> {
  const seats = [...new Set(recipients)];
  const empty = new Map<string, UnreadMailBadge | null>(seats.map((seat) => [seat, null]));
  if (seats.length === 0 || !existsSync(path)) return empty;
  let db: Database;
  try { db = new Database(path, { readonly: true }); } catch { return empty; }
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    return readUnreadMailBadgesOn(db, seats).badges;
  } catch { return empty; /* pragma failed: badges stay null */ } finally { db.close(); }
}

/**
 * The badge read on an already open ledger connection (ELS-SERVER-MAINLOOP-STARVATION: the els server's badge worker
 * keeps one read-only connection and asks here). A seat that cannot be a recipient is skipped (null, not an error).
 * `error` = a read failed: a busy/locked ledger stops the read at once; any other SQL error (an incomplete schema, a
 * damaged page) skips that seat and is reported. Either way some seats are null for a reason that is not «no badge»,
 * so a cache must keep its last badges for this answer (JUD-B #39546 must ②).
 */
export function readUnreadMailBadgesOn(db: Database, recipients: Iterable<string>): { badges: Map<string, UnreadMailBadge | null>; error: string | null } {
  const seats = [...new Set(recipients)];
  const out = new Map<string, UnreadMailBadge | null>(seats.map((seat) => [seat, null]));
  let failure: string | null = null;
  for (const seat of seats) {
    let to: string;
    try { to = canonicalMessageAddress(seat); } catch { continue; /* a bad address only skips that seat */ }
    if (to === 'ALL') continue;
    try {
      const arms = unreadArmsOn(db, to);
      const row = db.query(`SELECT COUNT(*) AS count, MIN(created_at) AS oldest_created_at FROM (${arms.sql})`)
        .get(...arms.params) as { count: number; oldest_created_at: string | null };
      out.set(seat, { count: row.count, oldestCreatedAt: row.oldest_created_at ?? null });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      // A busy/locked ledger stays so for the rest of this listing — stop asking (ls stays fast).
      if (/busy|locked/i.test(failure)) return { badges: out, error: failure };
    }
  }
  return { badges: out, error: failure };
}

/** The single agent seat the unread set came from (see `UnreadSource`), or null. Read-only; absent ledger = null. */
export function readUnreadSource(recipient: string, path: string = defaultMsgStorePath()): UnreadSource | null {
  const to = canonicalMessageAddress(recipient);
  if (to === 'ALL') throw new Error('ALL is a topic, not a recipient');
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  db.exec(`PRAGMA busy_timeout = ${MSG_BUSY_TIMEOUT_MS}`);
  try { return unreadSourceOn(db, to); }
  finally { db.close(); }
}

const V2_CORE_COLUMNS = ['intent', 'refs_json', 'deadline_at', 'needs_ack', 'crown_directive', 'schema_version', 'body_ref_json'] as const;
const V2_ORIGIN_COLUMNS = ['origin_seat', 'origin_delegated', 'done_when'] as const;

function columnPresent(db: Database, name: string): boolean {
  return (db.query("SELECT COUNT(*) AS count FROM pragma_table_info('msg_messages') WHERE name = ?")
    .get(name) as { count: number }).count > 0;
}

/** Each optional column is projected on its own. A missing origin column is omitted (undefined on
 *  the row) so a pre-origin ledger still derives the sender; an explicit NULL stays NULL.
 *  Missing core columns are NULL and do not hide a row that has the other v2 columns.
 *  The settled seven v2 columns are the gate inside this projection — a canonical ledger without
 *  origin_seat/origin_delegated still reads intent, refs, and body refs. */
function v2Select(db: Database, qualified: boolean): string {
  const prefix = qualified ? 'm.' : '';
  // Project each core column on its own. A partial migration must not NULL out columns that exist.
  const core = V2_CORE_COLUMNS.map(name => columnPresent(db, name) ? `${prefix}${name}` : `NULL AS ${name}`).join(', ');
  const origin = V2_ORIGIN_COLUMNS.filter(name => columnPresent(db, name)).map(name => `${prefix}${name}`);
  return origin.length === 0 ? core : `${core}, ${origin.join(', ')}`;
}
