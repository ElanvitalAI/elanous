// Shadow-arm launch plan — estimate which candidate models fit today's
// shadow budget. Plans only: no live LLM calls.

import { debug } from '../debug/log.js';
import { estimateLlmCost } from './llm-cost.js';

export type ShadowStage = 'authoring' | 'implement' | 'review' | 'judge';

export type ShadowDifficulty = 'small' | 'medium' | 'umbrella' | 'rework';

export interface PlanShadowArmsInput {
  stage: ShadowStage;
  difficulty: ShadowDifficulty;
  inputTokens: number;
  expectedOutputTokens: number;
  candidates: string[];
  spentTodayUsd: number;
  dailyCapUsd: number;
}

export interface ShadowArmFire {
  model: string;
  estUsd: number;
}

export interface ShadowArmSkipped {
  model: string;
  reason: 'over-daily-cap' | 'unknown-price';
}

export interface ShadowArmsPlan {
  fire: ShadowArmFire[];
  skipped: ShadowArmSkipped[];
  remainingUsd: number;
}

export function planShadowArms(input: PlanShadowArmsInput): ShadowArmsPlan {
  const fire: ShadowArmFire[] = [];
  const skipped: ShadowArmSkipped[] = [];
  let remainingUsd = input.dailyCapUsd - input.spentTodayUsd;
  let overDailyCap = false;

  for (const model of input.candidates) {
    // Once the cap is crossed, every later arm is over-daily-cap — even one
    // whose price is unknown (the cap decision comes first).
    if (overDailyCap) {
      skipped.push({ model, reason: 'over-daily-cap' });
      continue;
    }
    const estimate = estimateLlmCost({
      model,
      inputTokens: input.inputTokens,
      outputTokens: input.expectedOutputTokens,
    });
    if (estimate.kind !== 'known') {
      skipped.push({ model, reason: 'unknown-price' });
      continue;
    }
    if (estimate.usd > remainingUsd) {
      skipped.push({ model, reason: 'over-daily-cap' });
      overDailyCap = true;
      continue;
    }
    fire.push({ model, estUsd: estimate.usd });
    remainingUsd -= estimate.usd;
  }

  debug.log('budget.shadow-arms', 'planned', {
    stage: input.stage,
    difficulty: input.difficulty,
    fire: fire.length,
    skipped: skipped.length,
    remainingUsd,
  });

  return { fire, skipped, remainingUsd };
}

// ── SHADOW-MODEL-ARMS · 그림자 «1팔» probe(명시 실행 · 관측만) ─────────────────────
/**
 * ⭐ 그림자 1팔 probe — `planShadowArms` 를 일일 상한 안에서 «실제 호출»해
 *   난이도·모델·예상/실제 비용·결과를 기록한다.
 *   ⛔ 관측만 한다 — 라이브 LLM 호출 0 · 파일 원장 쓰기 0. 팔은 «계획»이고 실행은 후속 조각이다.
 *   ⛔ 후보가 여러 개여도 첫 후보 «1팔»만 계획한다(저작 단계 팔은 단일 팔이다).
 */
export interface ShadowArmProbeRecord {
  stage: ShadowStage;
  difficulty: ShadowDifficulty;
  model: string;
  result: 'fire' | 'skipped';
  skipReason: 'over-daily-cap' | 'unknown-price' | null;
  expectedUsd: number | null;
  actualUsd: number;
  remainingUsd: number;
}

/** 그림자 1팔을 실제 호출해 기록을 낸다 — 실제 지출은 없다(계획만, actualUsd=0). */
export function probeShadowArm(input: PlanShadowArmsInput): ShadowArmProbeRecord {
  const model = input.candidates[0] ?? '';
  const plan = planShadowArms({ ...input, candidates: [model] });
  const fired = plan.fire[0];
  const skipped = plan.skipped[0];
  return {
    stage: input.stage,
    difficulty: input.difficulty,
    model,
    result: fired ? 'fire' : 'skipped',
    skipReason: skipped?.reason ?? null,
    expectedUsd: fired?.estUsd ?? null,
    actualUsd: 0,
    remainingUsd: plan.remainingUsd,
  };
}

/** 한 줄 원장 형식 — 예상 비용이 없으면 `expectedUsd=unknown`, fire 사유는 `under-daily-cap` 이다. */
export function formatShadowArmProbeRecord(record: ShadowArmProbeRecord): string {
  const reason = record.skipReason ?? 'under-daily-cap';
  const expectedUsd = record.expectedUsd === null ? 'unknown' : `${record.expectedUsd}`;
  return [
    `shadow-arm stage=${record.stage}`,
    `difficulty=${record.difficulty}`,
    `model=${record.model}`,
    `result=${record.result}`,
    `reason=${reason}`,
    `expectedUsd=${expectedUsd}`,
    `actualUsd=${record.actualUsd}`,
    `remainingUsd=${record.remainingUsd}`,
  ].join(' ');
}
