/**
 * TA-LIVE-MOVE-CARD-HISTORY — live-move(실행 · 그림자)를 «그 카드의 history» 에 한 줄로 남긴다.
 *
 * - 왜: live-move 사건은 logs(`task-agent` · `live-move`)에만 남았다 — 운영 logs.db 는 상한 정리로 약 2시간 창이라
 *   몇 시간 뒤엔 «0행»이 되고, 그 사건을 근거로 한 green 이 철회됐다(2026-10-10). 카드 원장은 정리되지 않는다.
 * - 무엇을: `{ at, event:'live-move', kind, executed, ok, executorResult(shadow|live), detail, runId?, pr?, head?, effect }`.
 *   `effect` 는 «그 수의 효과»를 아는 만큼만 — 모르면 `unknown`(지어내지 않는다).
 * - 쓰기 길: `updateTaskCard`(실행부·`run-bound` 와 같은 잠금 · 같은 상태 파일). 기존 history 항목은 건드리지 않고 덧붙이기만.
 * - 쓰기 실패는 live-move 를 막지 않는다 — 관측(`task-agent` · `live-move-history-failed`)만 남기고 돌아간다.
 */
import { debug } from '../debug/log.js';
import type { LiveMoveResult, TaskAgentLiveMove } from './live-moves.js';
import { LIVE_MOVE_HISTORY_EVENT, updateTaskCard, type TaskCard, type TaskCardEvent } from './task-hand.js';

export const LIVE_MOVE_EFFECT_UNKNOWN = 'unknown';
/** 리뷰는 떼어 띄운다(`defaultRequestReview` · stdio ignore) — 판정·must-fix·reviewRoute 는 그 리뷰 자기 관측에만 있다. */
export const LIVE_REVIEW_EFFECT_REQUESTED = 'review requested · result not received (self review runs detached; verdict/must-fix/reviewRoute not reported back)';
/** TA-REVIEW-RESULT-CAPTURE — 결과 파일로 받는 review: 결과는 다음 TA 틱 · `tasks show` 가 `live-move-result` 줄로 회수한다. */
export const LIVE_REVIEW_EFFECT_PENDING = 'review requested · result pending (self review runs detached; --json result expected at resultPath, appended as live-move-result on a later TA tick or tasks show)';

interface LiveMoveHistoryBase {
  at: string;
  /** 판단한 수의 종류(설정 어휘 그대로 — propose-land 는 propose-land). 실행부 결과의 kind('land')와 섞지 않는다. */
  kind: TaskAgentLiveMove;
  runId?: string | null;
  pr?: number;
  /** 수 «전»에 읽은 카드의 기록(머리 판정용) — 없으면 head 를 싣지 않는다. */
  before?: Pick<TaskCard, 'reviewRequests' | 'landAttempts'>;
}

/**
 * 호출부가 «아는 사실»을 명시한다 — live 는 실행부 결과가 «반드시» 있고, shadow 는 «실행부를 부르지 않았다»는 판단 사유가 있다.
 * 결과 부재만으로 shadow·미실행을 단정하지 않게 둘을 타입으로 가른다.
 */
export type LiveMoveHistoryInput = LiveMoveHistoryBase & (
  | { executorResult: 'live'; result: LiveMoveResult; shadowDetail?: never }
  | { executorResult: 'shadow'; shadowDetail: string; result?: never }
);

/**
 * 효과 한 줄 — 아는 만큼만.
 * - shadow · 실행 안 됨 → `none — …`(부작용이 없었다는 것은 «안다»).
 * - review 실행 → 요청만 했고 결과는 못 받았다(비동기).
 * - land 성공 → «실행부가 ok 를 보고했다»만 적는다(병합 상태는 여기서 다시 확인하지 않는다) · 병합 sha 는 모른다.
 * - propose-green 실행 → 칸 id.
 * - 그 밖(land 실패 · 카드 갱신 실패 등) → `unknown`.
 */
export function liveMoveEffect(input: Pick<LiveMoveHistoryInput, 'executorResult' | 'result'>, checklistId?: string | null): string {
  if (input.executorResult === 'shadow') return 'none — shadow (not executed)';
  const result = input.result;
  if (!result) return LIVE_MOVE_EFFECT_UNKNOWN;
  if (!result.executed) return 'none — not executed';
  if (result.kind === 'review' && result.ok) return result.resultPath ? LIVE_REVIEW_EFFECT_PENDING : LIVE_REVIEW_EFFECT_REQUESTED;
  if (result.kind === 'land' && result.ok) return 'land reported ok by the executor (merge state not re-checked here) · merge sha not reported';
  if (result.kind === 'propose-green' && result.ok) return `green proposed · checklist ${checklistId ?? '-'} (checklist untouched)`;
  return LIVE_MOVE_EFFECT_UNKNOWN;
}

type MoveRecord = { pr: number; head: string; at: string };

/**
 * 실행한 머리 — 수 «전»에 읽은 카드(`before`)와 기록 시점 카드를 비교해, 그 PR 에 «이번 수 동안 새로 생긴» 기록
 * (reviewRequests · landAttempts)이 정확히 하나일 때만 그 머리다. 둘 이상(겹친 수)·없음·실행 안 함·`before` 모름 → 싣지 않는다(지어내지 않는다).
 */
function executedHead(card: TaskCard, input: LiveMoveHistoryInput): string | undefined {
  if (!input.result?.executed || input.pr === undefined || !input.before) return undefined;
  const pick = (c: Pick<TaskCard, 'reviewRequests' | 'landAttempts'>): readonly MoveRecord[] =>
    (input.kind === 'review' ? c.reviewRequests : input.kind === 'propose-land' ? c.landAttempts : undefined) ?? [];
  const key = (entry: MoveRecord) => `${entry.pr}\u0000${entry.head}\u0000${entry.at}`;
  const seen = new Set(pick(input.before).map(key));
  const fresh = pick(card).filter((entry) => entry.pr === input.pr && !seen.has(key(entry)));
  if (fresh.length !== 1) return undefined;
  const entry = fresh[0]!;
  // 귀속 확인 — 그 기록이 «이 결과»의 것임을 결과 쪽 사실로 맞춰 본다. 못 맞추면 싣지 않는다.
  const result = input.result;
  // land 결과는 머리를 싣지 않는다(detail = pr land 출력 꼬리) — 호출별 귀속 근거가 없으니 land 줄엔 head 를 싣지 않는다.
  const attributed = input.kind === 'review' && result.detail.includes(entry.head.slice(0, 12));
  return attributed ? entry.head : undefined;
}

export function liveMoveHistoryEntry(card: TaskCard, input: LiveMoveHistoryInput): TaskCardEvent {
  const head = executedHead(card, input);
  return {
    at: input.at,
    event: LIVE_MOVE_HISTORY_EVENT,
    kind: input.kind,
    executed: input.result?.executed ?? false,
    // 실행 결과가 없으면(그림자) ok 는 «미상» — 칸을 싣지 않는다(참으로 기본값을 주지 않는다).
    ...(input.result ? { ok: input.result.ok } : {}),
    executorResult: input.executorResult,
    // 자르지 않는다 — 실행부 detail 은 이미 짧게(≤300) 만들어지고, 오래 보존할 근거를 조용히 잘라 두지 않는다.
    detail: input.result?.detail ?? input.shadowDetail ?? '',
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.pr !== undefined ? { pr: input.pr } : {}),
    ...(head ? { head } : {}),
    // TA-REVIEW-RESULT-CAPTURE — 실행한 review 만 결과 파일 경로를 싣는다(다른 수 · 그림자 줄은 종전 칸 그대로).
    ...(input.result?.executed && input.result.resultPath ? { resultPath: input.result.resultPath } : {}),
    effect: liveMoveEffect(input, card.checklistId ?? null),
  };
}

export type LiveMoveHistoryOutcome = { written: true; entry: TaskCardEvent } | { written: false; reason: string };

/**
 * 카드 history 에 한 줄을 덧붙인다. 던지지 않는다 — 실패·카드 없음은 관측으로 남기고 결과로 돌려준다.
 * `log` 는 호출자의 관측 seam(없으면 `debug.log`).
 */
export function recordLiveMoveHistory(
  statePath: string, cardId: string, input: LiveMoveHistoryInput,
  log: (category: string, event: string, data: Record<string, unknown>) => void = (c, e, d) => debug.log(c, e, d, { level: 'warn' }),
): LiveMoveHistoryOutcome {
  let entry: TaskCardEvent | undefined;
  let missing = false;
  let outcome: LiveMoveHistoryOutcome;
  try {
    updateTaskCard(statePath, cardId, (current) => {
      if (!current) { missing = true; return undefined; }
      entry = liveMoveHistoryEntry(current, input);
      return { ...current, history: [...(current.history ?? []), entry] };
    });
    outcome = missing || !entry ? { written: false, reason: 'task card not in state file' } : { written: true, entry };
  } catch (error) {
    outcome = { written: false, reason: (error instanceof Error ? error.message : String(error)).slice(-300) };
  }
  if (!outcome.written) {
    try {
      log('task-agent', 'live-move-history-failed', {
        card: cardId, kind: input.kind, executorResult: input.executorResult, executed: input.result?.executed ?? false, reason: outcome.reason,
      });
    } catch { /* fail-soft */ }
  }
  return outcome;
}
