import { describe, test, expect } from 'bun:test';
import { shouldAutoCompact } from '../src/compact/index.js';

const config = {
  enabled: true,
  triggerRatio: 0.85,
  preserveLastN: 4,
  preserveFirstN: 1,
  partial: true,
  workingBudgetTokens: 256_000,
};

describe('shouldAutoCompact', () => {
  test('disabled config never fires and records window and budget metadata', () => {
    const decision = shouldAutoCompact(
      [{ role: 'user', content: 'x'.repeat(200_000) }],
      'gpt-5.6-terra',
      { ...config, enabled: false },
    );
    expect(decision.fire).toBe(false);
    expect(decision.reason).toBe('disabled');
    expect(decision.windowTokens).toBe(1_050_000);
    expect(decision.budgetTokens).toBe(256_000);
  });

  test('uses the working budget below the catalog context window', () => {
    const decision = shouldAutoCompact(
      [{ role: 'user', content: 'x'.repeat(600_000) }],
      'gpt-5.6-terra',
      config,
    );
    expect(decision.fire).toBe(false);
    expect(decision.reason).toBe('under-threshold');
    expect(decision.maxTokens).toBe(256_000);
    expect(decision.windowTokens).toBe(1_050_000);
    expect(decision.budgetTokens).toBe(256_000);
  });

  test('fires once use exceeds the working-budget threshold', () => {
    const decision = shouldAutoCompact(
      [{ role: 'user', content: 'x'.repeat(920_000) }],
      'gpt-5.6-terra',
      config,
    );
    expect(decision.fire).toBe(true);
    expect(decision.reason).toBe('threshold-exceeded');
    expect(decision.partial).toBe(true);
  });

  test('uses the inference fallback when the catalog does not know a local model', () => {
    const decision = shouldAutoCompact(
      [{ role: 'user', content: 'short message' }],
      'local:gemma',
      config,
    );
    expect(decision.maxTokens).toBe(32_000);
    expect(decision.windowTokens).toBe(32_000);
    expect(decision.budgetTokens).toBe(256_000);
  });

  test('uses the catalog window without a valid budget from a partial config call', () => {
    const partialConfig = { ...config, workingBudgetTokens: 0 } as typeof config;
    const decision = shouldAutoCompact(
      [{ role: 'user', content: 'x'.repeat(600_000) }],
      'gpt-5.6-terra',
      partialConfig,
    );
    expect(decision.fire).toBe(false);
    expect(decision.maxTokens).toBe(1_050_000);
    expect(decision.windowTokens).toBe(1_050_000);
    expect(decision.budgetTokens).toBeUndefined();
  });
});
