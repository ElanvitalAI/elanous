// DIRECTIVE-EXPIRY (Q5 · the in-memory gap) — a seat-mail notice held in the TUI queue was read from the ledger when it
// arrived; if it expired or was retracted while it waited, the flush must not deliver it. The ledger row is re-read at
// flush time (structured `expires_at` only). Fail-open: a ledger error keeps the notice (late beats lost).
//
// 세 얼굴: 관측 = debug.log('msg.held', 'dropped-lapsed', {msgIds}) · 판단 근거 = {@link keepLive} · 수복과 인계 = the
// dropped mail is still in the ledger; the next inbox snapshot names a lapsed directive once («expired: #id»).

import { debug } from '../debug/log.js';
import { isLive } from '../msg/directive-expiry.js';

/** Pure: keep notices whose msgId is not lapsed (`expiresAtOf` returns the ledger expiry, null = none / unknown). */
export function keepLive<T extends { readonly msgId?: number }>(items: readonly T[], expiresAtOf: (msgId: number) => string | null | undefined, now: number): { kept: T[]; dropped: number[] } {
  const kept: T[] = [];
  const dropped: number[] = [];
  for (const item of items) {
    if (item.msgId === undefined) { kept.push(item); continue; }
    const expiresAt = expiresAtOf(item.msgId);
    if (isLive({ expiresAt: expiresAt ?? null }, now)) kept.push(item); else dropped.push(item.msgId);
  }
  return { kept, dropped };
}

/** Impure: re-read each held notice's ledger expiry (one read-only store open per flush). */
export function dropLapsedHeld<T extends { readonly msgId?: number }>(items: readonly T[], deps: { readExpiry?: (ids: readonly number[]) => Map<number, string | null>; now?: () => number } = {}): T[] {
  const ids = items.flatMap((item) => (item.msgId === undefined ? [] : [item.msgId]));
  if (ids.length === 0) return [...items];
  try {
    const expiries = (deps.readExpiry ?? readLedgerExpiry)(ids);
    const { kept, dropped } = keepLive(items, (id) => expiries.get(id) ?? null, (deps.now ?? Date.now)());
    if (dropped.length > 0) debug.log('msg.held', 'dropped-lapsed', { msgIds: dropped });
    return kept;
  } catch (error) {
    debug.log('msg.held', 'expiry-check-failed', { error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
    return [...items];
  }
}

function readLedgerExpiry(ids: readonly number[]): Map<number, string | null> {
  const { openMsgStoreReadOnly } = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
  const store = openMsgStoreReadOnly();
  try {
    const out = new Map<number, string | null>();
    for (const id of ids) { const m = store.getMessage(id); out.set(id, m?.expiresAt ?? null); }
    return out;
  } finally { store.close(); }
}
