// LLM-CALL-COST-LEDGER (OP #132226 · #132275) — raw fetch 경로 4종 회귀.
// 계약: 요청 1회당 llm.usage 원장 행 1개 · 조기 return(키 없음 등)엔 행 0개.
// 관측 = ledgered-call.test.ts 와 동일(debug.log('llm.usage','llm-usage') 스파이).
// 스텁 = bun:test mock.module 로 llm-call-gateway.llmNetworkFetch 를 가짜 Response 로.
import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { debug } from '../debug/log.js';
import { llmOnce } from '../domains/signal-dedup.js';
import { grokAgentSearch } from '../grok/agent-search.js';
import { buildGrokLiveSearchKeywordCallable } from '../intake-plane/keyword-crawl-grok.js';

type Row = Record<string, unknown>;
const rows: Row[] = [];

let realGateway: typeof import('../session-runtime/llm-call-gateway.js');
beforeAll(async () => {
  spyOn(debug, 'log').mockImplementation((category: string, event: string, data?: unknown) => {
    if (category === 'llm.usage' && event === 'llm-usage') rows.push((data ?? {}) as Row);
  });
  realGateway = await import('../session-runtime/llm-call-gateway.js');
  const gateway = realGateway;
  mock.module('../session-runtime/llm-call-gateway.js', () => ({
    ...gateway,
    llmNetworkFetch: async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"suppress":[1],"clusters":[]}' } }],
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    }), { status: 200 }),
    llmNetworkSend: async () => new Response(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: '검색 요약', annotations: [] }] }],
    }), { status: 200 }),
  }));
});
afterAll(async () => {
  const gateway = await import('../session-runtime/llm-call-gateway.js');
  mock.module('../session-runtime/llm-call-gateway.js', () => gateway);
});

// 시험 간섭 꼴 C(env-without-restore) 처방(OP #133021) — beforeEach 저장 · afterEach 복원.
let savedXaiKey: string | undefined;
beforeEach(() => { savedXaiKey = process.env.XAI_API_KEY; });
afterEach(() => {
  if (savedXaiKey === undefined) delete process.env.XAI_API_KEY;
  else process.env.XAI_API_KEY = savedXaiKey;
});

function rowsFor(site: string): Row[] { return rows.filter(r => r.site === site); }

describe('signal-dedup llmOnce — grok 1콜 = 원장 1행', () => {
  test('xai 성공 경로: site signal-dedup · providerName grok', async () => {
    process.env.XAI_API_KEY = 'test-key';
    rows.length = 0;
    const out = await llmOnce('판정 프롬프트');
    expect(out).toContain('suppress');
    const site = rowsFor('signal-dedup');
    expect(site).toHaveLength(1);
    expect(site[0]!.billingProvider).toBe('grok');
    delete process.env.XAI_API_KEY;
  });
});

describe('grokAgentSearch — responses 1콜 = 원장 1행 · 조기 return(키 없음) = 0행', () => {
  test('성공 경로: site grok-agent-search · model=호출에 쓴 model', async () => {
    rows.length = 0;
    const res = await grokAgentSearch('쿼리', { apiKey: 'k', model: 'grok-search-model-x' });
    expect(res.ok).toBe(true);
    const site = rowsFor('grok-agent-search');
    expect(site).toHaveLength(1);
    expect(site[0]!.billingProvider).toBe('grok');
    expect(site[0]!.model).toBe('grok-search-model-x');
  });

  test('missing-api-key 조기 return: 행 0개', async () => {
    rows.length = 0;
    // apiKey:'' 는 nullish 아니므로 credential 조회 없이 그대로 falsy → 조기 return(결정적)
    const res = await grokAgentSearch('쿼리', { apiKey: '' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('missing-api-key');
    expect(rowsFor('grok-agent-search')).toHaveLength(0);
  });
});

describe('keyword-crawl-grok — responses 1콜 = 원장 1행', () => {
  test('성공 경로: site keyword-crawl-grok · providerName grok', async () => {
    rows.length = 0;
    const call = buildGrokLiveSearchKeywordCallable({
      apiKey: () => 'k',
      model: 'grok-crawl-model-x',
      fetchFn: (async () => new Response(JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: '요약', annotations: [] }] }],
      }), { status: 200 })) as never,
    });
    const res = await call({ keyword: 'HBM' } as never);
    expect(String(res.summary)).toContain('요약');
    const site = rowsFor('keyword-crawl-grok');
    expect(site).toHaveLength(1);
    expect(site[0]!.billingProvider).toBe('grok');
    expect(site[0]!.model).toBe('grok-crawl-model-x');
  });
});

// knowledge 임베딩 원장 행 시험은 OP 결정(#132724)으로 이번 PR 범위 밖 — FU로 이관됨.
