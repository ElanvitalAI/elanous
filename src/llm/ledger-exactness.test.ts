// JUD-B mustFix 회귀 (judb-39659-9d9d8ff1986d) — 원장 행 정확성: 요청 1회당 llm.usage 행 1개.
// 범위는 OP 결정(#132724): signal-dedup·keyword-crawl 파싱 throw 이중행 금지 ·
// streamChatLedgered 조기 break 원본 정리 + 동기 생성 throw 1행.
// (knowledge 임베딩은 OP 결정으로 이번 PR에서 제거 — FU #132724)
import { test, expect, describe, beforeAll, afterAll, mock, spyOn } from 'bun:test';
import { debug } from '../debug/log.js';
import { llmOnce } from '../domains/signal-dedup.js';
import { buildGrokLiveSearchKeywordCallable } from '../intake-plane/keyword-crawl-grok.js';
import { streamChatLedgered } from '../llm/ledgered-call.js';

type Row = Record<string, unknown>;
const rows: Row[] = [];

let fetchImpl: ((...a: unknown[]) => Promise<Response>) | undefined;

beforeAll(async () => {
  spyOn(debug, 'log').mockImplementation((category: string, event: string, data?: unknown) => {
    if (category === 'llm.usage' && event === 'llm-usage') rows.push((data ?? {}) as Row);
  });
  const gateway = await import('../session-runtime/llm-call-gateway.js');
  mock.module('../session-runtime/llm-call-gateway.js', () => ({
    ...gateway,
    llmNetworkFetch: async (...a: unknown[]) => {
      // 공용 시그니처로 캐스트 — fetchImpl(래퍼 스텁)과 실제 게이트웨이 fetch의 합집합 호출 타이핑(TS2556).
      const fn = (fetchImpl ?? gateway.llmNetworkFetch) as unknown as (...args: unknown[]) => Promise<Response>;
      return fn(...a);
    },
  }));
});
afterAll(async () => {
  const gateway = await import('../session-runtime/llm-call-gateway.js');
  mock.module('../session-runtime/llm-call-gateway.js', () => gateway);
});

function rowsFor(site: string): Row[] { return rows.filter(r => r.site === site); }

// signal-dedup 로컬 폴백의 /models 프로브는 bare global fetch — 실네트워크 나가지 않게 스텁.
let realFetch: typeof globalThis.fetch | undefined;
function stubGlobalFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
  realFetch = globalThis.fetch;
  // typeof fetch에는 preconnect 등 부속 속성이 붙어 화살표 함수 직접 대입이 안 됨 — 호출 시그니처로 좁혀 받고 대입 지점에서 캐스트.
  globalThis.fetch = impl as unknown as typeof globalThis.fetch;
}
function restoreGlobalFetch(): void {
  if (realFetch) { globalThis.fetch = realFetch; realFetch = undefined; }
}

// ── mustFix ② signal-dedup — 응답 후 파싱 throw 시에도 요청당 정확히 1행 ──
describe('signal-dedup llmOnce — 한 요청 = 원장 1행 (이중행 금지)', () => {
  test('grok: 응답 ok 후 res.json() throw → grok 행 1개 (catch 재기록 없음)', async () => {
    rows.length = 0;
    process.env.XAI_API_KEY = 'test-key';
    stubGlobalFetch(async () => { throw new Error('no local probe in test'); });
    fetchImpl = async () => new Response('{"choices":[{"message"', { status: 200 }); // 깨진 JSON — res.json()이 throw
    try {
      const out = await llmOnce('판정 프롬프트');
      expect(out).toBeNull(); // grok 실패 + 로컬 /models 프로브 스텁 throw → null
      const site = rowsFor('signal-dedup').filter(r => r.billingProvider === 'grok');
      expect(site).toHaveLength(1); // RED: 수리 전 2행(수신 ok 행 + catch 실패 행)
    } finally {
      fetchImpl = undefined;
      delete process.env.XAI_API_KEY;
      restoreGlobalFetch();
    }
  });

  test('grok: fetch 자체 throw(네트워크) → 실패 1행 (provider-call-failed)', async () => {
    rows.length = 0;
    process.env.XAI_API_KEY = 'test-key';
    stubGlobalFetch(async () => { throw new Error('no local probe in test'); });
    fetchImpl = async () => { throw new Error('network down'); };
    try {
      const out = await llmOnce('판정 프롬프트');
      expect(out).toBeNull();
      const site = rowsFor('signal-dedup').filter(r => r.billingProvider === 'grok');
      expect(site).toHaveLength(1);
      expect(site[0]!.missingReason).toBe('provider-call-failed');
    } finally {
      fetchImpl = undefined;
      delete process.env.XAI_API_KEY;
      restoreGlobalFetch();
    }
  });

  test('로컬 폴백: chat 응답 ok 후 res.json() throw → local 행 1개', async () => {
    rows.length = 0;
    delete process.env.XAI_API_KEY; // grok 경로 스킵
    stubGlobalFetch(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'gemma-3-x' }] }), { status: 200 });
      }
      throw new Error('unexpected fetch in test');
    });
    fetchImpl = async () => new Response('{"choices"', { status: 200 }); // chat — 깨진 JSON
    try {
      const out = await llmOnce('판정 프롬프트');
      expect(out).toBeNull();
      const site = rowsFor('signal-dedup').filter(r => r.billingProvider === 'local');
      expect(site).toHaveLength(1); // RED: 수리 전 2행
    } finally {
      fetchImpl = undefined;
      restoreGlobalFetch();
    }
  });
});

// ── mustFix ② keyword-crawl-grok — 응답 후 파식 throw 시에도 요청당 정확히 1행 ──
describe('keyword-crawl-grok — 한 요청 = 원장 1행 (이중행 금지)', () => {
  test('응답 ok 후 res.json() throw → 행 1개 (degradation summary 유지)', async () => {
    rows.length = 0;
    const call = buildGrokLiveSearchKeywordCallable({
      apiKey: () => 'k',
      model: 'grok-crawl-model-x',
      fetchFn: (async () => new Response('{"output":[{', { status: 200 })) as never,
    });
    const res = await call({ keyword: 'HBM' } as never);
    expect(String(res.summary)).toContain('threw'); // 예외는 폴백 summary로 — 호출측엔 throw 없음
    const site = rowsFor('keyword-crawl-grok');
    expect(site).toHaveLength(1); // RED: 수리 전 2행
  });
});

// ── mustFix ③ streamChatLedgered — 조기 break 원본 정리 + 동기 생성 throw 1행 ──
describe('streamChatLedgered — 원본 iterator 종료 전파 + 동기 생성 throw 1행', () => {
  test('소비자 조기 break → 원본 iterator.return 호출 + 원장 1행', async () => {
    rows.length = 0;
    const returnCalls: number[] = [];
    async function* src() {
      yield { type: 'text' as const, delta: 'a' };
      yield { type: 'text' as const, delta: 'b' };
    }
    const g = src();
    // generator.return의 TReturn 제약(void) 때문에 unknown 인자로 못 넘김 — 완화 시그니처 캐스트로 원본 위임.
    const origReturn = g.return?.bind(g) as unknown as ((value?: unknown) => Promise<unknown>) | undefined;
    if (origReturn) g.return = (async (value?: unknown) => {
      returnCalls.push(1);
      return origReturn(value);
    }) as unknown as typeof g.return;
    const provider = {
      name: 'stub',
      defaultModel: 'm1',
      available: () => true,
      streamChat: () => g,
    } as unknown as import('../llm.js').LLMProvider;
    for await (const _ev of streamChatLedgered(provider, [], undefined, { site: 'test-break' })) {
      break; // 첫 이벤트 뒤 조기 break
    }
    expect(returnCalls.length).toBe(1); // RED: 수리 전 0 — 원본 정리 누락
    expect(rowsFor('test-break')).toHaveLength(1);
  });

  test('streamChat 생성 동기 throw → 원장 1행 (provider-call-failed)', async () => {
    rows.length = 0;
    const provider = {
      name: 'stub2',
      defaultModel: 'm2',
      available: () => true,
      streamChat: () => { throw new Error('sync boom'); },
    } as unknown as import('../llm.js').LLMProvider;
    const iter = streamChatLedgered(provider, [], undefined, { site: 'test-sync-throw' });
    await expect(async () => { for await (const _e of iter) void _e; }).toThrow('sync boom');
    const site = rowsFor('test-sync-throw');
    expect(site).toHaveLength(1); // RED: 수리 전 0행
    expect(site[0]!.missingReason).toBe('provider-call-failed');
  });
});
