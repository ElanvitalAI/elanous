import type { PendingTaskNotification } from '../agent/task-notification.js';
import { debug } from '../debug/log.js';
import { redactMissionResultPath, type StartedClassicMissionCliJob } from './mission-cli-consumer.js';
import type { ClassicSidetabMissionResult } from './classic-sidetab-mission.js';

export type ClassicMissionNotificationEnqueue = (notification: PendingTaskNotification) => void;
export const CLASSIC_SIDETAB_MISSION_LABEL = 'sidetab mission';
const CLASSIC_SIDETAB_PAIR_TIMEOUT_MS = 60 * 60 * 1_000;
const MAX_PAIR_ANSWER_CHARS = 12_000;
export interface ClassicSidetabMissionPairCompletionResult {
  codex: ClassicSidetabMissionResult;
  claude: ClassicSidetabMissionResult;
  status: 'done' | 'error';
  finishedAt: number;
}
type ClassicSidetabPairOutcome = ClassicSidetabMissionResult;
interface ClassicSidetabMissionPairJob {
  missionId?: string;
  taskId: string;
  parentSessionId?: string;
  startedAt: number;
  completion: Promise<ClassicSidetabPairOutcome>;
}

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

/** Deliver a single combined parent notification after both parallel agents finish. */
export function enqueueClassicSidetabMissionPairCompletion(
  pair: { codex: ClassicSidetabMissionPairJob; claude: ClassicSidetabMissionPairJob },
  enqueue: ClassicMissionNotificationEnqueue,
  now: () => number = Date.now,
  options: { timeoutMs?: number; onTimeout?: () => void; onComplete?: (result: ClassicSidetabMissionPairCompletionResult) => void } = {},
): Promise<ClassicSidetabMissionPairCompletionResult> {
  const taskId = pair.codex.taskId;
  const startedAt = Math.min(pair.codex.startedAt, pair.claude.startedAt);
  const timeoutMs = options.timeoutMs ?? CLASSIC_SIDETAB_PAIR_TIMEOUT_MS;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<[ClassicSidetabPairOutcome, ClassicSidetabPairOutcome]>((resolve) => {
    timeout = setTimeout(() => {
      try { options.onTimeout?.(); } catch { /* timeout cleanup cannot suppress the receipt */ }
      const failure = (member: string): ClassicSidetabPairOutcome => ({ ok: false, status: 'failed', error: `${member} sidetab mission exceeded the one-hour safety timeout` });
      resolve([failure('Codex'), failure('Claude')]);
    }, Math.max(1, timeoutMs));
  });
  return Promise.race([Promise.all([pair.codex.completion, pair.claude.completion]), timedOut]).then(([codex, claude]) => {
    const finishedAt = now();
    const ok = codex.ok && claude.ok && Boolean(codex.content?.trim()) && Boolean(claude.content?.trim());
    const result = { codex, claude, status: ok ? 'done' as const : 'error' as const, finishedAt };
    try { options.onComplete?.(result); }
    catch { debug.log('classic-sidetab.mission-pair', 'completion-callback-failed', { taskId, retry: false }); }
    let truncated = false;
    const body = (name: string, result: ClassicSidetabPairOutcome): string => {
      const content = result.content?.trim();
      const text = result.ok
        ? content ? redactMissionResultPath(content, result.path) : 'completed without an answer'
        : redactMissionResultPath(result.error ?? 'no result returned', result.path);
      if (text.length > MAX_PAIR_ANSWER_CHARS) truncated = true;
      const bounded = text.length > MAX_PAIR_ANSWER_CHARS
        ? `${text.slice(0, MAX_PAIR_ANSWER_CHARS)}\n[answer truncated]`
        : text;
      return result.ok ? `${name} answer:\n${bounded}` : `${name} failed: ${bounded}`;
    };
    const output = JSON.stringify({
      status: ok ? 'done' : 'error',
      body: `Concurrent Codex + Claude mission pair (${pair.codex.missionId ?? 'Codex unavailable'} / ${pair.claude.missionId ?? 'Claude unavailable'})\n\n${body('Codex', codex)}\n\n${body('Claude', claude)}`,
      artifacts: [],
      id: pair.codex.missionId ?? pair.claude.missionId ?? taskId,
    });
    try {
      enqueue({
        taskId,
        ...(pair.codex.parentSessionId ? { parentSessionId: pair.codex.parentSessionId } : {}),
        agentName: 'Codex + Claude',
        label: CLASSIC_SIDETAB_MISSION_LABEL,
        state: ok ? 'done' : 'error',
        output,
        truncated,
        durationMs: Math.max(0, finishedAt - startedAt),
        finishedAt,
      });
    } catch {
      debug.log('classic-sidetab.mission-pair', 'completion-enqueue-failed', { taskId, retry: false });
    }
    return result;
  }).catch(() => {
    const finishedAt = now();
    const failure = (error: string): ClassicSidetabMissionResult => ({ ok: false, status: 'failed', error });
    const result: ClassicSidetabMissionPairCompletionResult = {
      codex: failure('Codex/Claude pair failed before results were available'),
      claude: failure('Codex/Claude pair failed before results were available'),
      status: 'error', finishedAt,
    };
    try { options.onComplete?.(result); } catch { debug.log('classic-sidetab.mission-pair', 'completion-callback-failed', { taskId, retry: false }); }
    try {
      enqueue({
        taskId,
        ...(pair.codex.parentSessionId ? { parentSessionId: pair.codex.parentSessionId } : {}),
        agentName: 'Codex + Claude',
        label: CLASSIC_SIDETAB_MISSION_LABEL,
        state: 'error',
        output: JSON.stringify({ status: 'error', body: 'Concurrent Codex/Claude missions failed before results were available', artifacts: [], id: pair.codex.missionId ?? pair.claude.missionId ?? taskId }),
        truncated: false,
        durationMs: Math.max(0, finishedAt - startedAt),
        finishedAt,
      });
    } catch {
      debug.log('classic-sidetab.mission-pair', 'completion-enqueue-failed', { taskId, retry: false });
    }
    return result;
  }).finally(() => { if (timeout) clearTimeout(timeout); });
}
