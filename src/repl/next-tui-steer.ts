// A200 ELN-MIDTURN-STEER — the REPL child's per-turn steer inbox.
//
// The Next TUI sends input typed during a running turn over Bun IPC instead of holding it until
// the turn ends. The child puts it in the session's pending-input registry, which the tool loop
// (`streamLLMWithTools` · `drainPendingUserInput`) drains right before the next model request,
// after tool results are appended (codex/opencode «steer»). The in-flight tool or stream is not cut.
// When the turn ends with no further model request, the undelivered items are withdrawn here and
// the parent, which still holds them, submits them as the next turn — nothing is lost or doubled.

import { debug } from '../debug/log.js';
import { enqueuePendingUserInput, removePendingUserInput } from '../session/pending-input.js';

export const NEXT_TUI_STEER_TYPE = 'elanous.next-tui.steer';
export const NEXT_TUI_STEER_RETRACT_TYPE = 'elanous.next-tui.steer-retract';

export type NextTuiSteerRequest =
  | { kind: 'steer'; steerId: string; text: string }
  | { kind: 'retract'; steerIds: string[] };

/** Buffers steer messages that arrive before the child turn installs its listener (same shape as push-now). */
export function createNextTuiSteerRouter() {
  const listeners = new Map<string, (request: NextTuiSteerRequest) => void>();
  const pending = new Map<string, NextTuiSteerRequest[]>();
  return {
    receive(message: unknown): boolean {
      if (message === null || typeof message !== 'object') return false;
      const raw = message as { type?: unknown; turnId?: unknown; steerId?: unknown; text?: unknown; steerIds?: unknown };
      if (typeof raw.turnId !== 'string' || !raw.turnId) return false;
      let request: NextTuiSteerRequest;
      if (raw.type === NEXT_TUI_STEER_TYPE && typeof raw.steerId === 'string' && raw.steerId && typeof raw.text === 'string') {
        request = { kind: 'steer', steerId: raw.steerId, text: raw.text };
      } else if (raw.type === NEXT_TUI_STEER_RETRACT_TYPE && Array.isArray(raw.steerIds)
        && raw.steerIds.every((id) => typeof id === 'string')) {
        request = { kind: 'retract', steerIds: raw.steerIds as string[] };
      } else return false;
      const listener = listeners.get(raw.turnId);
      if (listener) listener(request);
      else pending.set(raw.turnId, [...(pending.get(raw.turnId) ?? []), request]);
      return true;
    },
    listen(turnId: string, listener: (request: NextTuiSteerRequest) => void): () => void {
      listeners.set(turnId, listener);
      for (const request of pending.get(turnId) ?? []) listener(request);
      pending.delete(turnId);
      return () => {
        if (listeners.get(turnId) === listener) listeners.delete(turnId);
        pending.delete(turnId);
      };
    },
  };
}

/**
 * One turn's steer inbox. `onApplied` receives the parent's steer ids once the tool loop drained them
 * into the next model request. `finish()` withdraws what was never drained and returns those ids.
 */
export function createNextTuiSteerInbox(sessionId: string, onApplied: (steerIds: string[]) => void) {
  const steerIdByPendingId = new Map<string, string>();
  const onDrained = (_texts: readonly string[], items: readonly { id: string }[]): void => {
    const steerIds: string[] = [];
    for (const item of items) {
      const steerId = steerIdByPendingId.get(item.id);
      if (steerId === undefined) continue;
      steerIdByPendingId.delete(item.id);
      steerIds.push(steerId);
    }
    if (steerIds.length === 0) return;
    debug.log('turn.steer', 'injected', { sessionId, steerIds, count: steerIds.length }, { level: 'info' });
    onApplied(steerIds);
  };
  const pendingIdsFor = (steerIds: readonly string[]): string[] => {
    const wanted = new Set(steerIds);
    return [...steerIdByPendingId].filter(([, steerId]) => wanted.has(steerId)).map(([pendingId]) => pendingId);
  };
  return {
    push(steerId: string, text: string): boolean {
      const pendingId = enqueuePendingUserInput(sessionId, text, onDrained);
      if (pendingId === null) return false;
      steerIdByPendingId.set(pendingId, steerId);
      debug.log('turn.steer', 'received', { sessionId, steerId, chars: text.length });
      return true;
    },
    retract(steerIds: readonly string[]): void {
      const pendingIds = pendingIdsFor(steerIds);
      for (const pendingId of pendingIds) steerIdByPendingId.delete(pendingId);
      if (pendingIds.length > 0) removePendingUserInput(pendingIds, 'recalled');
    },
    /** Turn ended: what no model request consumed goes back to the parent's queue as the next turn. */
    finish(): string[] {
      const carried = [...steerIdByPendingId.values()];
      if (steerIdByPendingId.size > 0) removePendingUserInput([...steerIdByPendingId.keys()], 'submitted-as-prompt');
      steerIdByPendingId.clear();
      if (carried.length > 0) debug.log('turn.steer', 'carried-to-next-turn', { sessionId, steerIds: carried, count: carried.length });
      return carried;
    },
  };
}
