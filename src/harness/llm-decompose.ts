// 하니스 LLM decompose (H2 · Planner seam · 2026-07-21)
//
// DESIGN-cross-surface-autonomy-membrane §14f H2(Planner seam·decompose 순수로직 차용). 마커 없는
// 자유서술 objective 는 parseHeuristicPlan 이 통째로 1스텝으로 붕괴 → Executor 가 분해 없이 단발 구현한다.
// 이 헬퍼는 **이미 DB-free 로 승격된 순수 브레인** `TaskGenerator`(task-orchestrator/generator)를 그대로
// 재사용해 richer 스텝으로 분해한다.
//
// ★★ 방화벽(제1원칙·[[feedback_signal_wiring_via_mission]]): mission-engine(decomposeMissionToPhases·
//   defaultDecomposeCallable)을 **import 하지 않는다** — TaskStore/registry/FS 초안이 딸리는 heavy 층이다.
//   `TaskGenerator` 만 소비 → 미션 DB 읽기/쓰기 0. callable 은 호출측이 streamLLM 으로 주입(mission-engine 우회).
//
// ★ fail-soft: parse/validation 실패나 LLM 오류 시 [] 반환 → 상위(plan seam)가 [objective] 단일 스텝 유지(무회귀).

import { TaskGenerator, type DecomposeCallable } from '../task-orchestrator/generator.js';
import type { DecomposePromptProfile } from '../task-orchestrator/generator-prompt.js';
import { debug } from '../debug/log.js';

const observe = (data: Record<string, unknown>): void => {
  try { debug.log('harness.llm-decompose', 'completed', data); } catch { /* fail-soft */ }
};

const OBSERVATION_ERROR_FALLBACK = 'error reason unavailable';

const observationErrorReason = (error: unknown): string => {
  try {
    return (error instanceof Error ? error.message : String(error)).slice(0, 120);
  } catch {
    return OBSERVATION_ERROR_FALLBACK;
  }
};

/**
 * 자유서술 objective 를 스텝 제목 배열로 분해. 실패/빈 결과 시 []([]는 상위가 무시).
 * @param callable LLM 호출(streamLLM 등) — 호출측 주입. DB 무접촉.
 * @param opts.context Planner grounding 블록(코드/skill 팩트) → decompose 프롬프트 activeSummary 로 실려 richer 분해.
 */
export async function llmDecomposeSteps(
  objective: string,
  callable: DecomposeCallable,
  opts?: { context?: string; maxTasks?: number; promptProfile?: DecomposePromptProfile; signal?: AbortSignal; onRationale?: (rationale: string) => void },
): Promise<string[]> {
  const startedAt = Date.now();
  const promptProfileObservation = opts?.promptProfile ? { promptProfile: opts.promptProfile } : {};
  if (!objective.trim()) {
    observe({ inputLength: objective.length, taskCount: 0, durationMs: Date.now() - startedAt, failed: false, ...promptProfileObservation });
    return [];
  }
  try {
    const gen = new TaskGenerator({ callable });
    const result = await gen.decompose(
      {
        objective,
        goalKind: 'coding',
        ...(opts?.promptProfile ? { promptProfile: opts.promptProfile } : {}),
        ...(opts?.context ? { context: { activeSummary: opts.context } } : {}),
        ...(opts?.maxTasks ? { constraints: { maxTasks: opts.maxTasks } } : {}),
      },
      opts?.signal ? { signal: opts.signal } : undefined,
    );
    const steps = result.proposal.tasks.map((t) => t.title).filter((t) => !!t && t.trim().length > 0);
    observe({ inputLength: objective.length, taskCount: result.proposal.tasks.length, durationMs: Date.now() - startedAt, failed: false, ...promptProfileObservation });
    try { opts?.onRationale?.(result.proposal.rationale); } catch { /* Observation cannot change the proposed steps. */ }
    return steps;
  } catch (error) {
    observe({ inputLength: objective.length, taskCount: 0, durationMs: Date.now() - startedAt, failed: true, error: observationErrorReason(error), ...promptProfileObservation });
    return []; // fail-soft — 상위가 휴리스틱/단일 스텝 유지.
  }
}
