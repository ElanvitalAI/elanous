// ELN-AGENT-EVENT-PROTOCOL residual (0.3.34 P0 cell · OP 결정 #136151): the notice side of the eln → els wire.
// main wired only the busy flip (entry.ts setBusy → agentEvents.busy); notice production never reached the bridge —
// the cell's JUD-B HOLD note: «notice는 합성 브리지 시험만 있어 핵심 알림 생산 방출 미연결». Every real producer
// (seat-mail poll, seat-mail guide, capsule-done, event-watch, ceo-ingress, sidetab, harness-child, graph-node)
// funnels into ONE door — queue.enqueueNotice (enqueueCapsuleDoneNotice calls this.enqueueNotice too) — so one wrap
// wires the whole production path. Observation only: the queue's answer is returned untouched, and a throwing
// bridge is swallowed here as well (the real bridge guards its sink; this guard keeps a raw test double honest).
import type { AgentEventBridge } from './agent-event-bridge.js';
import { type NextTuiQueueItem, type NextTuiQueueNoticeSource, createNextTuiQueue } from './core/queue.js';

/** The queue object the real entry owns (createNextTuiQueue's return, by structural inference). */
export type NoticeWiredQueue = ReturnType<typeof createNextTuiQueue>;

/**
 * Emit one agent-event notice for every notice the queue accepts. Level: an urgent mail is an `alert`; everything
 * else is `info` (the capsule summary row mutates after enqueue, so a failure level is not knowable at this door).
 * Must run before any producer is wired (seat-mail watcher, capsule knocks) so `this.enqueueNotice` inside the
 * queue resolves to the wrapped door.
 */
export function wireNoticeEvents(queue: NoticeWiredQueue, agentEvents: AgentEventBridge): void {
  const inner = queue.enqueueNotice.bind(queue);
  queue.enqueueNotice = (text: string, _source: NextTuiQueueNoticeSource, meta: { msgId?: number; occurredAt?: number; urgent?: boolean } = {}): NextTuiQueueItem => {
    const item = inner(text, _source, meta);
    try { agentEvents.notice(meta.urgent === true ? 'alert' : 'info', text); } catch { /* observation must not change the queue */ }
    return item;
  };
}
