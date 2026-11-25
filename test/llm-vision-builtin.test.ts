// VISION-CATALOG-BUILTIN (대표 2026-11-25 «이미지는 모든 공급자에서») — 발견 스냅숏이 없어도 현행 주력 모델은 비전이다.
// 기대값은 OpenRouter `/api/v1/models` input_modalities 실측(11-25)의 리터럴 — 제품 표에서 만들지 않는다.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinVisionFact, glmVisionFact, isVisionCapableModel, brandLikelyVisionCapable } from '../src/llm-vision-capability';
import { isLikelyVisionModel, messagesCarryImages } from '../src/llm';
import { reloadCatalog } from '../src/registry/loader';

const saved = process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT;
beforeAll(() => { delete process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT; reloadCatalog(); });
afterAll(() => {
  if (saved === undefined) delete process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT; else process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT = saved;
  reloadCatalog();
});

describe('builtinVisionFact — upstream id', () => {
  test('Claude 현행(opus-5.5 · sonnet-5.5 · sonnet-5 · haiku-5.5) = 비전', () => {
    expect(builtinVisionFact('anthropic/claude-opus-5.5')).toBe(true);
    expect(builtinVisionFact('anthropic/claude-sonnet-5.5')).toBe(true);
    expect(builtinVisionFact('anthropic/claude-sonnet-5')).toBe(true);
    expect(builtinVisionFact('anthropic/claude-haiku-5.5')).toBe(true);
  });
  test('grok 4.x · gemini · gpt-6.1-terra = 비전', () => {
    expect(builtinVisionFact('x-ai/grok-4.20')).toBe(true);
    expect(builtinVisionFact('x-ai/grok-4.7')).toBe(true);
    expect(builtinVisionFact('google/gemini-3.8-flash')).toBe(true);
    expect(builtinVisionFact('openai/gpt-6.1-terra')).toBe(true);
  });
  test('GLM — flash 5.3 · V 변형만 비전 · glm-5.3 은 text-only(사실 false)', () => {
    expect(builtinVisionFact('z-ai/glm-5.3-flash')).toBe(true);
    expect(builtinVisionFact('z-ai/glm-5v-turbo')).toBe(true);
    expect(builtinVisionFact('z-ai/glm-4.6v')).toBe(true);
    expect(builtinVisionFact('z-ai/glm-4.5v')).toBe(true);
    expect(builtinVisionFact('z-ai/glm-5.3')).toBe(false);
    expect(builtinVisionFact('z-ai/glm-4.7-flash')).toBe(false);
  });
  test('모르는 벤더는 «모른다»(undefined)', () => {
    expect(builtinVisionFact('moonshotai/kimi-k3')).toBeUndefined();
    expect(builtinVisionFact('no-slash')).toBeUndefined();
  });
});

describe('glmVisionFact — z.ai 직결 id', () => {
  test('glm-5.3-flash 비전 · glm-5.3 text-only · 남의 id 는 모른다', () => {
    expect(glmVisionFact('glm-5.3-flash')).toBe(true);
    expect(glmVisionFact('GLM-4.6V')).toBe(true);
    expect(glmVisionFact('glm-5.3')).toBe(false);
    expect(glmVisionFact('kimi-k3')).toBeUndefined();
  });
});

describe('isVisionCapableModel — 스냅숏 없이', () => {
  test('openrouter/anthropic/claude-sonnet-5 · opus-5.5 = userMessage 비전 (smoke 11-25 FAIL 의 원인)', () => {
    expect(isVisionCapableModel('openrouter', 'openrouter/anthropic/claude-sonnet-5', 'userMessage')).toBe(true);
    expect(isVisionCapableModel('openrouter', 'openrouter/anthropic/claude-opus-5.5', 'userMessage')).toBe(true);
    expect(isVisionCapableModel('openrouter', 'openrouter/x-ai/grok-4.20', 'userMessage')).toBe(true);
    expect(isVisionCapableModel('openrouter', 'openrouter/anthropic/claude-sonnet-5', 'toolResult')).toBe(false);
  });
  test('glm 브랜드 — flash 는 userMessage 비전(도구 이미지 follow-up 켜짐) · glm-5.3 아님', () => {
    expect(isVisionCapableModel('glm', 'glm-5.3-flash', 'userMessage')).toBe(true);
    expect(isVisionCapableModel('glm', 'glm-5.3', 'userMessage')).toBe(false);
    expect(isVisionCapableModel('glm', 'glm-5.3-flash', 'toolResult')).toBe(false);
    expect(brandLikelyVisionCapable('glm')).toBe(true);
  });
  test('카탈로그 사실이 내장 표를 이긴다 — 스냅숏이 text-only 라 하면 false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vision-builtin-'));
    const path = join(dir, 's.json');
    const meta = { source: 'auto-openrouter-api', lastSeen: 'x', autoFilled: true, confidence: 'high' };
    writeFileSync(path, JSON.stringify({ version: 1, generatedAt: 'x', sources: [], models: [
      { id: 'anthropic/claude-haiku-5.5', provider: 'openrouter', partial: { id: 'anthropic/claude-haiku-5.5', provider: 'openrouter', vision: null }, discoveryMeta: meta },
    ] }));
    process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT = path;
    reloadCatalog();
    expect(isVisionCapableModel('openrouter', 'openrouter/anthropic/claude-haiku-5.5', 'userMessage')).toBe(false);
    delete process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT;
    reloadCatalog();
    expect(isVisionCapableModel('openrouter', 'openrouter/anthropic/claude-haiku-5.5', 'userMessage')).toBe(true);
  });
});

describe('isLikelyVisionModel — 같은 규칙', () => {
  test('GLM · OpenRouter Claude', () => {
    expect(isLikelyVisionModel('glm-5.3-flash')).toBe(true);
    expect(isLikelyVisionModel('glm-5.3')).toBe(false);
    expect(isLikelyVisionModel('openrouter/anthropic/claude-sonnet-5')).toBe(true);
  });
});

describe('messagesCarryImages', () => {
  test('사용자 첨부 · 도구 결과 이미지 · 글만', () => {
    expect(messagesCarryImages([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image', mediaType: 'image/png', base64: 'AAAA' }] }])).toBe(true);
    expect(messagesCarryImages([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', mediaType: 'image/png', base64: 'AAAA' }] }] }])).toBe(true);
    expect(messagesCarryImages([{ role: 'user', content: 'hi' }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }])).toBe(false);
  });
});
