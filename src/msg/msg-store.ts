import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { validateProvenance, type Provenance } from '../provenance/provenance.js';

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
}

export interface Message extends MessageEnvelope {
  id: number;
  createdAt: string;
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
  if (Object.keys(record).some(key => !['from', 'to', 'body', 'kind', 'replyTo', 'expiresAt', 'priority', 'supersedes', 'provenance'].includes(key))) throw new Error('unknown message field');
  return {
    from, to, body: record.body,
    ...(record.kind === undefined ? {} : { kind: record.kind as string }),
    ...(replyTo === undefined ? {} : { replyTo }),
    ...(record.expiresAt === undefined ? {} : { expiresAt: normalizeExpiry(record.expiresAt as string) }),
    ...(record.priority === undefined ? {} : { priority: record.priority as number }),
    ...(record.supersedes === undefined ? {} : { supersedes: record.supersedes as number }),
    ...(record.provenance === undefined ? {} : { provenance: Object.freeze({ ...(record.provenance as Provenance) }) }),
  };
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

/** Unread count ⊕ newest unread ID for one recipient (same predicate as `unreadCountOn`). */
function unreadSummaryOn(db: Database, to: string): { count: number; maxId: number | null } {
  const hasAcks = hasMessageAckTable(db);
  const hasMetadata = hasEnvelopeMetadata(db);
  const ackClause = hasAcks ? 'AND NOT EXISTS (SELECT 1 FROM msg_message_acks a WHERE a.message_id=m.id AND a.recipient=?)' : '';
  const expiryClause = hasMetadata ? "AND (m.expires_at IS NULL OR julianday(m.expires_at) > julianday('now'))" : '';
  const groupClause = hasGroupMembershipTable(db) ? ` OR EXISTS (
        SELECT 1 FROM msg_group_memberships gm WHERE gm.address = m.recipient AND gm.seat = ?
          AND m.id > gm.joined_after_id AND (gm.left_after_id IS NULL OR m.id <= gm.left_after_id)
      )` : '';
  const row = db.query(`SELECT COUNT(*) AS count, MAX(m.id) AS max_id FROM msg_messages m
    WHERE m.id > COALESCE((SELECT last_id FROM msg_cursors WHERE recipient = ?), 0)
      ${expiryClause} ${ackClause}
      AND (m.recipient = ? OR (m.recipient = 'ALL' AND m.sender <> ?)${groupClause})`)
    .get(...[to, ...(hasAcks ? [to] : []), to, to, ...(hasGroupMembershipTable(db) ? [to] : [])]) as { count: number; max_id: number | null };
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
}

function fromRow(row: MessageRow): Message {
  return { id: row.id, from: row.sender, to: row.recipient, body: row.body,
    ...(row.kind === null ? {} : { kind: row.kind }),
    ...(row.reply_to == null ? {} : { replyTo: row.reply_to }),
    ...(row.expires_at == null ? {} : { expiresAt: row.expires_at }),
    ...(row.priority == null ? {} : { priority: row.priority }),
    ...(row.supersedes == null ? {} : { supersedes: row.supersedes }),
    ...(parseStoredProvenance(row.provenance_json) ? { provenance: parseStoredProvenance(row.provenance_json)! } : {}),
    createdAt: row.created_at };
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

  // A read-only SSE connection may outlive another process's in-place migration.
  private get hasReplyTo(): boolean {
    return (this.db.query(`SELECT COUNT(*) AS count FROM pragma_table_info('msg_messages') WHERE name = 'reply_to'`)
      .get() as { count: number }).count > 0;
  }

  private get hasProvenance(): boolean {
    return (this.db.query(`SELECT COUNT(*) AS count FROM pragma_table_info('msg_messages') WHERE name = 'provenance_json'`)
      .get() as { count: number }).count > 0;
  }

  private get hasGroupMemberships(): boolean {
    return (this.db.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'msg_group_memberships'")
      .get() as { count: number }).count > 0;
  }

  private readWithSchema<T>(read: (hasReplyTo: boolean, hasGroupMemberships: boolean, hasProvenance: boolean) => T): T {
    // The schema projection and rows must share one SQLite snapshot. Otherwise a writer can
    // migrate between them and a reader could advance past a reply with its link erased.
    return this.db.transaction(() => read(this.hasReplyTo, this.hasGroupMemberships, this.hasProvenance)).deferred();
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
    return this.db.transaction(() => {
      const existing = this.db.query(`SELECT m.id, m.sender, m.recipient, m.body, m.kind, m.reply_to, m.created_at, m.provenance_json
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
    }).immediate();
  }

  private insertMessage(input: MessageEnvelope): Message {
    const msg = validateMessageEnvelope(input);
    if (msg.replyTo !== undefined && this.db.query('SELECT 1 FROM msg_messages WHERE id = ?').get(msg.replyTo) === null) {
      throw new Error(`reply target not found: #${msg.replyTo}`);
    }
    const createdAt = new Date().toISOString();
    if (msg.supersedes !== undefined && !this.db.query('SELECT 1 FROM msg_messages WHERE id = ?').get(msg.supersedes)) throw new Error(`superseded message not found: #${msg.supersedes}`);
    const result = this.db.query(`INSERT INTO msg_messages(sender, recipient, body, kind, reply_to, created_at, expires_at, priority, supersedes, provenance_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(msg.from, msg.to, msg.body, msg.kind ?? null, msg.replyTo ?? null, createdAt, msg.expiresAt ?? null, msg.priority ?? null, msg.supersedes ?? null, msg.provenance ? JSON.stringify(msg.provenance) : null);
    return { id: Number(result.lastInsertRowid), ...msg, createdAt };
  }

  post(input: MessageEnvelope): Message {
    const message = validateMessageEnvelope(input);
    if (message.to.startsWith('group:')) return this.db.transaction(() => {
      if (!this.db.query('SELECT 1 FROM msg_groups WHERE address = ?').get(message.to)) throw new Error(`group not found: ${message.to}`);
      return this.insertMessage(message);
    }).immediate();
    if (message.to !== 'ALL') return this.insertMessage(message);
    const now = this.clock();
    const hourStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours())).toISOString();
    return this.db.transaction(() => {
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
    }).immediate();
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
    return this.readWithSchema((hasReplyTo, hasGroupMemberships, hasProvenance) => {
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
      return (this.db.query(`SELECT m.id, m.sender, m.recipient, m.body, m.kind, ${hasReplyTo ? 'm.reply_to' : 'NULL AS reply_to'}, m.created_at, ${metadata}, ${provenance} FROM msg_messages m ${acksJoin}
        WHERE m.id > ? ${expiryFilter} ${ackFilter} AND (m.recipient = ? OR (m.recipient = 'ALL' AND m.sender <> ?)${groupClause}) ORDER BY m.id ASC LIMIT ?`)
        .all(...params) as MessageRow[]).map(fromRow);
    });
  }

  /** One message by durable ID, or null when absent. */
  getMessage(messageId: number): Message | null {
    if (!Number.isSafeInteger(messageId) || messageId < 1) throw new Error('message ID must be a positive integer');
    return this.readWithSchema((hasReplyTo, _groups, hasProvenance) => {
      const metadata = hasEnvelopeMetadata(this.db) ? 'expires_at, priority, supersedes' : 'NULL AS expires_at, NULL AS priority, NULL AS supersedes';
      const provenance = hasProvenance ? 'provenance_json' : 'NULL AS provenance_json';
      const row = this.db.query(`SELECT id, sender, recipient, body, kind, ${hasReplyTo ? 'reply_to' : 'NULL AS reply_to'}, created_at, ${metadata}, ${provenance} FROM msg_messages
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
    return this.readWithSchema((hasReplyTo, _groups, hasProvenance) => hasReplyTo
      ? (this.db.query(`SELECT id, sender, recipient, body, kind, reply_to, created_at, ${hasProvenance ? 'provenance_json' : 'NULL AS provenance_json'} FROM msg_messages
        WHERE reply_to = ? AND id > ? ORDER BY id ASC LIMIT ?`).all(messageId, afterId, limit) as MessageRow[]).map(fromRow)
      : []);
  }

  /** A request and its direct replies, in insertion order, independent of recipient cursors. */
  listThread(messageId: number, after: number = 0, limit: number = 100): Message[] {
    if (!Number.isSafeInteger(messageId) || messageId < 1) throw new Error('message ID must be a positive integer');
    validCursor(after);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be between 1 and 1000');
    return this.readWithSchema((hasReplyTo, _groups, hasProvenance) => {
      const target = this.db.query(`SELECT id, ${hasReplyTo ? 'reply_to' : 'NULL AS reply_to'} FROM msg_messages WHERE id = ?`)
        .get(messageId) as { id: number; reply_to: number | null } | null;
      if (target === null) throw new Error(`message not found: #${messageId}`);
      const rootId = target.reply_to ?? target.id;
      const rows = this.db.query(`SELECT id, sender, recipient, body, kind, ${hasReplyTo ? 'reply_to' : 'NULL AS reply_to'}, created_at, ${hasProvenance ? 'provenance_json' : 'NULL AS provenance_json'} FROM msg_messages
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
    return this.readWithSchema((hasReplyTo, _groups, hasProvenance) => (this.db.query(`SELECT id, sender, recipient, body, kind, ${hasReplyTo ? 'reply_to' : 'NULL AS reply_to'}, created_at, ${hasProvenance ? 'provenance_json' : 'NULL AS provenance_json'} FROM msg_messages
      WHERE id > ? ORDER BY id ASC LIMIT ?`).all(after, limit) as MessageRow[]).map(fromRow));
  }

  /** Read a half-open UTC timestamp window for periodic message-mirror summaries. */
  listCreatedBetween(start: string, end: string): Message[] {
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error('invalid message time window');
    return this.readWithSchema((hasReplyTo, _groups, hasProvenance) => (this.db.query(`SELECT id, sender, recipient, body, kind,
      ${hasReplyTo ? 'reply_to' : 'NULL AS reply_to'}, created_at, ${hasProvenance ? 'provenance_json' : 'NULL AS provenance_json'} FROM msg_messages
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
