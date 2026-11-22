// LLM-CALL-COST-LEDGER (OP #132226 · #132275) — "모든 LLM 호출이 llm.usage 원장에 행을 남긴다".
// streamLLM 래퍼 경유 턴은 이미 logAgentTurnUsage 로 기록된다(llm.ts:5205/5228/10074).
// 이 시험은 래퍼 밖 5종 경로가 남기는 행을 계약으로 못박는다:
//   ① streamChatLedgered — 소비 완료 시 행 1개(정상 종료·예외·usage 이벤트 3갈래) · 미소비 제너레이터는 행 0개
//   ② logUnmeteredRow — raw fetch 지점 1행 래퍼(성공·실패 missingReason)
// 관측 = 기존 패턴(openrouter-byok-cost.test.ts:96, advisor-checkpoints.test.ts:158)과 동일하게
// debug.log('llm.usage','llm-usage') 스파이. 생산 경로는 그대로 logAgentTurnUsage.
import { test, expect, describe, afterEach } from 'bun:test';
import { spyOn } from 'bun:test';
import { debug } from '../debug/log.js';
import { streamChatLedgered, logUnmeteredRow } from './ledgered-call.js';
import type { LLMProvider, LLMMessage, LLMOpts, LLMStreamEvent } from '../llm.js';

type Row = Record<string, unknown>;
const rows: Row[] = [];
let spy: ReturnType<typeof spyOn> | undefined;

function rowsFor(site: string): Row[] {
  return rows.filter(r => r.site === site);
}

afterEach(() => { rows.length = 0; });

describe('streamChatLedgered — every consumed provider stream leaves exactly one ledger row', () => {
  test('① 정상 소비 완료: 행 1개 (site·providerName·model=provider.defaultModel·measured:false)', async () => {
    spy = spyOn(debug, 'log').mockImplementation((category: string, event: string, data?: unknown) => {
      if (category === 'llm.usage' && event === 'llm-usage') rows.push((data ?? {}) as Row);
    });
    const provider = fakeProvider('grok', [
      { type: 'text', delta: '안녕' },
      { type: 'finish', reason: 'stop' },
    ]);
    let text = '';
    // 출처: #39659 — 시험 최소 호출 예산(페이크 프로바이더 1턴), 상한 아님
    for await (const d of textDeltas(streamChatLedgered(provider, [{ role: 'user', content: 'hi' }], { temperature: 0.2, maxTokens: 10 }, { site: 'domain-dart-disclosure', jobKind: 'domain-report' }))) text += d;
    expect(text).toBe('안녕');
    const site = rowsFor('domain-dart-disclosure');
    expect(site).toHaveLength(1);
    expect(site[0]!.providerName).toBe(undefined); // billingProvider 로만 남는다 — 아래 단언 참조
    expect(site[0]!.billingProvider).toBe('grok');
    expect(site[0]!.model).toBe('fake-model');
    expect(site[0]!.jobKind).toBe('domain-report');
    expect(site[0]!.measured).toBe(false);
    expect(site[0]!.missingReason).toBe('provider-usage-absent');
    spy.mockRestore();
  });

  test('② provider 스트림이 예외로 끝나도 행 1개 (missingReason=provider-call-failed)', async () => {
    spy = spyOn(debug, 'log').mockImplementation((category: string, event: string, data?: unknown) => {
      if (category === 'llm.usage' && event === 'llm-usage') rows.push((data ?? {}) as Row);
    });
    const provider = fakeProvider('openai', [], new Error('boom'));
    await expect(async () => {
      for await (const _d of textDeltas(streamChatLedgered(provider, [{ role: 'user', content: 'hi' }], undefined, { site: 'domain-dig-verdict' }))) void _d;
    }).toThrow('boom');
    const site = rowsFor('domain-dig-verdict');
    expect(site).toHaveLength(1);
    expect(site[0]!.billingProvider).toBe('openai');
    expect(site[0]!.missingReason).toBe('provider-call-failed');
    spy.mockRestore();
  });

  test('③ 스트림에 usage 이벤트가 실려 오면 실측치로 기록 (measured 행·토큰 단언)', async () => {
    spy = spyOn(debug, 'log').mockImplementation((category: string, event: string, data?: unknown) => {
      if (category === 'llm.usage' && event === 'llm-usage') rows.push((data ?? {}) as Row);
    });
    const provider = fakeProvider('anthropic', [
      { type: 'text', delta: 'ok' },
      { type: 'usage', usage: { provider: 'anthropic', inputTokens: 11, outputTokens: 7, stopReason: 'stop' } },
      { type: 'finish', reason: 'stop' },
    ]);
    let text = '';
    for await (const d of textDeltas(streamChatLedgered(provider, [{ role: 'user', content: 'hi' }], undefined, { site: 'domain-retro-report' }))) text += d;
    expect(text).toBe('ok');
    const site = rowsFor('domain-retro-report');
    expect(site).toHaveLength(1);
    expect(site[0]!.inputTokens).toBe(11);
    expect(site[0]!.outputTokens).toBe(7);
    spy.mockRestore();
  });

  test('④ 미소비 제너레이터는 행 0개 — 제너레이터 생성만으로 원장에 행이 생기지 않는다', async () => {
    spy = spyOn(debug, 'log').mockImplementation((category: string, event: string, data?: unknown) => {
      if (category === 'llm.usage' && event === 'llm-usage') rows.push((data ?? {}) as Row);
    });
    const provider = fakeProvider('grok', [{ type: 'text', delta: 'x' }]);
    const gen = streamChatLedgered(provider, [{ role: 'user', content: 'hi' }], undefined, { site: 'domain-morning-essential' });
    void gen; // 소비 없음
    expect(rows).toHaveLength(0);
    spy.mockRestore();
  });

  test('⑤ usage 이벤트가 2번 와도 행은 1개 — 마지막 실측치 1행으로 정착', async () => {
    spy = spyOn(debug, 'log').mockImplementation((category: string, event: string, data?: unknown) => {
      if (category === 'llm.usage' && event === 'llm-usage') rows.push((data ?? {}) as Row);
    });
    const provider = fakeProvider('grok', [
      { type: 'usage', usage: { provider: 'openai', inputTokens: 3 } },
      { type: 'usage', usage: { provider: 'openai', inputTokens: 5, outputTokens: 2 } },
      { type: 'finish', reason: 'stop' },
    ]);
    for await (const _d of textDeltas(streamChatLedgered(provider, [{ role: 'user', content: 'hi' }], undefined, { site: 'domain-weekly-alpha' }))) void _d;
    expect(rowsFor('domain-weekly-alpha')).toHaveLength(1);
    expect(rowsFor('domain-weekly-alpha')[0]!.inputTokens).toBe(5);
    spy.mockRestore();
  });
});

describe('logUnmeteredRow — raw fetch 지점 1행 래퍼', () => {
  test('성공 행: site·providerName(billingProvider)·model·jobKind', () => {
    spy = spyOn(debug, 'log').mockImplementation((category: string, event: string, data?: unknown) => {
      if (category === 'llm.usage' && event === 'llm-usage') rows.push((data ?? {}) as Row);
    });
    logUnmeteredRow('grok-4-1-fast-reasoning', { providerName: 'grok', site: 'signal-dedup' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.site).toBe('signal-dedup');
    expect(rows[0]!.billingProvider).toBe('grok');
    expect(rows[0]!.model).toBe('grok-4-1-fast-reasoning');
    expect(rows[0]!.measured).toBe(false);
    expect(rows[0]!.missingReason).toBe('provider-usage-absent');
    logUnmeteredRow('text-embedding-3-small', { providerName: 'openai', site: 'knowledge-embedding', jobKind: 'embedding' });
    expect(rows).toHaveLength(2);
    expect(rows[1]!.jobKind).toBe('embedding');
    spy.mockRestore();
  });

  test('실패 행: missingReason=provider-call-failed', () => {
    spy = spyOn(debug, 'log').mockImplementation((category: string, event: string, data?: unknown) => {
      if (category === 'llm.usage' && event === 'llm-usage') rows.push((data ?? {}) as Row);
    });
    logUnmeteredRow('gemma-x', { providerName: 'local', site: 'signal-dedup', missingReason: 'provider-call-failed' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.missingReason).toBe('provider-call-failed');
    spy.mockRestore();
  });

  test('원장 throw 가 호출측으로 새어나가지 않는다 (fail-soft)', () => {
    spy = spyOn(debug, 'log').mockImplementation((category: string) => {
      if (category === 'llm.usage') throw new Error('ledger exploded');
    });
    expect(() => logUnmeteredRow('m', { providerName: 'grok', site: 'x' })).not.toThrow();
    spy.mockRestore();
  });
});

// ── helpers ──

function fakeProvider(name: string, events: LLMStreamEvent[], throwAt?: Error): LLMProvider {
  return {
    name,
    defaultModel: 'fake-model',
    available: () => true,
    chat: async function* () { yield ''; },
    streamChat: async function* (_m: LLMMessage[], _o?: LLMOpts): AsyncGenerator<LLMStreamEvent, void, unknown> {
      if (throwAt) throw throwAt;
      for (const ev of events) yield ev;
    },
  };
}

async function* textDeltas(events: AsyncGenerator<LLMStreamEvent, void, unknown>): AsyncGenerator<string, void, unknown> {
  for await (const ev of events) if (ev.type === 'text' && ev.delta) yield ev.delta;
}
