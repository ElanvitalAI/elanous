// SIGNAL-INBOX-SNAPSHOT (Q6) — the impure half: read the seat's ledger, build the block (inbox-snapshot.ts), stamp a
// `delivered` receipt (source turn-snapshot · never an ack) on each listed mail, remember lapsed directives already named.
// Seats only: a cwd that is no federation seat gets nothing (member chat unchanged). Fail-open: any error drops the block.

import { debug } from '../debug/log.js';
import { buildInboxSnapshot, type SnapshotMail } from './inbox-snapshot.js';
import { OUTBOUND_WINDOW_MS, outboundBudgetLine } from './outbound-coalesce.js';
import type { Message, MsgStore } from './msg-store.js';

/** How far back the first snapshot of a process looks for lapsed mail. */
export const LAPSED_LOOKBACK_MS = 2 * 60 * 60_000;

const lastSnapshotAt = new Map<string, number>();
const namedExpired = new Map<string, Set<number>>();

const toSnapshot = (m: Message): SnapshotMail => ({ id: m.id, from: m.from, body: m.body, kind: m.kind ?? null,
  ...(m.refs ? { refs: m.refs } : {}), crownDirective: m.crownDirective ?? null, goal: m.goal ?? null, priority: m.priority ?? null });

export interface InboxSnapshotTurnDeps {
  readonly openStore?: () => MsgStore;
  readonly now?: () => Date;
}

/** One block for this seat's turn (null = nothing to show / not a seat / ledger unavailable). */
export function seatInboxSnapshotText(seat: string | null | undefined, deps: InboxSnapshotTurnDeps = {}): string | null {
  if (!seat) return null;
  let store: MsgStore | null = null;
  try {
    const now = (deps.now ?? (() => new Date()))();
    store = deps.openStore ? deps.openStore() : (require('./msg-store.js') as typeof import('./msg-store.js')).openMsgStore();
    // OP-DIGEST-FLUSH-TICK — parked machine mail flushes when due even if nobody wrote to OP since (idempotent).
    if (seat.toUpperCase() === 'OP') { try { store.flushOpDigestIfDue(); } catch { /* read-only or busy: the TUI tick retries */ } }
    const unread = store.list(seat, store.getCursor(seat), 200);
    const since = new Date(lastSnapshotAt.get(seat) ?? now.getTime() - LAPSED_LOOKBACK_MS);
    const lapsed = store.listLapsed(seat, since, now);
    const named = namedExpired.get(seat) ?? new Set<number>();
    const sent = store.countSentSince(seat, new Date(now.getTime() - OUTBOUND_WINDOW_MS));
    const result = buildInboxSnapshot(unread.map(toSnapshot), lapsed.map(toSnapshot), named, undefined, outboundBudgetLine(sent));
    for (const id of result.shownIds) {
      try { store.recordReceipt({ messageId: id, recipient: seat, state: 'delivered', source: 'turn-snapshot' }); } catch { /* an ALL/group row or a newer state: the line still shows */ }
    }
    for (const id of result.expiredNamed) named.add(id);
    namedExpired.set(seat, named);
    lastSnapshotAt.set(seat, now.getTime());
    debug.log('msg.snapshot', 'built', { seat, unread: unread.length, shown: result.shownIds.length, lapsed: lapsed.length, expiredNamed: result.expiredNamed.length });
    return result.text;
  } catch (error) {
    debug.log('msg.snapshot', 'failed', { seat, error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
    return null;
  } finally {
    if (!deps.openStore) { try { store?.close(); } catch { /* closed */ } }
  }
}

/** Test seam: forget the per-seat memory. */
export function resetInboxSnapshotMemory(): void { lastSnapshotAt.clear(); namedExpired.clear(); }
