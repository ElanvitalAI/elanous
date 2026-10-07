/**
 * TASK-AGENT-SHADOW — 슈퍼바이저가 런의 멈춤을 확정한 자리에서 판단부를 «그림자»로 부른다.
 *
 * RFC-task-agent-any-task-to-completion-2026-10-06 §A9 «판단부 호출부 0»을 메운다.
 * - 입력은 슈퍼바이저 결과에 «이미 실려 있는» 값만 쓴다(네트워크 호출 0): 종료 어휘 ·
 *   PR 번호/병합 여부(`prNumber`·`merged`). 리뷰 판정·must-fix 는 결과에 없으므로 비운다
 *   («통과»로 읽지 않는다 — 판단부가 review 수를 고른다).
 * - 실행부는 언제나 shadow 로 부른다: «했을 수»만 기록하고 명령은 하나도 돌리지 않는다.
 *   설정 `taskAgent.mode=live` 도 이 경로에는 먹지 않는다(실행은 `autopilot task-agent-action` 몫).
 * - 관측: `debug.log('task-agent', 'shadow-move', …)` → `elanous logs --category task-agent`.
 */
import { debug } from '../debug/log.js';
import type { SupervisorJobResult, SupervisorStopReason } from '../self-dev/run-supervisor.js';
import { executeNextAction, type NextAction } from './actions.js';
import { judgeNextMove, type TaskJudgeInput, type TaskJudgement } from './judge.js';

export interface TaskAgentShadowInput {
  runId: string | null;
  stopReason: SupervisorStopReason;
  results: readonly SupervisorJobResult[];
}

export interface TaskAgentShadowMove {
  runId: string | null;
  stopReason: SupervisorStopReason;
  move: TaskJudgement['move'];
  executorKind: TaskJudgement['executorKind'] | null;
  variant: TaskJudgement['executorVariant'] | null;
  reason: string;
  /** 실행부 결과 — shadow 경로에서는 늘 'shadow'(실행부 밖의 수면 null). */
  executorResult: string | null;
  /** 실행부가 남긴 «했을 수» 문면. */
  wouldDo: string | null;
  pr: number | null;
}

export interface TaskAgentShadowDeps {
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  /** 시험용 — shadow 실행부가 명령을 부르면 여기로 온다(정상이면 0회). */
  command?: (args: string[]) => Promise<{ status: number; stdout: string; stderr?: string }>;
}

/** 슈퍼바이저 결과에서 판단부 입력을 만든다 — 추가 조회 없이 이미 실린 값만. */
export function shadowJudgeInput(stopReason: SupervisorStopReason, results: readonly SupervisorJobResult[]): TaskJudgeInput {
  const withPr = results.filter((result) => typeof result.prNumber === 'number' && result.prNumber > 0);
  const input: TaskJudgeInput = { stopReason };
  if (withPr.length > 0) {
    input.pr = withPr[0]!.prNumber!;
    // 병합 여부만 결과에 실린다 — 닫힘(CLOSED)은 여기서 모른다. 병합이 아니면 OPEN 으로 둔다(판단부는 MERGED 만 본다).
    input.prState = withPr.every((result) => result.merged === true) ? 'MERGED' : 'OPEN';
  }
  return input;
}

export async function recordTaskAgentShadowMove(input: TaskAgentShadowInput, deps: TaskAgentShadowDeps = {}): Promise<TaskAgentShadowMove> {
  const judgeInput = shadowJudgeInput(input.stopReason, input.results);
  const judgement = judgeNextMove(judgeInput);
  let executorResult: string | null = null;
  let wouldDo: string | null = null;
  if (judgement.executorKind) {
    const action: NextAction = {
      kind: judgement.executorKind,
      ...(judgement.executorVariant ? { variant: judgement.executorVariant } : {}),
      taskId: input.runId ?? 'run-unknown',
      rationale: judgement.reason,
      pr: typeof judgeInput.pr === 'number' ? judgeInput.pr : 0,
      runId: input.runId ?? '',
      original: [...new Set(input.results.map((result) => result.feature))].join(' · '),
      checklistId: '',
    };
    executorResult = await executeNextAction(action, {
      mode: 'shadow',
      command: deps.command ?? (async () => { throw new Error('task-agent shadow path must not run commands'); }),
      observe: (_event, data) => { wouldDo = data.reason; },
    });
  }
  const move: TaskAgentShadowMove = {
    runId: input.runId,
    stopReason: input.stopReason,
    move: judgement.move,
    executorKind: judgement.executorKind ?? null,
    variant: judgement.executorVariant ?? null,
    reason: judgement.reason,
    executorResult,
    wouldDo,
    pr: typeof judgeInput.pr === 'number' ? judgeInput.pr : null,
  };
  (deps.log ?? ((category, event, data) => debug.log(category, event, data)))('task-agent', 'shadow-move', { ...move });
  return move;
}
