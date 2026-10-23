import { describe, expect, test } from 'bun:test';
import { ZAI_OPENROUTER_FALLBACK_MODEL } from '../llm/zai-coding-plan.js';
import { applyGlmCredentialFallback, decideGlmChildCredential, GlmChildCredentialError } from '../self-dev/glm-credential-guard.js';
import { glmNoCredentialReceipt, renderGlmNoCredential, simGlmNoCredential } from './fault-glm-no-credential.js';

// GLM-NO-CREDENTIAL-FALLBACK (OP #28375) — 생산 발사 직전 해석(toSelfImplementOptions)을 가짜 자격 env 로 그대로 부른다.
describe('fault-glm-no-credential — glm 자식 자격 없음 · 발사 전 판정', () => {
  test('ZAI 없음 ⊕ OpenRouter 있음 → openrouter/z-ai/glm-5.3 로 바꿔 발사 · glm-no-credential-fallback 관측', () => {
    const obs = simGlmNoCredential({ zaiKey: false, openrouterKey: true, injectionId: 'inj-glm-fallback' });
    console.log(renderGlmNoCredential(obs).join('\n'));
    expect(obs.result).toBe('fallback');
    expect(obs.childLlm).toEqual({ provider: 'openrouter', model: ZAI_OPENROUTER_FALLBACK_MODEL, source: 'flag' });
    expect(obs.rows).toContainEqual({
      category: 'self-dev.child-llm',
      event: 'glm-no-credential-fallback',
      data: expect.objectContaining({ from: 'glm/glm-5.3', to: `openrouter/${ZAI_OPENROUTER_FALLBACK_MODEL}`, reason: expect.stringContaining('Z.ai 자격 없음') }),
    });
  });

  test('ZAI 없음 ⊕ OpenRouter 없음 → 발사 전 거부(이유 한 줄) · 조용한 no-progress 없음', () => {
    const obs = simGlmNoCredential({ zaiKey: false, openrouterKey: false, injectionId: 'inj-glm-refuse' });
    console.log(renderGlmNoCredential(obs).join('\n'));
    expect(obs.result).toBe('refused');
    expect(obs.childLlm).toBeNull();
    expect(obs.error).toContain('발사 전 거부');
    expect(obs.error).toContain('ZAI_API_KEY');
    expect(obs.error).toContain('OPENROUTER_API_KEY');
    expect(obs.error).not.toContain('\n');
    expect(obs.rows.map((row) => row.event)).toEqual(['glm-no-credential-refused']);
  });

  test('ZAI 있음 → glm 그대로(OpenRouter 유무 무관) · 관측 0 · 배너가 «no provider configured» 라고 거짓말하지 않는다', () => {
    for (const openrouterKey of [true, false]) {
      const obs = simGlmNoCredential({ zaiKey: true, openrouterKey, model: 'glm-5.3-flash' });
      expect(obs.result).toBe('keep');
      expect(obs.childLlm).toEqual({ provider: 'glm', model: 'glm-5.3-flash', source: 'flag' });
      expect(obs.rows).toEqual([]);
      // 🩸 run-6c85c69f — Pod 자식 PTY 첫 줄이 자격이 «있는데도» 이 문면이었고, 부검이 그것을 원인으로 읽었다.
      expect(obs.banner).not.toContain('no provider configured');
      expect(obs.banner).toContain('provider: glm / glm-5.3-flash');
      expect(obs.banner).toContain('ZAI_API_KEY');
    }
  });

  test('glm 이 아닌 자식은 건드리지 않는다 · 순수 판정 표', () => {
    const none = { zai: () => false, openrouter: () => false };
    const grok = { provider: 'grok', model: 'grok-4.6', source: 'flag' as const };
    expect(decideGlmChildCredential(grok, none)).toEqual({ kind: 'keep' });
    expect(applyGlmCredentialFallback(grok, none)).toBe(grok);
    expect(applyGlmCredentialFallback(undefined, none)).toBeUndefined();
    expect(decideGlmChildCredential({ provider: 'glm', model: 'glm-5.3' }, { zai: () => true, openrouter: () => false })).toEqual({ kind: 'keep' });
    expect(decideGlmChildCredential({ provider: 'glm', model: 'glm-5.3' }, { zai: () => false, openrouter: () => true }).kind).toBe('fallback');
    expect(() => applyGlmCredentialFallback({ provider: 'glm', model: 'glm-5.3', source: 'config', effort: 'high' }, none)).toThrow(GlmChildCredentialError);
    // effort·source 는 그대로 — 바뀌는 것은 길(provider·model)뿐
    expect(applyGlmCredentialFallback({ provider: 'glm', model: 'glm-5.3-flash', source: 'config', effort: 'high' }, { zai: () => false, openrouter: () => true }))
      .toEqual({ provider: 'openrouter', model: ZAI_OPENROUTER_FALLBACK_MODEL, source: 'config', effort: 'high' });
  });

  test('영수증 = 명령 ⊕ injectionId ⊕ 결과', () => {
    expect(glmNoCredentialReceipt({ injectionId: 'inj-x', result: 'fallback' })).toBe('영수증: bun test src/ux-sim/fault-glm-no-credential.test.ts ⊕ inj-x ⊕ fallback');
  });
});
