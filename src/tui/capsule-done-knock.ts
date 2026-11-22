/**
 * CAPSULE-B1 TUI wiring (ENTRY-TS-LAND-ORDER row 6 · D12) — a `capsule-done` frame from the chat child becomes one
 * queued notice and one knock on the idle door, so an idle seat opens a turn when a background capsule finishes.
 * The child's `<task-notification>` drain still carries the result body into that turn; the notice is the doorbell.
 *
 * Always on (CAPSULE-FLAGS-REMOVE-DEFAULT). Same capsule twice
 * (replay · reconnect) = one notice: the notice text carries `capsule:<id>` and the producer dedupes queued text.
 *
 * OP #106762 ⓐ — a capsule that finishes during a busy turn carries its real notice text (capsuleDoneNotice —
 * 큐 노티스와 같은 문면) into the mid-turn event box; when drained, the queued notice is removed from the
 * original queue, so the same capsule surfaces exactly once per session.
 */
import type { CapsuleDoneEvent, CapsuleEvent } from '../turn-capsule/contract.js';
import { emitTurnLife } from '../debug/turn-life.js';
import { capsuleDoneNotice } from './core/notice-producers.js';

export interface CapsuleDoneKnockDeps {
  readonly sessionId: string;
  readonly subscribe: (sessionId: string, listener: (event: CapsuleEvent) => void) => () => void;
  /** Queues the notice; null = already queued (duplicate). */
  readonly enqueue: (event: CapsuleDoneEvent) => unknown;
  readonly knock: () => void;
  /** SEAT-TURN-MIDTURN-MAIL 어댑터 — 턴 중 완료는 이벤트함에도 한 건(모두 지정해야 켠다). */
  readonly busy?: () => boolean;
  readonly enqueueMidTurn?: (event: { kind: string; id: string; text: string }, onDrained?: () => void) => boolean;
  /** OP #106762 ⓐ — 배수된 사건의 대기 큐 노티스를 지운다(fail-open · 지운 건수를 돌려준다). */
  readonly removeQueuedNotice?: (match: { source: string; msgId?: number; text?: string; capsuleId?: string }) => number;
}

/** Returns the unsubscribe. */
export function wireCapsuleDoneKnock(deps: CapsuleDoneKnockDeps): () => void {
  return deps.subscribe(deps.sessionId, (event) => {
    if (event.type !== 'capsule-done') return;
    const queued = deps.enqueue(event);
    emitTurnLife('turn-life:capsule-done-knock', {
      sessionId: deps.sessionId, capsuleId: event.capsuleId, kind: event.kind, status: event.status, queued: Boolean(queued),
    });
    if (deps.busy?.() && deps.enqueueMidTurn !== undefined) {
      // OP #106762 ⓐ — 이벤트 문면 = 큐 노티스 문면(capsuleDoneNotice). 배수 시 원본 큐에서 그 노티스를 지운다.
      const text = capsuleDoneNotice(event);
      deps.enqueueMidTurn(
        { kind: 'capsule-done', id: `capsule:${event.capsuleId}`, text },
        deps.removeQueuedNotice === undefined ? undefined : () => { deps.removeQueuedNotice?.({ source: 'capsule-done', text, capsuleId: event.capsuleId }); },
      );
    }
    // OPS-RULES token cost: result-only notifications wait for a person or another actual event turn.
    // The task notification drain carries the result into that turn; this frame never opens one.
  });
}
