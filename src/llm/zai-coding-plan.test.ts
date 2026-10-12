// ZAI-CODING-PLAN-PROVIDER — 키 있음/없음 · 한도 코드 판별·정책·폴백 · 동시 상한 · 창 적산 · usage 표면 · 키 값 0회.
// ⛔ 실 네트워크 0 — 호환 공급자·OpenRouter·공식 조회는 전부 seam 으로 주입한다.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { LLMProvider, LLMStreamEvent } from '../llm.js';
import { debug } from '../debug/log.js';
import {
  activeZaiLimit, appendZaiLedger, buildZaiUsageView, classifyZaiError, decideZaiAction, extractZaiPlanLimitSignal, isZaiPeak,
  makeZaiCodingPlanProvider, parseZaiQuota, readZaiLedger, sumZaiLocalWindows, zaiCredits, zaiWireModel,
  ZaiCodingPlanLimitError, ZaiConcurrencyGate, ZAI_CODING_PLAN_URL,
  type ZaiLedgerRecord, type ZaiOveragePolicy,
} from './zai-coding-plan.js';

const SECRET = 'zai-test-SECRET-0123456789abcdef';
const dirs: string[] = [];
function tmp(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// 2026-10-12(월) 03:00 UTC = 11:00 SGT → 비첨두 · 2026-10-12 07:00 UTC = 15:00 SGT → 첨두
const OFF_PEAK = Date.parse('2026-10-12T03:00:00Z');
const PEAK = Date.parse('2026-10-12T07:00:00Z');

function apiError(status: number, code: number, message: string): Error & { status: number; bodyText: string } {
  return Object.assign(new Error(`LLM API ${status}`), { status, bodyText: JSON.stringify({ error: { code: String(code), message } }) });
}

interface FakeCall { name: string; model: string; url: string; apiKey?: string; wire: Record<string, unknown> }
function fakeCompat(behaviour: () => AsyncGenerator<LLMStreamEvent, void, unknown>, calls: FakeCall[]) {
  return (name: string, model: string, url: string, cfg: { apiKey?: string }, wire: Record<string, unknown>): LLMProvider => {
    calls.push({ name, model, url, apiKey: cfg.apiKey, wire });
    return {
      name, defaultModel: model, available: () => true,
      streamChat: () => behaviour(),
      async *chat() { /* unused */ },
    };
  };
}
function fakeOpenRouter(calls: string[]) {
  return (): LLMProvider => ({
    name: 'openrouter', defaultModel: 'x', available: () => true,
    async *streamChat(_m, opts) { calls.push(String(opts?.model)); yield { type: 'text', delta: 'from-or' }; },
    async *chat() { /* unused */ },
  });
}
async function drain(gen: AsyncGenerator<LLMStreamEvent, void, unknown>): Promise<LLMStreamEvent[]> {
  const out: LLMStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('키 있음/없음 — glm 은 키가 있을 때만 직결이다', () => {
  const saved = { ...process.env };
  beforeEach(async () => { (await import('../config.js'))._resetKeyCacheForTests(); });
  afterEach(async () => { process.env = { ...saved }; (await import('../config.js'))._resetKeyCacheForTests(); });

  async function construct(): Promise<{ ok: true; p: LLMProvider } | { ok: false; message: string }> {
    const llm = await import('../llm.js');
    const uc = await import('../user-config.js');
    const base = uc.getUserConfig();
    try { return { ok: true, p: llm.getProviderForConfig({ ...base, llm: { ...base.llm, provider: 'glm', model: undefined } } as never) }; }
    catch (e) { return { ok: false, message: e instanceof Error ? e.message : String(e) }; }
  }

  test('키 없음 → 종전 안내 오류 그대로(OpenRouter 로 쓰라)', async () => {
    process.env.ELANOUS_KEY_CACHE_DIR = tmp('zai-nokey-');
    delete process.env.ZAI_API_KEY;
    const r = await construct();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('glm 직결 provider 는 아직 배선되지 않았다');
      expect(r.message).toContain('openrouter/z-ai/glm-5.3');
    }
  });

  test('키 있음 → glm 공급자 · 기본 glm-5.3 · 키 값은 공급자 표면에 없다', async () => {
    process.env.ELANOUS_KEY_CACHE_DIR = tmp('zai-key-');
    process.env.ZAI_API_KEY = SECRET;
    const r = await construct();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.p.name).toBe('glm');
      expect(r.p.defaultModel).toBe('glm-5.3');
      expect(r.p.available()).toBe(true);
      expect(JSON.stringify(r.p)).not.toContain(SECRET);
    }
  });

  // 🩸 ZAI-POD-CHILD 실측(10-11 · si-task-aaf5d691e4ed): Pod 의 gate 진단·리뷰가 `getProvider('glm-5.3')` 로 provider 를
  //   골랐고, 레지스트리 `glm-` 접두가 local 이라 «Local LLM unavailable: set LOCAL_LLM_URL» 로 죽었다.
  async function byModel(model: string): Promise<{ ok: true; name: string } | { ok: false; message: string }> {
    const llm = await import('../llm.js');
    try { return { ok: true, name: llm.getProvider(model).name }; }
    catch (e) { return { ok: false, message: e instanceof Error ? e.message : String(e) }; }
  }

  test('ELANOUS_LLM_PROVIDER=glm ⊕ 키 있음 → getProvider(glm-5.3·glm-5.3-flash) 도 glm 공급자(local 로 안 떨어진다)', async () => {
    process.env.ELANOUS_KEY_CACHE_DIR = tmp('zai-bymodel-key-');
    process.env.ZAI_API_KEY = SECRET;
    process.env.ELANOUS_LLM_PROVIDER = 'glm';
    delete process.env.LOCAL_LLM_URL;
    expect(await byModel('glm-5.3')).toEqual({ ok: true, name: 'glm' });
    expect(await byModel('glm-5.3-flash')).toEqual({ ok: true, name: 'glm' });
  });

  test('ELANOUS_LLM_PROVIDER=glm ⊕ 키 없음 → local 이 아니라 OpenRouter 안내 오류', async () => {
    process.env.ELANOUS_KEY_CACHE_DIR = tmp('zai-bymodel-nokey-');
    delete process.env.ZAI_API_KEY;
    process.env.ELANOUS_LLM_PROVIDER = 'glm';
    delete process.env.LOCAL_LLM_URL;
    const r = await byModel('glm-5.3');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('openrouter/z-ai/glm-5.3');
  });

  test('활성 provider 가 glm 이 아니면 종전 그대로 — glm-5.3 은 local 계열', async () => {
    process.env.ELANOUS_KEY_CACHE_DIR = tmp('zai-bymodel-other-');
    process.env.ZAI_API_KEY = SECRET;
    process.env.ELANOUS_LLM_PROVIDER = 'openrouter';
    expect(await byModel('glm-5.3')).toEqual({ ok: true, name: 'local' });
  });
});

test('키 우선순위 — 키 캐시 파일이 env 를 이긴다(값은 비교만)', async () => {
  const cfg = await import('../config.js');
  const { writeFileSync } = await import('node:fs');
  const { getZaiApiKey } = await import('./zai-coding-plan.js');
  const saved = { dir: process.env.ELANOUS_KEY_CACHE_DIR, key: process.env.ZAI_API_KEY };
  const dir = tmp('zai-keyprio-');
  writeFileSync(join(dir, 'zai_api_key'), 'from-cache-file\n');
  process.env.ELANOUS_KEY_CACHE_DIR = dir;
  process.env.ZAI_API_KEY = 'from-env';
  cfg._resetKeyCacheForTests();
  try {
    expect(getZaiApiKey()).toBe('from-cache-file');
  } finally {
    if (saved.dir === undefined) delete process.env.ELANOUS_KEY_CACHE_DIR; else process.env.ELANOUS_KEY_CACHE_DIR = saved.dir;
    if (saved.key === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = saved.key;
    cfg._resetKeyCacheForTests();
  }
});

describe('오류 판별 — 1113/1308/1310/1316~1321', () => {
  test('코드 → 종류·창', () => {
    const c = (code: number, msg = 'x') => classifyZaiError(429, JSON.stringify({ error: { code: String(code), message: msg } }));
    expect(c(1113)).toMatchObject({ code: 1113, kind: 'balance-limit', window: null });
    expect(c(1316)).toMatchObject({ kind: 'balance-limit', window: '5h' });
    expect(c(1317)).toMatchObject({ kind: 'balance-limit', window: 'weekly' });
    expect(c(1318)).toMatchObject({ kind: 'balance-limit', window: '5h' });
    expect(c(1319)).toMatchObject({ kind: 'balance-limit', window: 'weekly' });
    expect(c(1308, 'Usage limit reached for 5 hours')).toMatchObject({ kind: 'plan-limit', window: '5h' });
    expect(c(1310)).toMatchObject({ kind: 'plan-limit', window: 'weekly' });
    expect(c(1309)).toMatchObject({ kind: 'plan-unavailable' });
    expect(c(1302)).toMatchObject({ kind: 'rate' });
    expect(c(1214)).toMatchObject({ kind: 'other' });
    expect(classifyZaiError(500, 'not json')).toBeNull();
  });

  test('1308 plan-limit 응답을 provider-neutral 신호로 추출하고 다른 오류는 null', () => {
    const body = JSON.stringify({ error: {
      code: '1308',
      message: 'Usage limit reached for the past 5 hours. Resets at 2026-10-11 09:12:33.',
    } });
    expect(extractZaiPlanLimitSignal(429, body, 'stop')).toEqual({
      provider: 'glm', kind: 'plan-limit', resetAt: Date.parse('2026-10-11T09:12:33+08:00'), overage: 'stop',
    });
    expect(extractZaiPlanLimitSignal(429, JSON.stringify({ error: { code: '1316', message: 'limit' } }), 'stop')).toBeNull();
    expect(extractZaiPlanLimitSignal(500, 'not json', 'stop')).toBeNull();
  });

  test('next_flush_time — 문면의 시각(시간대 없으면 UTC+8) · 숫자 칸', () => {
    const msg = 'Usage limit reached for the past 5 hours. Insufficient balance for extra usage. Resets at 2026-10-11 09:12:33.';
    const r = classifyZaiError(429, JSON.stringify({ error: { code: '1316', message: msg } }))!;
    expect(r.resetAt).toBe(Date.parse('2026-10-11T09:12:33+08:00'));
    expect(r.resetRaw).toBe('2026-10-11 09:12:33');
    const n = classifyZaiError(429, JSON.stringify({ error: { code: '1310', message: 'm', next_flush_time: 1791677291813 } }))!;
    expect(n.resetAt).toBe(1791677291813);
  });

  test('정책 결정표', () => {
    const t = (p: ZaiOveragePolicy, k: 'plan-limit' | 'balance-limit' | 'plan-unavailable', ph: 'pre' | 'post') => decideZaiAction(p, k, ph);
    for (const k of ['plan-limit', 'balance-limit', 'plan-unavailable'] as const) {
      expect(t('stop', k, 'pre')).toBe('stop');
      expect(t('stop', k, 'post')).toBe('stop');
      expect(t('openrouter', k, 'post')).toBe('openrouter');
    }
    expect(t('balance', 'plan-limit', 'pre')).toBe('call');           // 잔액으로 계속
    expect(t('balance', 'plan-limit', 'post')).toBe('openrouter');    // 서버가 막았다 → 다음 칸
    expect(t('balance', 'balance-limit', 'post')).toBe('openrouter'); // 1113/1316~1321 → 다음 칸
  });
});

describe('공급자 흐름 — 적산·폴백·멈춤', () => {
  function setup(policy: ZaiOveragePolicy, behaviour: () => AsyncGenerator<LLMStreamEvent, void, unknown>, opts: { orKey?: boolean; ledger?: ZaiLedgerRecord[]; now?: number } = {}) {
    const ledgerPath = join(tmp('zai-ledger-'), 'ledger.jsonl');
    for (const r of opts.ledger ?? []) appendZaiLedger(r, { ledgerPath });
    const compatCalls: FakeCall[] = [];
    const orCalls: string[] = [];
    const provider = makeZaiCodingPlanProvider(
      { provider: 'glm', zaiCodingPlan: { overage: policy } } as never,
      {
        key: () => SECRET, ledgerPath, now: () => opts.now ?? OFF_PEAK,
        makeCompat: fakeCompat(behaviour, compatCalls) as never,
        makeOpenRouter: fakeOpenRouter(orCalls),
        openRouterKey: () => (opts.orKey === false ? undefined : 'or-key'),
        gate: new ZaiConcurrencyGate(() => 3),
        quotaSnapshot: () => null,
      },
    );
    return { provider, compatCalls, orCalls, ledgerPath };
  }

  test('성공 → 코딩 엔드포인트 · glm 이름 · max_tokens 생략 · usage 를 크레딧으로 적산', async () => {
    const { provider, compatCalls, ledgerPath } = setup('stop', async function* () {
      yield { type: 'text', delta: 'ok' };
      yield { type: 'usage', usage: { inputTokens: 1000, cacheReadInputTokens: 2000, outputTokens: 500 } };
    });
    const evs = await drain(provider.streamChat!([{ role: 'user', content: 'hi' }], {}));
    expect(evs.map((e) => e.type)).toEqual(['text', 'usage']);
    expect(compatCalls[0]).toMatchObject({ name: 'glm', model: 'glm-5.3', url: ZAI_CODING_PLAN_URL });
    expect(compatCalls[0]!.wire).toMatchObject({ omitMaxTokens: true });
    expect(compatCalls[0]!.wire.extraBody).toBeUndefined();   // 설정이 없으면 reasoning_effort 를 안 싣는다(서버 기본)
    const rec = readZaiLedger({ ledgerPath, now: () => OFF_PEAK });
    // (1000×6.9 + 2000×1.7 + 500×24)/10000 = 2.23 → 비첨두 0.5× = 1.115
    expect(rec).toEqual([expect.objectContaining({ kind: 'call', model: 'glm-5.3', peak: false, bucket: 'plan' })]);
    expect((rec[0] as { credits: number }).credits).toBeCloseTo(1.115, 10);
  });

  test('reasoningEffort → reasoning_effort(low·high·max 만)', async () => {
    const { provider, compatCalls } = setup('stop', async function* () { yield { type: 'text', delta: 'ok' }; });
    await drain(provider.streamChat!([{ role: 'user', content: 'hi' }], { reasoningEffort: 'medium' }));
    await drain(provider.streamChat!([{ role: 'user', content: 'hi' }], { reasoningEffort: 'minimal' }));
    await drain(provider.streamChat!([{ role: 'user', content: 'hi' }], { reasoningEffort: 'xhigh' }));
    expect(compatCalls.map((c) => (c.wire.extraBody as { reasoning_effort?: string })?.reasoning_effort)).toEqual(['high', 'low', 'max']);
  });

  for (const code of [1113, 1316, 1317, 1318]) {
    test(`${code} · balance 정책 → OpenRouter(openrouter/z-ai/glm-5.3) · 한도 기록`, async () => {
      const { provider, orCalls, ledgerPath } = setup('balance', async function* () { throw apiError(429, code, 'Insufficient balance. Resets at 2026-10-11 09:12:33'); });
      const evs = await drain(provider.streamChat!([{ role: 'user', content: 'hi' }], {}));
      expect(evs).toEqual([{ type: 'text', delta: 'from-or' }]);
      expect(orCalls).toEqual(['openrouter/z-ai/glm-5.3']);
      expect(readZaiLedger({ ledgerPath, now: () => OFF_PEAK })).toEqual([expect.objectContaining({ kind: 'limit', code, limitKind: 'balance-limit' })]);
    });
    test(`${code} · stop 정책 → 멈춤(ZaiCodingPlanLimitError) · OpenRouter 0회`, async () => {
      const { provider, orCalls } = setup('stop', async function* () { throw apiError(429, code, 'limit'); });
      await expect(drain(provider.streamChat!([{ role: 'user', content: 'hi' }], {}))).rejects.toBeInstanceOf(ZaiCodingPlanLimitError);
      expect(orCalls).toEqual([]);
    });
  }

  test('1308 한도 stop 오류에 구조화 신호를 보존한다', async () => {
    const resetAt = Date.parse('2026-10-11T09:12:33+08:00');
    const { provider } = setup('stop', async function* () {
      throw apiError(429, 1308, 'Usage limit reached for 5 hours. Resets at 2026-10-11 09:12:33.');
    });
    await expect(drain(provider.streamChat!([{ role: 'user', content: 'hi' }], {}))).rejects.toMatchObject({
      planLimitSignal: { provider: 'glm', kind: 'plan-limit', resetAt, overage: 'stop' },
    });
  });

  test('flash 모델도 사양의 폴백 대상(openrouter/z-ai/glm-5.3)으로 간다', async () => {
    const { provider, orCalls } = setup('openrouter', async function* () { throw apiError(429, 1308, 'Usage limit reached for 5 hours'); });
    await drain(provider.streamChat!([{ role: 'user', content: 'hi' }], { model: 'glm-5.3-flash' }));
    expect(orCalls).toEqual(['openrouter/z-ai/glm-5.3']);
  });

  test('OpenRouter 키가 없으면 폴백 대신 한도 오류', async () => {
    const { provider } = setup('openrouter', async function* () { throw apiError(429, 1310, 'weekly'); }, { orKey: false });
    await expect(drain(provider.streamChat!([{ role: 'user', content: 'hi' }], {}))).rejects.toBeInstanceOf(ZaiCodingPlanLimitError);
  });

  test('출력이 나간 뒤의 한도 오류는 폴백하지 않는다', async () => {
    const { provider, orCalls } = setup('openrouter', async function* () { yield { type: 'text', delta: 'a' }; throw apiError(429, 1316, 'x'); });
    await expect(drain(provider.streamChat!([{ role: 'user', content: 'hi' }], {}))).rejects.toBeInstanceOf(ZaiCodingPlanLimitError);
    expect(orCalls).toEqual([]);
  });

  test('한도 아닌 오류(1214·HTTP 500)는 그대로 던진다', async () => {
    const { provider, orCalls } = setup('openrouter', async function* () { throw apiError(400, 1214, 'bad param'); });
    await expect(drain(provider.streamChat!([{ role: 'user', content: 'hi' }], {}))).rejects.toThrow('LLM API 400');
    expect(orCalls).toEqual([]);
  });

  test('pre — 살아 있는 플랜 한도: stop 은 호출 0 · balance 는 호출하고 잔액 칸에 적는다', async () => {
    const limit: ZaiLedgerRecord = { ts: OFF_PEAK - 60_000, kind: 'limit', code: 1310, limitKind: 'plan-limit', window: 'weekly', resetAt: OFF_PEAK + 3_600_000, model: 'glm-5.3' };
    const stop = setup('stop', async function* () { yield { type: 'text', delta: 'never' }; }, { ledger: [limit] });
    await expect(drain(stop.provider.streamChat!([{ role: 'user', content: 'hi' }], {}))).rejects.toBeInstanceOf(ZaiCodingPlanLimitError);
    expect(stop.compatCalls).toEqual([]);
    const bal = setup('balance', async function* () { yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }; }, { ledger: [limit] });
    await drain(bal.provider.streamChat!([{ role: 'user', content: 'hi' }], {}));
    expect(bal.compatCalls.length).toBe(1);
    expect(readZaiLedger({ ledgerPath: bal.ledgerPath, now: () => OFF_PEAK }).filter((r) => r.kind === 'call')).toEqual([expect.objectContaining({ bucket: 'balance' })]);
    const or = setup('openrouter', async function* () { yield { type: 'text', delta: 'never' }; }, { ledger: [limit] });
    await drain(or.provider.streamChat!([{ role: 'user', content: 'hi' }], {}));
    expect(or.compatCalls).toEqual([]);
    expect(or.orCalls).toEqual(['openrouter/z-ai/glm-5.3']);
  });

  test('pre — 10분 안 공식 조회가 «남은 양 0» 이면 stop 은 호출하지 않는다(서버의 조용한 잔액 결제 전에 막는다)', async () => {
    const ledgerPath = join(tmp('zai-snap-'), 'l.jsonl');
    const compatCalls: FakeCall[] = [];
    const p = makeZaiCodingPlanProvider({ provider: 'glm', zaiCodingPlan: { overage: 'stop' } } as never, {
      key: () => SECRET, ledgerPath, now: () => OFF_PEAK, gate: new ZaiConcurrencyGate(() => 3),
      makeCompat: fakeCompat(async function* () { yield { type: 'text', delta: 'never' }; }, compatCalls) as never,
      quotaSnapshot: () => ({ status: 'ok', level: 'max', fetchedAt: OFF_PEAK - 60_000, windows: [
        { window: '5h', limit: 28000, used: 28000, remaining: 0, resetAt: OFF_PEAK + 3_600_000 },
        { window: 'weekly', limit: 140000, used: 30000, remaining: 110000, resetAt: OFF_PEAK + 86_400_000 },
      ] }),
    });
    await expect(drain(p.streamChat!([{ role: 'user', content: 'hi' }], {}))).rejects.toBeInstanceOf(ZaiCodingPlanLimitError);
    expect(compatCalls).toEqual([]);
  });

  test('슬롯을 기다린 호출은 깨어난 뒤 한도를 «다시» 본다', async () => {
    const ledgerPath = join(tmp('zai-recheck-'), 'l.jsonl');
    const compatCalls: FakeCall[] = [];
    let unblock: () => void = () => {};
    const blocked = new Promise<void>((r) => { unblock = r; });
    const p = makeZaiCodingPlanProvider({ provider: 'glm', zaiCodingPlan: { overage: 'stop' } } as never, {
      key: () => SECRET, ledgerPath, now: () => OFF_PEAK, gate: new ZaiConcurrencyGate(() => 1), quotaSnapshot: () => null,
      makeCompat: fakeCompat(async function* () { await blocked; throw apiError(429, 1316, 'Resets at 2026-10-12 20:00:00'); }, compatCalls) as never,
    });
    const first = drain(p.streamChat!([{ role: 'user', content: 'a' }], {})).catch((e) => e);
    const second = drain(p.streamChat!([{ role: 'user', content: 'b' }], {})).catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    unblock();
    expect(await first).toBeInstanceOf(ZaiCodingPlanLimitError);
    expect(await second).toBeInstanceOf(ZaiCodingPlanLimitError);
    expect(compatCalls.length).toBe(1);                  // 두 번째는 직결하지 않았다
  });

  test('리셋 시각이 지난 한도는 살아 있지 않다', () => {
    const r: ZaiLedgerRecord = { ts: OFF_PEAK - 7_200_000, kind: 'limit', code: 1316, limitKind: 'balance-limit', window: '5h', resetAt: OFF_PEAK - 1, model: 'glm-5.3' };
    expect(activeZaiLimit([r], OFF_PEAK)).toBeNull();
    expect(activeZaiLimit([{ ...r, resetAt: OFF_PEAK + 1 }], OFF_PEAK)).not.toBeNull();
  });
});

describe('wire 본문 — 실제 호환 공급자로 보낸 HTTP 요청', () => {
  test('코딩 엔드포인트 · Bearer 키 · glm-5.3 · reasoning_effort · max_tokens 없음 · 위장 헤더 없음', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), headers: { ...(init.headers as Record<string, string>) }, body: JSON.parse(String(init.body)) });
      const sse = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n';
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    try {
      const p = makeZaiCodingPlanProvider({ provider: 'glm', reasoningLevel: 'high' } as never, {
        key: () => SECRET, ledgerPath: join(tmp('zai-wire-'), 'l.jsonl'), gate: new ZaiConcurrencyGate(() => 3), quotaSnapshot: () => null,
      });
      const evs = await drain(p.streamChat!([{ role: 'user', content: 'hi' }], {}));
      expect(evs.some((e) => e.type === 'text')).toBe(true);
    } finally { globalThis.fetch = original; }
    expect(seen.length).toBe(1);
    expect(seen[0]!.url).toBe(ZAI_CODING_PLAN_URL);
    expect(seen[0]!.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(Object.keys(seen[0]!.headers).sort()).toEqual(['Authorization', 'Content-Type']);
    expect(seen[0]!.body).toMatchObject({ model: 'glm-5.3', reasoning_effort: 'high', stream: true });
    expect('max_tokens' in seen[0]!.body).toBe(false);
    expect('temperature' in seen[0]!.body).toBe(false);
  });
});

describe('동시 상한', () => {
  test('상한 3 — 다섯을 동시에 띄워도 최대 3 · 끝나면 다음이 들어간다', async () => {
    const gate = new ZaiConcurrencyGate(() => 3);
    let peak = 0;
    const releases: Array<() => void> = [];
    const provider = makeZaiCodingPlanProvider({ provider: 'glm' } as never, {
      key: () => SECRET, ledgerPath: join(tmp('zai-conc-'), 'l.jsonl'), gate, quotaSnapshot: () => null,
      makeCompat: fakeCompat(async function* () {
        peak = Math.max(peak, gate.inFlight);
        await new Promise<void>((resolve) => releases.push(resolve));
        yield { type: 'text', delta: 'x' };
      }, []) as never,
    });
    const runs = Array.from({ length: 5 }, () => drain(provider.streamChat!([{ role: 'user', content: 'hi' }], {})));
    for (let i = 0; i < 50 && releases.length < 3; i++) await new Promise((r) => setTimeout(r, 5));
    expect(gate.inFlight).toBe(3);
    expect(gate.queued).toBe(2);
    while (releases.length > 0 || gate.inFlight > 0) {
      releases.splice(0).forEach((r) => r());
      await new Promise((r) => setTimeout(r, 5));
    }
    await Promise.all(runs);
    expect(peak).toBe(3);
    expect(gate.inFlight).toBe(0);
  });

  test('release 는 슬롯을 대기자에게 «양도»한다 — 그 사이 새 호출이 끼어 상한을 넘지 않는다', async () => {
    const gate = new ZaiConcurrencyGate(() => 1);
    const r1 = await gate.acquire();
    let second = false;
    const p2 = gate.acquire().then((r) => { second = true; return r; });
    await Promise.resolve();
    r1();                                   // 대기자에게 넘김(active 그대로 1)
    let third = false;
    const p3 = gate.acquire().then((r) => { third = true; return r; });   // 끼어드는 새 호출
    expect(gate.inFlight).toBe(1);
    const r2 = await p2;
    await Promise.resolve();
    expect(second).toBe(true);
    expect(third).toBe(false);              // 상한 1 을 넘지 않는다
    r2();
    (await p3)();
    expect(gate.inFlight).toBe(0);
  });

  test('이미 취소된 요청은 줄을 서지 않는다', async () => {
    const gate = new ZaiConcurrencyGate(() => 1);
    const r1 = await gate.acquire();
    const ac = new AbortController(); ac.abort(new Error('gone'));
    await expect(gate.acquire(ac.signal)).rejects.toThrow('gone');
    expect(gate.queued).toBe(0);
    r1();
    expect(gate.inFlight).toBe(0);
  });

  test('상한이 다른 공급자는 서로의 상한을 바꾸지 않는다', async () => {
    const releases: Array<() => void> = [];
    let inFlightOne = 0; let peakOne = 0;
    const mk = (max: number, track: boolean) => makeZaiCodingPlanProvider({ provider: 'glm', zaiCodingPlan: { maxConcurrent: max } } as never, {
      key: () => SECRET, ledgerPath: join(tmp('zai-gates-'), 'l.jsonl'), quotaSnapshot: () => null,
      makeCompat: fakeCompat(async function* () {
        if (track) { inFlightOne += 1; peakOne = Math.max(peakOne, inFlightOne); }
        await new Promise<void>((r) => releases.push(r));
        if (track) inFlightOne -= 1;
        yield { type: 'text', delta: 'x' };
      }, []) as never,
    });
    const one = mk(1, true);
    mk(3, false);                                     // 뒤에 만든 상한 3 이 앞의 상한 1 을 덮지 않는다
    const runs = [0, 1].map(() => drain(one.streamChat!([{ role: 'user', content: 'hi' }], {})));
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 2));
    expect(peakOne).toBe(1);
    while (releases.length > 0 || inFlightOne > 0) { releases.splice(0).forEach((r) => r()); await new Promise((r) => setTimeout(r, 2)); }
    await Promise.all(runs);
    expect(peakOne).toBe(1);
  });

  test('기본 상한 3 · config 로 바꾼다', async () => {
    const { zaiSettingsFromConfig } = await import('./zai-coding-plan.js');
    expect(zaiSettingsFromConfig(undefined)).toEqual({ overage: 'stop', maxConcurrent: 3 });
    expect(zaiSettingsFromConfig({ zaiCodingPlan: { overage: 'balance', maxConcurrent: 5 } })).toEqual({ overage: 'balance', maxConcurrent: 5 });
    expect(zaiSettingsFromConfig({ zaiCodingPlan: { overage: 'nope' as never, maxConcurrent: 0 } })).toEqual({ overage: 'stop', maxConcurrent: 3 });
  });
});

describe('크레딧·창 적산', () => {
  test('계수 — glm-5.3 6.9/1.7/24 · flash 2.3/0.56/8 · 첨두 1× · 비첨두 0.5×', () => {
    expect(isZaiPeak(PEAK)).toBe(true);
    expect(isZaiPeak(OFF_PEAK)).toBe(false);
    expect(isZaiPeak(Date.parse('2026-10-11T07:00:00Z'))).toBe(false); // 일요일
    expect(zaiCredits('glm-5.3', { input: 10_000, cached: 10_000, output: 10_000 }, PEAK)).toBeCloseTo(32.6, 10);
    expect(zaiCredits('glm-5.3-flash', { input: 10_000, cached: 10_000, output: 10_000 }, PEAK)).toBeCloseTo(10.86, 10);
    expect(zaiCredits('glm-5.3', { input: 10_000, cached: 0, output: 0 }, OFF_PEAK)).toBeCloseTo(3.45, 10);
    // 작은 호출을 반올림해 0 으로 접지 않는다 — 1000번 쌓이면 그대로 보인다.
    const tiny = zaiCredits('glm-5.3', { input: 1, cached: 0, output: 0 }, OFF_PEAK);
    expect(tiny).toBeGreaterThan(0);
    expect(tiny * 1000).toBeCloseTo(0.345, 10);
  });

  test('5h 롤링 · 주 창 · 잔액 칸이 따로 쌓인다', () => {
    const call = (ago: number, credits: number, bucket: 'plan' | 'balance' = 'plan'): ZaiLedgerRecord => ({ ts: OFF_PEAK - ago, kind: 'call', model: 'glm-5.3', input: 0, cached: 0, output: 0, credits, peak: false, bucket });
    const h = 3_600_000;
    const w = sumZaiLocalWindows([call(1 * h, 10), call(4 * h, 20), call(6 * h, 40), call(8 * 24 * h, 999), call(2 * h, 5, 'balance')], OFF_PEAK);
    expect(w.fiveHour.used).toBe(30);
    expect(w.weekly.used).toBe(70);
    expect(w.balanceCredits).toBe(5);
    expect(w.fiveHour.oldestTs).toBe(OFF_PEAK - 4 * h);
  });

  test('usage 표 — 공식 조회가 이기고, 실패하면 적산 «추정» ⊕ 429 리셋 시각', () => {
    const official = parseZaiQuota({ data: { level: 'max', limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 28000, currentValue: 120, remaining: 27880, nextResetTime: OFF_PEAK + 1000 },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 140000, currentValue: 300, remaining: 139700, nextResetTime: OFF_PEAK + 2000 },
    ] } }, OFF_PEAK);
    expect(official.status).toBe('ok');
    const v1 = buildZaiUsageView(official, [], OFF_PEAK);
    expect(v1.windows).toEqual([
      { window: '5h', used: 120, limit: 28000, resetAt: OFF_PEAK + 1000, source: 'official' },
      { window: 'weekly', used: 300, limit: 140000, resetAt: OFF_PEAK + 2000, source: 'official' },
    ]);
    const ledger: ZaiLedgerRecord[] = [
      { ts: OFF_PEAK - 60_000, kind: 'call', model: 'glm-5.3', input: 0, cached: 0, output: 0, credits: 12, peak: false, bucket: 'plan' },
      { ts: OFF_PEAK - 30_000, kind: 'limit', code: 1310, limitKind: 'plan-limit', window: 'weekly', resetAt: OFF_PEAK + 99_000, model: 'glm-5.3' },
    ];
    const v2 = buildZaiUsageView({ status: 'error', detail: 'http-500' }, ledger, OFF_PEAK);
    expect(v2.windows[0]).toMatchObject({ window: '5h', used: 12, limit: 28000, source: 'estimated', resetAt: OFF_PEAK - 60_000 + 5 * 3_600_000 });
    expect(v2.windows[1]).toMatchObject({ window: 'weekly', source: 'next_flush_time', resetAt: OFF_PEAK + 99_000 });
    expect(v2.lastLimit).toMatchObject({ code: 1310 });
  });

  test('공식 응답이 불완전하면(창 하나 · 쓴 양 없음) 공식으로 안 쓰고 추정 표로 간다', () => {
    const one = parseZaiQuota({ data: { limits: [{ unit: 3, number: 5, usage: 28000, currentValue: 5, remaining: 27995 }] } }, OFF_PEAK);
    expect(one).toEqual({ status: 'error', detail: 'incomplete-windows' });
    const noUsed = parseZaiQuota({ data: { limits: [
      { unit: 3, number: 5, usage: 28000, nextResetTime: 1 },
      { unit: 6, number: 1, usage: 140000, currentValue: 0, remaining: 140000 },
    ] } }, OFF_PEAK);
    expect(noUsed.status).toBe('error');
    const v = buildZaiUsageView(one, [], OFF_PEAK);
    expect(v.windows.map((w) => [w.window, w.source])).toEqual([['5h', 'estimated'], ['weekly', 'estimated']]);
  });

  test('원장 — 오래된 줄이 많으면 남길 줄만으로 다시 쓴다', () => {
    const ledgerPath = join(tmp('zai-compact-'), 'l.jsonl');
    const old: ZaiLedgerRecord = { ts: OFF_PEAK - 30 * 86_400_000, kind: 'call', model: 'glm-5.3', input: 0, cached: 0, output: 0, credits: 1, peak: false, bucket: 'plan' };
    for (let i = 0; i < 1_000; i++) appendZaiLedger(old, { ledgerPath });
    appendZaiLedger({ ...old, ts: OFF_PEAK - 1000 }, { ledgerPath });
    expect(readZaiLedger({ ledgerPath, now: () => OFF_PEAK }).length).toBe(1);
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    expect(readFileSync(ledgerPath, 'utf8').trim().split('\n').length).toBe(1);
  });

  test('model id — 아는 둘만 통과', () => {
    expect(zaiWireModel('glm-5.3-flash')).toBe('glm-5.3-flash');
    expect(zaiWireModel('openrouter/z-ai/glm-5.3')).toBe('glm-5.3');
    expect(zaiWireModel('glm-5.1')).toBe('glm-5.3');
    expect(zaiWireModel(undefined)).toBe('glm-5.3');
  });
});

describe('eln usage 표면', () => {
  test('키 있음 → zai 세 행(5h·주·잔액) · 키 없음 → 종전 문면·JSON 과 같다', async () => {
    const { collectUnifiedUsage, formatUnifiedUsage } = await import('../budget/unified-usage.js');
    const common = { listCodexAccounts: () => [], resolveGrokCredential: () => null, openRouterKey: () => undefined, now: () => OFF_PEAK };
    const without = await collectUnifiedUsage({ ...common, zaiKey: () => undefined });
    expect(without.accountCounts).toEqual({ codex: 0, grok: 0, openrouter: 0 });
    expect('zaiCodingPlan' in without).toBe(false);
    expect(formatUnifiedUsage(without)).not.toContain('zai');

    const withKey = await collectUnifiedUsage({
      ...common,
      zaiKey: () => SECRET,
      fetchZaiQuota: async () => parseZaiQuota({ data: { limits: [
        { unit: 3, number: 5, usage: 28000, currentValue: 2800, remaining: 25200, nextResetTime: OFF_PEAK + 3_600_000 },
        { unit: 6, number: 1, usage: 140000, currentValue: 0, remaining: 140000, nextResetTime: OFF_PEAK + 86_400_000 },
      ] } }, OFF_PEAK),
      readZaiLedger: () => [],
    });
    expect(withKey.accountCounts.zai).toBe(1);
    // seam 없이도 env 키가 있으면(시험 런타임) 행이 선다
    const savedKey = process.env.ZAI_API_KEY;
    process.env.ZAI_API_KEY = SECRET;
    try {
      const envOnly = await collectUnifiedUsage({ ...common, fetchZaiQuota: async () => ({ status: 'error', detail: 'x' }), readZaiLedger: () => [] });
      expect(envOnly.accountCounts.zai).toBe(1);
    } finally { if (savedKey === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = savedKey; }
    // 조회가 «던져도» usage 는 살아 있고 추정 표로 간다
    const thrown = await collectUnifiedUsage({ ...common, zaiKey: () => SECRET, fetchZaiQuota: async () => { throw new Error('boom'); }, readZaiLedger: () => [] });
    expect(thrown.zaiCodingPlan?.quotaStatus).toBe('error');
    expect(formatUnifiedUsage(thrown)).toContain('출처=추정');
    expect(withKey.rows.filter((r) => r.provider === 'zai').map((r) => r.accountName)).toEqual(['plan-5h', 'plan-week', 'extra-usage']);
    const text = formatUnifiedUsage(withKey);
    expect(text).toContain('zai  accounts=1');
    expect(text).toContain('10%');
    expect(text).toContain('2800/28000 크레딧 · 출처=공식 · elanous 적산 0');
    expect(text).toContain('잔액 사용 0 크레딧');
    expect(text + JSON.stringify(withKey)).not.toContain(SECRET);
  });
});

describe('키 값 0회 — 로그·오류·요약', () => {
  test('성공·한도·폴백·멈춤 경로의 debug.log 인자와 오류 문면에 키가 없다', async () => {
    const seen: string[] = [];
    const spy = spyOn(debug, 'log').mockImplementation(((...args: unknown[]) => { seen.push(JSON.stringify(args)); }) as never);
    try {
      for (const [policy, gen] of [
        ['stop', async function* () { yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } } as LLMStreamEvent; }],
        ['balance', async function* () { throw apiError(429, 1316, 'x Resets at 2026-10-11 09:12:33'); }],
        ['stop', async function* () { throw apiError(429, 1113, 'balance'); }],
      ] as const) {
        const p = makeZaiCodingPlanProvider({ provider: 'glm', zaiCodingPlan: { overage: policy } } as never, {
          key: () => SECRET, ledgerPath: join(tmp('zai-secret-'), 'l.jsonl'), gate: new ZaiConcurrencyGate(() => 3), quotaSnapshot: () => null,
          makeCompat: fakeCompat(gen as never, []) as never, makeOpenRouter: fakeOpenRouter([]), openRouterKey: () => 'or',
        });
        try { await drain(p.streamChat!([{ role: 'user', content: 'hi' }], {})); } catch (e) { seen.push(String(e)); }
      }
    } finally { spy.mockRestore(); }
    expect(seen.some((s) => s.includes('zai.coding-plan'))).toBe(true);
    expect(seen.join('\n')).not.toContain(SECRET);
  });
});

test('llm.zaiCodingPlan.overage 는 config set → get 왕복에서 살아남는다', () => {
  const dir = tmp('zai-cfg-');
  const cli = (...args: string[]) => spawnSync(process.execPath, ['bin/elanous.mjs', '--config-dir', dir, 'config', ...args], { cwd: join(import.meta.dir, '..', '..'), encoding: 'utf8' });
  expect(cli('set', 'llm.zaiCodingPlan.overage', 'balance').status).toBe(0);
  const got = cli('get', 'llm.zaiCodingPlan.overage');
  expect(got.status).toBe(0);
  expect(got.stdout.trim().split('\n').at(-1)).toContain('balance');
}, 120_000);
