/**
 * CAPSULE-B4-HARNESS-DONE-FRAME (내부 문서 `TURN-CAPSULE-EVENTS` §3.3 ③-4) — a harness child finishing and a graph
 * run ending become the same `capsule-done` event as a background Agent (B1), instead of their own queued notices.
 *
 * Pure converters only. The TUI wiring (entry.ts harness/graph block → bus.publish · door.offer) lands after the
 * one-door wiring (C2); no switch (CAPSULE-FLAGS-REMOVE-DEFAULT).
 */
import type { PendingTaskNotification } from '../agent/task-notification.js';
import type { GraphRunIdleWake } from '../graph-runner/runner.js';
import type { CapsuleDoneEvent, CapsuleStatus } from './contract.js';

/** Terminal notification states only. `running` (a line-watch progress notice · #38537) is not a completion. */
const NOTIFICATION_STATUS: Readonly<Record<Exclude<PendingTaskNotification['state'], 'running'>, CapsuleStatus>> = {
  done: 'ok', error: 'failed', aborted: 'cancelled',
};

/** A harness child's task-notification (TUI process queue) → `capsule-done{kind:'harness'}`.
 *  Supplements never reopen a turn (same rule as today's idle wake), and a `running` progress notice is not a
 *  completion — both map to null. */
export function capsuleDoneFromHarnessNotification(
  notification: Pick<PendingTaskNotification, 'taskId' | 'agentName' | 'label' | 'state' | 'durationMs' | 'finishedAt' | 'completionDelivery'>,
  sessionId: string,
): CapsuleDoneEvent | null {
  if (notification.completionDelivery === 'supplement' || notification.state === 'running') return null;
  const status = NOTIFICATION_STATUS[notification.state];
  const endedAt = notification.finishedAt;
  const startedAt = Math.max(0, endedAt - Math.max(0, notification.durationMs));
  return {
    type: 'capsule-done', capsuleId: notification.taskId, kind: 'harness', sessionId, startedAt, endedAt, status,
    summary: `${notification.label ?? notification.agentName} · ${status} · ${Math.round((endedAt - startedAt) / 1000)}s`,
  };
}

/** A graph run that finished → `capsule-done{kind:'graph'}`. Approval waits and dry runs are not completions (null):
 *  an approval wait keeps its own path — it asks a person, it does not report a result. */
export function capsuleDoneFromGraphRun(wake: GraphRunIdleWake, sessionId: string, startedAt: number, endedAt = Date.now()): CapsuleDoneEvent | null {
  if (wake.dryRun || (wake.status !== 'done' && wake.status !== 'failed')) return null;
  const status: CapsuleStatus = wake.status === 'done' ? 'ok' : 'failed';
  return {
    type: 'capsule-done', capsuleId: `graph:${wake.graphId}/${wake.runId}`, kind: 'graph', sessionId,
    startedAt: Math.min(startedAt, endedAt), endedAt, status,
    summary: `${wake.graphId}/${wake.runId} · ${status}`,
  };
}
