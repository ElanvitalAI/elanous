import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { handleScraps, type ScrapsRouteOptions } from './nexus/api/scraps.js';
import { canonicalUrl } from './intake-plane/core.js';

export interface TelegramMemberIdentity { botId: string; userId: number; chatId: number }

/** Fail closed against the operational MemberStore after deletion or session revocation. */
export function activeTelegramMember(root: string, memberId: string, now = new Date()): boolean {
  const path = join(root, 'members', 'members.sqlite');
  if (!existsSync(path)) return false;
  let db: Database;
  try { db = new Database(path, { readonly: true }); } catch { return false; }
  try {
    return Boolean(db.query(`SELECT 1 FROM members m WHERE m.id = ?
      AND NOT EXISTS (SELECT 1 FROM member_deletion_requests d WHERE d.member_id = m.id AND d.status <> 'cancelled')
      AND EXISTS (SELECT 1 FROM member_sessions s WHERE s.member_id = m.id
        AND s.revoked_at IS NULL AND s.expires_at > ?)`).get(memberId, now.toISOString()));
  } catch { return false; }
  finally { db.close(); }
}

const codeHash = (code: string) => createHash('sha256').update(code).digest('hex');
const bindingKey = (identity: TelegramMemberIdentity) => [identity.botId, identity.userId, identity.chatId] as const;

function open(root: string): Database {
  const dir = join(root, 'intake');
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, 'telegram-member.sqlite'), { create: true });
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS enrollment (
    code_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, expires_at INTEGER NOT NULL
  ); CREATE TABLE IF NOT EXISTS binding (
    bot_id TEXT NOT NULL, user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
    member_id TEXT NOT NULL, PRIMARY KEY(bot_id, user_id, chat_id)
  ); CREATE TABLE IF NOT EXISTS delivery (
    receipt_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, user_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL, member_id TEXT NOT NULL, scrap_id TEXT NOT NULL, text TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'sent'))
  ); CREATE TABLE IF NOT EXISTS receipt (
    receipt_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, user_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL, member_id TEXT NOT NULL, scrap_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'sent'))
  )`);
  const deliveryColumns = db.query('PRAGMA table_info(delivery)').all() as { name: string }[];
  if (!deliveryColumns.some((column) => column.name === 'member_id')) db.exec('ALTER TABLE delivery ADD COLUMN member_id TEXT');
  return db;
}

/** Called only after Nexus has authenticated the member session. The code is returned once; only its hash is stored. */
export function issueTelegramMemberCode(root: string, memberId: string, now = Date.now()): string {
  const code = randomBytes(16).toString('hex');
  const db = open(root);
  try {
    db.query('DELETE FROM enrollment WHERE expires_at <= ?').run(now);
    db.query('INSERT INTO enrollment (code_hash, member_id, expires_at) VALUES (?, ?, ?)')
      .run(codeHash(code), memberId, now + 10 * 60_000);
  } finally { db.close(); }
  return code;
}

/** A real Telegram DM supplies the identity; the user-supplied code supplies no member ID. */
export function consumeTelegramMemberCode(root: string, identity: TelegramMemberIdentity, code: string, now = Date.now()): boolean {
  if (!/^[0-9a-f]{32}$/.test(code) || !identity.botId || !Number.isSafeInteger(identity.userId)
    || !Number.isSafeInteger(identity.chatId) || identity.userId !== identity.chatId) return false;
  const db = open(root);
  try {
    return db.transaction(() => {
      const found = db.query('SELECT member_id, expires_at FROM enrollment WHERE code_hash = ?').get(codeHash(code)) as { member_id: string; expires_at: number } | null;
      if (!found || found.expires_at <= now) return false;
      if (db.query('DELETE FROM enrollment WHERE code_hash = ?').run(codeHash(code)).changes !== 1) return false;
      db.query('DELETE FROM delivery WHERE bot_id = ? AND user_id = ? AND chat_id = ? AND member_id <> ?')
        .run(...bindingKey(identity), found.member_id);
      db.query('DELETE FROM receipt WHERE bot_id = ? AND user_id = ? AND chat_id = ? AND member_id <> ?')
        .run(...bindingKey(identity), found.member_id);
      db.query(`INSERT INTO binding (bot_id, user_id, chat_id, member_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(bot_id, user_id, chat_id) DO UPDATE SET member_id = excluded.member_id`)
        .run(...bindingKey(identity), found.member_id);
      return true;
    })();
  } finally { db.close(); }
}

export function verifiedTelegramMember(root: string, identity: TelegramMemberIdentity): string | null {
  if (!identity.botId || identity.userId !== identity.chatId) return null;
  const db = open(root);
  try {
    return (db.query('SELECT member_id FROM binding WHERE bot_id = ? AND user_id = ? AND chat_id = ?')
      .get(...bindingKey(identity)) as { member_id: string } | null)?.member_id ?? null;
  } finally { db.close(); }
}

/** Public member ID for a currently authenticated Telegram binding. Never return the internal ID or a connection code. */
export function telegramMemberPublicHandle(root: string, identity: TelegramMemberIdentity): string | null {
  const memberId = verifiedTelegramMember(root, identity);
  if (!memberId || !activeTelegramMember(root, memberId)) return null;
  const path = join(root, 'members', 'members.sqlite');
  let db: Database;
  try { db = new Database(path, { readonly: true }); } catch { return null; }
  try {
    const row = db.query('SELECT handle FROM member_handles WHERE member_id = ?').get(memberId) as { handle: string } | null;
    return row && /^[a-z][a-z0-9_]{2,29}$/.test(row.handle) ? row.handle : null;
  } catch { return null; } // Older installs have no member_handles table yet.
  finally { db.close(); }
}

/** The receipt row is committed before Bot API send; sent is recorded immediately after confirmation. */
export function telegramReceiptStatus(root: string, identity: TelegramMemberIdentity, receiptId: string, scrapId: string): 'pending' | 'sent' {
  const memberId = verifiedTelegramMember(root, identity);
  if (!memberId) throw new Error('telegram member binding unavailable');
  const db = open(root);
  try {
    db.query(`INSERT OR IGNORE INTO receipt (receipt_id, bot_id, user_id, chat_id, member_id, scrap_id, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')`).run(receiptId, ...bindingKey(identity), memberId, scrapId);
    const row = db.query('SELECT member_id, status FROM receipt WHERE receipt_id = ?').get(receiptId) as { member_id: string; status: 'pending' | 'sent' };
    if (row.member_id !== memberId) throw new Error('telegram receipt member mismatch');
    return row.status;
  } finally { db.close(); }
}

export function markTelegramReceiptSent(root: string, identity: TelegramMemberIdentity, receiptId: string): void {
  const memberId = verifiedTelegramMember(root, identity);
  if (!memberId) return;
  const db = open(root);
  try {
    db.query("UPDATE receipt SET status = 'sent' WHERE receipt_id = ? AND member_id = ? AND bot_id = ? AND user_id = ? AND chat_id = ?")
      .run(receiptId, memberId, ...bindingKey(identity));
  } finally { db.close(); }
}

/** Pending DM outbox identities for this bot. A relinked member's old rows are excluded. */
export function pendingTelegramMemberChats(root: string, botId: string): TelegramMemberIdentity[] {
  const db = open(root);
  try {
    return db.query(`SELECT DISTINCT r.bot_id AS botId, r.user_id AS userId, r.chat_id AS chatId
      FROM receipt r JOIN binding b ON b.bot_id = r.bot_id AND b.user_id = r.user_id
        AND b.chat_id = r.chat_id AND b.member_id = r.member_id
      WHERE r.bot_id = ? AND r.user_id = r.chat_id AND r.status = 'pending'
      UNION
      SELECT DISTINCT d.bot_id AS botId, d.user_id AS userId, d.chat_id AS chatId
      FROM delivery d JOIN binding b ON b.bot_id = d.bot_id AND b.user_id = d.user_id
        AND b.chat_id = d.chat_id AND b.member_id = d.member_id
      WHERE d.bot_id = ? AND d.user_id = d.chat_id AND d.status = 'pending'
      ORDER BY userId, chatId`)
      .all(botId, botId) as TelegramMemberIdentity[];
  } finally { db.close(); }
}

export function pendingTelegramReceipts(root: string, identity: TelegramMemberIdentity): string[] {
  const memberId = verifiedTelegramMember(root, identity);
  if (!memberId) return [];
  const db = open(root);
  try {
    return (db.query(`SELECT receipt_id AS receiptId FROM receipt
      WHERE bot_id = ? AND user_id = ? AND chat_id = ? AND member_id = ? AND status = 'pending'
      ORDER BY rowid`).all(...bindingKey(identity), memberId) as { receiptId: string }[])
      .map((row) => row.receiptId);
  } finally { db.close(); }
}

export type TelegramScrapResult =
  | { status: 'absorbed'; memberId: string; receiptId: string; scrapId: string; cardText: string }
  | { status: 'failed'; reason: string };

/** Calls the same member scrap handler as /v1/scraps, with the owner resolved from a verified server-side binding. */
export async function saveTelegramMemberScrap(input: {
  options: Pick<ScrapsRouteOptions, 'instanceRoot' | 'extractors' | 'byokCard' | 'now'> & { memberActive?: (memberId: string) => boolean };
  identity: TelegramMemberIdentity; messageId: number; url: string;
  onAccepted?: (receiptId: string, scrapId: string) => Promise<void>;
}): Promise<TelegramScrapResult> {
  const memberId = verifiedTelegramMember(input.options.instanceRoot, input.identity);
  if (!memberId) return { status: 'failed', reason: 'connection-required' };
  const isActive = input.options.memberActive ?? ((id: string) => activeTelegramMember(input.options.instanceRoot, id));
  if (!isActive(memberId)) return { status: 'failed', reason: 'member-inactive' };
  const normalized = canonicalUrl(input.url);
  if (!normalized) return { status: 'failed', reason: 'invalid-url' };
  const key = `tg-${codeHash(`${input.identity.botId}:${input.identity.userId}:${input.identity.chatId}:${input.messageId}:${normalized}`).slice(0, 48)}`;
  const options: ScrapsRouteOptions = { ...input.options, resolveOwner: async () => ({ memberId }),
    onAccepted: input.onAccepted ? async (_owner, scrapId) => {
      if (verifiedTelegramMember(input.options.instanceRoot, input.identity) !== memberId) throw new Error('telegram member binding changed');
      await input.onAccepted!(key, scrapId);
    } : undefined };
  const post = await handleScraps(new Request('http://nexus.local/v1/scraps', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ kind: 'web', source: 'telegram', raw: { url: normalized } }),
  }), options);
  if (post.status !== 201 && post.status !== 200) return { status: 'failed', reason: `scrap-post-${post.status}` };
  const created = await post.json() as { id?: string; status?: string };
  if (typeof created.id !== 'string') return { status: 'failed', reason: 'scrap-id-missing' };
  const get = await handleScraps(new Request('http://nexus.local/v1/scraps'), options);
  if (get.status !== 200) return { status: 'failed', reason: `scrap-get-${get.status}` };
  const read = await get.json() as { scraps?: Array<{ id: string; memberId?: string; raw?: { url?: string }; status?: string; card?: { title?: string; points?: string[] } }> };
  const scrap = read.scraps?.find((item) => item.id === created.id && item.memberId === memberId && item.raw?.url === normalized);
  if (!scrap || scrap.status !== 'absorbed' || !scrap.card?.points?.[0]) return { status: 'failed', reason: 'scrap-readback-incomplete' };
  if (!isActive(memberId)) return { status: 'failed', reason: 'member-inactive' };
  if (verifiedTelegramMember(input.options.instanceRoot, input.identity) !== memberId) return { status: 'failed', reason: 'connection-changed' };
  const cardText = `${scrap.card.title ?? '링크 요약'}\n${scrap.card.points.join('\n')}\n저장 ID: ${scrap.id}`;
  return { status: 'absorbed', memberId, receiptId: key, scrapId: scrap.id, cardText };
}

export function recordTelegramCompletion(root: string, identity: TelegramMemberIdentity, result: Extract<TelegramScrapResult, { status: 'absorbed' }>): void {
  const memberId = verifiedTelegramMember(root, identity);
  if (!memberId || memberId !== result.memberId) throw new Error('telegram member binding changed');
  const db = open(root);
  try {
    db.query(`INSERT OR IGNORE INTO delivery (receipt_id, bot_id, user_id, chat_id, member_id, scrap_id, text, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`).run(result.receiptId, ...bindingKey(identity), memberId, result.scrapId, result.cardText);
  } finally { db.close(); }
}

export function pendingTelegramCompletion(root: string, identity: TelegramMemberIdentity): { receiptId: string; text: string }[] {
  const memberId = verifiedTelegramMember(root, identity);
  if (!memberId) return [];
  const db = open(root);
  try {
    return db.query(`SELECT d.receipt_id AS receiptId, d.text FROM delivery d
      JOIN receipt r ON r.receipt_id = d.receipt_id AND r.member_id = d.member_id
      WHERE d.bot_id = ? AND d.user_id = ? AND d.chat_id = ? AND d.member_id = ?
        AND d.status = 'pending' AND r.status = 'sent' ORDER BY d.rowid`)
      .all(...bindingKey(identity), memberId) as { receiptId: string; text: string }[];
  } finally { db.close(); }
}

export interface TelegramPendingCard {
  kind: 'receipt' | 'completion';
  receiptId: string;
  text: string;
}

/** Receipts before their completion cards, only for the currently bound member. */
export function pendingTelegramMemberCards(root: string, identity: TelegramMemberIdentity): TelegramPendingCard[] {
  const memberId = verifiedTelegramMember(root, identity);
  if (!memberId || identity.userId !== identity.chatId) return [];
  const receipts = pendingTelegramReceipts(root, identity).map((receiptId): TelegramPendingCard => ({
    kind: 'receipt', receiptId, text: `접수했습니다. 접수 ID: ${receiptId}`,
  }));
  const completions = pendingTelegramCompletion(root, identity).map((pending): TelegramPendingCard => ({
    kind: 'completion', receiptId: pending.receiptId, text: pending.text,
  }));
  return [...receipts, ...completions];
}

export interface TelegramCardTransport {
  send(identity: TelegramMemberIdentity, text: string): Promise<boolean>;
}

/** Safety cap for one synchronous batch. A full batch yields, then continues. */
const RETRY_BATCH_CAP = 64;
/** Hard ceiling so a drain that keeps failing cannot spin forever. */
const RETRY_DRAIN_CAP = 4096;

const chatKey = (identity: TelegramMemberIdentity) => `${identity.botId}:${identity.userId}:${identity.chatId}`;

/**
 * Restart drain. Each batch is bounded and yields before the next one, so
 * pending cards past the batch cap are not left until another process start.
 * A failed or forbidden chat stays pending for a future restart, but is
 * excluded from every later batch of this drain so it cannot starve a healthy
 * chat. Confirmed cards are marked once. Receipts stay ahead of completions.
 */
export async function retryPendingTelegramMemberCards(input: {
  root: string;
  botId: string;
  transport: TelegramCardTransport;
  memberActive?: (memberId: string) => boolean;
  limit?: number;
  yieldBetweenBatches?: () => Promise<void>;
}): Promise<{ attempted: number; confirmed: number }> {
  const isActive = input.memberActive ?? ((memberId: string) => activeTelegramMember(input.root, memberId));
  const batchCap = input.limit ?? RETRY_BATCH_CAP;
  const yieldBetweenBatches = input.yieldBetweenBatches ?? (() => Promise.resolve());
  let attempted = 0;
  let confirmed = 0;
  const seen = new Set<string>();
  const excludedChats = new Set<string>();
  let batches = 0;
  while (attempted < RETRY_DRAIN_CAP && batches < RETRY_DRAIN_CAP) {
    if (batches > 0) await yieldBetweenBatches();
    batches++;
    const chats = pendingTelegramMemberChats(input.root, input.botId)
      .filter((identity) => !excludedChats.has(chatKey(identity)));
    let batchAttempted = 0;
    let progressed = false;
    for (const identity of chats) {
      if (batchAttempted >= batchCap || attempted >= RETRY_DRAIN_CAP) break;
      if (identity.userId !== identity.chatId) continue;
      const memberId = verifiedTelegramMember(input.root, identity);
      if (!memberId || !isActive(memberId)) continue;
      let cards = pendingTelegramMemberCards(input.root, identity);
      let chatFailed = false;
      for (let cardIndex = 0; cardIndex < cards.length; cardIndex++) {
        if (chatFailed || batchAttempted >= batchCap || attempted >= RETRY_DRAIN_CAP) break;
        const card = cards[cardIndex]!;
        const key = `${chatKey(identity)}:${card.kind}:${card.receiptId}`;
        if (seen.has(key)) continue;
        if (verifiedTelegramMember(input.root, identity) !== memberId || !isActive(memberId)) break;
        seen.add(key);
        attempted++;
        batchAttempted++;
        let sent = false;
        try { sent = await input.transport.send(identity, card.text); } catch { sent = false; }
        if (!sent || verifiedTelegramMember(input.root, identity) !== memberId) {
          chatFailed = true;
          excludedChats.add(chatKey(identity));
          break;
        }
        if (card.kind === 'receipt') markTelegramReceiptSent(input.root, identity, card.receiptId);
        else markTelegramCompletionSent(input.root, identity, card.receiptId);
        confirmed++;
        progressed = true;
        if (card.kind === 'receipt') {
          const refreshed = pendingTelegramMemberCards(input.root, identity)
            .filter((next) => !seen.has(`${chatKey(identity)}:${next.kind}:${next.receiptId}`));
          cards = cards.slice(0, cardIndex + 1).concat(refreshed);
        }
      }
    }
    // A full batch of failures still continues: those chats are now excluded,
    // so the next batch can reach a healthy chat that the cap had hidden.
    if (batchAttempted < batchCap) break;
  }
  return { attempted, confirmed };
}

export function markTelegramCompletionSent(root: string, identity: TelegramMemberIdentity, receiptId: string): void {
  const memberId = verifiedTelegramMember(root, identity);
  if (!memberId) return;
  const db = open(root);
  try { db.query("UPDATE delivery SET status = 'sent' WHERE receipt_id = ? AND member_id = ? AND status = 'pending'").run(receiptId, memberId); }
  finally { db.close(); }
}
