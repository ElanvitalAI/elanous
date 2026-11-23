// HQ-PTY-BUDGET-GUARD — 호스트 단위 PTY 예산 가드의 순수 계산부 (출처: #130442).
//
// 사건(2026-11-22): PTY 풀 고갈 — ttys 527·고아 484 (출처: #130253 사고 보고 · #130442 풀 복구 510→140·509→70).
// 구조 원인: registry.MAX_CONCURRENT 는 «프로세스별» Map 크기만 본다 — 홀더·하니스 프로세스가 늘면
// 호스트 openpty 풀은 무제한으로 소진된다. 칸 완료선: «호스트 PTY 사용 ≥85% 면 새 자리·하니스 자식
// PTY 발급 거부 + 고아 보유자 회수» (출처: #130442).
//
// 분리: 상한 산정·판별 = 이 순수 함수(주입형 입력 — 제품 상수 import 없이 시험 가능).
// 실측부(원장 고아 회수·점유 계수·배선·감사) = registry.startPty 초크포인트.
// 미무장(ELANOUS_PTY_HOST_BUDGET 없음/0/파손) = 수동 모드 — 종전 동작 그대로(양식: src/budget-guard/budget-guard.ts Decision M4).

/** 거부 임계(퍼센트) — 칸 원문 그대로. */
export const PTY_BUDGET_DENY_AT_PCT = 85; // 출처: #130442 · 칸 원문 «호스트 PTY 사용 ≥85% 면 새 자리·하니스 자식 PTY 발급 거부»

export interface PtyBudgetGuardInput {
  /** 호스트 원장(alive=1) 라이브 PTY 행 수 — 고아 회수(reap) 직후 값. */
  readonly occupied: number;
  /** 호스트 PTY 예산(ELANOUS_PTY_HOST_BUDGET). 0 이하 = 미무장(수동). */
  readonly capacity: number;
  /** 거부 임계(퍼센트). */
  readonly denyAtPct: number;
}

export interface PtyBudgetGuardDecision {
  readonly verdict: 'allow' | 'deny';
  /** true = 예산 미무장(상한 0 이하) — 판정 없이 통과(종전 동작). */
  readonly passive: boolean;
  readonly occupied: number;
  readonly capacity: number;
  /** 이번 발급분까지 포함한 점유 — «다음» 발급이 상한을 넘는지 본다(예약-1). */
  readonly projectedOccupied: number;
  /** projectedOccupied/capacity 백분율(표시용). 미무장이면 0. */
  readonly projectedPct: number;
  readonly denyAtPct: number;
  readonly denyReason: string | null;
}

export function decidePtyBudgetGuard(input: PtyBudgetGuardInput): PtyBudgetGuardDecision {
  const occupied = Number.isFinite(input.occupied) && input.occupied > 0 ? Math.trunc(input.occupied) : 0; // 출처: #130442 — 파손 점유 입력은 빈 원장(0)으로
  const capacity = Number.isFinite(input.capacity) && input.capacity > 0 ? Math.trunc(input.capacity) : 0; // 출처: #130442 — 파손·비양수 예산 = 미무장(0)
  const denyAtPct = Number.isFinite(input.denyAtPct) && input.denyAtPct > 0 ? input.denyAtPct : PTY_BUDGET_DENY_AT_PCT; // 출처: #130442 — 임계 파손 방어(기본 상수로)
  const projectedOccupied = occupied + 1; // 출처: #130442 — 예약-1: 다음 발급분까지 계산
  // 정수 교차곱 비교 — 부동소수 함정(17/20*100 = 84.999…) 회피: 17*100 ≥ 85*20 이 정확히 성립한다.
  const deny = capacity > 0 && projectedOccupied * 100 >= denyAtPct * capacity; // 출처: #130442 — 100=백분율 환산(정수 비교)
  const projectedPct = capacity > 0 ? (projectedOccupied * 100) / capacity : 0; // 출처: #130442 — 100=백분율 환산(표시용)
  const denyReason = deny
    ? `pty host budget guard: projected ${projectedOccupied}/${capacity} = ${projectedPct}% ≥ ${denyAtPct}% (occupied ${occupied}, budget ELANOUS_PTY_HOST_BUDGET=${capacity}) — close or reap a PTY before starting another`
    : null;
  return {
    verdict: deny ? 'deny' : 'allow',
    passive: capacity <= 0, // 출처: #130442 — 예산 0 이하 = 미무장 판정 표시
    occupied,
    capacity,
    projectedOccupied,
    projectedPct,
    denyAtPct,
    denyReason,
  };
}

/** ELANOUS_PTY_HOST_BUDGET 해석 — 양의 정수만 무장. 나머지(없음·빈값·파손·0·음수·소수)는 0=수동. */
export function parsePtyHostBudgetEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 0; // 출처: #130442 — 미설정/빈값 = 수동(종전 동작)
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return 0; // 출처: #130442 — 0·음수·소수·파손 = 수동
  return parsed;
}
