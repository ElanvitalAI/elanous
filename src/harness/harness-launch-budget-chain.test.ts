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

  // #24276(LLM-SHARE): 발사 관문은 grok «못 쟀다»를 통과로 보지 않는다(주간 사용률 80% 상한을 실제로 적용).
  //   codex 의 «못 쟀다»만 경고와 함께 발사한다.
  test('unmeasured codex launches with its own warning; unmeasured grok does not launch', () => {
    const noUsage = { ...inputs([{ provider: 'openai-codex' }, { provider: 'grok' }]), codexCandidates: [{ name: 'default' }], grokUsedPercent: undefined } as BudgetInputs;
    const codex = harnessLaunchBudgetDecision(noUsage);
    expect(codex.decision).toEqual(expect.objectContaining({ action: 'proceed', provider: 'openai-codex' }));
    expect(codex.warning).toContain('openai-codex usage unmeasured');
    expect(codex.unmeasuredProvider).toBe('openai-codex');
    const grok = harnessLaunchBudgetDecision(noUsage, { childLlmProvider: 'grok' });
    expect(grok.decision).toEqual(expect.objectContaining({ action: 'stop', reasons: ['grok: 모름'] }));
    expect(grok.unmeasuredProvider).toBeUndefined();
  });

  test('measured exhausted codex falls through to measured grok under the launch cap, never to unmeasured grok', () => {
    const mixed = { ...inputs([{ provider: 'openai-codex' }, { provider: 'grok' }]), codexCandidates: [{ name: 'default', usedPercent: 95 }], grokUsedPercent: undefined } as BudgetInputs;
    const unmeasured = harnessLaunchBudgetDecision(mixed);
    expect(unmeasured.decision.action).toBe('stop');
    expect(unmeasured.warning).toBeUndefined();
    expect(unmeasured.unmeasuredProvider).toBeUndefined();
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
