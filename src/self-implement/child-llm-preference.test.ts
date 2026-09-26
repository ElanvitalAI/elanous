import { describe, expect, it, spyOn, afterEach } from 'bun:test';
import { chainFromFallbackNames, resolveChildLlmPreference } from './child-llm-preference.js';
import { buildUserConfig, DEFAULT_BUDGET_GATE, parseChildLlmPreference, parseHarnessBudgetGate, type UserConfig } from '../user-config.js';
import { debug } from '../debug/log.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function preferenceConfig(patch: {
  childLlm?: NonNullable<UserConfig['tools']['selfImplement']['childLlm']>;
  fallbackChain?: string[];
  budgetGate?: {
    minHeadroomPercent: number;
    onShortfall: 'decompose' | 'wait-reset' | 'next-provider' | 'proceed';
    maxUsedPercent?: { readonly [provider: string]: number };
  };
}): Parameters<typeof resolveChildLlmPreference>[0] {
  return {
    tools: { selfImplement: { ...(patch.childLlm ? { childLlm: patch.childLlm } : {}) } },
    llm: { provider: 'auto', ...(patch.fallbackChain ? { fallbackChain: patch.fallbackChain } : {}) },
    ...(patch.budgetGate ? { harness: { budgetGate: patch.budgetGate } } : {}),
  } as unknown as Parameters<typeof resolveChildLlmPreference>[0];
}

describe('resolveChildLlmPreference', () => {
  const warnings: string[] = [];
  const write = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    warnings.push(String(chunk));
    return true;
  });
  afterEach(() => { warnings.length = 0; });

  it('⑴ provider·model 만 있으면 pinned 한 칸', () => {
    const resolved = resolveChildLlmPreference(preferenceConfig({
      childLlm: { provider: 'openai-codex', model: 'gpt-6-sol' },
    }));
    expect(resolved.mode).toBe('pinned');
    expect(resolved.chain).toEqual([{ provider: 'openai-codex', model: 'gpt-6-sol' }]);
    expect(resolved.source).toEqual({ mode: 'inferred', chain: 'pinned' });
    expect(resolved.budgetGate).toEqual(DEFAULT_BUDGET_GATE);
  });

  it('⑵ mode auto · chain 없음 · fallbackChain 에서 만든다', () => {
    const resolved = resolveChildLlmPreference(preferenceConfig({
      childLlm: { mode: 'auto' },
      fallbackChain: ['codex-rotate', 'grok'],
    }));
    expect(resolved.mode).toBe('auto');
    expect(resolved.chain).toEqual([{ provider: 'openai-codex' }, { provider: 'grok' }]);
    expect(resolved.source.chain).toBe('fallbackChain');
    // fallbackChain 파생을 지우면 openai-codex 칸이 사라져 이 기대가 실패한다.
    const withoutFallback = resolveChildLlmPreference(preferenceConfig({ childLlm: { mode: 'auto' } }));
    expect(withoutFallback.chain.map((entry) => entry.provider)).not.toEqual(['openai-codex', 'grok']);
  });

  it('⑶ 사용자 chain 이 fallbackChain 보다 이긴다', () => {
    const resolved = resolveChildLlmPreference(preferenceConfig({
      childLlm: { mode: 'auto', chain: [{ provider: 'grok' }] },
      fallbackChain: ['codex-rotate', 'grok'],
    }));
    expect(resolved.chain).toEqual([{ provider: 'grok' }]);
    expect(resolved.source.chain).toBe('config');
  });

  it('⑷ 범위 밖 minHeadroomPercent 는 기본 15 와 경고', () => {
    const gate = parseHarnessBudgetGate({ minHeadroomPercent: 150 });
    expect(gate.minHeadroomPercent).toBe(15);
    expect(gate.onShortfall).toBe('next-provider');
    expect(warnings.some((line) => line.includes('minHeadroomPercent') && line.includes('150'))).toBe(true);
    const resolved = resolveChildLlmPreference(preferenceConfig({
      childLlm: { mode: 'auto' },
      fallbackChain: ['codex-rotate', 'grok'],
      budgetGate: gate,
    }));
    expect(resolved.budgetGate.minHeadroomPercent).toBe(15);
  });

  it('모르는 fallback 이름은 경고하고 건너뛴다', () => {
    const chain = chainFromFallbackNames(['codex-rotate', 'not-a-step', 'grok']);
    expect(chain).toEqual([{ provider: 'openai-codex' }, { provider: 'grok' }]);
    expect(warnings.some((line) => line.includes('not-a-step'))).toBe(true);
  });

  it('mode 없는 model-only 는 auto 다 — provider 가 없으면 pinned 로 추론하지 않는다', () => {
    const parsed = parseChildLlmPreference({ model: 'grok-4.6' });
    expect(parsed?.mode).toBeUndefined();
    expect(parsed?.model).toBe('grok-4.6');
    expect(parsed?.provider).toBeUndefined();
    const resolved = resolveChildLlmPreference(preferenceConfig({
      childLlm: parsed,
      fallbackChain: ['codex-rotate', 'grok'],
    }));
    expect(resolved.mode).toBe('auto');
    expect(resolved.source).toEqual({ mode: 'inferred', chain: 'fallbackChain' });
    expect(resolved.chain).toEqual([{ provider: 'openai-codex' }, { provider: 'grok' }]);
  });

  it('provider 가 숫자가 아니면 경고하고 칸을 버린다', () => {
    const parsed = parseChildLlmPreference({ provider: 123 });
    expect(parsed).toBeUndefined();
    expect(warnings.some((line) => line.includes('123'))).toBe(true);
  });

  it('객체가 아닌 childLlm 은 경고 후 버리고 기본으로 진행한다', () => {
    expect(parseChildLlmPreference('grok')).toBeUndefined();
    expect(parseChildLlmPreference(['grok'])).toBeUndefined();
    expect(warnings.some((line) => line.includes('객체가 아니다') && line.includes('grok'))).toBe(true);
    const resolved = resolveChildLlmPreference(preferenceConfig({ fallbackChain: ['codex-rotate', 'grok'] }));
    expect(resolved.mode).toBe('auto');
    expect(resolved.chain).toEqual([{ provider: 'openai-codex' }, { provider: 'grok' }]);
  });

  it('mode 가 없으면 provider 없을 때 auto', () => {
    const resolved = resolveChildLlmPreference(preferenceConfig({ fallbackChain: ['grok'] }));
    expect(resolved.mode).toBe('auto');
    expect(resolved.chain).toEqual([{ provider: 'grok' }]);
    expect(resolved.source).toEqual({ mode: 'inferred', chain: 'fallbackChain' });
  });

  it('계정 회전 칸을 만들지 않는다', () => {
    const resolved = resolveChildLlmPreference(preferenceConfig({
      childLlm: { mode: 'auto' },
      fallbackChain: ['codex-rotate'],
    }));
    expect(resolved.chain).toEqual([{ provider: 'openai-codex' }]);
    expect(JSON.stringify(resolved)).not.toContain('rotate');
    expect(JSON.stringify(resolved)).not.toContain('account');
  });

  it('잘못된 mode·chain·onShortfall 은 경고와 함께 기본', () => {
    expect(parseChildLlmPreference({ mode: 'sometimes', provider: 'grok' })).toEqual({ provider: 'grok' });
    expect(parseChildLlmPreference({ chain: 'grok', mode: 'auto' })).toEqual({ mode: 'auto' });
    expect(parseHarnessBudgetGate({ onShortfall: 'panic', minHeadroomPercent: 20 })).toEqual({
      minHeadroomPercent: 20,
      onShortfall: 'next-provider',
      maxUsedPercent: { 'openai-codex': 95, grok: 48 },
    });
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('buildUserConfig 가 provider·model 을 유지하고 budgetGate 기본을 싣는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'child-llm-pref-'));
    const path = join(dir, 'config.json');
    try {
      writeFileSync(path, JSON.stringify({
        tools: { selfImplement: { childLlm: { provider: 'openai-codex', model: 'gpt-6-sol', mode: 'auto', chain: [{ provider: 'grok', model: 'grok-4.6' }] } } },
        harness: { budgetGate: { minHeadroomPercent: 40, onShortfall: 'wait-reset' } },
      }));
      const config = buildUserConfig(path);
      expect(config.tools.selfImplement.childLlm).toEqual({
        provider: 'openai-codex',
        model: 'gpt-6-sol',
        mode: 'auto',
        chain: [{ provider: 'grok', model: 'grok-4.6' }],
      });
      expect(config.harness?.budgetGate).toEqual({
        minHeadroomPercent: 40,
        onShortfall: 'wait-reset',
        maxUsedPercent: { 'openai-codex': 95, grok: 48 },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('buildUserConfig 는 범위 밖 예산을 기본으로 접고 발사를 막지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'child-llm-pref-'));
    const path = join(dir, 'config.json');
    try {
      writeFileSync(path, JSON.stringify({ harness: { budgetGate: { minHeadroomPercent: 150, onShortfall: 'nope' } } }));
      const config = buildUserConfig(path);
      expect(config.harness?.budgetGate).toEqual(DEFAULT_BUDGET_GATE);
      expect(config.tools.selfImplement.childLlm).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // spy kept so stderr writes stay captured for the whole file
  void write;
  void debug;
});
