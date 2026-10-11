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

  // 발사 관문은 grok «못 쟀다»도 codex 와 같은 꼴로 경고와 함께 발사한다.
  // 잰 주간 사용률에만 80% 상한을 적용한다.
  test('unmeasured grok launches with unmeasuredProvider grok', () => {
    const noUsage = { ...inputs([{ provider: 'openai-codex' }, { provider: 'grok' }]), codexCandidates: [{ name: 'default' }], grokUsedPercent: undefined } as BudgetInputs;
    const codex = harnessLaunchBudgetDecision(noUsage);
    expect(codex.decision).toEqual(expect.objectContaining({ action: 'proceed', provider: 'openai-codex' }));
    expect(codex.warning).toContain('openai-codex usage unmeasured');
    expect(codex.unmeasuredProvider).toBe('openai-codex');
    const grok = harnessLaunchBudgetDecision(noUsage, { childLlmProvider: 'grok' });
    expect(grok.decision).toEqual(expect.objectContaining({ action: 'proceed', provider: 'grok', reasons: ['grok: 모름'] }));
    expect(grok.warning).toContain('grok usage unmeasured');
    expect(grok.unmeasuredProvider).toBe('grok');
  });

  test('measured exhausted codex falls through to measured grok under the launch cap, and to unmeasured grok', () => {
    const mixed = { ...inputs([{ provider: 'openai-codex' }, { provider: 'grok' }]), codexCandidates: [{ name: 'default', usedPercent: 95 }], grokUsedPercent: undefined } as BudgetInputs;
    const unmeasured = harnessLaunchBudgetDecision(mixed);
    expect(unmeasured.decision).toEqual(expect.objectContaining({ action: 'next-provider', provider: 'grok' }));
    expect(unmeasured.warning).toContain('grok usage unmeasured');
    expect(unmeasured.unmeasuredProvider).toBe('grok');
    const measured = harnessLaunchBudgetDecision({ ...mixed, grokUsedPercent: 48 });
    expect(measured.decision).toEqual(expect.objectContaining({ action: 'next-provider', provider: 'grok' }));
    expect(measured.warning).toBeUndefined();
    const exhausted = harnessLaunchBudgetDecision({ ...mixed, grokUsedPercent: 80 });
    expect(exhausted.decision.action).toBe('stop');
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
