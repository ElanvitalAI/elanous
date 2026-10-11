// OR-BYOK-COST — OpenRouter BYOK 호출의 상류 청구액이 원장(usdKnown)·Pod 롤업까지 가는가. 실 API 를 부르지 않는다.
// 픽스처 = UX 실측(10-11) 모양: provider=OpenAI · is_byok=true · cost=0 · cost_details.upstream_inference_cost=0.0000093.
import { describe, expect, it, spyOn } from 'bun:test';
import { debug } from '../debug/log.js';
import { parseOpenAIUsage } from '../prompt-cache/openai.js';
import { llmUsageCostFields } from '../budget/llm-cost.js';
import { parseOpenAISSELines, streamLLM, type LLMProvider, type LLMStreamEvent } from '../llm.js';
import { rollup } from '../../scripts/usage-rollup.js';
import { reemitPodUsage } from '../task-orchestrator/surfaces/self-implement-pod.js';

const MODEL = 'openai/gpt-6-luna';
const byokUsage = (extra: Record<string, unknown> = {}) => ({
  prompt_tokens: 12, completion_tokens: 5, cost: 0, is_byok: true,
  cost_details: { upstream_inference_cost: 0.0000093 }, ...extra,
});
const byokBody = (usage: Record<string, unknown>) => ({ id: 'gen-1', model: MODEL, provider: 'OpenAI', choices: [], usage });

async function collect(lines: string[]): Promise<LLMStreamEvent[]> {
  const out: LLMStreamEvent[] = [];
  for await (const e of parseOpenAISSELines(lines)) out.push(e);
  return out;
}

describe('OR-BYOK-COST — parse', () => {
  it('stream: the final SSE chunk carries byok and the upstream cost', async () => {
    const events = await collect([
      `data: ${JSON.stringify({ model: MODEL, provider: 'OpenAI', choices: [{ delta: { content: 'hi' } }] })}`,
      `data: ${JSON.stringify(byokBody(byokUsage()))}`,
      'data: [DONE]',
    ]);
    const usage = events.find((e) => e.type === 'usage') as Extract<LLMStreamEvent, { type: 'usage' }>;
    expect(usage.usage).toMatchObject({ reportedCostUsd: 0, byok: true, upstreamCostUsd: 0.0000093 });
  });

  it('non-stream: the response body usage is read the same way', () => {
    expect(parseOpenAIUsage(byokBody(byokUsage()))).toMatchObject({ reportedCostUsd: 0, byok: true, upstreamCostUsd: 0.0000093 });
  });

  it('non-BYOK: the parsed usage is byte-identical to before (no new keys)', () => {
    const u = parseOpenAIUsage({ model: MODEL, usage: { prompt_tokens: 12, completion_tokens: 5, cost: 0.00042 } });
    expect(JSON.stringify(u)).toBe(JSON.stringify({ provider: 'openai', inputTokens: 12, outputTokens: 5, reportedCostUsd: 0.00042 }));
    const f = parseOpenAIUsage({ usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0.1, is_byok: false, cost_details: { upstream_inference_cost: 0.5 } } });
    expect(f).not.toHaveProperty('byok');
    expect(f).not.toHaveProperty('upstreamCostUsd');
  });

  it('BYOK with no / non-numeric upstream cost marks byok but leaves the upstream cost absent (unknown, not 0)', () => {
    const none = parseOpenAIUsage(byokBody(byokUsage({ cost_details: undefined })));
    expect(none).toMatchObject({ byok: true });
    expect(none).not.toHaveProperty('upstreamCostUsd');
    const str = parseOpenAIUsage(byokBody(byokUsage({ cost_details: { upstream_inference_cost: '0.0000093' } })));
    expect(str).not.toHaveProperty('upstreamCostUsd');
  });

  it('observes llm.openrouter byok-cost with model, upstream provider and amount only', () => {
    const rows: Array<[string, string, unknown]> = [];
    const spy = spyOn(debug, 'log').mockImplementation((c, e, d) => { rows.push([c, e, d]); });
    try { parseOpenAIUsage(byokBody(byokUsage())); } finally { spy.mockRestore(); }
    const row = rows.find(([c, e]) => c === 'llm.openrouter' && e === 'byok-cost');
    expect(row?.[2]).toEqual({ model: MODEL, provider: 'OpenAI', upstreamCostUsd: 0.0000093 });
  });
});

describe('OR-BYOK-COST — ledger cost', () => {
  it('BYOK: cost = OR charge + upstream charge (> 0) with the byok source split out', () => {
    const { cost } = llmUsageCostFields(MODEL, { inputTokens: 12, outputTokens: 5, reportedCostUsd: 0, byok: true, upstreamCostUsd: 0.0000093 } as never, { configPricing: {} }, 'api');
    expect(cost).toMatchObject({ kind: 'actual', usd: 0.0000093, source: 'provider-reported', costSource: 'byok-upstream', byok: true, orChargeUsd: 0, upstreamUsd: 0.0000093 });
    expect((cost as { usd: number }).usd).toBeGreaterThan(0);
  });

  it('non-BYOK: cost object is byte-identical to before', () => {
    const { cost } = llmUsageCostFields('no-such-model-for-pricing', { inputTokens: 12, outputTokens: 5, reportedCostUsd: 0.00042 } as never, { configPricing: {} }, 'api');
    expect(JSON.stringify(cost)).toBe(JSON.stringify({ kind: 'actual', model: 'no-such-model-for-pricing', usd: 0.00042, source: 'provider-reported' }));
  });

  it('BYOK with upstream unknown: partial (not actual 0), upstream null', () => {
    const { cost } = llmUsageCostFields(MODEL, { inputTokens: 12, outputTokens: 5, reportedCostUsd: 0, byok: true } as never, { configPricing: {} }, 'api');
    expect(cost).toMatchObject({ kind: 'partial', usd: 0, byok: true, upstreamUsd: null, orChargeUsd: 0 });
  });

  it('subscription billing still wins (BYOK path is API-billed only)', () => {
    const { cost } = llmUsageCostFields(MODEL, { reportedCostUsd: 0, byok: true, upstreamCostUsd: 1 } as never, { configPricing: {} }, 'subscription');
    expect(cost.kind).toBe('included');
  });

  it('streamLLM: the aggregated stream-llm row carries the BYOK cost', async () => {
    const provider: LLMProvider = {
      name: 'probe-provider', defaultModel: MODEL, available: () => true,
      async *streamChat() {
        yield { type: 'text', delta: 'ok' } as LLMStreamEvent;
        yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 5, reportedCostUsd: 0, byok: true, upstreamCostUsd: 0.0000093 } } as LLMStreamEvent;
      },
      async *chat() { yield 'ok'; },
    };
    const rows: Array<Record<string, unknown>> = [];
    const spy = spyOn(debug, 'log').mockImplementation((c, e, d) => { if (c === 'llm.usage' && e === 'llm-usage') rows.push(d as Record<string, unknown>); });
    try { await streamLLM([{ role: 'user', content: 'x' }], () => {}, { provider }); } finally { spy.mockRestore(); }
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cost).toMatchObject({ kind: 'actual', usd: 0.0000093, byok: true, costSource: 'byok-upstream' });
  });
});

describe('OR-BYOK-COST — Pod → host rollup', () => {
  const line = (cost: Record<string, unknown>) => JSON.stringify({ event: 'llm-usage', data: { site: 'stream-llm', billingProvider: 'openrouter', model: MODEL, inputTokens: 12, outputTokens: 5, cost } });

  it('usage-rollup counts BYOK upstream into usdKnown and carries the byok fields; unknown upstream stays unknown', () => {
    const { rows } = rollup([
      line({ kind: 'actual', usd: 0.0000093, byok: true, upstreamUsd: 0.0000093, orChargeUsd: 0, costSource: 'byok-upstream' }),
      line({ kind: 'partial', usd: 0, byok: true, upstreamUsd: null, orChargeUsd: 0, costSource: 'byok-upstream' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ calls: 2, usdKnown: 0.0000093, unknownCostCalls: 1, byokCalls: 2, byokUpstreamUsd: 0.0000093, byokUpstreamUnknownCalls: 1 });
  });

  it('usage-rollup: non-BYOK rows gain no new keys', () => {
    const { rows } = rollup([line({ kind: 'actual', usd: 0.5, source: 'provider-reported' })]);
    expect(rows[0]).not.toHaveProperty('byokCalls');
    expect(rows[0]).not.toHaveProperty('byokUpstreamUsd');
  });

  it('reemitPodUsage carries the byok fields to the host ledger (and omits them for old rows)', () => {
    const { rows } = rollup([line({ kind: 'actual', usd: 0.0000093, byok: true, upstreamUsd: 0.0000093, orChargeUsd: 0, costSource: 'byok-upstream' })]);
    const legacy = { site: 'x', provider: 'openrouter', model: MODEL, calls: 1, inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, usdKnown: 0.1, unknownCostCalls: 0 };
    const logs = `ELANOUS_USAGE_ROLLUP ${JSON.stringify({ measured: true, truncated: false, rows: [...rows, legacy] })}`;
    const out: Array<Record<string, unknown>> = [];
    reemitPodUsage(logs, 'job-1', (c, e, d) => { if (e === 'llm-usage') out.push(d); });
    expect(out[0]).toMatchObject({ byokCalls: 1, byokUpstreamUsd: 0.0000093, cost: { kind: 'known', usd: 0.0000093 } });
    expect(out[0]).not.toHaveProperty('byokUpstreamUnknownCalls');
    expect(out[1]).not.toHaveProperty('byokCalls');
  });
});
