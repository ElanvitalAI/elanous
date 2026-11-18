import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { validateProvenance, type Provenance } from '../provenance/provenance.js';
import { hasReceiptTable, latestReceiptIdOn, legacyIntent, listReceiptsOn, MSG_RECEIPTS_SCHEMA, recordReceiptOn, type Receipt, type ReceiptInput, type ReceiptQuery, type ReceiptRecordOutcome, type ReceiptState } from './msg-receipts.js';

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
}

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
  if (fromAddress.startsWith('group:') || fromAddress.startsWith('pane:') || fromAddress.startsWith('session:') || fromAddress.includes('/')) throw new Error('sender must be a seat');
  const from = canonicalSeatId(fromAddress);
  const to = canonicalMessageAddress(record.to as string);
  if (from === 'ALL') throw new Error('ALL cannot send messages');
  if (from.startsWith('group:')) throw new Error('sender must be a seat');
  if (typeof record.body !== 'string' || !record.body.trim()) throw new Error('message body must be nonempty');
  if (record.kind !== undefined && (typeof record.kind !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(record.kind))) {
    throw new Error('invalid message kind');
  }
  const replyTo = record.replyTo;
  if (replyTo !== undefined && (typeof replyTo !== 'number' || !Number.isSafeInteger(replyTo) || replyTo < 1)) {
    throw new Error('replyTo must be a positive integer message ID');
  }
  if (record.expiresAt !== undefined && (typeof record.expiresAt !== 'string' || !Number.isFinite(Date.parse(record.expiresAt)))) throw new Error('expiresAt must be an ISO timestamp');
  if (record.priority !== undefined && (typeof record.priority !== 'number' || !Number.isFinite(record.priority))) throw new Error('priority must be a finite number');
  if (record.supersedes !== undefined && (typeof record.supersedes !== 'number' || !Number.isSafeInteger(record.supersedes) || record.supersedes < 1)) throw new Error('supersedes must be a positive message ID');
  if (record.provenance !== undefined && !validateProvenance(record.provenance)) throw new Error('invalid message provenance');
  if (record.intent !== undefined && !['request', 'decision', 'info', 'alert'].includes(record.intent as string)) throw new Error('intent must be request, decision, info, or alert');
  if (record.refs !== undefined && (!Array.isArray(record.refs) || record.refs.length === 0 || !(record.refs as unknown[]).every(item => typeof item === 'string'))) throw new Error('refs must be a nonempty array of strings (omit it to store NULL)');
  if (record.deadlineAt !== undefined && (typeof record.deadlineAt !== 'string' || !Number.isFinite(Date.parse(record.deadlineAt)))) throw new Error('deadlineAt must be an ISO timestamp');
  if (record.needsAck !== undefined && typeof record.needsAck !== 'boolean') throw new Error('needsAck must be a boolean');
  if (record.doneWhen !== undefined && (typeof record.doneWhen !== 'string' || !record.doneWhen.trim() || record.doneWhen.length > 500)) throw new Error('doneWhen must be a nonempty string of at most 500 characters');
  if (record.crownDirective !== undefined && (typeof record.crownDirective !== 'string' || !record.crownDirective.trim())) throw new Error('crownDirective must be a nonempty string');
  if (record.origin !== undefined && (typeof record.origin !== 'object' || record.origin === null || Array.isArray(record.origin)
      || !['human', 'agent', 'system', 'tool'].includes((record.origin as { kind?: unknown }).kind as string))) throw new Error('origin.kind must be human, agent, system, or tool');
  if (Object.keys(record).some(key => !['from', 'to', 'body', 'kind', 'replyTo', 'expiresAt', 'priority', 'supersedes', 'provenance', 'intent', 'refs', 'deadlineAt', 'doneWhen', 'needsAck', 'crownDirective', 'origin'].includes(key))) throw new Error('unknown message field');
  return {
    from, to, body: record.body,
    ...(record.kind === undefined ? {} : { kind: record.kind as string }),
    ...(replyTo === undefined ? {} : { replyTo }),
    ...(record.expiresAt === undefined ? {} : { expiresAt: normalizeExpiry(record.expiresAt as string) }),
    ...(record.priority === undefined ? {} : { priority: record.priority as number }),
    ...(record.supersedes === undefined ? {} : { supersedes: record.supersedes as number }),
    ...(record.provenance === undefined ? {} : { provenance: Object.freeze({ ...(record.provenance as Provenance) }) }),
    ...(record.intent === undefined ? {} : { intent: record.intent as MessageEnvelope['intent'] }),
    ...(record.refs === undefined ? {} : { refs: [...(record.refs as string[])] }),
    ...(record.deadlineAt === undefined ? {} : { deadlineAt: record.deadlineAt as string }),
    ...(record.doneWhen === undefined ? {} : { doneWhen: (record.doneWhen as string).trim() }),
    ...(record.needsAck === undefined ? {} : { needsAck: record.needsAck as boolean }),
    ...(record.crownDirective === undefined ? {} : { crownDirective: record.crownDirective as string }),
    ...(record.origin === undefined ? {} : { origin: normalizeMessageOrigin(record.origin as Record<string, unknown>, from) }),
  };
}

function normalizeMessageOrigin(value: Record<string, unknown>, sender: string): MessageOrigin {
  const kind = value.kind as MessageOrigin['kind'];
  if (value.seat !== undefined && value.seat !== sender) {
    throw new Error('origin.seat must match the sender');
  }
  if (value.delegatedByCrown !== undefined && typeof value.delegatedByCrown !== 'boolean') {
    throw new Error('origin.delegatedByCrown must be a boolean when present');
  }
  const extra = Object.keys(value).filter(key => !['kind', 'seat', 'delegatedByCrown'].includes(key));
  if (extra.length > 0) throw new Error('unknown origin field');
  // An explicit origin always carries the sender. Omitting seat must not make a reread differ.
  // false is a real value (the public type allows it) and must survive a reread, not be dropped.
  return { kind, seat: sender,
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
function unreadWhereOn(db: Database, to: string): { where: string; params: string[] } {
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
    where: `m.id > COALESCE((SELECT last_id FROM msg_cursors WHERE recipient = ?), 0)
      ${expiryClause} ${ackClause}
      AND (m.recipient = ? OR (m.recipient = 'ALL' AND m.sender <> ?)${groupClause})`,
    params: [to, ...(hasAcks ? [to] : []), to, to, ...(hasGroups ? [to] : [])],
  };
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
  const { where, params } = unreadWhereOn(db, to);
  const row = db.query(`SELECT COUNT(*) AS count, MAX(m.id) AS max_id FROM msg_messages m WHERE ${where}`)
    .get(...params) as { count: number; max_id: number | null };
  return { count: row.count, maxId: row.max_id ?? null };
}

function unreadCountOn(db: Database, to: string): number {
  const hasAcks = hasMessageAckTable(db);
  const hasMetadata = hasEnvelopeMetadata(db);
  const ackClause = hasAcks ? 'AND NOT EXISTS (SELECT 1 FROM msg_message_acks a WHERE a.message_id=m.id AND a.recipient=?)' : '';
  const expiryClause = hasMetadata ? "AND (m.expires_at IS NULL OR julianday(m.expires_at) > julianday('now'))" : '';
  const groupClause = hasGroupMembershipTable(db) ? ` OR EXISTS (
        SELECT 1 FROM msg_group_memberships gm WHERE gm.address = m.recipient AND gm.seat = ?
          AND m.id > gm.joined_after_id AND (gm.left_after_id IS NULL OR m.id <= gm.left_after_id)
      )` : '';
  const params = [to, ...(hasAcks ? [to] : []), to, to, ...(hasGroupMembershipTable(db) ? [to] : [])];
  return (db.query(`SELECT COUNT(*) AS count FROM msg_messages m
    WHERE m.id > COALESCE((SELECT last_id FROM msg_cursors WHERE recipient = ?), 0)
      ${expiryClause} ${ackClause}
      AND (m.recipient = ? OR (m.recipient = 'ALL' AND m.sender <> ?)${groupClause})`)
    .get(...params) as { count: number }).count;
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
  private readonly clock: () => Date;
  /** posted-receipt events held until the outermost write transaction commits (dropped on rollback). */
  private pendingPostedEvents: Array<() => void> = [];
  private postedEventDepth = 0;

  /**
   * SEAT-INBOX B1-C (#38194 REVIEW-1 ①②): run one message write as a single immediate transaction so the message
   * INSERT and its posted receipt commit or roll back together (a failed post never leaves a stored message behind,
   * so a retry cannot store it twice), and emit `msg.receipt.posted` only after that commit.
   */
  private withPostedEvents<T>(write: () => T): T {
    this.postedEventDepth += 1;
    let result: T;
    try { result = this.db.inTransaction ? write() : this.db.transaction(write).immediate(); }
    catch (error) {
      this.postedEventDepth -= 1;
      if (this.postedEventDepth === 0) this.pendingPostedEvents = [];
      throw error;
    }
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

  constructor(path: string = defaultMsgStorePath(), options: { readOnly?: boolean; now?: () => Date } = {}) {
    this.clock = options.now ?? (() => new Date());
    if (options.readOnly && (path === ':memory:' || !existsSync(path))) throw new Error('message ledger unavailable for read-only SSE service');
    if (!options.readOnly && path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = options.readOnly ? new Database(path, { readonly: true }) : new Database(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
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
    // Serialize the schema check and ALTER across processes opening an old ledger at once.
    if (!options.readOnly) this.db.transaction(() => {
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
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_msg_messages_reply_to ON msg_messages(reply_to, id)');
    }).immediate();
  }

  append(input: MessageEnvelope): Message { return this.post(input); }

  /** Append once for a coordination comment, task failure, or decided notification. */
  appendWithProvenance(input: MessageEnvelope, provenanceKey: string): Message {
    if (typeof provenanceKey !== 'string' || !/^(?:coord|ta-failure|decision):[^:]+:[^:]+$/.test(provenanceKey) &&
        !/^release-stage:[^:]+:event$/.test(provenanceKey) &&
        !/^(?:release-event|rla-held-event):[A-Za-z0-9_-]+:(?:OP|RLA)$/.test(provenanceKey) &&
        !/^rla-command-reply:[1-9][0-9]*:OP$/.test(provenanceKey) &&
        !/^rla-question-reply:[1-9][0-9]*:OP$/.test(provenanceKey)) {
      throw new Error('invalid message provenance key');
    }
    const msg = validateMessageEnvelope(input);
    if (!provenanceKey.startsWith('release-stage:') && provenanceKey.split(':')[2] !== msg.to) {
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

  private insertMessage(input: MessageEnvelope): Message {
    const msg = validateMessageEnvelope(input);
    if (msg.replyTo !== undefined && this.db.query('SELECT 1 FROM msg_messages WHERE id = ?').get(msg.replyTo) === null) {
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
    const result = this.db.query(`INSERT INTO msg_messages(sender, recipient, body, kind, reply_to, created_at, expires_at, priority, supersedes, provenance_json, from_kind, intent, refs_json, deadline_at, needs_ack, crown_directive, schema_version, body_ref_json, origin_seat, origin_delegated, done_when)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(msg.from, msg.to, msg.body, msg.kind ?? null, msg.replyTo ?? null, createdAt, msg.expiresAt ?? null, msg.priority ?? null, msg.supersedes ?? null, msg.provenance ? JSON.stringify(msg.provenance) : null, fromKind, intent, msg.refs ? JSON.stringify(msg.refs) : null, msg.deadlineAt ?? null, needsAck ? 1 : 0, msg.crownDirective ?? null, 2, null, origin?.seat ?? null, origin?.delegatedByCrown === undefined ? null : (origin.delegatedByCrown ? 1 : 0), msg.doneWhen ?? null);
    const id = Number(result.lastInsertRowid);
    // SEAT-INBOX B1-C §4a — posted = 원장 커밋. 수신자 칸은 주소 그대로(ALL · group 포함).
    recordReceiptOn(this.db, { messageId: id, recipient: msg.to, state: 'posted', source: 'ledger' }, () => new Date(createdAt),
      { deferEvent: emit => { this.pendingPostedEvents.push(emit); } });
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
    return recordReceiptOn(this.db, { ...input, recipient }, this.clock);
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

  post(input: MessageEnvelope): Message {
    const message = validateMessageEnvelope(input);
    if (message.to.startsWith('group:')) return this.withPostedEvents(() => {
      if (!this.db.query('SELECT 1 FROM msg_groups WHERE address = ?').get(message.to)) throw new Error(`group not found: ${message.to}`);
      return this.insertMessage(message);
    });
    if (message.to !== 'ALL') return this.withPostedEvents(() => this.insertMessage(message));
    const now = this.clock();
    const hourStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours())).toISOString();
    return this.withPostedEvents(() => {
      const row = this.db.query(`SELECT broadcast_count, summary_id FROM msg_group_all_budget
        WHERE sender = ? AND hour_start = ?`).get(message.from, hourStart) as { broadcast_count: number; summary_id: number | null } | null;
      if (row && row.broadcast_count >= 2) {
        if (row.summary_id !== null) {
          return this.getMessage(row.summary_id)!;
        }
        const summary = this.insertMessage({ from: message.from, to: 'ALL', kind: 'summary',
          body: 'group:all 시간당 상한(2건)을 초과한 방송은 이 요약 한 건으로 접었습니다.' });
        this.db.query('UPDATE msg_group_all_budget SET summary_id = ? WHERE sender = ? AND hour_start = ?')
          .run(summary.id, message.from, hourStart);
        return summary;
      }
      const posted = this.insertMessage(message);
      this.db.query(`INSERT INTO msg_group_all_budget(sender, hour_start, broadcast_count, summary_id)
        VALUES (?, ?, 1, NULL) ON CONFLICT(sender, hour_start)
        DO UPDATE SET broadcast_count = msg_group_all_budget.broadcast_count + 1`)
        .run(message.from, hourStart);
      return posted;
    });
  }

  createGroup(name: string, owner: string): string {
    const address = canonicalGroupAddress(name.startsWith('group:') ? name : `group:${name}`);
    const seat = canonicalSeatId(owner);
    return this.db.transaction(() => {
      this.db.query('INSERT INTO msg_groups(address) VALUES (?)').run(address);
      this.db.query('INSERT INTO msg_group_memberships(address, seat, joined_after_id) VALUES (?, ?, ?)')
        .run(address, seat, this.latestId());
      return address;
    }).immediate();
  }

  joinGroup(group: string, member: string): boolean {
    const address = canonicalGroupAddress(group);
    const seat = canonicalSeatId(member);
    return this.db.transaction(() => {
      if (!this.db.query('SELECT 1 FROM msg_groups WHERE address = ?').get(address)) throw new Error(`group not found: ${address}`);
      const existing = this.db.query('SELECT 1 FROM msg_group_memberships WHERE address = ? AND seat = ? AND left_after_id IS NULL')
        .get(address, seat);
      if (existing) return false;
      this.db.query('INSERT INTO msg_group_memberships(address, seat, joined_after_id) VALUES (?, ?, ?)')
        .run(address, seat, this.latestId());
      return true;
    }).immediate();
  }

  leaveGroup(group: string, member: string): boolean {
    const address = canonicalGroupAddress(group);
    const seat = canonicalSeatId(member);
    return this.db.transaction(() => {
      const result = this.db.query(`UPDATE msg_group_memberships SET left_after_id = ?
        WHERE id = (SELECT id FROM msg_group_memberships WHERE address = ? AND seat = ? AND left_after_id IS NULL ORDER BY id DESC LIMIT 1)`)
        .run(this.latestId(), address, seat);
      return result.changes > 0;
    }).immediate();
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

  /** Only the active sender may settle or report its own attempt; stale failures cannot overwrite success. */
  settleTaDelivery(requestId: number, token: string, replyBody: string, delivered: boolean): boolean {
    return this.db.transaction(() => {
      const owner = this.db.query('SELECT token FROM msg_ta_claim WHERE request_id = ?').get(requestId) as { token: string } | null;
      if (owner?.token !== token || this.taDeliveryStatus(requestId) === 'delivered') return false;
      if (delivered) this.setTaDeliveryStatus(requestId, 'delivered');
      this.updateTaReply(requestId, replyBody);
      this.db.query('DELETE FROM msg_ta_claim WHERE request_id = ? AND token = ?').run(requestId, token);
      return true;
    }).immediate();
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
  listByRecipient(recipient: string, after: number = 0, limit: number = 100): Message[] {
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
      const ackFilter = hasAcks ? 'AND a.message_id IS NULL' : '';
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

  /** Replies pointing at the supplied message, ordered by durable insertion ID. */
  listReplies(messageId: number, limit: number = 100, afterId: number = 0): Message[] {
    if (!Number.isSafeInteger(messageId) || messageId < 1) throw new Error('message ID must be a positive integer');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be between 1 and 1000');
    validCursor(afterId);
    return this.readWithSchema((hasReplyTo, _groups, hasProvenance, hasFromKind) => hasReplyTo
      ? (this.db.query(`SELECT id, sender, recipient, body, kind, reply_to, created_at, ${envelopeMetaSql(this.db, false)}, ${hasProvenance ? 'provenance_json' : 'NULL AS provenance_json'}, ${hasFromKind ? 'from_kind' : 'NULL AS from_kind'}, ${v2Select(this.db, false)} FROM msg_messages
        WHERE reply_to = ? AND id > ? ORDER BY id ASC LIMIT ?`).all(messageId, afterId, limit) as MessageRow[]).map(fromRow)
      : []);
  }

  /** A request and its direct replies, in insertion order, independent of recipient cursors. */
  listThread(messageId: number, after: number = 0, limit: number = 100): Message[] {
    if (!Number.isSafeInteger(messageId) || messageId < 1) throw new Error('message ID must be a positive integer');
    validCursor(after);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be between 1 and 1000');
    return this.readWithSchema((hasReplyTo, _groups, hasProvenance, hasFromKind) => {
      const target = this.db.query(`SELECT id, ${hasReplyTo ? 'reply_to' : 'NULL AS reply_to'} FROM msg_messages WHERE id = ?`)
        .get(messageId) as { id: number; reply_to: number | null } | null;
      if (target === null) throw new Error(`message not found: #${messageId}`);
      const rootId = target.reply_to ?? target.id;
      const rows = this.db.query(`SELECT id, sender, recipient, body, kind, ${hasReplyTo ? 'reply_to' : 'NULL AS reply_to'}, created_at, ${envelopeMetaSql(this.db, false)}, ${hasProvenance ? 'provenance_json' : 'NULL AS provenance_json'}, ${hasFromKind ? 'from_kind' : 'NULL AS from_kind'}, ${v2Select(this.db, false)} FROM msg_messages
        WHERE id > ? AND (id = ? ${hasReplyTo ? 'OR reply_to = ?' : ''}) ORDER BY id ASC LIMIT ?`)
        .all(...(hasReplyTo ? [after, rootId, rootId, limit] : [after, rootId, limit])) as MessageRow[];
      return rows.map(fromRow);
    });
  }

  list(recipient: string, after: number = 0, limit: number = 100): Message[] {
    return this.listByRecipient(recipient, after, limit);
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
    return this.getCursor(to);
  }

  ack(recipient: string, cursor: number): number { return this.advanceCursor(recipient, cursor); }

  /** Acknowledge exactly one delivered message for its recipient without moving past siblings. */
  ackMessage(recipient: string, messageId: number, status: 'acked' | 'done' = 'acked'): boolean {
    const to = canonicalMessageAddress(recipient);
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
    return true;
  }

  unreadCount(recipient: string): number {
    const to = canonicalMessageAddress(recipient);
    if (to === 'ALL') throw new Error('ALL is a topic, not a recipient');
    return unreadCountOn(this.db, to);
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

  close(): void { this.db.close(); }
}

/** SEAT-MAIL-ACK-SLA sent-alert ledger — additive table, created on the first alert (old binaries never read it). */
export const MSG_SLA_ALERTS_SCHEMA = `CREATE TABLE IF NOT EXISTS msg_sla_alerts (
  message_id INTEGER NOT NULL, recipient TEXT NOT NULL, stage TEXT NOT NULL, target TEXT NOT NULL,
  alert_id INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY (message_id, recipient, stage, target))`;

export function defaultMsgStorePath(): string { return join(elanousStateRoot(), 'msg', 'messages.db'); }
export function openMsgStore(path?: string): MsgStore { return new MsgStore(path); }
export function openMsgStoreReadOnly(path?: string): MsgStore { return new MsgStore(path, { readOnly: true }); }

/** Observe one recipient without creating a store or advancing its acknowledgement. */
export function readUnreadCount(recipient: string, path: string = defaultMsgStorePath()): number | null {
  const to = canonicalMessageAddress(recipient);
  if (to === 'ALL') throw new Error('ALL is a topic, not a recipient');
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try { return unreadCountOn(db, to); }
  finally { db.close(); }
}

/** Observe one recipient's unread count ⊕ newest unread ID (read-only · no cursor change). null = ledger absent («모름»). */
export function readUnreadSummary(recipient: string, path: string = defaultMsgStorePath()): { count: number; maxId: number | null } | null {
  const to = canonicalMessageAddress(recipient);
  if (to === 'ALL') throw new Error('ALL is a topic, not a recipient');
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try { return unreadSummaryOn(db, to); }
  finally { db.close(); }
}

/** The single agent seat the unread set came from (see `UnreadSource`), or null. Read-only; absent ledger = null. */
export function readUnreadSource(recipient: string, path: string = defaultMsgStorePath()): UnreadSource | null {
  const to = canonicalMessageAddress(recipient);
  if (to === 'ALL') throw new Error('ALL is a topic, not a recipient');
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
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
