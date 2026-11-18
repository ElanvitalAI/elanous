// ── eln 자리 우편 60초 안전망 (OP 11-17 21:5x · ELN-SEAT-SAY 4) ──
//
// runtime=eln ⊕ autowake 자리는 herdr 타이핑 대신 자기 우편 감시(#38164)로 받는다(`wakeRecipient` → `eln-mail-watch`).
// 그 감시가 죽었거나 막혔을 때만, 우편 뒤 60초 안에 «받음» 구조 신호(delivered 이상 영수증 · ack/커서)가 없으면
// herdr 로 «우편 확인» 한 줄을 한 번 친다(본문·보낸이 0). 한 번 = 원장 표 `msg_mail_fallbacks` 의 (message, recipient) 키.
// 실행은 post 한 프로세스가 띄운 detached 일회성 `eln msg mail-fallback` — 상주 프로세스 0 · 폴링 0(잠 한 번).
import type { Database } from 'bun:sqlite';
import { debug } from '../debug/log.js';
import type { MsgStore } from './msg-store.js';

export const MAIL_FALLBACK_MS = 60_000;

export const MSG_MAIL_FALLBACKS_SCHEMA = `CREATE TABLE IF NOT EXISTS msg_mail_fallbacks (
      message_id INTEGER NOT NULL,
      recipient TEXT NOT NULL,
      at TEXT NOT NULL,
      PRIMARY KEY (message_id, recipient)
    )`;

/** Structural «received»: a delivered-or-later receipt, or an ack (explicit or cursor). Unknown message = received (nothing to knock for). */
export function mailReceived(store: MsgStore, messageId: number, recipient: string): boolean {
  const status = store.messageStatus(recipient, messageId);
  if (status === null || status !== 'delivered') return true;
  return store.listReceipts({ messageId }).some(r => r.recipient === recipient && r.state !== 'posted' && r.state !== 'overdue');
}

/** Claim the one fallback for (message, recipient). False when it was already claimed. */
export function claimMailFallback(db: Database, messageId: number, recipient: string, at: Date): boolean {
  db.exec(MSG_MAIL_FALLBACKS_SCHEMA);
  return db.query('INSERT OR IGNORE INTO msg_mail_fallbacks(message_id, recipient, at) VALUES (?, ?, ?)').run(messageId, recipient, at.toISOString()).changes === 1;
}

export type MailFallbackResult = 'received' | 'already-knocked' | 'knocked' | 'knock-failed';

export interface MailFallbackDeps {
  openStore: () => MsgStore;
  wake: (address: string, msgId: number, message: { from: string; fallback: true }) => Promise<{ result: string; reason?: string }>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  waitMs?: number;
}

export async function runMailFallback(input: { messageId: number; recipient: string; from: string }, deps: MailFallbackDeps): Promise<MailFallbackResult> {
  await (deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(deps.waitMs ?? MAIL_FALLBACK_MS);
  const log = (event: string, data: Record<string, unknown>) => { try { debug.log('msg.fallback', event, { msgId: input.messageId, to: input.recipient, ...data }); } catch { /* fail-open */ } };
  const store = deps.openStore();
  let claimed: boolean;
  try {
    if (mailReceived(store, input.messageId, input.recipient)) { log('received', {}); return 'received'; }
    claimed = claimMailFallback(store.db, input.messageId, input.recipient, (deps.now ?? (() => new Date()))());
  } finally { store.close(); }
  if (!claimed) { log('already-knocked', {}); return 'already-knocked'; }
  try {
    const outcome = await deps.wake(input.recipient, input.messageId, { from: input.from, fallback: true });
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
