// ── eln 자리 우편 60초 안전망 (OP 11-17 21:5x · ELN-SEAT-SAY 4) ──
//
// runtime=eln ⊕ autowake 자리는 herdr 타이핑 대신 자기 우편 감시(#38164)로 받는다(`wakeRecipient` → `eln-mail-watch`).
// 그 감시가 죽었거나 막혔을 때만, 우편 뒤 60초 안에 «받음» 구조 신호(seen 이상 영수증 · 완료)가 없으면
// herdr 로 «우편 확인» 한 줄을 한 번 친다(본문·보낸이 0). 한 번 = 원장 표 `msg_mail_fallbacks` 의 (message, recipient) 키.
// 실행은 post 한 프로세스가 띄운 detached 일회성 `eln msg mail-fallback` — 상주 프로세스 0 · 폴링 0(잠 한 번).
import type { Database } from 'bun:sqlite';
import { debug } from '../debug/log.js';
import { canonicalMessageAddress, type MsgStore } from './msg-store.js';

export const MAIL_FALLBACK_MS = 60_000;

export const MSG_MAIL_FALLBACKS_SCHEMA = `CREATE TABLE IF NOT EXISTS msg_mail_fallbacks (
      message_id INTEGER NOT NULL,
      recipient TEXT NOT NULL,
      at TEXT NOT NULL,
      PRIMARY KEY (message_id, recipient)
    )`;

/** Evaluate the recipient's complete receipt history, not the paginated receipt feed. */
function mailDisposition(store: MsgStore, messageId: number, recipient: string): 'received' | 'expired' | 'pending' {
  const status = store.messageStatus(recipient, messageId);
  // A cursor-only ack cannot suppress a fallback for mail already handed to a
  // turn. An ack without a delivered receipt keeps the older suppression rule.
  if (status === null || status === 'done') return 'received';
  const address = canonicalMessageAddress(recipient);
  if (!store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'msg_receipts'").get())
    return status === 'acked' ? 'received' : 'pending';
  const rows = store.db.query(`SELECT state FROM msg_receipts WHERE message_id = ? AND recipient = ?
    AND state IN ('delivered', 'seen', 'accepted', 'rejected', 'done', 'expired')`).all(messageId, address) as { state: string }[];
  if (status === 'acked' && !rows.some(r => r.state === 'delivered')) return 'received';
  if (rows.some(r => r.state !== 'expired' && r.state !== 'delivered')) return 'received';
  return rows.some(r => r.state === 'expired') ? 'expired' : 'pending';
}

/** Structural «received»: seen or later, or explicit done; cursor-only ack is not processing. Unknown message = received (nothing to knock for). */
export function mailReceived(store: MsgStore, messageId: number, recipient: string): boolean {
  return mailDisposition(store, messageId, recipient) === 'received';
}

/** Claim the one fallback for (message, recipient). False when it was already claimed. */
export function claimMailFallback(db: Database, messageId: number, recipient: string, at: Date): boolean {
  const address = canonicalMessageAddress(recipient);
  return db.transaction(() => {
    db.exec(MSG_MAIL_FALLBACKS_SCHEMA);
    // Older versions stored raw recipient spellings. Honor their claims without rewriting history.
    const previous = db.query('SELECT recipient FROM msg_mail_fallbacks WHERE message_id = ?').all(messageId) as { recipient: string }[];
    for (const row of previous) {
      try { if (canonicalMessageAddress(row.recipient) === address) return false; }
      catch { /* Ignore malformed historical addresses. */ }
    }
    return db.query('INSERT OR IGNORE INTO msg_mail_fallbacks(message_id, recipient, at) VALUES (?, ?, ?)').run(messageId, address, at.toISOString()).changes === 1;
  }).immediate();
}

export type MailFallbackResult = 'received' | 'expired' | 'already-knocked' | 'knocked' | 'knock-failed';

export interface MailFallbackDeps {
  openStore: () => MsgStore;
  wake: (address: string, msgId: number, message: { from: string; fallback: true }) => Promise<{ result: string; reason?: string; wake?: string; target?: string }>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  waitMs?: number;
}

export async function runMailFallback(input: { messageId: number; recipient: string; from: string }, deps: MailFallbackDeps): Promise<MailFallbackResult> {
  await (deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(deps.waitMs ?? MAIL_FALLBACK_MS);
  const log = (event: string, data: Record<string, unknown>) => { try { debug.log('msg.fallback', event, { msgId: input.messageId, to: input.recipient, ...data }); } catch { /* fail-open */ } };
  const store = deps.openStore();
  let decision: 'received' | 'expired' | 'already-knocked' | 'claimed';
  try {
    // Serialize receipt/ack writers with the disposition and one-shot claim. A receipt may still
    // arrive after commit and before wake: the external wake itself is not transactional.
    decision = store.db.transaction(() => {
      const disposition = mailDisposition(store, input.messageId, input.recipient);
      if (disposition !== 'pending') return disposition;
      return claimMailFallback(store.db, input.messageId, input.recipient, (deps.now ?? (() => new Date()))()) ? 'claimed' : 'already-knocked';
    }).immediate();
  } finally { store.close(); }
  if (decision !== 'claimed') { log(decision, {}); return decision; }
  try {
    const outcome = await deps.wake(input.recipient, input.messageId, { from: input.from, fallback: true });
    if (outcome.result === 'injected' && outcome.wake === 'els') {
      try {
        const receipts = deps.openStore();
        try { receipts.recordReceipt({ messageId: input.messageId, recipient: input.recipient, state: 'delivered', source: 'cli', evidence: outcome.target ?? 'els:unknown' }); }
        finally { receipts.close(); }
      } catch (error) { log('receipt-failed', { error: error instanceof Error ? error.message : String(error) }); }
    }
    log(outcome.result === 'injected' ? 'knocked' : 'knock-failed', { result: outcome.result, reason: outcome.reason ?? null });
    return outcome.result === 'injected' ? 'knocked' : 'knock-failed';
  } catch (error) {
    log('knock-failed', { error: error instanceof Error ? error.message : String(error) });
    return 'knock-failed';
  }
}

/** Start the one-shot detached checker with the running CLI entry (the post returns at once). */
/** The checker's argv: the running interpreter ⊕ the running CLI entry ⊕ `msg mail-fallback …` (pure — the test pins it). */
export function mailFallbackSpawnArgv(input: { messageId: number; recipient: string; from: string }, runtime: { execPath: string; entry: string }): string[] {
  return [runtime.execPath, runtime.entry, 'msg', 'mail-fallback', '--msg', String(input.messageId), '--to', input.recipient, '--from', input.from];
}

/**
 * Start the one-shot detached checker with the running CLI entry (the post returns at once). Returns whether it started.
 * #38285 REVIEW ①: without a CLI entry (`process.argv[1]`) the safety net cannot start — that is logged, never silent.
 */
export function spawnMailFallback(
  input: { messageId: number; recipient: string; from: string },
  runtime: { execPath?: string; entry?: string | undefined; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const entry = 'entry' in runtime ? runtime.entry : process.argv[1];
  if (!entry) {
    try { debug.log('msg.fallback', 'spawn-skipped', { msgId: input.messageId, to: input.recipient, reason: 'no-cli-entry' }, { level: 'warn' }); }
    catch { /* fail-open */ }
    return false;
  }
  const child = Bun.spawn(mailFallbackSpawnArgv(input, { execPath: runtime.execPath ?? process.execPath, entry }), {
    detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: runtime.env ?? process.env,
  });
  (child as unknown as { unref?: () => void }).unref?.();
  return true;
}
