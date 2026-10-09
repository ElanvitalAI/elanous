import type { QueuePool, QueueTick } from './harness-queue.js';

export type LaunchAdvice = { verdict: 'launch-now' | 'wait' | 'unknown'; why: string; retryAfterHint?: string };
export type LaunchAdviceInput = { pool: QueuePool | null | undefined; caller: 'harness-queue-tick' | 'hand-task' | 'release-run' };

/** A pool-only suggestion; queue, seat, freeze and finish gates remain the dispatcher's decisions. */
export function adviseLaunch(input: LaunchAdviceInput): LaunchAdvice {
  const pool = input.pool;
  if (!pool || ![pool.running, pool.pending, pool.reserved, pool.limit].every(n => Number.isSafeInteger(n) && n >= 0)
    || pool.limit < 1) return { verdict: 'unknown', why: 'pool unavailable or incomplete' };
  const used = pool.running + pool.pending + pool.reserved;
  if (used >= pool.limit) return { verdict: 'wait', why: `pool ${used}/${pool.limit} occupied`, retryAfterHint: 'when a pool slot is released' };
  return { verdict: 'launch-now', why: `pool ${used}/${pool.limit} occupied` };
}

export function compareLaunchAdvice(advice: LaunchAdvice, actualOutcome: QueueTick['outcome']): {
  agree: boolean; kind: 'advice-launch-actual-wait' | 'advice-wait-actual-launch' | 'advice-unknown' | 'agree';
} {
  if (advice.verdict === 'unknown' || actualOutcome === 'skipped') return { agree: false, kind: 'advice-unknown' };
  if (advice.verdict === 'launch-now' && actualOutcome === 'waiting') return { agree: false, kind: 'advice-launch-actual-wait' };
  if (advice.verdict === 'wait' && actualOutcome === 'launched') return { agree: false, kind: 'advice-wait-actual-launch' };
  return { agree: true, kind: 'agree' };
}
