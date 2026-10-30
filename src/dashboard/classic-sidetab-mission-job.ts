import type { PendingTaskNotification } from '../agent/task-notification.js';
import { debug } from '../debug/log.js';
import { redactMissionResultPath, type StartedClassicMissionCliJob } from './mission-cli-consumer.js';

export type ClassicMissionNotificationEnqueue = (notification: PendingTaskNotification) => void;
export const CLASSIC_SIDETAB_MISSION_LABEL = 'sidetab mission';

/** Deliver one eventual sidetab result through the parent's existing task-notification input path. */
export function enqueueClassicSidetabMissionCompletion(
  job: StartedClassicMissionCliJob,
  agent: 'codex' | 'claude',
  enqueue: ClassicMissionNotificationEnqueue,
  now: () => number = Date.now,
): void {
  let deliveryAttempted = false;
  const enqueueOnce = (notification: PendingTaskNotification): void => {
    if (deliveryAttempted) return;
    deliveryAttempted = true;
    try {
      enqueue(notification);
    } catch {
      debug.log('classic-sidetab.mission', 'completion-enqueue-failed', {
        interactionId: job.interactionId,
        retry: false,
      });
    }
  };
  const deliver = (result: Awaited<StartedClassicMissionCliJob['completion']>): void => {
    const finishedAt = now();
    const state = result.ok ? 'done' : result.status === 'cancelled' ? 'aborted' : 'error';
    const body = result.ok
      ? redactMissionResultPath(result.content ?? '', result.path)
      : redactMissionResultPath(result.error ?? 'Sidetab mission failed; no result was returned', result.path);
    enqueueOnce({
      taskId: job.interactionId,
      agentName: agent === 'codex' ? 'Codex' : 'Claude Code',
      label: CLASSIC_SIDETAB_MISSION_LABEL,
      state,
      output: JSON.stringify({ status: state, body, artifacts: [], id: job.interactionId }),
      truncated: false,
      durationMs: Math.max(0, finishedAt - job.startedAt),
      finishedAt,
    });
  };
  void job.completion.then(deliver).catch(() => {
    const finishedAt = now();
    enqueueOnce({
      taskId: job.interactionId,
      agentName: agent === 'codex' ? 'Codex' : 'Claude Code',
      label: CLASSIC_SIDETAB_MISSION_LABEL,
      state: 'error',
      output: JSON.stringify({ status: 'error', body: 'Sidetab mission failed before a result was available', artifacts: [], id: job.interactionId }),
      truncated: false,
      durationMs: Math.max(0, finishedAt - job.startedAt),
      finishedAt,
    });
  });
}
