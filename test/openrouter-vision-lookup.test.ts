// VISION-CATALOG-BUILTIN — 모르는 OpenRouter 모델은 공급자 메타데이터(input_modalities)로 한 번 묻고 캐시한다.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __resetOpenRouterVisionLookupForTests, cachedOpenRouterVision, lookupOpenRouterVision, normalizeOpenRouterUpstreamId, parseOpenRouterModelsVision,
} from '../src/llm/openrouter-vision-lookup';
import { isVisionCapableModel } from '../src/llm-vision-capability';

const body = { data: [
  { id: 'moonshotai/kimi-k3', architecture: { input_modalities: ['text', 'image'] } },
  { id: 'deepseek/deepseek-v4.1-flash', architecture: { input_modalities: ['text'] } },
  { id: 'moonshotai/kimi-k3:batch', architecture: { input_modalities: ['text'] } },
] };

const savedCache = process.env.ELANOUS_OPENROUTER_VISION_CACHE;
let cachePath = '';
beforeEach(() => {
  __resetOpenRouterVisionLookupForTests();
  cachePath = join(mkdtempSync(join(tmpdir(), 'or-vision-cache-')), 'openrouter-vision-cache.json');
  process.env.ELANOUS_OPENROUTER_VISION_CACHE = cachePath;
});
afterEach(() => {
  if (savedCache === undefined) delete process.env.ELANOUS_OPENROUTER_VISION_CACHE; else process.env.ELANOUS_OPENROUTER_VISION_CACHE = savedCache;
  __resetOpenRouterVisionLookupForTests();
});

describe('parse · normalize', () => {
  test('input_modalities 에 image 가 있으면 true · 접미사(:batch)는 같은 id · 첫 값이 이긴다', () => {
    const m = parseOpenRouterModelsVision(body);
    expect(m.get('moonshotai/kimi-k3')).toBe(true);
    expect(m.get('deepseek/deepseek-v4.1-flash')).toBe(false);
    expect(parseOpenRouterModelsVision({ nope: 1 }).size).toBe(0);
    expect(normalizeOpenRouterUpstreamId('openrouter/Anthropic/claude-sonnet-5:batch')).toBe('anthropic/claude-sonnet-5');
  });
});

describe('lookupOpenRouterVision', () => {
  test('한 번 묻고 캐시 파일에 적는다 · 두 번째는 네트워크 0', async () => {
    let calls = 0;
    const fakeFetch = (async (url: string) => {
      calls += 1;
      expect(url).toBe('https://openrouter.ai/api/v1/models');
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await lookupOpenRouterVision('openrouter/moonshotai/kimi-k3', { fetch: fakeFetch })).toBe(true);
    expect(await lookupOpenRouterVision('openrouter/deepseek/deepseek-v4.1-flash', { fetch: fakeFetch })).toBe(false);
    expect(calls).toBe(1);
    expect(existsSync(cachePath)).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, 'utf-8')).vision['moonshotai/kimi-k3']).toBe(true);
    // 판정 함수도 이 사실을 쓴다(카탈로그·내장 표에 없는 모델).
    expect(isVisionCapableModel('openrouter', 'openrouter/moonshotai/kimi-k3', 'userMessage')).toBe(true);
  });

  test('다른 프로세스 = 캐시 파일에서 읽는다(네트워크 없이)', () => {
    writeFileSync(cachePath, JSON.stringify({ version: 1, fetchedAt: '2026-11-25T00:00:00.000Z', vision: { 'qwen/qwen3.8-max-0902': true } }));
    expect(cachedOpenRouterVision('openrouter/qwen/qwen3.8-max-0902')).toBe(true);
    expect(cachedOpenRouterVision('openrouter/qwen/unknown')).toBeUndefined();
  });

  test('실패 = «모른다» · 10분 동안 다시 묻지 않는다', async () => {
    let calls = 0;
    const failing = (async () => { calls += 1; return new Response('nope', { status: 503 }); }) as unknown as typeof fetch;
    let t = 1_000_000;
    expect(await lookupOpenRouterVision('openrouter/a/b', { fetch: failing, now: () => t })).toBeUndefined();
    t += 60_000;
    expect(await lookupOpenRouterVision('openrouter/a/b', { fetch: failing, now: () => t })).toBeUndefined();
    expect(calls).toBe(1);
  });

  test('시험 런타임은 주입 fetch·명시 캐시가 없으면 네트워크로 나가지 않는다', async () => {
    delete process.env.ELANOUS_OPENROUTER_VISION_CACHE;
    const realFetch = globalThis.fetch;
    let touched = 0;
    globalThis.fetch = (async () => { touched += 1; return new Response('{}'); }) as unknown as typeof fetch;
    try {
      expect(await lookupOpenRouterVision('openrouter/a/b')).toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(touched).toBe(0);
  });
});
