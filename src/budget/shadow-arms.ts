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
