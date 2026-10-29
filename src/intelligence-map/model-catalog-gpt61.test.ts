import { describe, expect, it } from 'bun:test';
import { BUILTIN_CATALOG, enabledModels } from './model-catalog.js';

describe('GPT-6.1 builtin catalog entries', () => {
  it('keeps Terra and Sol discoverable without API keys and links their tier variants', () => {
    const models = BUILTIN_CATALOG.models;
    const terra = models.find(model => model.id === 'gpt-6.1-terra');
    const sol = models.find(model => model.id === 'gpt-6.1-sol');
    expect(terra).toMatchObject({
      provider: 'openai-codex', contextWindow: 500_000, inputPerMtok: 1, outputPerMtok: 5,
      tier: 'better', variantOf: 'gpt-6', effortAxis: 'terra', reservedOutputTokens: 12_000,
    });
    expect(sol).toMatchObject({
      provider: 'openai-codex', contextWindow: 500_000, inputPerMtok: 2, outputPerMtok: 10,
      tier: 'best', variantOf: 'gpt-6', effortAxis: 'sol', reservedOutputTokens: 16_000,
    });
    expect(enabledModels({ ...BUILTIN_CATALOG, models: [terra!, sol!] }, {}).map(model => model.id))
      .toEqual(['gpt-6.1-terra', 'gpt-6.1-sol']);
    expect(models.find(model => model.id === 'gpt-6-sol')?.tags).toContain('legacy');
  });
});
