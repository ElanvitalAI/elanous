// ── Per-model system-prompt addon (codex/gpt-5 tool discipline) ──
//
// Locks the family-classification + addon selector so a future model
// rename doesn't accidentally strip the discipline from gpt-5.x or
// attach it to Claude/Grok/Gemini where it would be dead weight.

import { describe, test, expect } from 'bun:test';
import { getModelFamily, getModelPromptAddon, getModelTier } from '../src/models/prompts';
import { stripLocalLlmSpec, usesLongReasoningIdle } from '../src/llm';

describe('getModelFamily', () => {
  test('claude ids → "claude"', () => {
    expect(getModelFamily('claude-opus-4-6')).toBe('claude');
    expect(getModelFamily('claude-sonnet-4-5')).toBe('claude');
    expect(getModelFamily('claude-haiku-4-5-20251001')).toBe('claude');
  });

  test('codex + gpt-5 → "codex" (the weak-tool-call family)', () => {
    expect(getModelFamily('codex-mini-latest')).toBe('codex');
    expect(getModelFamily('gpt-5.4')).toBe('codex');
    expect(getModelFamily('gpt-5.4-mini')).toBe('codex');
    expect(getModelFamily('gpt-5')).toBe('codex');
  });

  test('older gpt / o-series → "gpt"', () => {
    expect(getModelFamily('gpt-4o')).toBe('gpt');
    expect(getModelFamily('gpt-4-turbo')).toBe('gpt');
    expect(getModelFamily('o1-preview')).toBe('gpt');
    expect(getModelFamily('o3-mini')).toBe('gpt');
  });

  test('grok / gemini / local / unknown', () => {
    expect(getModelFamily('grok-4-1-fast')).toBe('grok');
    expect(getModelFamily('gemini-2.0-flash')).toBe('gemini');
    expect(getModelFamily('local:llama-3')).toBe('local');
    expect(getModelFamily('something-weird-xyz')).toBe('other');
  });

  test('resolved local relay model selects local while raw LM Studio IDs remain other', () => {
    const rawModel = 'lmstudio-community/gemma-4-26b-a4b-it';
    const resolvedModel = `local:${rawModel}`;
    expect(getModelFamily(rawModel)).toBe('other');
    expect(getModelFamily(resolvedModel)).toBe('local');
    expect(getModelPromptAddon(resolvedModel)).toBe('');
    expect(usesLongReasoningIdle(getModelFamily(resolvedModel))).toBe(true);
    expect(usesLongReasoningIdle(getModelFamily(rawModel))).toBe(false);
    expect(stripLocalLlmSpec(resolvedModel)).toBe(rawModel);
  });

  test('OpenRouter GLM, Kimi, Qwen IDs → open-weight only', () => {
    for (const id of [
      'openrouter/z-ai/glm-5.3', 'openrouter/z-ai/glm-5.3-flash',
      'openrouter/moonshotai/kimi-k3', 'openrouter/qwen/qwen3.8-max-0902',
      'OPENROUTER/QWEN/QWEN3.8-FLASH',
    ]) {
      expect(getModelFamily(id)).toBe('open-weight');
      expect(getModelPromptAddon(id)).toBe('');
      expect(usesLongReasoningIdle(getModelFamily(id))).toBe(false);
    }
    expect(getModelFamily('openrouter/anthropic/claude-opus-4-8')).toBe('claude');
    for (const id of [
      'qwen3.8-27b-mlx', 'qwen3.6-flash', 'kimi-k2.6', 'glm-4.5-air',
      'lmstudio-community/gemma-4-26b-a4b-it', 'openrouter/acme/model',
      'vendor/qwen3.8-flash',
      // bare vendor ids — LM Studio native keys look like this; they must stay 'other'.
      'moonshotai/kimi-k3', 'z-ai/glm-5.3', 'qwen/qwen3.8-flash', 'qwen/qwen3-coder-30b',
    ]) expect(getModelFamily(id)).toBe('other');
    expect(getModelFamily('local:qwen')).toBe('local');
  });

  test('undefined / empty → "other"', () => {
    expect(getModelFamily(undefined)).toBe('other');
    expect(getModelFamily('')).toBe('other');
  });

  test('case-insensitive matching', () => {
    expect(getModelFamily('CLAUDE-OPUS-4-6')).toBe('claude');
    expect(getModelFamily('GPT-5.4')).toBe('codex');
  });
});

// ── 유휴 상한은 «구동기»로도 갈린다 (2026-09-13 🅕) ──────────────────
//
// 🩸 왜 있나: `getModelFamily` 가 `startsWith('gpt-5')` 로 codex 를 «버전으로» 박아서
//    같은 구독 구동기로 도는 `gpt-6-astra` 가 `gpt` 로 떨어지고 45초를 받았다.
//    실측(일곱 판): 턴 82.4초 → idle-timeout → `calls []` → 빈 턴 → give-up.
//    ⇒ 이 describe 가 빨강이면 astra 는 ***다시*** 도착 전에 잘린다.
describe('usesLongReasoningIdle — 구동기 축', () => {
  test('⛔⭐ `gpt-6-astra` 는 계열로는 `gpt` 지만 openai-codex 로 돌면 «긴» 유휴다', () => {
    expect(getModelFamily('gpt-6-astra')).toBe('gpt');
    // 계열만 보면 45초 — 이것이 관측된 실패의 원인이었다.
    expect(usesLongReasoningIdle(getModelFamily('gpt-6-astra'))).toBe(false);
    // 구동기를 같이 보면 180초.
    expect(usesLongReasoningIdle(getModelFamily('gpt-6-astra'), 'openai-codex')).toBe(true);
  });

  test('동료(sol·terra)는 «무변경» — 계열만으로도 이미 길다', () => {
    for (const m of ['gpt-5.6-sol', 'gpt-5.6-terra']) {
      expect(getModelFamily(m)).toBe('codex');
      expect(usesLongReasoningIdle(getModelFamily(m))).toBe(true);
      expect(usesLongReasoningIdle(getModelFamily(m), 'openai-codex')).toBe(true);
    }
  });

  test('⛔ 과탐 방지 — 구동기가 openai-codex 가 «아니면» gpt 계열은 그대로 45초', () => {
    expect(usesLongReasoningIdle(getModelFamily('gpt-4o'), 'openai')).toBe(false);
    expect(usesLongReasoningIdle(getModelFamily('gpt-4o'))).toBe(false);
    expect(usesLongReasoningIdle('other', 'openai')).toBe(false);
    expect(usesLongReasoningIdle(undefined, undefined)).toBe(false);
  });
});

describe('getModelPromptAddon — discipline applies only to weak-tool families', () => {
  test('codex family → non-empty addon with stricter state-polling guard', () => {
    const a = getModelPromptAddon('gpt-5.4');
    expect(a.length).toBeGreaterThan(200);
    expect(a).toContain('Tool-call hygiene');
    expect(a).toContain('read-only state tools');
    // Orchestrator / sub-agent delegation is the skill runner's
    // concern — it lives in buildSkillMessages, not here. Keeping it
    // out of the global addon prevents ordinary analysis turns from
    // being biased toward "delegate everything" behaviour.
    expect(a).not.toContain('ORCHESTRATOR');
    expect(a).not.toContain('Agent tool');
  });

  test('gpt family gets a lighter addon than codex family', () => {
    const gpt = getModelPromptAddon('gpt-4o');
    const codex = getModelPromptAddon('gpt-5.4');
    expect(gpt.length).toBeGreaterThan(100);
    expect(gpt).toContain('Tool-call hygiene');
    expect(gpt).not.toContain('read-only state tools');
    expect(codex).not.toBe(gpt);
  });

  test('claude family → empty string (already disciplined)', () => {
    expect(getModelPromptAddon('claude-opus-4-6')).toBe('');
    expect(getModelPromptAddon('claude-sonnet-4-5')).toBe('');
    expect(getModelPromptAddon('claude-haiku-4-5-20251001')).toBe('');
  });

  test('grok / gemini / local / unknown → empty string', () => {
    expect(getModelPromptAddon('grok-4-1-fast')).toBe('');
    expect(getModelPromptAddon('gemini-2.0-flash')).toBe('');
    expect(getModelPromptAddon('local:llama')).toBe('');
    expect(getModelPromptAddon('something-weird')).toBe('');
  });

  test('undefined / empty → empty string (safe no-op)', () => {
    expect(getModelPromptAddon(undefined)).toBe('');
    expect(getModelPromptAddon('')).toBe('');
  });

  test('codex hygiene rules cover the observed failures', () => {
    const a = getModelPromptAddon('gpt-5.4');
    expect(a).toContain('1. NEVER call the same tool');
    expect(a).toContain('2. Treat read-only state tools as stable');
    expect(a).toContain('3. After each tool_result');
    expect(a).toContain('4. If any tool_result contains');
  });

  test('addon mentions every runtime marker so model knows when to stop', () => {
    const a = getModelPromptAddon('gpt-5.4');
    expect(a).toContain('DUPLICATE CALL');
    expect(a).toContain('RUNTIME BLOCKED');
    expect(a).toContain('TOOL CALL REJECTED');
    expect(a).toContain('SYSTEM BUDGET NOTICE');
  });
});

// Session 21 — skill tier classification for router gating.
describe('getModelTier', () => {
  test('frontier models → T1', () => {
    expect(getModelTier('anthropic', 'claude-opus-4-6')).toBe('T1');
    expect(getModelTier('anthropic', 'claude-sonnet-4-5')).toBe('T1');
    expect(getModelTier('openai-codex', 'gpt-5.4')).toBe('T1');
    expect(getModelTier('grok', 'grok-4.20')).toBe('T1');
    expect(getModelTier('gemini', 'gemini-2.5-pro')).toBe('T1');
    expect(getModelTier('openai', 'o3-mini')).toBe('T1');
  });

  test('mini models → T2', () => {
    expect(getModelTier('anthropic', 'claude-haiku-4-5-20251001')).toBe('T2');
    expect(getModelTier('openai-codex', 'gpt-5-mini')).toBe('T2');
    expect(getModelTier('gemini', 'gemini-2.5-flash')).toBe('T2');
    expect(getModelTier('grok', 'grok-3-mini')).toBe('T2');
    expect(getModelTier('openai', 'gpt-4o')).toBe('T2');
  });

  test('local provider → T3 regardless of model id', () => {
    expect(getModelTier('local', 'mlx-community/gemma-4-26b-a4b-it')).toBe('T3');
    expect(getModelTier('local', undefined)).toBe('T3');
    expect(getModelTier('local', 'claude-opus-4-6')).toBe('T3');   // provider wins
  });

  test('community model ids (GGUF / MLX / Gemma / Llama / Qwen) → T3', () => {
    expect(getModelTier('auto', 'mlx-community/gemma-4-26b-a4b-it')).toBe('T3');
    expect(getModelTier('auto', 'lmstudio-community/gemma-4-26b-a4b-it-GGUF')).toBe('T3');
    expect(getModelTier('auto', 'local:llama3-70b')).toBe('T3');
    expect(getModelTier('auto', 'qwen2.5-coder')).toBe('T3');
  });

  test('unknown models default to T2 (conservative)', () => {
    expect(getModelTier('auto', 'mystery-model-v1')).toBe('T2');
    expect(getModelTier(undefined, undefined)).toBe('T2');
    expect(getModelTier('auto', '')).toBe('T2');
  });
});
// ⭐ 2026-09-23 — T1 은 «사다리에서 파생»된다. ⛔ 값(오늘의 모델명)을 박지 않고 불변식으로 적는다:
//   모델 이관이 사다리를 바꾸면 이 시험은 «새 값»으로 저절로 따라간다.
describe('getModelTier — 사다리 파생 불변식', () => {
  test('shipping 사다리의 best·loaded 칸 모델은 (로컬이 아니면) T1 이다', async () => {
    const { LLM_TIER_MAP_BY_PROVIDER, TIER_PROVIDERS } = await import('../src/model-tier/llm-tier-map');
    let pressed = 0;
    for (const provider of TIER_PROVIDERS) {
      if (provider === 'local') continue;
      for (const tier of ['best', 'loaded'] as const) {
        const spec = LLM_TIER_MAP_BY_PROVIDER[provider][tier];
        if (spec.status !== 'shipping') continue;
        pressed++;
        expect(`${provider}:${spec.model}=${getModelTier(provider, spec.model)}`).toBe(`${provider}:${spec.model}=T1`);
      }
    }
    expect(pressed).toBeGreaterThan(4);   // 자가 공허하지 않다
  });

  test('로컬 사다리는 best 칸이어도 T3 그대로다', async () => {
    const { LLM_TIER_MAP_BY_PROVIDER } = await import('../src/model-tier/llm-tier-map');
    expect(getModelTier('local', LLM_TIER_MAP_BY_PROVIDER.local.best.model)).toBe('T3');
  });

  test('⛔ 클라우드 게이트웨이 id 는 이름에 qwen 이 있어도 T3(로컬)이 아니다 — 대조군: 접두 없는 qwen 은 T3', () => {
    expect(getModelTier('openrouter', 'openrouter/qwen/qwen3.8-max-0902')).not.toBe('T3');
    expect(getModelTier(undefined, 'openrouter/qwen/qwen3.8-flash')).not.toBe('T3');
    expect(getModelTier(undefined, 'qwen3.6-flash')).toBe('T3');
  });
});

