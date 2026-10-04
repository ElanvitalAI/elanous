import { describe, expect, test } from 'bun:test';
import { harnessLaunchBudgetDecision } from './harness-cli-command.js';
import type { BudgetInputs } from '../self-implement/budget-gate.js';

function inputs(chain: { provider: string; model?: string }[]): BudgetInputs {
  return {
    preference: {
      mode: 'auto',
      chain,
      budgetGate: { minHeadroomPercent: 0, onShortfall: 'stop' },
      source: { mode: 'inferred', chain: 'fallbackChain' },
    },
    codexCandidates: [{ name: 'default', usedPercent: 10 }],
    grokUsedPercent: 5,
    maxUsedPercent: { 'openai-codex': 95, grok: 48 },
  } as unknown as BudgetInputs;
}

describe('harness launch budget — empty chain (L6b2 incident 10-03)', () => {
  test('empty chain judges with the code default chain and warns instead of blocking', () => {
    const { decision, warning } = harnessLaunchBudgetDecision(inputs([]));
    expect(decision.action).toBe('proceed');
    expect(decision.provider).toBe('openai-codex');
    expect(warning).toContain('code default');
  });

  test('explicit --child-llm-provider is the chain', () => {
    const { decision } = harnessLaunchBudgetDecision(inputs([]), { childLlmProvider: 'grok' });
    expect(decision.action).toBe('proceed');
    expect(decision.provider).toBe('grok');
  });

  test('explicit provider outside the budget gate proceeds with a warning', () => {
    const { decision, warning } = harnessLaunchBudgetDecision(inputs([]), { childLlmProvider: 'claude' });
    expect(decision.action).toBe('proceed');
    expect(warning).toContain('outside the budget gate');
  });

  test('unmeasured codex and grok launch with their own warning', () => {
    const noUsage = { ...inputs([{ provider: 'openai-codex' }, { provider: 'grok' }]), codexCandidates: [{ name: 'default' }], grokUsedPercent: undefined } as BudgetInputs;
    const codex = harnessLaunchBudgetDecision(noUsage);
    expect(codex.decision).toEqual(expect.objectContaining({ action: 'proceed', provider: 'openai-codex' }));
    expect(codex.warning).toContain('openai-codex usage unmeasured');
    expect(codex.unmeasuredProvider).toBe('openai-codex');
    const grok = harnessLaunchBudgetDecision(noUsage, { childLlmProvider: 'grok' });
    expect(grok.decision).toEqual(expect.objectContaining({ action: 'proceed', provider: 'grok' }));
    expect(grok.warning).toContain('grok usage unmeasured');
  });

  test('measured exhausted codex falls through to unmeasured grok, but not vice versa', () => {
    const mixed = { ...inputs([{ provider: 'openai-codex' }, { provider: 'grok' }]), codexCandidates: [{ name: 'default', usedPercent: 95 }], grokUsedPercent: undefined } as BudgetInputs;
    const { decision, warning } = harnessLaunchBudgetDecision(mixed);
    expect(decision).toEqual(expect.objectContaining({ action: 'next-provider', provider: 'grok' }));
    expect(warning).toContain('grok usage unmeasured');
    const exhausted = harnessLaunchBudgetDecision({ ...mixed, grokUsedPercent: 48 });
    expect(exhausted.decision.action).toBe('stop');
    expect(exhausted.warning).toBeUndefined();
    expect(exhausted.unmeasuredProvider).toBeUndefined();
  });

  test('empty chain warns once even when default provider usage is unmeasured', () => {
    const unknown = { ...inputs([]), codexCandidates: [], grokUsedPercent: undefined } as BudgetInputs;
    const { decision, warning, unmeasuredProvider } = harnessLaunchBudgetDecision(unknown);
    expect(decision).toEqual(expect.objectContaining({ action: 'proceed', provider: 'openai-codex' }));
    expect(warning).toContain('code default');
    expect(warning).toContain('openai-codex usage unmeasured');
    expect(unmeasuredProvider).toBe('openai-codex');
  });

  test('configured chain is judged as before (exhausted → stop)', () => {
    const exhausted = { ...inputs([{ provider: 'openai-codex' }]), codexCandidates: [{ name: 'default', usedPercent: 99 }] } as BudgetInputs;
    const { decision, warning } = harnessLaunchBudgetDecision(exhausted);
    expect(decision.action).toBe('stop');
    expect(warning).toBeUndefined();
  });
});
