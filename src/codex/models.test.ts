import { describe, expect, it } from 'bun:test';
import { CODEX_MODELS, findCodexModel } from './models.js';

describe('GPT-6.1 Codex models', () => {
  it('recommends Terra, keeps Sol available, and demotes legacy GPT-6 Sol', () => {
    expect(CODEX_MODELS.filter(model => model.recommended).map(model => model.id)).toEqual(['gpt-6.1-terra']);
    expect(CODEX_MODELS[0]?.id).toBe('gpt-6.1-terra');
    expect(findCodexModel('gpt-6.1-terra')).toMatchObject({
      contextWindow: 500_000,
      pricingUsd: { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.05 },
    });
    expect(findCodexModel('gpt-6.1-sol')).toMatchObject({
      contextWindow: 500_000,
      pricingUsd: { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.1 },
    });
    expect(findCodexModel('gpt-6-sol')).toMatchObject({
      tier: 'legacy',
      pricingUsd: { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.1 },
    });
    expect(findCodexModel('gpt-6-sol')?.recommended).not.toBe(true);
  });
});
