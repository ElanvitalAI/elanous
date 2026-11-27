// ── CONTEXT-BUDGET-ROTATION (0.3.34) — 회전 판정 상수 + 순수 함수 ──
// 세션 예산의 고정 접두/기록/턴 휘발성/요청 상한을 한 곳에 둔다. 기록 예산은
// long-session-compact 의 TURN_COMPACT_HISTORY_TOKENS 와 같은 값으로, 재선언이
// 아니라 import 재수출로 공유한다(두 매직 넘버가 어긋나면 판정 기준이 갈라진다).

import { estimateTokens } from '../tokens.js';

/** 고정 접두(시스템 프롬프트·좌석 지시 등) 예산. 출처: 정본 CONTEXT-BUDGET-ROTATION 설계. */
export const CONTEXT_FIXED_PREFIX_TOKENS = 14_000;

/** 기록(저장된 이력 행) 예산 — 원본 상수를 재수출한다(재선언 금지). */
export {
  TURN_COMPACT_HISTORY_TOKENS as CONTEXT_RECORD_TOKENS,
  TURN_COMPACT_FULL_INPUT_TOKENS as CONTEXT_FULL_INPUT_TOKENS,
} from './long-session-compact.js';

/** 턴 휘발성 블록(턴별 컨텍스트) 예산. */
export const CONTEXT_TURN_VOLATILE_TOKENS = 2_000;

/** 모델 요청 입력 상한. */
export const CONTEXT_REQUEST_INPUT_CEILING = 32_000;

/** HANDOFF 문서 상한 — 새 세션 첫 system 행의 크기. */
export const CONTEXT_HANDOFF_MAX_TOKENS = 2_000;

/** 교대 판정 — no-op 연속 임계. */
export const CONTEXT_ROTATION_NO_OP_STREAK = 2;
/** 교대 판정 — 턴수 상한(장기 런에서 기록이 작아도 턴 수로 갈아엎는 밸브). */
export const CONTEXT_ROTATION_TURN_CAP = 400;

export interface RotationCheck {
  /** 연속 no-op compaction 횟수. */
  noOpStreak: number;
  /** 세션 누적 턴 수(사람 user 행 기준). */
  turnCount: number;
  /** 진행 턴 중 — true면 절대 교대하지 않는다(턴 중 세션 스왑 금지). */
  turnInFlight: boolean;
  /** 마지막 사람 턴이 답변 완료인가 — 미응답 사람 턴을 요약로 흘리지 않는 가드. */
  lastHumanTurnAnswered: boolean;
}

/** 교대 판정: no-op 연속 ≥2 또는 턴수 상한 도달. 진행 턴·미응답 사람 턴은 금지. */
export function shouldRotate(check: RotationCheck): boolean {
  if (check.turnInFlight) return false;
  if (!check.lastHumanTurnAnswered) return false;
  return check.noOpStreak >= CONTEXT_ROTATION_NO_OP_STREAK || check.turnCount >= CONTEXT_ROTATION_TURN_CAP;
}

/** 기록 토큰 측정(교대 로그·판정 보조) — 콘텐츠 문자열 기준 합. */
export function measureRecordTokens(messages: readonly { content: string }[]): number {
  let total = 0;
  for (const m of messages) total += estimateTokens(m.content);
  return total;
}
