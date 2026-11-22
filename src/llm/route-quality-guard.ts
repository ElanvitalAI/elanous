// ── ROUTER-QUALITY-GUARD-95 — 가벼운 선출 → 유형별 품질 게이트 → (미달 시) 고급 상향 ──
//
// OP 0.3.33 순위표 8위·P0(ROUTER-QUALITY-GUARD-95). 이 모듈은 «라우팅 정책»이 아니라
// «품질 가드 판정»이다: 호출자(라우터·어드바이저)가 가벼운 모델을 먼저 고르고, 게이트가
// 통과하면 그대로 인도하고, 미달이면 고급 모델로 정확히 한 번 상향한다.
// 결정은 RouteDecision(route-decision.ts)과 같은 «읽기모델» 철학을 따른다 — 실행은 호출자 소유.
//
// jud-39614 mustFix ①②: ① shadow 대차 — 과제당 프리미엄 평가를 정확히 1회 수행해 대차 근거를
// 남기고(통과 분의 그림자 점수), 게이트 실패 시 그 점수를 그대로 인도 점수로 재사용한다(추가 evaluate 0).
// ② 유형별 임계 — 인도 허용 최소 품질을 taskType별 floors 맵으로 적용하고 적용값(appliedFloor)을 근거로 남긴다.

/** 인도 허용 최소 품질 기본값 — floors에 없는 유형의 폐백(ROUTER-QUALITY-GUARD-95). */
export const DEFAULT_QUALITY_FLOOR = 0.95;

export interface GuardedRouteDecision {
  /** 이번 과제에 인도할 모델 (게이트 통과 시 lightweight, 미달 시 premium). */
  model: string;
  /** true = 게이트 실패로 고급 상향한 재시도. */
  escalated: boolean;
  /** 인도 모델의 품질 점수 (상향분은 프리미엄 점수). */
  qualityScore: number;
  /** 가벼운 첫 시도의 점수 (상향하지 않은 경우 qualityScore와 같음). */
  firstAttemptScore: number;
  /** shadow: 같은 rubric으로 프리미엄을 평가한 점수(과제당 1회). shadow:false면 null. */
  shadowScore: number | null;
  /** shadowScore − firstAttemptScore(프리미엄 대차). shadow:false면 null. */
  shadowDelta: number | null;
  /** 이번 과제 유형(floors 조회 키). */
  taskType: string;
  /** 적용된 인도 임계 — floors[taskType] ?? DEFAULT_QUALITY_FLOOR. */
  appliedFloor: number;
}

export interface DecideGuardedRouteInput {
  lightweight: string;
  premium: string;
  /** 모델 하나의 품질을 측정하는 게이트(0~1). 가벼운 1회 + shadow 시 프리미엄 1회. */
  evaluate: (model: string) => number | Promise<number>;
  /** 과제 유형 — floors 조회 키(필수). */
  taskType: string;
  /** 유형→인도 임계. 미등록 유형은 DEFAULT_QUALITY_FLOOR 폐백. */
  floors?: Readonly<Record<string, number>>;
  /** true(기본) = 통과 분도 프리미엄을 정확히 1회 평가해 shadow 대차 근거를 남긴다. false = 게이트 실패 분에서만 프리미엄 평가. */
  shadow?: boolean;
}

/**
 * 가벼운 선출 → 유형별 게이트 → (미달 시) 고급 상향. 게이트 통과 시 가벼운을 유지한다(비용 절감이 목적).
 * 프리미엄 평가는 과제당 정확히 1회다: shadow:on이면 통과 분의 대차 근거로 쓰이고, 게이트 실패 분은
 * 그 점수를 그대로 인도 점수로 재사용한다(shadow:off + 게이트 실패 시에만 실패 분에서 1회).
 */
export async function decideGuardedRoute(input: DecideGuardedRouteInput): Promise<GuardedRouteDecision> {
  // OP #132280 필수 1: 완료선 «task-type 별 ≥95%» — floors의 모든 바닥은 0.95 이상이어야 한다.
  // (0.95 미만 값을 넣으면 그 유형의 인도 품질 하한이 깨지므로 설정 오류로 거부한다.)
  for (const [type, floor] of Object.entries(input.floors ?? {})) {
    if (!(floor >= DEFAULT_QUALITY_FLOOR))
      throw new Error(`route-quality-guard: floor for "${type}" is ${floor}, must be >= ${DEFAULT_QUALITY_FLOOR} (OP #132280)`);
  }
  const shadowOn = input.shadow !== false;
  const appliedFloor = input.floors?.[input.taskType] ?? DEFAULT_QUALITY_FLOOR;
  const firstAttemptScore = await input.evaluate(input.lightweight);
  let shadowScore: number | null = null;
  if (shadowOn) shadowScore = await input.evaluate(input.premium);
  const shadowDelta = shadowScore === null ? null : shadowScore - firstAttemptScore;
  const base = { firstAttemptScore, shadowScore, shadowDelta, taskType: input.taskType, appliedFloor };
  if (firstAttemptScore >= appliedFloor) {
    return { model: input.lightweight, escalated: false, qualityScore: firstAttemptScore, ...base };
  }
  const premiumScore = shadowScore ?? await input.evaluate(input.premium);
  return { model: input.premium, escalated: true, qualityScore: premiumScore, ...base };
}