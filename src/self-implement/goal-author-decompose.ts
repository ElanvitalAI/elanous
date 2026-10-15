import { debug } from '../debug/log.js';
import { adversarialPlanCritique } from '../harness/adversarial-plan.js';
import { classifyHeft, adversarialThreshold } from '../harness/harness-seams.js';
import { llmDecomposeSteps } from '../harness/llm-decompose.js';
import { GOAL_AUTHOR_COARSE_MAX_SLICES } from '../task-orchestrator/generator-prompt.js';
import { getDefaultLogStore } from '../mss/logging/log-store.js';
import { emitDecision } from '../live/detail-switch.js';
import { selectPlanningLlm } from '../prompt-enhance/enhance.js';
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

/**
 * ⭐ AUTHOR-SHADOW-FIRST-SPLIT ① (0.2.29 · 근거 사례 #26644 · 대표 10-12 «착지해야만 낼 수 있는 증거는
 * 처음 저작부터 쪼갰어야»). 골 문면에 «명시 표지» 한 줄이 있을 때만 처음부터 두 조각
 * (① 그림자 → ② live 스위치, 선행 간선 1)으로 낸다. 표지가 없으면 어떤 문면이든 종전 LLM 분해 그대로다.
 *
 * ⛔ 발동은 명시 표지 «하나»뿐이다 — 자연어 감지(자율 표지·운영 실증·부정어)는 쓰지 않는다.
 *   자연어 부정 판별은 수렴하지 않았고(리뷰 r4~r6), 오탐은 live 조각이 원 목표와 반대로 «켜라»를 지시하게 만든다.
 *   자연어 감지 발동은 후속 개선(OP 결정 10-15).
 * 런 슈퍼바이저 REVIEW-MUSTFIX-CLASSIFY ②가 «런 중간»에 같은 쪼개기를 한다 — 저작이 먼저 막고 그쪽은 놓친 것을 받는다.
 */
export const SHADOW_FIRST_SPLIT_MARKER = '분할: 그림자 먼저';
/**
 * 정확히 한 꼴 — 한 줄 «전체»가 `분할: 그림자 먼저` 와 같을 때만(콜론 뒤 공백 정확히 1개 · 앞·뒤 공백 불허).
 * 줄바꿈은 LF·CRLF 만 — 홀로 남은 CR 은 줄의 일부로 남아 불일치(미발동)다.
 */
function hasShadowFirstSplitMarkerLine(objective: string): boolean {
  return objective.split(/\r?\n/).some((line) => line === SHADOW_FIRST_SPLIT_MARKER);
}

export type ShadowFirstSplitPiece = { id: 'shadow' | 'live'; step: string; dependsOn: readonly ('shadow' | 'live')[] };

export type ShadowFirstSplitVerdict =
  | { kind: 'shadow-first-split'; pieces: readonly [ShadowFirstSplitPiece, ShadowFirstSplitPiece] }
  | { kind: 'single-piece' };

/** 순수 판정 — 골 문면의 명시 표지 줄만 본다(LLM·원장·자연어 감지 0 · 던지지 않는다). grounding context 는 읽지 않는다. */
export function classifyShadowFirstSplit(objective: string): ShadowFirstSplitVerdict {
  if (!hasShadowFirstSplitMarkerLine(objective)) return { kind: 'single-piece' };
  return {
    kind: 'shadow-first-split',
    pieces: [
      {
        id: 'shadow',
        step: '① 그림자 — 이 골의 배선이 자율 결정을 «기록만» 한다(자율 실행 0). 판정 = 시험 통과 ⊕ 그림자 관측 줄 모양(기록된 결정 1건 이상).',
        dependsOn: [],
      },
      {
        id: 'live',
        step: '② live 스위치 — 선행 = ① 그림자 착지. 같은 배선의 자율 실행을 켠다. 판정 = ① 착지 뒤 그림자 로그에 기대 결정 1건 이상 ⊕ 스위치 켬 ⊕ 이 골의 원 판정.',
        dependsOn: ['shadow'],
      },
    ],
  };
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
    // ⭐ AUTHOR-SHADOW-FIRST-SPLIT ① — LLM 분해·적대 비평 «전에» 규칙 판정. 감지된 골은 처음부터 두 조각.
    //   single-piece 는 관측 0 · 동작 0 변화(종전 그대로).
    const shadowSplit = classifyShadowFirstSplit(objective);
    if (shadowSplit.kind === 'shadow-first-split') {
      try {
        debug.log('goal-author', 'shadow-first-split', {
          surface: 'goal-author',
          verdict: shadowSplit.kind,
          trigger: 'explicit-marker',
          pieces: shadowSplit.pieces.map((piece) => piece.id),
          edges: shadowSplit.pieces.reduce((n, piece) => n + piece.dependsOn.length, 0),
          ...(options?.runId === undefined ? {} : { runId: options.runId }),
        });
      } catch { /* observation is fail-soft */ }
      return finalize(
        shadowSplit.pieces.map((piece) => piece.step),
        `명시 표지 «${SHADOW_FIRST_SPLIT_MARKER}» — 그림자 우선 두 조각(선행 간선 1).`,
      );
    }
    const { streamLLM } = await import('../llm.js');
    // ⭐ AUTHOR-DECOMPOSE-KNOB(0.2.24 · G7 #25848) — 쪼개기·적대 비평의 두 streamLLM 호출이 인핸서와
    //   «같은 규칙»으로 planning 노브(roleLlm.planning ⊕ ELANOUS_PROMPT_ENHANCE_MODEL/EFFORT)를 따른다.
    //   미설정이면 종전 그대로 — model 은 아예 전달하지 않는다(streamLLM 기본 모델) ⊕ effort 는 high.
    const { model, effort } = selectPlanningLlm();
    const llmOpts: { model?: string; reasoningEffort: 'low' | 'medium' | 'high' } = model === undefined
      ? { reasoningEffort: effort }
      : { model, reasoningEffort: effort };
    let decompositionRationale: string | undefined;
    const steps = await llmDecomposeSteps(
      objective,
      (input) => streamLLM([{ role: 'user', content: input.prompt }], () => {}, llmOpts).then((text) => ({ text })),
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
    if (!reviewExecuted) return finalize(steps, decompositionRationale);
    const critic = (prompt: string) => streamLLM([{ role: 'user', content: prompt }], () => {}, llmOpts);

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
