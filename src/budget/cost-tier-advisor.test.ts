import { describe, expect, it, spyOn } from 'bun:test';
import { debug } from '../debug/log.js';
import { adviseCostTier, COST_TIERS, type CostTier } from './cost-tier-advisor.js';
import { estimateLlmCost } from './llm-cost.js';

function forecast(
  recommendation: 'safe' | 'warn' | 'throttle',
  usedPercent = 85,
): {
  recommendation: 'safe' | 'warn' | 'throttle';
  usedPercent: number;
  atCurrentPaceReachesLimitAt: number | null;
} {
  return {
    recommendation,
    usedPercent,
    atCurrentPaceReachesLimitAt: recommendation === 'safe' ? null : Date.now() + 3_600_000,
  };
}

describe('adviseCostTier', () => {
  it('warn 이면 한 단계 아래 등급을 절감률과 함께 제안한다 (premium→balanced)', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const got = adviseCostTier({ current: 'premium', forecast: forecast('warn', 82) });
    expect(got).not.toBeNull();
    expect(got!.from).toBe('premium');
    expect(got!.to).toBe('balanced');
    const expectedSaving = Math.round(
      (1 - COST_TIERS.balanced.usdPerTaskEstimate / COST_TIERS.premium.usdPerTaskEstimate) * 100,
    );
    expect(got!.savingPercent).toBe(expectedSaving);
    expect(got!.qualityRisk).toBe(COST_TIERS.balanced.qualityRisk);
    expect(got!.reason).toContain('82');
    expect(log).toHaveBeenCalledWith(
      'budget.cost-tier',
      'advised',
      { from: 'premium', to: 'balanced', savingPercent: expectedSaving },
    );
    log.mockRestore();
  });

  it('balanced+throttle → economy', () => {
    const got = adviseCostTier({ current: 'balanced', forecast: forecast('throttle', 96) });
    expect(got).not.toBeNull();
    expect(got!.from).toBe('balanced');
    expect(got!.to).toBe('economy');
    expect(got!.savingPercent).toBe(
      Math.round((1 - COST_TIERS.economy.usdPerTaskEstimate / COST_TIERS.balanced.usdPerTaskEstimate) * 100),
    );
    expect(got!.reason).toContain('96');
  });

  it('economy+throttle → null (더 내려갈 곳 없음)', () => {
    const got = adviseCostTier({ current: 'economy' as CostTier, forecast: forecast('throttle', 99) });
    expect(got).toBeNull();
  });

  it('premium+safe → null', () => {
    const got = adviseCostTier({ current: 'premium', forecast: forecast('safe', 40) });
    expect(got).toBeNull();
  });

  it('등급 표의 모델은 모두 llm-cost 가격표에 있다 (source: estimate)', () => {
    for (const tier of Object.values(COST_TIERS)) {
      expect(tier.source).toBe('estimate');
      for (const model of Object.values(tier.stages)) {
        expect(estimateLlmCost({ model, inputTokens: 1, outputTokens: 1 }).kind).toBe('known');
      }
    }
  });
});
