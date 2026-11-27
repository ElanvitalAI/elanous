// The CEO channel — the one product door a representative (CEO) chat message enters through.
// OP-CHANNEL-INGRESS-1121 rows ①③④ (CEO-CHANNEL-FIRST-CLASS · CEO-MSG-ACK-SLA-FAILOVER, 0.3.32 P0, owner
// TC-H-CC-1). The personal polling script (seat-state/OP/tools/tg-op-bot.ts) retires: adapters feed THIS door.
//
//   ① ingress — an adapter hands one inbound message here: the allowlist (chat ids) decides from=CEO, the message
//      lands on the disk queue (SQLite, source+chatId+messageId unique → 중복 0 — telegram ids are
//      per-chat: two chats may share one id) and in the mail ledger as from=CEO
//      (OP 위장 0), then crosses the injection seam (row ② — HAND-ELN-ELS-API's bridge; a seam here so their
//      landing wires in without touching this module) into the OP session's turn.
//   ③ receipt — 👀 is the moment the OP session takes the message as its own turn input (markSeen), not the
//      filing. 30 s without 👀 → red (onStale). 5 min without an answer → the same thread gets
//      «⏰ OP 무응답 5분 · RES 대신 받음» and RES gets the same event (failover).
//   ④ reply — the OP answer goes back through sendReply into the SAME chat, threaded on the CEO message; a
//      failed send stays in the outbox and is retried (batched on the next success).
//
// Fail-soft everywhere: a refused ledger, a dead adapter or a throwing bridge never refuses a CEO message —
// it is logged (one line) and the queue keeps it.
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { appendAuditLine } from '../kit/audit-ledger/index.js';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import type { MessageEnvelope } from '../msg/msg-store.js';

/** Row ③ — 👀 SLA: a message the OP session has not picked up within this long goes red. */
export const CEO_SEEN_SLA_MS = 30_000;
/** Row ③ — answer SLA: no real answer within this long and RES takes the message. */
export const CEO_ANSWER_SLA_MS = 5 * 60_000;
/** Row ③ — the same-thread alert the failover sends. */
export const CEO_FAILover_TEXT = '⏰ OP 무응답 5분 · RES 대신 받음';
/** The OP crown tag — assembled from code points: the literal in source is a public-export leak (ceo-mark), cf. src/loops/consensus.ts. */
const TG_OP_CROWN = String.fromCodePoint(0x1F451);

/** One representative chat message, as the adapter parsed it from the wire. */
export interface CeoInbound {
  readonly source: 'telegram';
  /** The chat the message arrived in — the allowlist key, the dedupe key's chat half (ids repeat across chats) and the reply destination. */
  readonly chatId: string;
  /** The person who sent it (validated against the allowlist alongside the chat). */
  readonly senderId: string;
  /** The channel's own per-chat message id — with chatId the dedupe key; the thread anchor for the reply. */
  readonly messageId: string;
  readonly threadId?: string;
  readonly text: string;
  readonly at: number;
}

/** OP #119739 / JUD #119740 — the lookup key is chat-bound: telegram message ids repeat across chats. */
type CeoKey = Pick<CeoInbound, 'source' | 'chatId' | 'messageId'>;

/** The mail-ledger post seam (default: the in-process store — `MsgStore.post`). */
export type CeoLedgerPost = (envelope: MessageEnvelope) => unknown;

/** Row ② — the bridge into the OP session's turn. Absent → the message stays queued (redelivered when it lands). */
export type CeoInject = (inbound: CeoInbound) => void | Promise<void>;

/** Row ④ — the egress: send `text` into the CEO's chat, threaded on the message. false = send failed. */
export type CeoSendReply = (inbound: CeoInbound, text: string) => Promise<boolean>;

export interface CeoChannelOpts {
  /** Where the queue db and the audit line live. */
  readonly stateDir: string;
  /** Allowed chat ids (one binding until the tooling grows). */
  readonly allow: () => readonly string[];
  /** Allowed sender (user) ids — checked only when provided; a bound chat with any sender is from=CEO. */
  readonly senderAllow?: () => readonly string[];
  readonly now?: () => number;
  /** Timer seam, so tests bound the SLAs without real waits. */
  readonly arm?: (delayMs: number, fire: () => void) => { cancel: () => void };
  readonly post?: CeoLedgerPost;
  readonly inject?: CeoInject;
  readonly sendReply?: CeoSendReply;
  /** Row ③ — the red: 30 s without a pickup. */
  readonly onStale?: (inbound: CeoInbound) => void;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}

export interface CeoChannel {
  receive(inbound: CeoInbound): Promise<{ readonly status: 'accepted' | 'duplicate' | 'rejected' }>;
  /** 👀 — the OP session took the message as its own turn input. Cancels the red. */
  markSeen(key: CeoKey): boolean;
  /** Durable proof that this exact signed ingress frame received the OP tab's intake answer. */
  acceptIngress(key: CeoKey, ingressId: string, turn: { readonly sessionId: string; readonly turnRunId: string }): boolean;
  hasAcceptedIngress(key: CeoKey, ingressId: string, turn: { readonly sessionId: string; readonly turnRunId: string }): boolean;
  /** ✅ — the OP answer, replied into the same thread. Returns the send result. */
  markAnswered(key: CeoKey, replyText: string, grant: CeoAcceptedGrant): Promise<boolean>;
  /** Re-send every reply that failed to leave (row ④ batching). */
  retryOutbox(): Promise<number>;
  /** Re-inject every row still queued (a restart, or a bridge that was not up yet). */
  redeliver(): Promise<number>;
  counts(): { readonly waiting: number; readonly answered: number; readonly outbox: number };
  stop(): void;
}

export interface CeoAcceptedGrant { readonly ingressId: string; readonly sessionId: string; readonly turnRunId: string }

export const QUEUE_SCHEMA = `CREATE TABLE IF NOT EXISTS ceo_inbox (
  source TEXT NOT NULL, message_id TEXT NOT NULL, chat_id TEXT NOT NULL, sender_id TEXT NOT NULL,
  thread_id TEXT, text TEXT NOT NULL, at INTEGER NOT NULL,
  state TEXT NOT NULL, reply_text TEXT, seen_at INTEGER, answered_at INTEGER,
  PRIMARY KEY (source, chat_id, message_id))`;

const TEXT_BOUND = 3_800;
const WAITING_STATES = "('queued', 'injected', 'stale', 'seen')";

/** One queue row as `rowOf` reads it back — the SQLite column names (snake_case), not the wire field names. */
interface CeoRow {
  readonly source: string;
  readonly message_id: string;
  readonly chat_id: string;
  readonly sender_id: string;
  readonly thread_id: string | null;
  readonly text: string;
  readonly at: number;
  readonly state: string;
  readonly reply_text: string | null;
  readonly seen_at: number | null;
  readonly answered_at: number | null;
}

const rowOf = (db: Database, key: CeoKey) => db.query(
  'SELECT source, message_id, chat_id, sender_id, thread_id, text, at, state, reply_text, seen_at, answered_at FROM ceo_inbox WHERE source = ? AND chat_id = ? AND message_id = ?',
).get(key.source, key.chatId, key.messageId) as CeoRow | undefined;

const inboundOf = (row: CeoRow): CeoInbound => ({
  source: row.source as CeoInbound['source'], chatId: row.chat_id, senderId: row.sender_id, messageId: row.message_id,
  ...(row.thread_id ? { threadId: row.thread_id } : {}), text: row.text, at: row.at,
});

const defaultLog = (event: string, data: Record<string, unknown>): void => { debug.log('ceo-channel', event, data); };

/** Post one envelope through the real in-process ledger (fail-soft: a refused post is one logged line). */
function postThroughLedger(envelope: MessageEnvelope): unknown {
  const { openMsgStore } = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
  const store = openMsgStore();
  try { return store.post(envelope); } finally { store.close(); }
}

/** The mail-ledger envelope for one inbound CEO message — from=CEO, never OP (위장 0). */
export function ceoEnvelope(inbound: CeoInbound, to: string, kind: string, body: string): MessageEnvelope {
  return {
    from: 'CEO', to, kind, body,
    refs: [`telegram-message:${inbound.messageId}`, `telegram-chat:${inbound.chatId}`, `telegram-sender:${inbound.senderId}`],
  };
}

/** OP #119739 / JUD #119740 — the retired (source, message_id) primary key ate a second allowed
 *  chat's message with the same id; re-key in place (existing rows already carry chat_id).
 *  JUD #119836 / OP #119845 — the swap is ONE transaction: SQLite DDL is transactional, so a
 *  mid-run copy failure rolls the whole re-key back (the retired table keeps its rows; the next
 *  boot retries) instead of stranding the queue under the fresh empty key.
 *  FU-39405-CONCURRENT-START-SCHEMA — the schema is re-read INSIDE the lock, so a concurrent
 *  starter that finished the same re-key while we waited on BEGIN IMMEDIATE is skipped, never doubled. */
export function ensureChatBoundKey(db: Database, log: (event: string, data: Record<string, unknown>) => void): void {
  const readSchema = (): string =>
    (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ceo_inbox'").get() as { sql: string } | undefined)?.sql ?? '';
  const tableSql = readSchema();
  if (tableSql && !tableSql.includes('PRIMARY KEY (source, chat_id, message_id)')) {
    try {
      db.exec('BEGIN IMMEDIATE');
      // FU-39405-CONCURRENT-START-SCHEMA — re-read the schema INSIDE the write lock: a concurrent
      // starter that finished the same re-key while we waited for the lock is skipped here.
      if (readSchema().includes('PRIMARY KEY (source, chat_id, message_id)')) {
        db.exec('COMMIT');
        log('migrate-skip-lock-race', {});
        return;
      }
      db.exec('ALTER TABLE ceo_inbox RENAME TO ceo_inbox_retired_key');
      db.exec(QUEUE_SCHEMA);
      db.exec('INSERT OR IGNORE INTO ceo_inbox (source, message_id, chat_id, sender_id, thread_id, text, at, state, reply_text, seen_at, answered_at) SELECT source, message_id, chat_id, sender_id, thread_id, text, at, state, reply_text, seen_at, answered_at FROM ceo_inbox_retired_key');
      db.exec('DROP TABLE ceo_inbox_retired_key');
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* the transaction never opened */ }
      log('migrate-rolled-back', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export function createCeoChannel(opts: CeoChannelOpts): CeoChannel {
  const stateDir = opts.stateDir;
  mkdirSync(stateDir, { recursive: true });
  const db = new Database(join(stateDir, 'ceo-channel.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(QUEUE_SCHEMA);
  db.exec(`CREATE TABLE IF NOT EXISTS ceo_accepted_ingress (
    source TEXT NOT NULL, chat_id TEXT NOT NULL, message_id TEXT NOT NULL, ingress_id TEXT NOT NULL,
    session_id TEXT NOT NULL, turn_run_id TEXT NOT NULL,
    PRIMARY KEY (source, chat_id, message_id, ingress_id))`);
  // Old reply-pending rows have no grant and can never be retried into an external send.
  db.exec(`CREATE TABLE IF NOT EXISTS ceo_authorized_outbox (
    source TEXT NOT NULL, chat_id TEXT NOT NULL, message_id TEXT NOT NULL,
    ingress_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_run_id TEXT NOT NULL, reply_text TEXT NOT NULL,
    PRIMARY KEY (source, chat_id, message_id))`);
  const log = opts.log ?? defaultLog;
  ensureChatBoundKey(db, log);
  const now = opts.now ?? Date.now;
  const post = opts.post ?? postThroughLedger;
  const sendReply = opts.sendReply ?? (async () => false);
  const onStale = opts.onStale ?? ((inbound) => { log('stale', { ...keyOf(inbound) }); });
  const arm = opts.arm ?? ((delayMs: number, fire: () => void) => {
    const timer = setTimeout(fire, delayMs);
    (timer as { unref?: () => void }).unref?.();
    return { cancel: () => clearTimeout(timer) };
  });

  const keyOf = (inbound: CeoInbound | ReturnType<typeof inboundOf>): CeoKey => ({ source: inbound.source, chatId: inbound.chatId, messageId: inbound.messageId });
  const audit = (event: string, data: Record<string, unknown>): void => {
    try { appendAuditLine(join(stateDir, 'ceo-channel-audit.jsonl'), `${JSON.stringify({ at: now(), event, ...data })}\n`); }
    catch { /* the audit must not break the door */ }
    log(event, data);
  };

  const seenTimers = new Map<string, { cancel: () => void }>();
  const answerTimers = new Map<string, { cancel: () => void }>();
  const timerKey = (key: CeoKey): string => `${key.source}:${key.chatId}:${key.messageId}`;
  const cancelTimers = (key: CeoKey): void => {
    seenTimers.get(timerKey(key))?.cancel(); seenTimers.delete(timerKey(key));
    answerTimers.get(timerKey(key))?.cancel(); answerTimers.delete(timerKey(key));
  };

  const armTimers = (inbound: CeoInbound): void => {
    const key = timerKey(inbound);
    if (!seenTimers.has(key)) seenTimers.set(key, arm(CEO_SEEN_SLA_MS, () => {
      seenTimers.delete(key);
      const row = rowOf(db, inbound);
      if (!row || row.state === 'seen' || row.state === 'answered' || row.state === 'failed-over') return;
      db.query('UPDATE ceo_inbox SET state = ? WHERE source = ? AND chat_id = ? AND message_id = ?')
        .run('stale', inbound.source, inbound.chatId, inbound.messageId);
      audit('stale-red', { ...keyOf(inbound), chatId: inbound.chatId });
      try { onStale(inbound); } catch (error) { log('stale-callback-threw', { ...keyOf(inbound), error: error instanceof Error ? error.message : String(error) }); }
    }));
    if (!answerTimers.has(key)) answerTimers.set(key, arm(CEO_ANSWER_SLA_MS, () => {
      answerTimers.delete(key);
      const row = rowOf(db, inbound);
      if (!row || row.state === 'answered' || row.state === 'failed-over') return;
      db.query('UPDATE ceo_inbox SET state = ? WHERE source = ? AND chat_id = ? AND message_id = ?').run('failed-over', inbound.source, inbound.chatId, inbound.messageId);
      cancelTimers(inbound);
      audit('failover-res', { ...keyOf(inbound), chatId: inbound.chatId });
      // Row ③ — the same thread gets the alert, RES gets the same event; both best-effort.
      void sendReply(inbound, CEO_FAILover_TEXT).catch(() => false);
      try { post(ceoEnvelope(inbound, 'RES', 'alert', `${CEO_FAILover_TEXT}\n[TG-OP ${TG_OP_CROWN}] ${inbound.text.slice(0, TEXT_BOUND)}`)); }
      catch (error) { log('failover-post-threw', { ...keyOf(inbound), error: error instanceof Error ? error.message : String(error) }); }
    }));
  };

  const injectRow = async (inbound: CeoInbound): Promise<void> => {
    if (opts.inject) {
      try {
        await opts.inject(inbound);
        db.query("UPDATE ceo_inbox SET state = 'injected' WHERE source = ? AND chat_id = ? AND message_id = ?").run(inbound.source, inbound.chatId, inbound.messageId);
      } catch (error) {
        // Row ② — the bridge was not up (or refused): the row stays queued and redeliver() picks it up.
        log('inject-refused', { ...keyOf(inbound), error: error instanceof Error ? error.message : String(error) });
      }
    } else {
      log('inject-no-bridge', { ...keyOf(inbound), why: 'row ② bridge not wired yet — message queued, redeliver on boot' });
    }
  };

  const hasAcceptedIngress = (key: CeoKey, ingressId: string, turn: CeoAcceptedGrant): boolean => !!db.query(
    'SELECT 1 FROM ceo_accepted_ingress WHERE source = ? AND chat_id = ? AND message_id = ? AND ingress_id = ? AND session_id = ? AND turn_run_id = ?',
  ).get(key.source, key.chatId, key.messageId, ingressId, turn.sessionId, turn.turnRunId);

  return {
    receive: async (inbound) => {
      const allowed = opts.allow().map(String);
      const senderAllowed = opts.senderAllow?.().map(String) ?? null;
      if (!allowed.includes(String(inbound.chatId))
        || (senderAllowed !== null && !senderAllowed.includes(String(inbound.senderId)))) {
        audit('rejected-not-allowed', { source: inbound.source, messageId: inbound.messageId, chatId: inbound.chatId, senderId: inbound.senderId });
        return { status: 'rejected' };
      }
      const inserted = db.query(`INSERT OR IGNORE INTO ceo_inbox (source, message_id, chat_id, sender_id, thread_id, text, at, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')`).run(inbound.source, inbound.messageId, String(inbound.chatId), String(inbound.senderId),
        inbound.threadId ?? null, inbound.text.slice(0, TEXT_BOUND), inbound.at);
      if (inserted.changes === 0) { audit('duplicate-ignored', keyOf(inbound)); return { status: 'duplicate' }; }
      audit('queued', { ...keyOf(inbound), chatId: inbound.chatId });
      // ① — the mail ledger gets it as from=CEO (priority over the inbox filing; fail-soft).
      try { post(ceoEnvelope(inbound, 'OP', 'coord', `[TG-OP ${TG_OP_CROWN}] ${inbound.text.slice(0, TEXT_BOUND)}`)); }
      catch (error) { log('ledger-post-threw', { ...keyOf(inbound), error: error instanceof Error ? error.message : String(error) }); }
      await injectRow(inbound);
      armTimers(inbound);
      return { status: 'accepted' };
    },
    markSeen: (key) => {
      const row = rowOf(db, key);
      if (!row || row.state === 'seen' || row.state === 'reply-pending' || row.state === 'answered' || row.state === 'failed-over') return false;
      db.query('UPDATE ceo_inbox SET state = ?, seen_at = COALESCE(seen_at, ?) WHERE source = ? AND chat_id = ? AND message_id = ?')
        .run('seen', now(), key.source, key.chatId, key.messageId);
      seenTimers.get(timerKey(key))?.cancel(); seenTimers.delete(timerKey(key));
      audit('seen', key);
      return true;
    },
    acceptIngress: (key, ingressId, turn) => {
      if (!/^[0-9a-f]{64}$/.test(ingressId) || !turn.sessionId || !turn.turnRunId
        || turn.sessionId.length > 128 || turn.turnRunId.length > 128 || !rowOf(db, key)) return false;
      db.query('INSERT OR IGNORE INTO ceo_accepted_ingress (source, chat_id, message_id, ingress_id, session_id, turn_run_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(key.source, key.chatId, key.messageId, ingressId, turn.sessionId, turn.turnRunId);
      return true;
    },
    hasAcceptedIngress,
    markAnswered: async (key, replyText, grant) => {
      if (!grant || !hasAcceptedIngress(key, grant.ingressId, grant)) return false;
      const row = rowOf(db, key);
      if (!row || row.state === 'answered') return false;
      const boundedReply = replyText.slice(0, TEXT_BOUND);
      db.transaction(() => {
        db.query('INSERT OR REPLACE INTO ceo_authorized_outbox (source, chat_id, message_id, ingress_id, session_id, turn_run_id, reply_text) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(key.source, key.chatId, key.messageId, grant.ingressId, grant.sessionId, grant.turnRunId, boundedReply);
        db.query('UPDATE ceo_inbox SET state = ?, reply_text = ?, answered_at = ? WHERE source = ? AND chat_id = ? AND message_id = ?')
          .run('reply-pending', boundedReply, now(), key.source, key.chatId, key.messageId);
      })();
      cancelTimers(key);
      const inbound = inboundOf(row);
      const sent = await sendReply(inbound, boundedReply).catch(() => false);
      db.query('UPDATE ceo_inbox SET state = ? WHERE source = ? AND chat_id = ? AND message_id = ?')
        .run(sent ? 'answered' : 'reply-pending', key.source, key.chatId, key.messageId);
      audit(sent ? 'answered' : 'answer-send-failed', key);
      return sent;
    },
    retryOutbox: async () => {
      const rows = db.query(`SELECT i.source, i.message_id, i.chat_id, i.sender_id, i.thread_id, i.text, i.at, i.state,
        i.reply_text, i.seen_at, i.answered_at FROM ceo_inbox i
        JOIN ceo_authorized_outbox o ON o.source = i.source AND o.chat_id = i.chat_id AND o.message_id = i.message_id
          AND o.reply_text = i.reply_text
        JOIN ceo_accepted_ingress a ON a.source = o.source AND a.chat_id = o.chat_id AND a.message_id = o.message_id
          AND a.ingress_id = o.ingress_id AND a.session_id = o.session_id AND a.turn_run_id = o.turn_run_id
        WHERE i.state = 'reply-pending'`)
        .all() as Array<NonNullable<ReturnType<typeof rowOf>>>;
      let sent = 0;
      for (const row of rows) {
        const inbound = inboundOf(row);
        const ok = await sendReply(inbound, row.reply_text ?? '').catch(() => false);
        if (ok) {
          db.query("UPDATE ceo_inbox SET state = 'answered' WHERE source = ? AND chat_id = ? AND message_id = ?").run(inbound.source, inbound.chatId, inbound.messageId);
          sent += 1;
        }
      }
      if (rows.length > 0) audit('outbox-retried', { tried: rows.length, sent });
      return sent;
    },
    redeliver: async () => {
      // An attempted socket send can fail after the row became injected. A daemon restart also
      // loses the in-memory sink status. Both states must be offered again until a real intake.
      const rows = db.query(`SELECT source, message_id, chat_id, sender_id, thread_id, text, at, state, reply_text, seen_at, answered_at FROM ceo_inbox WHERE state IN ('queued', 'injected', 'stale')`)
        .all() as Array<NonNullable<ReturnType<typeof rowOf>>>;
      let delivered = 0;
      for (const row of rows) {
        const inbound = inboundOf(row);
        await injectRow(inbound);
        const after = rowOf(db, inbound);
        if (after?.state === 'injected') { armTimers(inbound); delivered += 1; }
      }
      if (rows.length > 0) audit('redelivered', { queued: rows.length, delivered });
      return delivered;
    },
    counts: () => ({
      waiting: (db.query(`SELECT COUNT(*) AS count FROM ceo_inbox WHERE state IN ${WAITING_STATES}`).get() as { count: number }).count,
      answered: (db.query("SELECT COUNT(*) AS count FROM ceo_inbox WHERE state = 'answered'").get() as { count: number }).count,
      outbox: (db.query("SELECT COUNT(*) AS count FROM ceo_inbox WHERE state = 'reply-pending'").get() as { count: number }).count,
    }),
    stop: () => {
      for (const timer of seenTimers.values()) timer.cancel();
      for (const timer of answerTimers.values()) timer.cancel();
      seenTimers.clear(); answerTimers.clear();
      db.close();
    },
  };
}
