// ── 페이즈 누적 예산 (무한 분할 방지 cap) — 대표 지시 2026-07-23 ──────────────────
//
// PLAN-anti-infinite-phase-split-2026-07-23 · Device 1. 근본: 팽창엔진 splitPhaseIntoSubphases
// (÷최대4/회)에 **누적 상한이 없어** 실행 중 막힐 때마다 무한히 쪼개진다(라이브 e4f97b: 7→20+).
// 이 모듈이 "미션이 가질 수 있는 총 페이즈 수"의 하드 상한(순수·결정론)을 SSOT 로 준다.
//
// 정책(대표 확정 2026-07-23): maxPhases = arcCount × perArc(기본 5). 아크 구조가 없으면 floor,
// 절대 상한 hardCeiling. cap 도달 시 split 은 차단되고 조율자가 reshape(merge)/HITL 로 처리(Device 3).
// gradeArcConformance(아크당 4~5페이즈)와 정합 — 5/arc 는 "아크당 완주가능 페이즈"의 상한.

import { getUserConfig } from '../user-config/reader.js';

export interface PhaseBudgetConfig {
  /** 아크당 허용 페이즈 수(기본 5·gradeArcConformance 상한과 정합). */
  perArc: number;
  /** 아크 구조가 없는(arcCount=0) 미션의 기본 예산(기본 8). */
  floor: number;
  /** 아크 수와 무관한 절대 안전 상한(기본 40·폭주 backstop). */
  hardCeiling: number;
}

export const DEFAULT_PHASE_BUDGET: PhaseBudgetConfig = { perArc: 5, floor: 8, hardCeiling: 40 };

/** ★ 미션 총 페이즈 예산(순수·결정론). arcCount>0 → arcCount×perArc, 없으면 floor. hardCeiling 로 상한.
 *  이 값이 splitPhaseIntoSubphases 가 넘지 못하는 누적 상한(SSOT). */
export function computePhaseBudget(arcCount: number, cfg: PhaseBudgetConfig = DEFAULT_PHASE_BUDGET): number {
  const base = Number.isFinite(arcCount) && arcCount > 0 ? Math.ceil(arcCount) * cfg.perArc : cfg.floor;
  return Math.max(1, Math.min(cfg.hardCeiling, base));
}

export interface SplitAllowance {
  /** 예산까지 남은 순증 여유(budget - currentCount). 음수면 이미 초과. */
  room: number;
  /** 이번 split 이 만들 수 있는 최대 서브페이즈 수(1 이하 = 분할 불가). */
  allowedSub: number;
  /** true = 예산 도달·초과로 split 차단(조율자 reshape/HITL 필요). */
  capHit: boolean;
  budget: number;
}

/** ★ 이번 split 이 예산 안에서 만들 수 있는 서브페이즈 수(순수). split 은 1페이즈를 N개로 치환(net +N-1)
 *  이므로 N-1 ≤ room → N ≤ room+1. maxSub 와 room+1 중 작은 값. allowedSub ≤ 1 이면 cap-hit(분할 불가).
 *  currentCount = 현재 미션의 페이즈(subagent 태스크) 수. */
export function computeSplitAllowance(currentCount: number, budget: number, maxSub: number): SplitAllowance {
  const room = budget - currentCount;
  const allowedSub = Math.max(0, Math.min(maxSub, room + 1));
  return { room, allowedSub, capHit: allowedSub <= 1, budget };
}

/** ★ raw `autopilot.phaseBudget` 값 → PhaseBudgetConfig(순수·결정론·테스트 가능). 각 필드는 양수만
 *  채택, 나머지는 기본값(부분 지정·오타·타입오류 방어). config 유무·seam 무관하게 단위테스트 가능. */
export function parsePhaseBudget(rawPhaseBudget: unknown): PhaseBudgetConfig {
  const pb = (rawPhaseBudget ?? {}) as Partial<PhaseBudgetConfig>;
  const pick = (v: unknown, d: number): number => (typeof v === 'number' && v > 0 ? v : d);
  return {
    perArc: pick(pb.perArc, DEFAULT_PHASE_BUDGET.perArc),
    floor: pick(pb.floor, DEFAULT_PHASE_BUDGET.floor),
    hardCeiling: pick(pb.hardCeiling, DEFAULT_PHASE_BUDGET.hardCeiling),
  };
}

/** user-config `autopilot.phaseBudget` 읽기(I/O·fail-soft — raw.autopilot 경로로 loopControl 과 동형). */
export function phaseBudgetFromConfig(): PhaseBudgetConfig {
  try {
    const ap = getUserConfig().raw?.autopilot as { phaseBudget?: unknown } | undefined;
    return parsePhaseBudget(ap?.phaseBudget);
  } catch {
    return DEFAULT_PHASE_BUDGET; // config 접근 실패는 cap 결정을 막지 않는다(기본 폴백)
  }
}
