import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';

export interface MessageEnvelope {
  from: string;
  to: string;
  body: string;
  kind?: string;
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

/** Check untrusted input before opening the DB or executing a write. */
export function validateMessageEnvelope(input: unknown): MessageEnvelope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('message must be an object');
  const record = input as Record<string, unknown>;
  const from = canonicalSeatId(record.from as string);
  const to = canonicalSeatId(record.to as string);
  if (from === 'ALL') throw new Error('ALL cannot send messages');
  if (typeof record.body !== 'string' || !record.body.trim()) throw new Error('message body must be nonempty');
  if (record.kind !== undefined && (typeof record.kind !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(record.kind))) {
    throw new Error('invalid message kind');
  }
  if (Object.keys(record).some(key => !['from', 'to', 'body', 'kind'].includes(key))) throw new Error('unknown message field');
  return record.kind === undefined ? { from, to, body: record.body } : { from, to, body: record.body, kind: record.kind as string };
}

function validCursor(cursor: number): number {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor must be a nonnegative safe integer');
  return cursor;
}

function unreadCountOn(db: Database, to: string): number {
  return (db.query(`SELECT COUNT(*) AS count FROM msg_messages m
    WHERE m.id > COALESCE((SELECT last_id FROM msg_cursors WHERE recipient = ?), 0)
      AND (m.recipient = ? OR (m.recipient = 'ALL' AND m.sender <> ?))`)
    .get(to, to, to) as { count: number }).count;
}

interface MessageRow {
  id: number;
  sender: string;
  recipient: string;
  body: string;
  kind: string | null;
  created_at: string;
}

function fromRow(row: MessageRow): Message {
  return { id: row.id, from: row.sender, to: row.recipient, body: row.body,
    ...(row.kind === null ? {} : { kind: row.kind }), createdAt: row.created_at };
}

/** SQLite owns both append order and per-recipient acknowledgement progress. */
export class MsgStore {
  readonly db: Database;

  constructor(path: string = defaultMsgStorePath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS msg_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      body TEXT NOT NULL,
      kind TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msg_messages_recipient_id ON msg_messages(recipient, id);
    CREATE TABLE IF NOT EXISTS msg_cursors (
      recipient TEXT PRIMARY KEY,
      last_id INTEGER NOT NULL DEFAULT 0 CHECK(last_id >= 0)
    );
    CREATE TABLE IF NOT EXISTS msg_provenance (
      provenance_key TEXT PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES msg_messages(id)
    );`);
  }

  append(input: MessageEnvelope): Message {
    return this.insertMessage(input);
  }

  /** Append once for a provenance key such as coord:<commentId>:<recipient>. */
  appendWithProvenance(input: MessageEnvelope, provenanceKey: string): Message {
    if (typeof provenanceKey !== 'string' || !/^coord:[^:]+:[^:]+$/.test(provenanceKey)) {
      throw new Error('invalid message provenance key');
    }
    const msg = validateMessageEnvelope(input);
    if (provenanceKey.split(':')[2] !== msg.to) throw new Error('provenance recipient does not match message recipient');
    return this.db.transaction(() => {
      const existing = this.db.query(`SELECT m.id, m.sender, m.recipient, m.body, m.kind, m.created_at
        FROM msg_provenance p JOIN msg_messages m ON m.id = p.message_id WHERE p.provenance_key = ?`)
        .get(provenanceKey) as MessageRow | null;
      if (existing) return fromRow(existing);
      const message = this.insertMessage(msg);
      this.db.query('INSERT INTO msg_provenance(provenance_key, message_id) VALUES (?, ?)')
        .run(provenanceKey, message.id);
      return message;
    }).immediate();
  }

  private insertMessage(input: MessageEnvelope): Message {
    const msg = validateMessageEnvelope(input);
    const createdAt = new Date().toISOString();
    const result = this.db.query(`INSERT INTO msg_messages(sender, recipient, body, kind, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(msg.from, msg.to, msg.body, msg.kind ?? null, createdAt);
    return { id: Number(result.lastInsertRowid), ...msg, createdAt };
  }

  post(input: MessageEnvelope): Message { return this.append(input); }

  /** Messages strictly after the supplied cursor, ordered by durable insertion ID. */
  listByRecipient(recipient: string, after: number = 0, limit: number = 100): Message[] {
    const to = canonicalSeatId(recipient);
    if (to === 'ALL') throw new Error('ALL is a topic, not a recipient');
    validCursor(after);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be between 1 and 1000');
    return (this.db.query(`SELECT id, sender, recipient, body, kind, created_at FROM msg_messages
      WHERE id > ? AND (recipient = ? OR (recipient = 'ALL' AND sender <> ?))
      ORDER BY id ASC LIMIT ?`).all(after, to, to, limit) as MessageRow[]).map(fromRow);
  }

  list(recipient: string, after: number = 0, limit: number = 100): Message[] {
    return this.listByRecipient(recipient, after, limit);
  }

  getCursor(recipient: string): number {
    const to = canonicalSeatId(recipient);
    if (to === 'ALL') throw new Error('ALL is a topic, not a recipient');
    return (this.db.query('SELECT last_id FROM msg_cursors WHERE recipient = ?').get(to) as { last_id: number } | null)?.last_id ?? 0;
  }

  /** Atomically reject future IDs and keep concurrent or stale acknowledgements from rewinding. */
  advanceCursor(recipient: string, cursor: number): number {
    const to = canonicalSeatId(recipient);
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

  unreadCount(recipient: string): number {
    const to = canonicalSeatId(recipient);
    if (to === 'ALL') throw new Error('ALL is a topic, not a recipient');
    return unreadCountOn(this.db, to);
  }

  unreadRecipients(): UnreadRecipient[] {
    return this.db.query(`WITH recipients(recipient) AS (
        SELECT 'OP' UNION SELECT 'MK' UNION SELECT 'TC' UNION SELECT 'UX'
        UNION SELECT recipient FROM msg_messages WHERE recipient <> 'ALL'
        UNION SELECT recipient FROM msg_cursors WHERE recipient <> 'ALL'
      )
      SELECT r.recipient AS recipient, COUNT(m.id) AS count
      FROM recipients r
      LEFT JOIN msg_cursors c ON c.recipient = r.recipient
      JOIN msg_messages m ON m.id > COALESCE(c.last_id, 0)
        AND (m.recipient = r.recipient OR (m.recipient = 'ALL' AND m.sender <> r.recipient))
      GROUP BY r.recipient ORDER BY r.recipient ASC`).all() as UnreadRecipient[];
  }

  unread(): UnreadRecipient[] { return this.unreadRecipients(); }

  close(): void { this.db.close(); }
}

export function defaultMsgStorePath(): string { return join(elanousStateRoot(), 'msg', 'messages.db'); }
export function openMsgStore(path?: string): MsgStore { return new MsgStore(path); }

/** Observe one recipient without creating a store or advancing its acknowledgement. */
export function readUnreadCount(recipient: string, path: string = defaultMsgStorePath()): number | null {
  const to = canonicalSeatId(recipient);
  if (to === 'ALL') throw new Error('ALL is a topic, not a recipient');
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try { return unreadCountOn(db, to); }
  finally { db.close(); }
}
