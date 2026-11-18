/**
 * ELN-EXTERNAL-EVENTS-BETWEEN-TURNS — idle door for two events the Next TUI
 * already observes but does not open a turn for:
 *   • a harness child finishing (task-notification queue)
 *   • a graph run ending (done, final failure) or parking on an approval node
 *
 * A node end only queues. Knocking once per node would open one turn per node,
 * including a failure that is about to retry. While a turn is running the
 * notice stays queued. The idle door (injectKey) opens only when nothing is
 * running. This path never steers the running turn.
 */

import { emitTurnLife } from '../debug/turn-life.js';
import type { PendingTaskNotification } from '../agent/task-notification.js';
import type { GraphProgressObservation } from '../graph-runner/graph-progress-observation.js';
import type { GraphRunIdleWake } from '../graph-runner/runner.js';

export interface IdleEventWakeDeps {
  busy: () => boolean;
  injectKey: (key: unknown) => boolean | void;
  queueWake: unknown;
  /** Running-turn steer. These events must not call it; the seam test counts it. */
  steer?: (text: string) => void;
  enqueueChild: (info: { goal: string; outcome: string }) => unknown;
  /** Node-end text. Queued only — never opens the idle door. */
  enqueueGraphNode: (text: string) => unknown;
  /** Run-end or approval-wait text. This is the one knock for the run. */
  enqueueGraphRun: (text: string) => unknown;
  childLabel: (n: Pick<PendingTaskNotification, 'label' | 'agentName'>) => string;
  graphNodeText: (event: GraphProgressObservation) => string | null;
  graphRunText: (wake: GraphRunIdleWake) => string | null;
}

export interface IdleEventWake {
  onChild(n: PendingTaskNotification): boolean;
  /** Queue a node end. Returns false because a node end never knocks. */
  onGraphNode(event: GraphProgressObservation): boolean;
  /** Knock once for a finished run or an approval wait. */
  onGraphRun(wake: GraphRunIdleWake): boolean;
}

function knock(deps: IdleEventWakeDeps, queued: unknown): boolean {
  if (!queued || deps.busy()) return false;
  deps.injectKey(deps.queueWake);
  return true;
}

export function createIdleEventWake(deps: IdleEventWakeDeps): IdleEventWake {
  return {
    onChild(n) {
      // OBSERVE-TURN-EVENT-LIFECYCLE — 하니스 자식 종결 도착(busy 판정은 문 너머에서).
      try { emitTurnLife('turn-life:event-arrived', { source: 'harness-child', arrivedAt: Date.now() }); } catch { /* observability is fail-open */ }
      const queued = deps.enqueueChild({ goal: deps.childLabel(n), outcome: n.state });
      return knock(deps, queued);
    },
    onGraphNode(event) {
      // OBSERVE-TURN-EVENT-LIFECYCLE — 그래프 노드 종결 도착(큐행, 노크 없음).
      try { emitTurnLife('turn-life:event-arrived', { source: 'graph-node', arrivedAt: Date.now() }); } catch { /* observability is fail-open */ }
      const text = deps.graphNodeText(event);
      if (text === null) return false;
      deps.enqueueGraphNode(text);
      return false;
    },
    onGraphRun(wake) {
      // OBSERVE-TURN-EVENT-LIFECYCLE — 그래프 런 종결/승인 대기 도착(런당 노크 1회).
      try { emitTurnLife('turn-life:event-arrived', { source: 'graph-node', arrivedAt: Date.now() }); } catch { /* observability is fail-open */ }
      const text = deps.graphRunText(wake);
      if (text === null) return false;
      return knock(deps, deps.enqueueGraphRun(text));
    },
  };
}

/** Display name for a finished harness child — label, else agent, one short line. */
export function idleChildLabel(n: Pick<PendingTaskNotification, 'label' | 'agentName'>): string {
  return ((n.label ?? '').trim() || n.agentName).replace(/\s+/g, ' ').slice(0, 60);
}

/**
 * A node end is queued progress, not a wake. Start and a dry run return null.
 * A failure here may still be retried, so the caller must not knock.
 */
export function graphNodeEndNotice(event: GraphProgressObservation): string | null {
  if (event.dryRun) return null;
  if (event.kind !== 'completed' && event.kind !== 'failed') return null;
  const verb = event.kind === 'completed' ? '완료' : '실패';
  return `그래프 노드 끝: ${event.graphId}/${event.nodeId} — ${verb}`;
}

/** One line for the single wake of a run: done, final failure, or approval wait. */
export function graphRunIdleNotice(wake: GraphRunIdleWake): string | null {
  if (wake.dryRun) return null;
  if (wake.status === 'done') return `그래프 런 끝: ${wake.graphId}/${wake.runId} — 완료`;
  if (wake.status === 'failed') return `그래프 런 끝: ${wake.graphId}/${wake.runId} — 실패`;
  if (wake.status === 'awaiting-approval') {
    const node = wake.nodeId ? `/${wake.nodeId}` : '';
    return `그래프 승인 대기: ${wake.graphId}/${wake.runId}${node}`;
  }
  return null;
}
