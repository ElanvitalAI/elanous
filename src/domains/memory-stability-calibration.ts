// ── M1 stability 보정 — ≈22일 승격 기준의 실측 분포 재보정 + 효과 수치 (2026-11-21) ──
//
// 칸: MEM-STABILITY-DAYS-CALIBRATION(ROSTER-0332). stabilityDays 곡선(base 7 + importance
// 30 + 미엘린 45 → imp5·recall0 ≈ 22일)의 승격 기준(hot 잔류 기간)을 이벤트 나이의 실측
// 분포로 재보정한다.
//   관측: 회상된(recall_count>0) 기억의 p80 나이 — 기억이 실제 회상되며 살아있는 수명의
//   상한 proxy. 현재 기본 기준(≈22일) 대비 비율 λ 를 곡선 전체에 균일하게(형상 유지) 반영.
//   가드: λ 상·하한 [0.5, 2] — 작은 표본·이상치로 곡선이 튀지 않게(기본 기준 [11, 44]일).
//   빈 표본·오류 → 기본 곡선(source='default') — 보정은 fail-soft, 궤도 밖 이동 없음.
// 효과 수치: decay 전후 tier 로 승격(상향)·강등(하향)·보존(유지) 건수 — 사이클 로그·보고.
// 보정 근거 표(rationale): 관측→판정 행 — 사이클 로그와 보고에 그대로 붙는다.

import { Database } from 'bun:sqlite';
import { applyMemoryDecay, stabilityDays } from './surface-events.js';

/** 현재 기본 승격 기준(일) — importance 5 · recall 0 → 7 + 30×0.5 = 22. */
export const STABILITY_CALIBRATION_WINDOW_DAYS = 22;
/** 보정 비율 상·하한 — 기본 기준의 [0.5, 2]배(= [11, 44]일) 밖으로 못 나간다. */
export const STABILITY_CALIBRATION_MIN_LAMBDA = 0.5;
export const STABILITY_CALIBRATION_MAX_LAMBDA = 2;

/** stability 곡선 — 기본 곡선(stabilityDays)과 같은 인자. */
export type StabilityFn = (importance: number | null | undefined, recallCount: number | null | undefined) => number;

/** 실측 표본 — 이벤트 하나의 나이(일)와 회상 여부. */
export interface StabilityAgeSample { ageDays: number; recalled: boolean }

/** 실측 — 현재 이벤트의 나이(일) 분포. 회사(recall_count>0) 여부까지 관측한다. */
export function measureStabilityAges(db: Database, opts: { nowMs?: number } = {}): StabilityAgeSample[] {
  const nowMs = opts.nowMs ?? Date.now();
  const rows = db.prepare('SELECT ts, recall_count FROM events').all() as Array<{ ts: string; recall_count: number | null }>;
  return rows.map((row) => {
    const parsed = Date.parse(row.ts);
    const ageDays = Number.isFinite(parsed) ? Math.max(0, (nowMs - parsed) / 86400000) : 0;
    return { ageDays, recalled: (row.recall_count ?? 0) > 0 };
  });
}

/** 선형 보간 백분위 — sortedAsc 필수. 빈 배열 → 0. */
function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const at = (sortedAsc.length - 1) * (p / 100);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  if (lo === hi) return sortedAsc[lo]!;
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (at - lo);
}

/** 보정 근거 표 행 — 관측 → 판정. 사이클 로그·보고에 그대로 붙는다. */
export interface StabilityRationaleRow { row: string; observed: string; decision: string }

export interface StabilityCalibration {
  measured: { events: number; recalledEvents: number; agesDays: { p50: number; p80: number; p95: number } };
  /** 보정 근거 표 — 관측 → 판정 행. */
  rationale: StabilityRationaleRow[];
  /** 보정된 stability(일) 곡선 — 기본 곡선과 같은 인자. */
  stability: StabilityFn;
  /** 적용 비율 — [0.5, 2]. 기본 곡선 = 1. */
  lambda: number;
  source: 'measured' | 'default';
}

const fmt = (n: number): string => `${Math.round(n * 10) / 10}`;

function defaultCalibration(reason: string): StabilityCalibration {
  return {
    measured: { events: 0, recalledEvents: 0, agesDays: { p50: 0, p80: 0, p95: 0 } },
    rationale: [
      { row: '실측 표본', observed: reason, decision: '기본 곡선 유지(보정 생략)' },
      { row: '현재 기본 승격 기준(일)', observed: `≈${STABILITY_CALIBRATION_WINDOW_DAYS}(importance 5·recall 0)`, decision: '—' },
    ],
    stability: (importance, recallCount) => stabilityDays(importance, recallCount),
    lambda: 1,
    source: 'default',
  };
}

/** 실측 나이 분포로 ≈22일 승격 기준을 재보정 — λ = 관측 p80 / 22(회상 기억 — 없으면 전체 대체), 상·하한 [0.5, 2]. */
export function calibrateStabilityDays(samples: readonly StabilityAgeSample[]): StabilityCalibration {
  if (samples.length === 0) return defaultCalibration('빈 표본');
  const recalledAges = samples.filter((sample) => sample.recalled).map((sample) => sample.ageDays).sort((a, b) => a - b);
  const allAges = samples.map((sample) => sample.ageDays).sort((a, b) => a - b);
  const measured = {
    events: samples.length,
    recalledEvents: recalledAges.length,
    agesDays: { p50: percentile(allAges, 50), p80: percentile(allAges, 80), p95: percentile(allAges, 95) },
  };
  // 관측 신호: 회상된 기억의 p80 나이(회상 기억 없으면 전체 p80) — 승격 기준의 실측.
  const observedP80 = percentile(recalledAges.length > 0 ? recalledAges : allAges, 80);
  const lambda = Math.min(STABILITY_CALIBRATION_MAX_LAMBDA,
    Math.max(STABILITY_CALIBRATION_MIN_LAMBDA, observedP80 / STABILITY_CALIBRATION_WINDOW_DAYS));
  const stability: StabilityFn = (importance, recallCount) =>
    Math.max(1, Math.round(lambda * stabilityDays(importance, recallCount)));
  const windowDays = Math.max(1, Math.round(lambda * STABILITY_CALIBRATION_WINDOW_DAYS));
  const rationale: StabilityRationaleRow[] = [
    { row: '실측 표본', observed: `이벤트 ${measured.events}(회상 ${measured.recalledEvents})`, decision: '—' },
    { row: '전체 나이 분포(일)', observed: `p50 ${fmt(measured.agesDays.p50)} · p80 ${fmt(measured.agesDays.p80)} · p95 ${fmt(measured.agesDays.p95)}`, decision: '—' },
    { row: `${recalledAges.length > 0 ? '회상 기억 p80 나이(일)' : '전체 p80 나이(일) — 회상 표본 0 · 전체 대체'} — 승격 기준 실측`, observed: `${fmt(observedP80)}`, decision: `목표 기본 승격 기준 ≈${fmt(observedP80)}일` },
    { row: '보정 비율 λ', observed: `${fmt(observedP80)} / ${STABILITY_CALIBRATION_WINDOW_DAYS} = ${fmt(observedP80 / STABILITY_CALIBRATION_WINDOW_DAYS)}`, decision: `상·하한 [${STABILITY_CALIBRATION_MIN_LAMBDA}, ${STABILITY_CALIBRATION_MAX_LAMBDA}] → λ=${fmt(lambda)}` },
    { row: '보정 후 기본 승격 기준(일)', observed: `λ×${STABILITY_CALIBRATION_WINDOW_DAYS} ≈ ${windowDays}`, decision: `[${STABILITY_CALIBRATION_MIN_LAMBDA * STABILITY_CALIBRATION_WINDOW_DAYS}, ${STABILITY_CALIBRATION_MAX_LAMBDA * STABILITY_CALIBRATION_WINDOW_DAYS}] 상한 내 · 곡선 형상(importance·미엘린 항) 유지` },
  ];
  return { measured, rationale, stability, lambda, source: 'measured' };
}

export interface DecayEffectCounts { promoted: number; demoted: number; retained: number }

const TIER_RANK: Record<string, number> = { hot: 0, warm: 1, cold: 2 };

/** ★ decay 경계 집계 (JUD HOLD #117655 3차 · 최종 좁힘) — 효과 수는 **decay 반환값이 실제로
 *  처리한 행**(applyMemoryDecay 루프의 items 스냅숏)에서만 나온다. 전후 재조회를 없애,
 *  decay 도중 다른 연결이 행을 끼워넣거나 지워도 처리 행 집합이 아니므로 효과 수는
 *  구조적으로 불변. 이 함수를 decay thunk 안에서 호출해 경계 수치를 저장한다. */
export function decayWithEffectCounts(db: Database, opts: {
  stability?: StabilityFn; nowMs?: number;
} = {}): { decay: ReturnType<typeof applyMemoryDecay>; effects: DecayEffectCounts } {
  const decay = applyMemoryDecay(db, { nowMs: opts.nowMs, stability: opts.stability });
  return { decay, effects: decay.effects };
}

/** decay 전후 tier 대비 승격(상향)·강등(하향)·보존(유지) 건수 — 사이클 효과 수치. */
export function effectCounts(pairs: ReadonlyArray<{ before: string | null; after: string }>): DecayEffectCounts {
  let promoted = 0;
  let demoted = 0;
  let retained = 0;
  for (const { before, after } of pairs) {
    const from = TIER_RANK[before ?? 'hot'] ?? 0;
    const to = TIER_RANK[after] ?? 0;
    if (to < from) promoted++;
    else if (to > from) demoted++;
    else retained++;
  }
  return { promoted, demoted, retained };
}