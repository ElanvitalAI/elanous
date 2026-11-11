// ── 미션 실행 예산 정책 — config-first 오버라이드 (2026-07-14) ────────────────
//
// 두 예산이 있었는데 통로가 반쪽이었다:
//   • walker(조사) 예산: env(ELANOUS_WALKER_BUDGET) 만 — 구 패턴
//   • SE(코딩) 예산: SE_BUDGET_LADDER 하드코딩 상수 — 오버라이드 전무(코드 편집만)
// 대표 지시(2026-07-14): SE 코딩 예산에 오버라이드 장치를 만들고, 정책을 통일한다.
//
// 결정 순서(feedback_config_over_env 선례 — 새 노브는 user-config 우선·env fallback):
//   1) user-config: autopilot.budget.se / autopilot.budget.walker (숫자 배열 또는 "a,b,c")
//   2) env fallback: ELANOUS_SE_BUDGET / ELANOUS_WALKER_BUDGET (쉼표 구분)
//   3) 하드코딩 기본값
// config 우선이라 `elanous config` 로 코드 변경 0·인스턴스별(테스트 config 만 상향) 조정 가능.

import { getUserConfig } from '../user-config/reader.js';

/** SE(코딩) 페이즈 예산 계단 — maxTurns(턴 상한·attempt 수). fallback 기본값일 뿐(config-first).
 *  ★ 2026-07-23 대표 재설계 "멀티 엘리베이션 불요·첫 실패 시 조율자 triage" — 운영은 **config
 *  `autopilot.budget.se` 를 단일 rung([12])로** 두어 단일 시도 후 실패 시 hasMoreRungs=false→split(조율자
 *  재구조화). 종전 다단 [150,400,1000] escalation 은 과대결합 페이즈를 grind 하는 근원(terra→opus→opus 전부
 *  gate-fail=scoping 문제·분할로 즉시 해소). 이 상수는 config/env 미설정 시 fallback(에스컬레이션 메커니즘
 *  자체는 보존·명시 다단 ladder 넘기면 동작). goal-loop iteration 캡(=12·유일 제약)은 se-elanous-self-impl. */
export const SE_BUDGET_LADDER_DEFAULT: readonly number[] = [150, 400, 1000];
/** walker(조사) 페이즈 예산 계단 — maxTokens(토큰 상한). */
export const WALKER_BUDGET_DEFAULT: readonly number[] = [128000, 256000, 512000];

/** 배열 또는 "a,b,c" 문자열 → 양수 number[]. 유효값 0개면 null(폴백 유도). 순수. */
export function parseBudgetList(raw: unknown): number[] | null {
  const src = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : null;
  if (!src) return null;
  const nums = src.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? nums : null;
}

/** user-config 의 dotted 경로에서 예산 배열 읽기(fail-soft). autopilot.budget.<key>.
 *  ★ 2026-07-19 수복 — autopilot 설정은 typed 필드가 아니라 **`.raw.autopilot`** 아래 있다(게이트
 *  selfHealAutoExec 등과 동일 경로). 종전엔 typed `.autopilot.budget` 를 읽어 **항상 undefined→env/기본
 *  폴백**이라 config 노브(autopilot.budget.walker/se)가 죽어 있었다(#4103 config-first 의도 미실현·라이브
 *  dogfood 로 발견). raw 우선·typed 폴백(setUserConfigOverlay 로 typed autopilot 을 주입하는 테스트 호환). */
function budgetFromConfig(key: 'se' | 'walker'): number[] | null {
  try {
    const cfg = getUserConfig() as {
      raw?: { autopilot?: { budget?: Record<string, unknown> } };
      autopilot?: { budget?: Record<string, unknown> };
    };
    const budget = cfg?.raw?.autopilot?.budget ?? cfg?.autopilot?.budget;
    return parseBudgetList(budget?.[key]);
  } catch {
    return null; // config 접근 실패는 예산 결정을 막지 않는다(폴백)
  }
}

/** SE(코딩) 예산 계단 — config → env(ELANOUS_SE_BUDGET) → 기본값. */
export function resolveSeBudgetLadder(): number[] {
  return (
    budgetFromConfig('se') ??
    parseBudgetList(process.env.ELANOUS_SE_BUDGET) ??
    [...SE_BUDGET_LADDER_DEFAULT]
  );
}

/** walker(조사) 예산 계단 — config → env(ELANOUS_WALKER_BUDGET) → 기본값. */
export function resolveWalkerBudget(): number[] {
  return (
    budgetFromConfig('walker') ??
    parseBudgetList(process.env.ELANOUS_WALKER_BUDGET) ??
    [...WALKER_BUDGET_DEFAULT]
  );
}

// ── walker 예산 강제(2026-07-19 조율자 인프라 후속) ──────────────────────────
// 결함: walker 토큰 예산은 입력 컨텍스트 trimToBudget(chat.ts) 에만 소비되고 tool-loop 종료를
// 강제하지 않는다 — 종료는 walker 가 설정하지 않는 maxTurns(family 기본 claude 24)가 결정. 그래서
// tiny 예산(200토큰)을 줘도 조사가 24턴까지 완주("예산 강제 미적용"·dogfood 실측). tool-loop 는 이미
// opts.maxTurns 를 존중(llm.ts:6551)하므로, 예산을 턴 상한으로 파생해 llmOpts 로 넘기면 강제된다.

/** 조사 1턴이 소비하는 토큰의 러프 추정(파일 read 몇 건 + 모델 출력). 예산→턴 파생 계수. */
export const WALKER_TOKENS_PER_TURN = 8000;

/** 조사 턴 상한 하드 실링 — 어떤 예산도 이 위로 loosen 하지 않는다(family 기본 = claude 24 와 정합). */
export const WALKER_MAX_TURNS_CEIL = 24;

/**
 * walker 토큰 예산 → tool-loop 턴 상한. **무회귀 설계**: 기본 계단(≥128k)에는 undefined 를 반환해
 * family 기본(24턴)을 그대로 두고(현행 무변경), 기본 최소값(128k)보다 작은 **의도적으로 작은 예산**
 * 에만 비례 상한을 건다. 즉 예산은 오직 tighten 만·절대 loosen 안 함.
 *   · budget ≥ WALKER_BUDGET_DEFAULT[0](128k) → undefined(family 기본 유지·회귀0)
 *   · budget < 128k → clamp(round(budget / 8000), 1, 24)  (예: 200→1, 48k→6)
 * 순수 함수. undefined = "상한 미설정(family 기본)".
 */
export function resolveWalkerMaxTurns(budget: number): number | undefined {
  if (!Number.isFinite(budget) || budget <= 0) return undefined;
  // 기본 계단 최소값 이상이면 강제하지 않는다(넉넉한 조사 예산은 family 기본이 안전망).
  if (budget >= WALKER_BUDGET_DEFAULT[0]!) return undefined;
  const turns = Math.round(budget / WALKER_TOKENS_PER_TURN);
  return Math.max(1, Math.min(WALKER_MAX_TURNS_CEIL, turns));
}
