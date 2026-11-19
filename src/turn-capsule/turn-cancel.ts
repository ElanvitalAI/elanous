/**
 * CAPSULE-B2-CANCEL-NOT-KILL (내부 문서 `TURN-CAPSULE-EVENTS` §3.3 ③-2 · K1 codex `Op::Interrupt`) — cancelling a
 * turn is not killing the seat's chat child. With stage B2 on, Esc / the stall watch / a turn cap send one
 * IPC message; the child aborts only that turn's controller (model stream · synchronous tools) and keeps living, so
 * the capsules it hosts keep running and later come back as `capsule-done` (B1).
 *
 * Fallback (§3.3 ⑤): a child that does not settle the turn within {@link TURN_CANCEL_GRACE_MS} is closed as before.
 */
import { CAPSULE_SYNC_CAP_MS } from './contract.js';

export const TURN_CANCEL_TYPE = 'elanous.next-tui.turn-cancel';

/** How long a cancelled turn may take to settle before the child is killed as today.
 *  출처: CAPSULE_SYNC_CAP_MS — the longest a synchronous capsule may hold the main turn. */
export const TURN_CANCEL_GRACE_MS = CAPSULE_SYNC_CAP_MS;

export type TurnCancelReason = 'stall';

export interface TurnCancelMessage {
  readonly type: typeof TURN_CANCEL_TYPE;
  readonly sessionId: string;
  readonly turnId: string;
  readonly reason?: TurnCancelReason;
}

export function isTurnCancelMessage(message: unknown): message is TurnCancelMessage {
  if (!message || typeof message !== 'object') return false;
  const value = message as Record<string, unknown>;
  return value.type === TURN_CANCEL_TYPE && typeof value.sessionId === 'string' && value.sessionId.length > 0
    && typeof value.turnId === 'string' && value.turnId.length > 0
    && (value.reason === undefined || value.reason === 'stall');
}

/** Cancels kept for a turn that is not listening yet (cold boot · stdin read before listen). 출처: JUD #38560 must ⓑ —
 *  a handful is enough: the host sends one cancel per Esc and turn ids never repeat within a child. */
export const TURN_CANCEL_HELD_MAX = 16;

/** Child side: one listener per running turn. A cancel that arrives before its turn listens (cold boot) is held
 *  and applied the moment that turn registers — never swallowed. Turn ids are unique per child, so a late cancel for
 *  a finished turn can never cancel a later one; held ids are bounded by {@link TURN_CANCEL_HELD_MAX}. */
export function createTurnCancelRouter() {
  let active: { turnId: string; onCancel: (reason?: TurnCancelReason) => void } | null = null;
  const held: Array<{ turnId: string; reason?: TurnCancelReason }> = [];
  const fire = (onCancel: (reason?: TurnCancelReason) => void, reason?: TurnCancelReason): void => {
    try { onCancel(reason); } catch { /* the turn still settles through its own abort path */ }
  };
  return {
    /** True when the message was a turn-cancel (applied now or held for its turn); false lets other routers see it. */
    receive(message: unknown): boolean {
      if (!isTurnCancelMessage(message)) return false;
      if (active && active.turnId === message.turnId) {
        const { onCancel } = active;
        active = null;
        fire(onCancel, message.reason);
      } else if (!held.some((entry) => entry.turnId === message.turnId)) {
        held.push({ turnId: message.turnId, reason: message.reason });
        if (held.length > TURN_CANCEL_HELD_MAX) held.shift();
      }
      return true;
    },
    listen(turnId: string, onCancel: (reason?: TurnCancelReason) => void): () => void {
      const index = held.findIndex((entry) => entry.turnId === turnId);
      if (index >= 0) {
        const [entry] = held.splice(index, 1);
        fire(onCancel, entry?.reason);
        return () => { /* already cancelled */ };
      }
      const entry = { turnId, onCancel };
      active = entry;
      return () => { if (active === entry) active = null; };
    },
    /** Held cancel count (observation and tests). */
    heldCount(): number { return held.length; },
  };
}
