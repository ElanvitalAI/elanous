// Cost-tier advisor — when forecast says warn/throttle, suggest one step down
// (premium → balanced → economy). Tier table values are estimates until
// MODEL-BENCH replaces them.

import { debug } from '../debug/log.js';
import type { ForecastResult } from './forecaster.js';

export type CostTier = 'premium' | 'balanced' | 'economy';

export const COST_TIERS: Record<CostTier, {
  label: string;
  stages: { authoring: string; implement: string; review: string; judge: string };
  usdPerTaskEstimate: number;
  qualityRisk: string;
  source: 'estimate';
}> = {
  premium: {
    label: '프리미엄',
    stages: {
      authoring: 'claude-opus-4-7',
      implement: 'gpt-6-astra',
      review: 'claude-opus-4-7',
      judge: 'grok-4.7',
    },
    usdPerTaskEstimate: 1.2,
    qualityRisk: '낮음 — 최고 품질 유지',
    source: 'estimate',
  },
  balanced: {
    label: '균형',
    stages: {
      authoring: 'claude-sonnet-4-6',
      implement: 'gpt-5.6-terra',
      review: 'claude-sonnet-4-6',
      judge: 'grok-4.6',
    },
    usdPerTaskEstimate: 0.45,
    qualityRisk: '중간 — 대부분 작업에 충분',
    source: 'estimate',
  },
  economy: {
    label: '절약',
    stages: {
      authoring: 'claude-haiku-4-5',
      implement: 'gpt-6-luna',
      review: 'gemini-2.5-flash',
      judge: 'gemini-3.5-flash-lite',
    },
    usdPerTaskEstimate: 0.12,
    qualityRisk: '높음 — 단순·반복 작업에 적합',
    source: 'estimate',
  },
};

const DOWN_ONE: Record<CostTier, CostTier | null> = {
  premium: 'balanced',
  balanced: 'economy',
  economy: null,
};

export function adviseCostTier(input: {
  current: CostTier;
  forecast: Pick<ForecastResult, 'recommendation' | 'usedPercent' | 'atCurrentPaceReachesLimitAt'>;
}): {
  from: CostTier;
  to: CostTier;
  savingPercent: number;
  qualityRisk: string;
  reason: string;
} | null {
  const { current, forecast } = input;
  if (forecast.recommendation === 'safe') return null;

  const to = DOWN_ONE[current];
  if (!to) return null;

  const fromTier = COST_TIERS[current];
  const toTier = COST_TIERS[to];
  const savingPercent = Math.round((1 - toTier.usdPerTaskEstimate / fromTier.usdPerTaskEstimate) * 100);
  const reason = `예산 사용 ${forecast.usedPercent}% · 예측 ${forecast.recommendation} → ${toTier.label}로 내리면 약 ${savingPercent}% 절감`;

  debug.log('budget.cost-tier', 'advised', { from: current, to, savingPercent });

  return {
    from: current,
    to,
    savingPercent,
    qualityRisk: toTier.qualityRisk,
    reason,
  };
}
