/**
 * CAPSULE-B1 TUI wiring (ENTRY-TS-LAND-ORDER row 6 · D12) — a `capsule-done` frame from the chat child becomes one
 * queued notice and one knock on the idle door, so an idle seat opens a turn when a background capsule finishes.
 * The child's `<task-notification>` drain still carries the result body into that turn; the notice is the doorbell.
 *
 * Always on (CAPSULE-FLAGS-REMOVE-DEFAULT). Same capsule twice
 * (replay · reconnect) = one notice: the notice text carries `capsule:<id>` and the producer dedupes queued text.
 */
import type { CapsuleDoneEvent, CapsuleEvent } from '../turn-capsule/contract.js';
import { emitTurnLife } from '../debug/turn-life.js';

export interface CapsuleDoneKnockDeps {
  readonly sessionId: string;
  readonly subscribe: (sessionId: string, listener: (event: CapsuleEvent) => void) => () => void;
  /** Queues the notice; null = already queued (duplicate). */
  readonly enqueue: (event: CapsuleDoneEvent) => unknown;
  readonly knock: () => void;
}

/** Returns the unsubscribe. */
export function wireCapsuleDoneKnock(deps: CapsuleDoneKnockDeps): () => void {
  return deps.subscribe(deps.sessionId, (event) => {
    if (event.type !== 'capsule-done') return;
    const queued = deps.enqueue(event);
    emitTurnLife('turn-life:capsule-done-knock', {
      sessionId: deps.sessionId, capsuleId: event.capsuleId, kind: event.kind, status: event.status, queued: Boolean(queued),
    });
    if (queued) deps.knock();
  });
}
