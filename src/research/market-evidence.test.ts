// DEMO-RESEARCH-MARKET-DATA — registry providers -> research evidence with FIXED fetchers and INJECTED credentials:
// no network, no host key, no secret store (lookupSecret and every availability are supplied here).
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import type { GraphCapabilityProviderDeclaration } from '../graph-runner/capabilities.js';
import { createEodhdDeclarations } from '../graph-runner/capability-providers/market-data/eodhd.js';
import { marketDataRegistry } from '../graph-runner/capability-providers/market-data/registry.js';
import { parseResearchRouteFields } from '../core-turn/research-route.js';
import {
  appendUnverifiedNumberWarning, findUnverifiedNumbers, formatMarketDataSection, marketEvidence, marketResultToContent,
  MARKET_DATA_NO_SOURCE_LINE,
} from './market-evidence.js';

const NOW = Date.UTC(2026, 10, 20, 3, 0, 0);
let urls: string[] = [];
const fixedFetch = async (url: string) => {
  urls.push(url);
  const path = new URL(url).pathname;
  const ticker = decodeURIComponent(path.split('/').pop() ?? '');
  if (path.includes('/real-time/')) return { ok: true, json: async () => ({ code: ticker, timestamp: 1_763_600_000, close: 70500 }) };
  return { ok: true, json: async () => [
    { date: '2026-11-18', open: 70000, high: 71000, low: 69500, close: 70100, volume: 12345678 },
    { date: '2026-11-19', open: 70100, high: 71500, low: 70000, close: 70500, volume: 9876543 },
  ] };
};
const flowProvider: GraphCapabilityProviderDeclaration = {
  id: 'fixed-kr-flow', provides: ['market.kr-flow@1'], tier: 'free', guarantees: { sourceAttribution: true },
  invoke: async (context) => ({ ok: true, outcome: 'ok',
    result: { source: 'fixed-flow', market: 'KR', symbol: (context.input as { symbol: string }).symbol, asOf: '2026-11-19',
      foreignNetVolume: -1234567, institutionNetVolume: 765432 },
    evidence: { source: 'fixed-flow' } }),
};
const keyed = (key: string | undefined) => [
  ...createEodhdDeclarations({ fetcher: fixedFetch, lookupSecret: async () => key }), flowProvider,
];
const registryWith = (key: string | undefined) => marketDataRegistry(keyed(key));

let logged: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
beforeEach(() => {
  urls = []; logged = [];
  spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    logged.push({ category, event, data: (data ?? {}) as Record<string, unknown> });
  }) as typeof debug.log);
});
afterEach(() => { spyOn(debug, 'log').mockRestore(); });

test('KR symbol: quote · daily bars · investor flow become market-data evidence with value, date and provider', async () => {
  const result = await marketEvidence(['005930'], 'q1', { registry: registryWith('injected-test-key'), now: () => NOW });
  expect(result.evidence.map((item) => item.sourceKind).sort()).toEqual(['market-data:eodhd', 'market-data:eodhd', 'market-data:fixed-flow']);
  const text = result.evidence.map((item) => item.content).join('\n');
  expect(text).toContain('005930 quote 70500 KRW');
  expect(text).toContain('2026-11-19 close 70500 volume 9876543');
  expect(text).toContain('foreign -1234567, institution 765432 · as of 2026-11-19');
  expect(result.evidence.every((item) => item.outcome === 'complete' && item.questionId === 'q1')).toBe(true);
  expect(result.calls.filter((call) => call.outcome === 'complete').length).toBe(3);
  // The injected key is never part of anything we produced.
  expect(JSON.stringify([result, logged])).not.toContain('injected-test-key');
  expect(JSON.stringify([result, logged])).not.toContain('api_token');
});

test('each provider emits start and completion with provider · contract · durationMs and no values', async () => {
  await marketEvidence(['005930'], 'q1', { registry: registryWith('injected-test-key'), now: () => NOW });
  const events = logged.filter((entry) => entry.category === 'research.market-data');
  expect(events.filter((entry) => entry.event === 'checked').length).toBe(3);
  expect(events.filter((entry) => entry.event === 'started').length).toBe(3);
  expect(events.filter((entry) => entry.event === 'complete').length).toBe(3);
  for (const entry of events) {
    expect(Object.keys(entry.data).sort()).toEqual(['contract', 'durationMs', 'provider']);
  }
  expect(JSON.stringify(events)).not.toContain('70500');
});

test('provider exception, missing credential, and zero calls have separate events and answer reasons', async () => {
  const throwing: GraphCapabilityProviderDeclaration = {
    id: 'throwing-quote', provides: ['market.quote@1'], tier: 'free', guarantees: { sourceAttribution: true },
    invoke: async () => { throw new Error('private token sk-secret'); },
  };
  const failed = await marketEvidence(['NVDA'], 'q1', { registry: marketDataRegistry([throwing]), now: () => NOW });
  expect(logged.some((entry) => entry.event === 'started' && entry.data.provider === 'throwing-quote')).toBe(true);
  expect(logged.some((entry) => entry.event === 'failed' && entry.data.provider === 'throwing-quote'
    && entry.data.reason === 'provider-error')).toBe(true);
  expect(formatMarketDataSection(failed, () => '')).toContain('시세 공급자 1곳 검사 · 실제 호출 1곳 · 실패 이유: throwing-quote/provider-error');
  expect(JSON.stringify([failed, logged])).not.toContain('sk-secret');

  logged = [];
  const missing: GraphCapabilityProviderDeclaration = {
    id: 'missing-key', provides: ['market.quote@1'], tier: 'free', keyEnv: ['ELANOUS_TEST_ABSENT_MARKET_KEY'],
    guarantees: { sourceAttribution: true }, invoke: async () => { throw new Error('must not invoke'); },
  };
  const previousKey = process.env.ELANOUS_TEST_ABSENT_MARKET_KEY;
  try {
    delete process.env.ELANOUS_TEST_ABSENT_MARKET_KEY;
    const unavailable = await marketEvidence(['NVDA'], 'q1', { registry: marketDataRegistry([missing]), now: () => NOW });
    expect(logged.some((entry) => entry.event === 'checked' && entry.data.provider === 'missing-key')).toBe(true);
    expect(logged.some((entry) => entry.event === 'started' && entry.data.provider === 'missing-key')).toBe(false);
    expect(logged.some((entry) => entry.event === 'skipped' && entry.data.provider === 'missing-key'
      && entry.data.reason === 'credential-missing')).toBe(true);
    expect(formatMarketDataSection(unavailable, () => '')).toContain('시세 공급자 1곳 검사 · 실제 호출 0곳 · 실패 이유: missing-key/credential-missing');
  } finally {
    if (previousKey === undefined) delete process.env.ELANOUS_TEST_ABSENT_MARKET_KEY;
    else process.env.ELANOUS_TEST_ABSENT_MARKET_KEY = previousKey;
  }

  logged = [];
  const noCalls = await marketEvidence([], 'q1', { registry: marketDataRegistry([throwing]), now: () => NOW });
  expect(logged.some((entry) => entry.event === 'no-attempt' && entry.data.reason === 'no-symbols')).toBe(true);
  expect(formatMarketDataSection(noCalls, () => '')).toContain('시세 공급자 0곳 검사 · 실제 호출 0곳 · 실패 이유: no-symbols');
});

test('a provider without its key is skipped and the skip is recorded (reason code only)', async () => {
  const noKeyProvider: GraphCapabilityProviderDeclaration = {
    id: 'env-keyed', provides: ['market.quote@1'], tier: 'free', keyEnv: ['ELANOUS_TEST_ABSENT_MARKET_KEY'],
    guarantees: { sourceAttribution: true }, invoke: async () => { throw new Error('must not be called'); },
  };
  const registry = marketDataRegistry([...keyed(undefined), noKeyProvider]);
  const previousKey = process.env.ELANOUS_TEST_ABSENT_MARKET_KEY;
  try {
    delete process.env.ELANOUS_TEST_ABSENT_MARKET_KEY;
    const result = await marketEvidence(['005930'], 'q1', { registry, now: () => NOW });
    expect(urls).toEqual([]);
    const skipped = result.calls.filter((call) => call.outcome === 'skipped');
    expect(skipped.map((call) => `${call.provider}:${call.reason}`)).toContain('env-keyed:credential-missing');
    expect(skipped.map((call) => call.provider)).toContain('eodhd-kr-quote');
    expect(logged.filter((entry) => entry.category === 'research.market-data' && entry.event === 'skipped').length).toBe(skipped.length);
    // Flow still came from the keyless provider; quote/ohlcv have no source at all.
    expect(result.evidence.map((item) => item.sourceKind)).toEqual(['market-data:fixed-flow']);
    const section = formatMarketDataSection(result, (item) => `- ${item.content}`);
    expect(section).toContain('건너뜀');
    expect(section).not.toContain('ELANOUS_TEST_ABSENT_MARKET_KEY');
  } finally {
    if (previousKey === undefined) delete process.env.ELANOUS_TEST_ABSENT_MARKET_KEY;
    else process.env.ELANOUS_TEST_ABSENT_MARKET_KEY = previousKey;
  }
});

test('no usable source at all: honest no-source line, never an estimate', async () => {
  const result = await marketEvidence(['005930'], 'q1', { registry: marketDataRegistry(createEodhdDeclarations({ fetcher: fixedFetch, lookupSecret: async () => undefined })), now: () => NOW });
  expect(result.evidence).toEqual([]);
  expect(result.invokedProviderIds).toEqual([]);
  expect(formatMarketDataSection(result, () => '')).toContain('시세 공급자 2곳 검사 · 실제 호출 0곳');
  expect(formatMarketDataSection(result, () => '')).toContain('시세·수급 출처를 확보하지 못함 — 숫자 추정 금지');
});

test('a provider that throws or fails is a recorded failure, not an exception', async () => {
  const broken: GraphCapabilityProviderDeclaration = {
    id: 'broken', provides: ['market.quote@1'], tier: 'free', guarantees: { sourceAttribution: true },
    invoke: async () => { throw new Error('secret-looking text sk-123'); },
  };
  const result = await marketEvidence(['NVDA'], 'q1', { registry: marketDataRegistry([broken]), now: () => NOW });
  expect(result.evidence).toEqual([]);
  expect(result.calls.some((call) => call.provider === 'broken' && call.outcome === 'failed')).toBe(true);
  expect(result.invokedProviderIds).toEqual(['broken']);
  expect(JSON.stringify([result, logged])).not.toContain('sk-123');
});

test('a failed credential lookup is not reported as a missing credential by its error text', async () => {
  const failingLookup: GraphCapabilityProviderDeclaration = {
    id: 'lookup-error', provides: ['market.quote@1'], tier: 'free', guarantees: { sourceAttribution: true },
    available: async () => { throw new Error('key_required'); },
    invoke: async () => { throw new Error('must not invoke'); },
  };
  const result = await marketEvidence(['NVDA'], 'q1', { registry: marketDataRegistry([failingLookup]), now: () => NOW });
  expect(result.calls).toContainEqual(expect.objectContaining({
    provider: 'lookup-error', outcome: 'failed', reason: 'availability-error',
  }));
  expect(result.calls).not.toContainEqual(expect.objectContaining({
    provider: 'lookup-error', reason: 'credential-missing',
  }));
});

test('US symbol asks quote and daily bars only (no KR flow contract)', async () => {
  const result = await marketEvidence(['NVDA'], 'q1', { registry: registryWith('injected-test-key'), now: () => NOW });
  expect(result.calls.map((call) => call.contract).sort()).toEqual(['market.ohlcv@1', 'market.quote@1']);
  expect(result.evidence.map((item) => item.content).join('\n')).toContain('NVDA quote 70500 USD');
});

test('marketResultToContent refuses results missing guaranteed fields', () => {
  expect(marketResultToContent('market.quote@1', { source: 'x', symbol: 'A' })).toBeUndefined();
  expect(marketResultToContent('market.other@1', { source: 'x', symbol: 'A' })).toBeUndefined();
});

test('number rule: numbers absent from market-data evidence are flagged unverified; matches and years are not', () => {
  const evidence = ['005930 quote 70500 KRW · as of 2026-11-19 · provider eodhd'];
  expect(findUnverifiedNumbers('종가 70,500원 (2026-11-19). 목표가 85,000원, 상승률 3.5%', evidence)).toEqual(['85000', '3.5']);
  expect(findUnverifiedNumbers('1. 첫째 2. 둘째 https://example.org/a/12345', evidence)).toEqual([]);
  const warned = appendUnverifiedNumberWarning('목표가 85,000원', evidence);
  expect(warned).toContain('미검증 숫자');
  expect(warned).toContain('85000');
  expect(appendUnverifiedNumberWarning('종가 70,500원', evidence)).toBe('종가 70,500원');
  expect(appendUnverifiedNumberWarning('목표가 85,000원', undefined)).toBe('목표가 85,000원');
  expect(appendUnverifiedNumberWarning('목표가 85,000원', [])).toContain(MARKET_DATA_NO_SOURCE_LINE);
});

test('route parser: only topic market (+ valid symbols) is carried; general / unknown / junk collapse to the old shape', () => {
  expect(parseResearchRouteFields({ localOnly: false, topic: 'market', symbols: ['005930', 'nvda', 'bad symbol', 7, '005930'] }))
    .toEqual({ localOnly: false, topic: 'market', symbols: ['005930', 'NVDA'] });
  expect(parseResearchRouteFields({ localOnly: false, topic: 'general', symbols: ['005930'] })).toEqual({ localOnly: false });
  expect(parseResearchRouteFields({ localOnly: false, topic: 'weather' })).toEqual({ localOnly: false });
  expect(parseResearchRouteFields({ topic: 'general' })).toBeUndefined();
  expect(parseResearchRouteFields({ localOnly: false, symbols: ['005930'] })).toEqual({ localOnly: false });
});
