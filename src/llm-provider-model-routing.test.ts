// ── getProviderForConfig: 라우팅-타임 model 인자 존중 (2026-07-15) ──────────────
//
// 종전엔 provider 가 명시(≠auto)면 `getProviderForConfig(cfg, model)` 의 model 인자를 버리고 cfg.model(혹은
// 브랜드 상수)만 썼다 — auto 모드는 getProvider(model)로 존중하는데 명시 provider 는 무시(비대칭). per-call
// 핀(resolveDefaultProvider(cfg,'grok-4.5') 등)이 조용히 기본 모델로 내려앉았다. 이 테스트가 대칭을 잠근다.

import { describe, it, expect } from 'bun:test';
import { getProviderForConfig } from './llm.js';
import type { UserConfig } from './user-config/types.js';

const cfg = (over: Record<string, unknown> = {}): UserConfig =>
  ({ llm: { provider: 'grok', model: 'grok-config-default', apiKey: 'k', ...over } }) as unknown as UserConfig;

describe('getProviderForConfig — 라우팅-타임 model 존중(대칭)', () => {
  it('명시 provider + model 인자 → provider.defaultModel 이 요청 모델 반영', () => {
    const p = getProviderForConfig(cfg(), 'grok-4.5');
    expect(p.name).toBe('grok');
    expect(p.defaultModel).toBe('grok-4.5'); // 종전엔 'grok-config-default' 로 내려앉음(버그)
  });

  it('model 인자 미지정 → 기존대로 cfg.model 사용(무변경)', () => {
    const p = getProviderForConfig(cfg());
    expect(p.defaultModel).toBe('grok-config-default');
  });

  it('provider 별로 요청 모델 스레딩(anthropic/openai/gemini)', () => {
    expect(getProviderForConfig(cfg({ provider: 'anthropic' }), 'claude-opus-4-8').defaultModel).toBe('claude-opus-4-8');
    expect(getProviderForConfig(cfg({ provider: 'openai' }), 'gpt-5.6').defaultModel).toBe('gpt-5.6');
    expect(getProviderForConfig(cfg({ provider: 'gemini' }), 'gemini-3.1-pro-preview').defaultModel).toBe('gemini-3.1-pro-preview');
  });
});

describe('getProviderForConfig — cross-family 모델은 implied provider 로 라우팅(400 수리)', () => {
  it('config=openai-codex + claude-opus 모델 → anthropic 어댑터(codex 400 방지)', () => {
    // "codex 분해 → opus 비평" adversarial 다양성의 배선 전제. 종전엔 Opus 를 codex Responses API 로
    // 보내 400. 이제 모델의 implied provider(anthropic)로 재라우팅.
    const p = getProviderForConfig(cfg({ provider: 'openai-codex', model: 'gpt-5.6-sol' }), 'claude-opus-4-8');
    expect(p.name).toBe('anthropic');
    expect(p.defaultModel).toBe('claude-opus-4-8');
  });

  it('same-family 는 유지 — config=openai-codex + gpt 모델은 codex 어댑터', () => {
    const p = getProviderForConfig(cfg({ provider: 'openai-codex', model: 'gpt-5.6-sol' }), 'gpt-5.6-sol');
    expect(p.name).toBe('openai-codex'); // openai↔openai-codex 호환 — override 안 함
  });

  it('config=anthropic + grok 모델 → grok 어댑터(cross-family)', () => {
    const p = getProviderForConfig(cfg({ provider: 'anthropic', model: 'claude-opus-4-8' }), 'grok-4.5');
    expect(p.name).toBe('grok');
    expect(p.defaultModel).toBe('grok-4.5');
  });

  it('model 미지정이면 config provider 유지(무변경·회귀 0)', () => {
    expect(getProviderForConfig(cfg({ provider: 'anthropic', model: 'claude-opus-4-8' })).name).toBe('anthropic');
  });
});
