// ── 페이즈 실행 루프 제어 정책 — phaseKind 별 goal-loop 반복 상한 (대표 2026-07-22) ──────
//
// 근본(dogfood 발견): operational(조사) 페이즈가 across-turn goal-loop 를 maxIterations(chat.ts
// 기본 8)까지 재주입하며 update_goal(완료) 반려 루프로 예산을 소진한다(512k 도 같은 실패). 조사의
// 산출물은 "기록된 결정"이라 재주입이 적어야 옳다 — 반면 implementation 은 코드게이트까지 반복이
// 정당(현행 유지). 그래서 goal-loop 반복 상한을 **phaseKind 별로 차등**한다.
//
// 정식 외부 인터페이스(대표 지시 — 정식화·외부 공개 가능 형태):
//   user-config `autopilot.loopControl.{operational,implementation}.maxIterations`
//   (feedback_config_over_env — 코드변경0·인스턴스별 튜닝·raw.autopilot 경로로 다른 플래그와 동형).
//   순수 resolve(resolveGoalLoopMaxIterations) + config seam(loopControlFromConfig) 로 분리 —
//   순수부는 단위테스트, I/O 는 fail-soft. chat.ts 의 opts.goalLoopMaxIterations seam 으로 흘러
//   runGoalLoop.maxIterations 를 결정한다(consumer 무개변·회귀0).
//
// 소비: scripts/run-mission.ts 가 phaseKind 확정 직후 이 정책으로 goalLoopMaxIterations 를 산출해
//   walker runTurnImpl 에 실어 보낸다(operational=바운디드·implementation/미지=undefined→기본 유지).

import { getUserConfig } from '../user-config/reader.js';
import type { PhaseKind } from './mission-se-bridge.js';

/** operational(조사) 기본 goal-loop 반복 상한 — 최초 턴 + 1회 재주입. 재주입 폭주(예산 소진) 근절.
 *  각 반복은 그 자체로 full tool-loop(walkerMaxTurns 상한) 이므로 2 = 넉넉한 조사 2패스. */
export const OPERATIONAL_GOAL_LOOP_MAX_ITERATIONS_DEFAULT = 2;

/** 정식 config 스키마 — user-config `autopilot.loopControl`. 전부 옵션(미지정 = 기본/현행). */
export interface LoopControlPolicy {
  /** operational(조사·운영) 페이즈 goal-loop 상한. 미지정 시 OPERATIONAL_*_DEFAULT. */
  operational?: { maxIterations?: number };
  /** implementation(코드/테스트) 페이즈 goal-loop 상한. 미지정 시 undefined → chat.ts 기본(8) 유지(회귀0). */
  implementation?: { maxIterations?: number };
}

/** phaseKind → goal-loop across-turn 반복 상한(순수). operational 은 바운디드, 그 외는 undefined
 *  (undefined = chat.ts 가 config `llm.goalLoop.maxIterations` ?? 8 로 폴백 — 현행 무변경·회귀0). */
export function resolveGoalLoopMaxIterations(
  phaseKind: PhaseKind | undefined,
  policy: LoopControlPolicy | null,
): number | undefined {
  if (phaseKind === 'operational') {
    const v = policy?.operational?.maxIterations;
    return typeof v === 'number' && v > 0 ? v : OPERATIONAL_GOAL_LOOP_MAX_ITERATIONS_DEFAULT;
  }
  if (phaseKind === 'implementation') {
    const v = policy?.implementation?.maxIterations;
    return typeof v === 'number' && v > 0 ? v : undefined; // undefined = 기본 유지
  }
  return undefined; // 미지 phaseKind — 기본 유지(보수)
}

/** user-config `autopilot.loopControl` 읽기(I/O·fail-soft — raw.autopilot 경로로 다른 autopilot 플래그와 동형). */
export function loopControlFromConfig(): LoopControlPolicy | null {
  try {
    const ap = getUserConfig().raw?.autopilot as { loopControl?: LoopControlPolicy } | undefined;
    return ap?.loopControl ?? null;
  } catch {
    return null; // config 접근 실패는 루프 결정을 막지 않는다(기본 폴백)
  }
}
