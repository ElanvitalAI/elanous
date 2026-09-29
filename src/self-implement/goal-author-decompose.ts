import { debug } from '../debug/log.js';
import { adversarialPlanCritique } from '../harness/adversarial-plan.js';
import { classifyHeft, adversarialThreshold } from '../harness/harness-seams.js';
import { llmDecomposeSteps } from '../harness/llm-decompose.js';
import { GOAL_AUTHOR_COARSE_MAX_SLICES } from '../task-orchestrator/generator-prompt.js';
import { getDefaultLogStore } from '../mss/logging/log-store.js';
import { emitDecision } from '../live/detail-switch.js';
import type { GoalAuthorDeps } from './goal-author.js';

const GOAL_STEPS_DECOMPOSED_EVENT = 'goal-steps-decomposed';

/** Injectable reader: failures remain distinguishable from a successful empty read. */
export type RecentStepCountReader = () => readonly number[];

type LogStoreLike = { query: (q?: { events?: string[] }) => readonly { data: string | null }[] };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Parse valid `stepCount` values; malformed rows are ignored and `[]` is a successful read. */
export function parseRecentStepCountsFromLogRows(rows: readonly { data: string | null }[]): number[] {
  const counts: number[] = [];
  for (const row of rows) {
    if (!row.data) continue;
    try {
      const data = JSON.parse(row.data) as unknown;
      if (!data || typeof data !== 'object') continue;
      const stepCount = (data as { stepCount?: unknown }).stepCount;
      if (isFiniteNumber(stepCount)) counts.push(stepCount);
    } catch {
      // Skip malformed log payloads while retaining the successful read result.
    }
  }
  return counts;
}

/** Reads the recent decomposition counts and throws on store/query failure. */
export function readRecentStepCountsFromLogStore(
  getStore: () => LogStoreLike | null = getDefaultLogStore,
): readonly number[] {
  const store = getStore();
  if (!store) throw new Error('recent step counts: log store unavailable');
  return parseRecentStepCountsFromLogRows(store.query({ events: [GOAL_STEPS_DECOMPOSED_EVENT] }));
}

/** Converts a reader failure to omission, without collapsing a successful empty array. */
export function readRecentStepCountsFailOpen(reader: RecentStepCountReader = readRecentStepCountsFromLogStore): readonly number[] | undefined {
  try {
    return reader();
  } catch {
    return undefined;
  }
}

/** Shared LLM-backed decomposition seam for every goal-author entrypoint. */
export function createGoalAuthorDecomposeSteps(
  signal?: AbortSignal,
  config: {
    adversarialReview?: boolean;
    adversarialReviewSource?: 'cli' | 'default' | 'unknown';
    recentStepCounts?: readonly number[];
  } = {},
): NonNullable<GoalAuthorDeps['decomposeSteps']> {
  return async (objective, options) => {
    const { streamLLM } = await import('../llm.js');
    let decompositionRationale: string | undefined;
    const steps = await llmDecomposeSteps(
      objective,
      (input) => streamLLM([{ role: 'user', content: input.prompt }], () => {}, { reasoningEffort: 'high' }).then((text) => ({ text })),
      { ...(options?.context ? { context: options.context } : {}), maxTasks: GOAL_AUTHOR_COARSE_MAX_SLICES, promptProfile: 'goal-author-coarse', ...(signal ? { signal } : {}), onRationale: (rationale) => { decompositionRationale = rationale; } },
    );
    const heft = classifyHeft(objective);
    const adversarialReviewSource = config.adversarialReviewSource
      ?? (config.adversarialReview === undefined ? 'default' : 'unknown');
    const reviewEnabled = config.adversarialReview !== false;
    const reviewForced = config.adversarialReview === true;
    const reviewEligible = steps.length >= adversarialThreshold(heft);
    const reviewExecuted = reviewEnabled && (reviewForced || reviewEligible);
    const reviewSkipReason = !reviewExecuted ? !reviewEnabled ? 'disabled' : 'below-threshold' : null;
    const recentStepCount = config.recentStepCounts;
    if (recentStepCount?.length) {
      const recentMaximum = Math.max(...recentStepCount);
      const threshold = adversarialThreshold(heft);
      if (recentMaximum < threshold) {
        debug.log('goal-author', 'adversarial-threshold-unreachable', {
          surface: 'goal-author',
          heft,
          threshold,
          recentMaximum,
          sampleSize: recentStepCount.length,
        });
      }
    }
    debug.log('goal-author', 'adversarial-review', {
      surface: 'goal-author',
      heft,
      adversarialReview: config.adversarialReview ?? null,
      adversarialReviewSource,
      reviewEnabled,
      reviewForced,
      reviewEligible,
      reviewExecuted,
      reviewSkipReason,
    });
    const finalize = (finalSteps: string[], rationale?: string): string[] => {
      if (finalSteps.length > 0 && rationale?.trim()) {
        try {
          emitDecision({
            kind: 'PLAN',
            what: finalSteps.length === 1 ? '분해 안 함(한 조각)' : `골을 조각 ${finalSteps.length}개로 분해`,
            reason: rationale.trim().split(/\r?\n|(?<=[.!?。])\s+/)[0]!,
            purpose: '조각마다 독립 런으로 · 실패를 작게 가둔다',
            target: finalSteps.slice(0, 8).join(' · '),
            paths: finalSteps.length,
            ...(options?.runId === undefined ? {} : { runId: options.runId }),
          });
        } catch { /* Live detail cannot change the decomposition result. */ }
      }
      return finalSteps;
    };
    if (!reviewExecuted) return finalize(steps, decompositionRationale);
    const critic = (prompt: string) => streamLLM([{ role: 'user', content: prompt }], () => {}, { reasoningEffort: 'high' });

    try {
      const critique = await adversarialPlanCritique(objective, steps, critic, options?.context);
      const sample = critique?.issues.slice(0, 3).map((issue) => issue.slice(0, 60)) ?? [];
      const byAxis = critique?.byAxis ?? { scope: [] };
      if (critique?.revisedSteps.length) {
        debug.log('goal-author', 'adversarial-revised', {
          surface: 'goal-author',
          heft,
          steps: critique.revisedSteps.length,
          issues: critique.issues.length,
          sample,
          byAxis,
          reviewEnabled,
        });
        return finalize(critique.revisedSteps);
      }

      debug.log('goal-author', 'adversarial-sound', {
        surface: 'goal-author',
        heft,
        issues: critique?.issues.length ?? 0,
        sample,
        byAxis,
        reviewEnabled,
      });
    } catch {
      // The red-team is advisory; authoring must retain the LLM decomposition on failure.
    }
    return finalize(steps, decompositionRationale);
  };
}
