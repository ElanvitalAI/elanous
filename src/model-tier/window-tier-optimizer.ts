// COST-OPTIMIZER-WINDOW-AWARE — 등급 배정의 창 반영(ROSTER-0334 P2-11 · 주인 TC-H-CC-1 · 판정 JUD-3).
//
// S: 창 인지 «계정 선택기»는 같은 등급 «안»에서만 창을 본다 — 등급 사다리(일감 신호 × 순간 × 올림)는
//    구독 창·크레딧을 전혀 못 본다.
// C: 배정 등급 칸의 구독 창이 전부 소진이어도 등급은 그대로다 — 프리미엄 일감이 크레딧·선불·API 를
//    태우고, 아래 등급에 «안 쓰면 리셋에 사라지는» 창이 남아 있어도 그대로다.
// Q: 등급 배정을 구독 창 리셋·남은 몫·크레딧으로 어떻게 다시 맞추나?
// A: 순수 windowAwareTierAssignment(current, provider, accounts) —
//      ① 배정 칸에 «쓸 수 있는» 창(남은 몫 > 예비 몫 · 리셋이 버텨야 할 시각 전에 «확실히» 오면 예비 0)이
//        있으면 그대로. ② 없으면 아래 등급(높은 것부터) 중 그런 창이 있는 곳으로 «한 번» 내린다(계정
//        선택기가 그 칸 안에서 계정을 고른다). ③ 어디에도 창이 없으면 크레딧 보유(credits.available)면
//        그대로(크레딧이 지출을 받는다) · 아니면 최하 등급(약)으로(선불·API 의 실지출을 가장 싼 모델로).
//    스냅숏 없음 · 후보 없음 · 활성 계정 없음 · 사람 명시(explicit) · 낡은 스냅숏(TTL)은 등급을 못 고친다.
//    코어 decide() 통합은 창 인지 계정 전환과 같은 프로+ 게이트(router.subscription_window_aware ·
//    jud-39528 ②) 안이고 routerMix(openrouter 혼합 배선)는 이 반영 바깥이다(model-orchestration.ts).
// 출처: seat-state/ELN-DOGFOOD/ASK-RIFLE-NOT-TANK-HARNESS-1117.md §한 몸 원칙 · ROSTER-0334 P2-11.
// 예비 몫 규칙은 창 인지 선택기(window-account-selector.ts)와 같은 규칙을 쓴다(두 판이 갈라지지 않게).

import type { AccountCandidate, AccountState, WorkTierClass } from './orchestration-core.js';
import { MUST_LAST_RESERVE_SHARE, WINDOW_SNAPSHOT_TTL_MS } from './window-account-selector.js';
import { WORK_TIER_CLASSES, WORK_TIER_LADDER_CELL } from './work-tier-policy.js';

/** 등급 배정의 창 반영 한 걸음 — null = 그대로(못 고침). */
export interface WindowTierStep {
  readonly from: WorkTierClass;
  readonly to: WorkTierClass;
  /** 결정 이유 칸에 그대로 남는 코드(문면 아님). */
  readonly reason: string;
}

/** 창 인지 선택기와 같은 예비 몫 — 리셋이 버텨야 할 시각 전에 «확실히» 오면 0(안 쓰면 사라지는 몫). */
function windowFloor(candidate: AccountCandidate): number {
  const reset = candidate.window?.resetsAtMs;
  const mustLast = candidate.mustLastUntilMs;
  return reset !== undefined && mustLast !== undefined && reset <= mustLast ? 0 : MUST_LAST_RESERVE_SHARE;
}

/** 이 계정의 구독 창을 «쓸 수 있는가» — 과금 종류가 구독이고 남은 몫이 예비 몫보다 크다. */
function usableWindow(candidate: AccountCandidate): boolean {
  return candidate.billing === 'subscription'
    && candidate.window !== undefined
    && Number.isFinite(candidate.window.remaining)
    && candidate.window.remaining > windowFloor(candidate);
}

/**
 * 등급 배정의 창 반영 — 배정 칸이 말라 있으면 «쓸 수 있는» 창이 있는 가장 높은 아래 등급으로 «한 번»
 * 내리고, 어디에도 창이 없으면 크레딧 보유에 따라 그대로/최하(약)로 정한다. 순수하다(시계·I/O 없음).
 * 스냅숏·활성·명시·신선 가드가 거절하면 null(등급은 그대로 — 지어 넣지 않는다).
 */
export function windowAwareTierAssignment(
  current: WorkTierClass,
  provider: string,
  accounts: AccountState | undefined,
): WindowTierStep | null {
  const state = accounts;
  if (!state) return null; // 스냅숏 없음.
  const observedAtMs = state.observedAtMs;
  const readAtMs = state.readAtMs;
  if (observedAtMs === undefined || readAtMs === undefined || observedAtMs > readAtMs
    || readAtMs - observedAtMs > WINDOW_SNAPSHOT_TTL_MS) return null; // 낡음(TTL 밖) — 못 고친다.
  if (!state.active || state.active.account === null) return null; // 활성 계정 없음.
  if (state.explicit === true) return null; // 사람이 명시 — 의도가 이긴다.
  const pool = state.candidates.filter((candidate) => candidate.provider === provider);
  if (pool.length === 0) return null; // 이 provider 의 후보 없음.
  const usableInCell = (klass: WorkTierClass): boolean =>
    pool.some((candidate) => (candidate.tiers === undefined || candidate.tiers.includes(WORK_TIER_LADDER_CELL[klass]))
      && usableWindow(candidate));
  if (usableInCell(current)) return null; // ① 배정 칸에 쓸 수 있는 창이 있으면 그대로.
  for (let index = WORK_TIER_CLASSES.indexOf(current) - 1; index >= 0; index -= 1) {
    const klass = WORK_TIER_CLASSES[index]!;
    if (usableInCell(klass)) return { from: current, to: klass, reason: `window:step-down:${current}->${klass}` }; // ② 한 번 내림.
  }
  const weakest = WORK_TIER_CLASSES[0]!;
  if (current === weakest) return null; // 이미 최하 — 더 내릴 곳 없음.
  if (pool.some((candidate) => candidate.credits?.available === true)) return null; // ③ 크레딧이 지출을 받는다.
  return { from: current, to: weakest, reason: `window:dry:no-credits:${current}->${weakest}` }; // 선불·API 실지출은 가장 싼 모델로.
}