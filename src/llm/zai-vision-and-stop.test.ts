// ZAI-OVERAGE-STOP-RETRY ⊕ GLM 비전 경로 (대표 11-25). ⛔ 실 네트워크 0 — 가짜 fetch 장치로 요청 모양과 횟수만 본다.
// 🩸 smoke 11-25: code 1310 · overage=stop 인데 같은 요청이 3번 나갔다 · glm-5.3 은 이미지를 못 본다.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMStreamEvent } from '../llm.js';
import { makeOpenAICompatProvider } from '../llm.js';
import { withFakeFetchDevice } from '../ux-sim/fake-fetch.js';
import { fetchApiWithRetry } from '../session-runtime/retry-api.js';
import {
  isZaiCodingPlanUrl, makeZaiCodingPlanProvider, zaiLimitStopsRetry, ZaiCodingPlanLimitError, ZaiConcurrencyGate,
} from './zai-coding-plan.js';

const ZAI_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';
const SECRET = 'zai-test-SECRET-vision-0123456789';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const dirs: string[] = [];
function tmp(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function drain(gen: AsyncGenerator<LLMStreamEvent, void, unknown>): Promise<LLMStreamEvent[]> {
  const out: LLMStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}
const OK_SSE = 'data: {"choices":[{"delta":{"content":"ZEBRA-42"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n';
const LIMIT_1310 = '{"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-29 02:55:16"}}';

describe('zaiLimitStopsRetry · isZaiCodingPlanUrl', () => {
  test('플랜·잔액 한도는 재시도 금지 · 속도 제한(1302)·JSON 아님은 종전 재시도', () => {
    expect(zaiLimitStopsRetry(429, LIMIT_1310)).toBe(true);
    expect(zaiLimitStopsRetry(429, '{"error":{"code":"1308","message":"Usage limit reached for 5 hour"}}')).toBe(true);
    expect(zaiLimitStopsRetry(429, '{"error":{"code":"1113","message":"Insufficient balance"}}')).toBe(true);
    expect(zaiLimitStopsRetry(429, '{"error":{"code":"1302","message":"rate"}}')).toBe(false);
    expect(zaiLimitStopsRetry(503, 'upstream down')).toBe(false);
    expect(isZaiCodingPlanUrl(ZAI_URL)).toBe(true);
    expect(isZaiCodingPlanUrl('https://openrouter.ai/api/v1/chat/completions')).toBe(false);
  });
});

describe('fetchApiWithRetry nonRetryable', () => {
  test('nonRetryable 이 참이면 429 라도 한 번만 보낸다 · 없으면 종전처럼 재시도', async () => {
    let calls = 0;
    await withFakeFetchDevice([{ url: 'https://retry.test/x', method: 'POST', response: () => { calls += 1; return new Response(LIMIT_1310, { status: 429 }); } }], async () => {
      await expect(fetchApiWithRetry('https://retry.test/x', { method: 'POST', body: '{}' }, {
        provider: 'openai-compatible', errorPrefix: 'LLM API', nonRetryable: (e) => zaiLimitStopsRetry(e.status, e.bodyText),
      })).rejects.toThrow('LLM API 429');
    });
    expect(calls).toBe(1);
  });
});

describe('GLM 직결 — 1310 · overage=stop', () => {
  test('요청 1번 · 곧바로 ZaiCodingPlanLimitError(재시도 0 · 폴백 0)', async () => {
    let calls = 0;
    await withFakeFetchDevice([{ url: ZAI_URL, method: 'POST', response: () => { calls += 1; return new Response(LIMIT_1310, { status: 429 }); } }], async () => {
      const p = makeZaiCodingPlanProvider({ provider: 'glm', model: 'glm-5.3-flash', zaiCodingPlan: { overage: 'stop' } } as never, {
        key: () => SECRET, ledgerPath: join(tmp('zai-stop-'), 'l.jsonl'), gate: new ZaiConcurrencyGate(() => 3), quotaSnapshot: () => null,
        makeCompat: makeOpenAICompatProvider as never, openRouterKey: () => undefined,
      });
      await expect(drain(p.streamChat!([{ role: 'user', content: 'hi' }], {}))).rejects.toBeInstanceOf(ZaiCodingPlanLimitError);
    });
    expect(calls).toBe(1);
  });
});

describe('GLM 직결 — 이미지', () => {
  test('glm-5.3 에 이미지 → glm-5.3-flash 로 · user content 에 image_url(data URL) · 키 값은 본문에 없다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await withFakeFetchDevice([{
      url: ZAI_URL, method: 'POST',
      response: (request) => {
        seen.push(JSON.parse(request.body ?? '{}') as Record<string, unknown>);
        return new Response(OK_SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
    }], async () => {
      const p = makeZaiCodingPlanProvider({ provider: 'glm', model: 'glm-5.3' } as never, {
        key: () => SECRET, ledgerPath: join(tmp('zai-img-'), 'l.jsonl'), gate: new ZaiConcurrencyGate(() => 3), quotaSnapshot: () => null,
        makeCompat: makeOpenAICompatProvider as never,
      });
      const evs = await drain(p.streamChat!([{ role: 'user', content: [
        { type: 'text', text: 'What word is in the image?' },
        { type: 'image', mediaType: 'image/png', base64: PNG_B64 },
      ] }], {}));
      expect(evs.some((e) => e.type === 'text')).toBe(true);
    });
    expect(seen.length).toBe(1);
    expect(seen[0]!.model).toBe('glm-5.3-flash');
    const user = (seen[0]!.messages as Array<{ role: string; content: unknown }>).find((m) => m.role === 'user')!;
    expect(user.content).toEqual([
      { type: 'text', text: 'What word is in the image?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
    ]);
    expect(JSON.stringify(seen[0])).not.toContain(SECRET);
  });

  test('도구 결과 이미지 → 합성 user 메시지(follow-up)로 image_url 이 실린다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await withFakeFetchDevice([{
      url: ZAI_URL, method: 'POST',
      response: (request) => {
        seen.push(JSON.parse(request.body ?? '{}') as Record<string, unknown>);
        return new Response(OK_SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
    }], async () => {
      const p = makeZaiCodingPlanProvider({ provider: 'glm', model: 'glm-5.3-flash' } as never, {
        key: () => SECRET, ledgerPath: join(tmp('zai-tool-img-'), 'l.jsonl'), gate: new ZaiConcurrencyGate(() => 3), quotaSnapshot: () => null,
        makeCompat: makeOpenAICompatProvider as never,
      });
      await drain(p.streamChat!([
        { role: 'user', content: 'Read the image' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: '/x.png' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'image', mediaType: 'image/png', base64: PNG_B64 }] }] },
      ], {}));
    });
    const wire = JSON.stringify(seen[0]!.messages);
    expect(wire).toContain(`"url":"data:image/png;base64,${PNG_B64}"`);
    expect((seen[0]!.messages as Array<{ role: string }>).some((m) => m.role === 'tool')).toBe(true);
  });
});

describe('GLM 직결 — 이미지 요청의 OpenRouter 폴백', () => {
  test('overage=openrouter · 1308 → 이미지 요청은 openrouter/z-ai/glm-5.3-flash 로(text-only glm-5.3 아님)', async () => {
    const orModels: string[] = [];
    await withFakeFetchDevice([{ url: ZAI_URL, method: 'POST', response: () => new Response('{"error":{"code":"1308","message":"Usage limit reached for 5 hour"}}', { status: 429 }) }], async () => {
      const p = makeZaiCodingPlanProvider({ provider: 'glm', model: 'glm-5.3', zaiCodingPlan: { overage: 'openrouter' } } as never, {
        key: () => SECRET, ledgerPath: join(tmp('zai-or-img-'), 'l.jsonl'), gate: new ZaiConcurrencyGate(() => 3), quotaSnapshot: () => null,
        makeCompat: makeOpenAICompatProvider as never, openRouterKey: () => 'or-key',
        makeOpenRouter: () => ({
          name: 'openrouter', defaultModel: 'x', available: () => true,
          async *streamChat(_m, opts) { orModels.push(String(opts?.model)); yield { type: 'text', delta: 'ZEBRA-42' }; },
          async *chat() { /* unused */ },
        }),
      });
      await drain(p.streamChat!([{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', base64: PNG_B64 }] }], {}));
    });
    expect(orModels).toEqual(['openrouter/z-ai/glm-5.3-flash']);
  });
});
