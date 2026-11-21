// ⛔ 2026-09-23 — provider 이름 «손 목록»이 새 provider 를 조용히 거른 사고가 하루에 셋이었다
//   (`TIER_PROVIDERS` · `CONFIG_LLM_PROVIDER_NAMES` · `RUNTIME_LLM_PROVIDER_NAMES` — 전부 `openrouter` 누락).
//   tsc 는 배열 누락을 못 잡는다. ⭐ 오늘의 목록을 박지 않고 «사다리가 shipping 이라 말하는 provider» 로 파생한다.
import { describe, expect, test } from 'bun:test';
import { LLM_TIER_MAP_BY_PROVIDER, TIER_PROVIDERS } from '../src/model-tier/llm-tier-map';
import { MODEL_TIERS } from '../src/model-tier/types';
import { CONFIG_LLM_PROVIDER_NAMES, RUNTIME_LLM_PROVIDER_NAMES, parseRoleLlmEntry } from '../src/user-config';

const shipping = TIER_PROVIDERS.filter((p) => MODEL_TIERS.some((t) => LLM_TIER_MAP_BY_PROVIDER[p][t].status === 'shipping'));

describe('shipping 사다리 provider 는 config·env·--role-llm 로 «고를 수 있다»', () => {
  test('자가 공허하지 않다', () => { expect(shipping.length).toBeGreaterThan(4); });
  test('config 수용 목록 ⊇ shipping', () => {
    expect(shipping.filter((p) => !CONFIG_LLM_PROVIDER_NAMES.includes(p))).toEqual([]);
  });
  test('runtime(env·role-llm) 목록 ⊇ shipping', () => {
    expect(shipping.filter((p) => !RUNTIME_LLM_PROVIDER_NAMES.includes(p))).toEqual([]);
  });
  test('셋업·온보딩의 키 감지 표(PROVIDER_ENV_SPEC) ⊇ shipping', async () => {
    const { PROVIDER_ENV_SPEC } = await import('../src/setup/llm-env-detect');
    const known = new Set(PROVIDER_ENV_SPEC.map((s) => s.provider));
    expect(shipping.filter((p) => !known.has(p))).toEqual([]);
  });
  test('--role-llm 이 shipping provider 를 받는다', () => {
    const rejected = shipping.filter((p) => !parseRoleLlmEntry({ provider: p }).ok);
    expect(rejected).toEqual([]);
  });
});

describe('모델 id → 계열/호환 — 게이트웨이 접두가 먼저다', () => {
  test('TimelyRouter 접두는 내부 모델 이름이 타 공급자와 같아도 자격을 분리한다', async () => {
    const { inferRuntimeLlmModelFamily, isRuntimeLlmModelCompatibleWithProvider } = await import('../src/user-config');
    const id = 'timelyrouter/anthropic/claude-demo';
    expect(inferRuntimeLlmModelFamily(id)).toBe('timelyrouter');
    expect(isRuntimeLlmModelCompatibleWithProvider('timelyrouter', id)).toBe(true);
    expect(isRuntimeLlmModelCompatibleWithProvider('openrouter', id)).toBe(false);
    expect(isRuntimeLlmModelCompatibleWithProvider('anthropic', id)).toBe(false);
  });

  test('openrouter/* 는 openrouter 계열이고 openrouter 와만 호환된다(벤더 이름이 claude 여도)', async () => {
    const { inferRuntimeLlmModelFamily, isRuntimeLlmModelCompatibleWithProvider } = await import('../src/user-config');
    const { LLM_TIER_MAP_BY_PROVIDER } = await import('../src/model-tier/llm-tier-map');
    const ids = [...new Set(MODEL_TIERS.map((t) => LLM_TIER_MAP_BY_PROVIDER.openrouter[t].model)), 'openrouter/anthropic/claude-x'];
    for (const id of ids) {
      expect(inferRuntimeLlmModelFamily(id)).toBe('openrouter');
      expect(isRuntimeLlmModelCompatibleWithProvider('openrouter', id)).toBe(true);
      expect(isRuntimeLlmModelCompatibleWithProvider('grok', id)).toBe(false);
    }
    expect(isRuntimeLlmModelCompatibleWithProvider('anthropic', 'claude-opus-5')).toBe(true);   // 대조군
  });
});
