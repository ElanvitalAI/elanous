// The mail side of the CEO reply (OP-CHANNEL-INGRESS-1121 row ④): 👀 comes only from the
// authenticated ingress socket's actual intake answer. A mail ack or sender string has no authority.
// The OP seat's signed reply in the same thread (msg replyTo = the CEO message id) is checked here. This watcher reads the
// mail ledger read-only, correlates rows back to channel queue rows via the refs the channel stamps
// (telegram-message:<id> + telegram-chat:<id> — the chat half: telegram ids repeat across chats), and
// drives markAnswered after the signature and accepted-ingress record agree.
//
// Fail-soft: a missing ledger, a locked db or a missing correlation is one logged line; nothing throws
// out of a scan, and a scan never writes the mail ledger.
import { existsSync } from 'node:fs';
import { debug } from '../debug/log.js';
import type { CeoChannel } from './ceo-channel.js';
import type { CeoReplyBinding } from './ceo-reply-proof.js';

/** The mail ledger the els state owns (read-only here). */
export interface CeoMailDb {
  /** Every CEO → OP mail row newer than `afterId` (ascending): id, refs_json, created_at. */
  ceoRows(afterId: number): Array<{ readonly id: number; readonly refsJson: string | null; readonly createdAt: string }>;
  /** One later candidate. The sender text alone grants no outbound authority. */
  firstReplyAfter(messageId: number, seat: string, afterId: number): CeoMailReply | null;
  close?(): void;
}

export interface CeoMailReply { readonly id: number; readonly sender: string; readonly body: string; readonly refsJson: string | null }

export interface CeoMailWatchOpts {
  readonly channel: CeoChannel;
  readonly mail: CeoMailDb;
  /** The seat whose ack/reply counts (the OP tab). */
  readonly seat?: string;
  /** Only an ingress-bound, authenticated OP turn reply may authorize external send. Default deny. */
  readonly verifyReply?: (parent: { readonly id: number }, key: Parameters<CeoChannel['markAnswered']>[0], reply: CeoMailReply) => CeoReplyBinding | 'pending' | null;
  /** Bounded scan progress across forged candidates; the daemon keeps this map between polls. */
  readonly replyCursor?: Map<number, number>;
  readonly pendingReplySince?: Map<number, number>;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}

const defaultLog = (event: string, data: Record<string, unknown>): void => { debug.log('ceo-mail-watch', event, data); };

/** The telegram-message ref → the channel key's messageId. */
export const ceoMessageRef = (messageId: string): string => `telegram-message:${messageId}`;
/** OP #119739 / JUD #119740 — the telegram-chat ref → the channel key's chatId (ids repeat across chats). */
export const ceoChatRef = (chatId: string): string => `telegram-chat:${chatId}`;
export const messageIdFromRefs = (refsJson: string | null): string | null => {
  if (!refsJson) return null;
  try {
    const refs = JSON.parse(refsJson) as unknown;
    if (!Array.isArray(refs)) return null;
    for (const ref of refs) {
      if (typeof ref === 'string' && ref.startsWith('telegram-message:')) return ref.slice('telegram-message:'.length);
    }
  } catch { /* a foreign row's refs are not ours to judge */ }
  return null;
};
export const chatIdFromRefs = (refsJson: string | null): string | null => {
  if (!refsJson) return null;
  try {
    const refs = JSON.parse(refsJson) as unknown;
    if (!Array.isArray(refs)) return null;
    for (const ref of refs) {
      if (typeof ref === 'string' && ref.startsWith('telegram-chat:')) return ref.slice('telegram-chat:'.length);
    }
  } catch { /* a foreign row's refs are not ours to judge */ }
  return null;
};

/** One scan: every CEO → OP mail row past the cursor → ✅ only on an authenticated turn reply. Returns the
 * action count alongside the advanced cursor (the daemon carries the cursor between scans). */
export async function scanCeoMail(opts: CeoMailWatchOpts & { cursor: number }): Promise<{ acted: number; cursor: number }> {
  const channel = opts.channel;
  const mail = opts.mail;
  const seat = opts.seat ?? 'OP';
  const log = opts.log ?? defaultLog;
  let cursor = opts.cursor;
  let acted = 0;
  for (const row of mail.ceoRows(cursor)) {
    if (row.id > cursor) cursor = row.id;
    const messageId = messageIdFromRefs(row.refsJson);
    if (!messageId) continue;
    // OP #119739 / JUD #119740 — the key is chat-bound; a row without a chat ref cannot correlate
    // (an old or foreign stamp): one logged line, nothing acted, the channel timers stay armed.
    const chatId = chatIdFromRefs(row.refsJson);
    if (!chatId) { log('no-chat-ref', { mailId: row.id, messageId }); continue; }
    const key = { source: 'telegram' as const, chatId, messageId };
    let after = opts.replyCursor?.get(row.id) ?? 0;
    // A forged first reply cannot hide a later legitimate one. Cap each poll and resume next time.
    for (let examined = 0; examined < 256; examined += 1) {
      const reply = mail.firstReplyAfter(row.id, seat, after);
      if (!reply) break;
      const verdict = opts.verifyReply?.(row, key, reply) ?? null;
      if (verdict === 'pending') {
        // The TUI can finish before the intake answer reaches ELS. Retry briefly; a
        // forged proof for a never accepted frame cannot block later real replies forever.
        const since = opts.pendingReplySince?.get(reply.id) ?? Date.now();
        opts.pendingReplySince?.set(reply.id, since);
        if (Date.now() - since < 2_000) break;
      }
      opts.pendingReplySince?.delete(reply.id);
      after = reply.id;
      opts.replyCursor?.set(row.id, after);
      if (!verdict || verdict === 'pending') {
        log('untrusted-reply-ignored', { mailId: row.id, replyId: reply.id });
        continue;
      }
      const sent = await channel.markAnswered(key, reply.body, verdict);
      log(sent ? 'answered' : 'answer-pending-send', { messageId, chatId, mailId: row.id, replyId: reply.id });
      acted += 1;
      break;
    }
  }
  return { acted, cursor };
}

/** bun:sqlite read-only projection of the mail ledger (the real db the els state owns). */
export function openCeoMailDb(path: string): CeoMailDb | null {
  if (!existsSync(path)) return null;
  const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
  let db: InstanceType<typeof Database>;
  try { db = new Database(path, { readonly: true }); } catch { return null; }
  db.exec('PRAGMA busy_timeout = 5000');
  const canonical = (value: string): string => value.trim().toUpperCase();
  const ceoRows = (afterId: number) => (db.query(
    "SELECT id, refs_json AS refsJson, created_at AS createdAt FROM msg_messages WHERE sender = 'CEO' AND recipient = ? AND id > ? ORDER BY id ASC",
  ).all('OP', afterId) as Array<{ id: number; refsJson: string | null; createdAt: string }>);
  return {
    ceoRows,
    firstReplyAfter: (messageId, seat, afterId) => (db.query(
      'SELECT id, sender, body, refs_json AS refsJson FROM msg_messages WHERE reply_to = ? AND UPPER(TRIM(sender)) = ? AND id > ? ORDER BY id ASC LIMIT 1',
    ).get(messageId, canonical(seat), afterId) as CeoMailReply | undefined) ?? null,
    close: () => db.close(),
  };
}
