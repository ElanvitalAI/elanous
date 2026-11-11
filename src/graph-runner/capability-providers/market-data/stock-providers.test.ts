import { expect, test } from 'bun:test';
import { dispatchGraphContract } from '../../capabilities.js';
import type { InProcessHandlerContext } from '../../in-process-registry.js';
import { createFinnhubDeclarations } from './finnhub.js';
import { createKisDeclarations } from './kis.js';
import { marketDataRegistry } from './registry.js';
import type { StockFetch } from './stock-common.js';

function context(input: unknown): InProcessHandlerContext {
  return { graphId: 'stock-sim', runId: 'run-1', nodeId: 'stock', input, outputs: {} };
}
function fixture(body: unknown): StockFetch {
  return async () => ({ ok: true, json: async () => body });
}

test('Finnhub declares free US quote and daily OHLCV contracts, with a user key', async () => {
  const seen: URL[] = [];
  const fetcher: StockFetch = async (url) => {
    const parsed = new URL(url); seen.push(parsed);
    return { ok: true, json: async () => parsed.pathname.endsWith('/quote')
      ? { c: 260.5, t: 1794182400 }
      : { s: 'ok', t: [1794182400], o: [258], h: [262], l: [257], c: [260], v: [12345] } };
  };
  const declarations = createFinnhubDeclarations({ fetcher, apiKey: 'fixture-key' });
  expect(declarations.map(({ id, provides, tier, secretRefs, conditions }) => ({ id, provides, tier, secretRefs, conditions })))
    .toEqual([
      { id: 'finnhub-us-quote', provides: ['market.quote@1'], tier: 'free', secretRefs: ['cred:finnhub.api_key'], conditions: { market: 'US' } },
      { id: 'finnhub-us-ohlcv', provides: ['market.ohlcv@1'], tier: 'free', secretRefs: ['cred:finnhub.api_key'], conditions: { market: 'US' } },
    ]);
  const registry = marketDataRegistry(declarations);
  expect(await dispatchGraphContract('market.quote@1', context({ market: 'US', symbol: 'AAPL' }), registry))
    .toMatchObject({ ok: true, result: { source: 'finnhub', price: 260.5, currency: 'USD' } });
  expect(await dispatchGraphContract('market.ohlcv@1', context({ market: 'US', symbol: 'AAPL', from: '2026-11-09', to: '2026-11-09' }), registry))
    .toMatchObject({ ok: true, result: { bars: [{ open: 258, high: 262, low: 257, close: 260, volume: 12345 }] } });
  expect(seen[0]!.searchParams.get('token')).toBe('fixture-key');
  expect(seen[1]!.searchParams.get('resolution')).toBe('D');
});

test('Finnhub fails closed on missing key, malformed candles, and non-US selection', async () => {
  const declarations = createFinnhubDeclarations({ apiKey: '', fetcher: fixture({}) });
  const registry = marketDataRegistry(declarations);
  expect(await dispatchGraphContract('market.quote@1', context({ market: 'US', symbol: 'AAPL' }), registry))
    .toMatchObject({ ok: false, error: 'unprovided' });
  const malformed = marketDataRegistry(createFinnhubDeclarations({ apiKey: 'fixture-key', fetcher: fixture({}) }));
  expect(await dispatchGraphContract('market.ohlcv@1', context({ market: 'US', symbol: 'AAPL', from: '2026-11-01', to: '2026-11-09' }), malformed))
    .toMatchObject({ ok: false, error: 'contract-exhausted', evidence: { attempts: [{ reason: 'provider_failed' }] } });
  expect(await dispatchGraphContract('market.quote@1', context({ market: 'KR', symbol: '005930' }), registry))
    .toMatchObject({ ok: false, error: 'unprovided' });
});

test('KIS uses owner app credentials, caches its token, and reads KR quote/OHLCV/flow', async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetcher: StockFetch = async (url, init) => {
    const parsed = new URL(url); calls.push({ url: parsed, init });
    const body = parsed.pathname.endsWith('/tokenP') ? { access_token: 'fixture-token', expires_in: 3600 }
      : parsed.pathname.endsWith('/inquire-price') ? { rt_cd: '0', output: { stck_prpr: '72000' } }
      : parsed.pathname.endsWith('/inquire-daily-itemchartprice') ? { rt_cd: '0', output2: [{ stck_bsop_date: '20261109', stck_oprc: '71000', stck_hgpr: '73000', stck_lwpr: '70000', stck_clpr: '72000', acml_vol: '125000' }] }
      : { rt_cd: '0', output: [{ stck_bsop_date: '20261109', frgn_ntby_qty: '1500', orgn_ntby_qty: '-300' }] };
    return { ok: true, json: async () => body };
  };
  const declarations = createKisDeclarations({ fetcher, appKey: 'fixture-app', appSecret: 'fixture-secret', now: () => new Date('2026-11-09T08:00:00Z') });
  expect(declarations.map((item) => item.provides)).toEqual([['market.quote@1'], ['market.ohlcv@1'], ['market.kr-flow@1']]);
  expect(declarations.every((item) => item.tier === 'free' && item.secretRefs?.join(',') === 'cred:kis.app_key,cred:kis.app_secret' && item.conditions?.market === 'KR')).toBe(true);
  const registry = marketDataRegistry(declarations);
  expect(await dispatchGraphContract('market.quote@1', context({ market: 'KR', symbol: '005930' }), registry))
    .toMatchObject({ ok: true, result: { source: 'kis', price: 72000, currency: 'KRW' } });
  expect(await dispatchGraphContract('market.ohlcv@1', context({ market: 'KR', symbol: '005930', from: '2026-11-09', to: '2026-11-09' }), registry))
    .toMatchObject({ ok: true, result: { bars: [{ close: 72000, volume: 125000 }] } });
  expect(await dispatchGraphContract('market.kr-flow@1', context({ market: 'KR', symbol: '005930' }), registry))
    .toMatchObject({ ok: true, result: { asOf: '2026-11-09', foreignNetVolume: 1500, institutionNetVolume: -300 } });
  expect(calls.filter((call) => call.url.pathname.endsWith('/tokenP'))).toHaveLength(1);
  expect(calls.filter((call) => call.url.pathname.includes('/quotations/')).map((call) => (call.init?.headers as Record<string, string>).tr_id))
    .toEqual(['FHKST01010100', 'FHKST03010100', 'FHKST01010900']);
});

test('KIS rejects missing owner keys and malformed flow without exposing credentials', async () => {
  const missing = marketDataRegistry(createKisDeclarations({ appKey: '', appSecret: '', fetcher: fixture({}) }));
  expect(await dispatchGraphContract('market.quote@1', context({ market: 'KR', symbol: '005930' }), missing))
    .toMatchObject({ ok: false, error: 'unprovided' });
  const bad = marketDataRegistry(createKisDeclarations({ appKey: 'fixture-app', appSecret: 'fixture-secret', fetcher: async (url) => ({ ok: true,
    json: async () => url.includes('/tokenP') ? { access_token: 'fixture-token', expires_in: 3600 } : { rt_cd: '0', output: [] } }) }));
  const result = await dispatchGraphContract('market.kr-flow@1', context({ market: 'KR', symbol: '005930' }), bad);
  expect(result).toMatchObject({ ok: false, error: 'contract-exhausted', evidence: { attempts: [{ reason: 'provider_failed' }] } });
  expect(JSON.stringify(result)).not.toContain('fixture-secret');
});

test('KIS rejects a daily window that could exceed its 100-row response before making a request', async () => {
  let calls = 0;
  const registry = marketDataRegistry(createKisDeclarations({ appKey: 'fixture-app', appSecret: 'fixture-secret',
    fetcher: async () => { calls += 1; return { ok: true, json: async () => ({}) }; } }));
  expect(await dispatchGraphContract('market.ohlcv@1', context({ market: 'KR', symbol: '005930',
    from: '2026-01-01', to: '2026-11-09' }), registry))
    .toMatchObject({ ok: false, error: 'contract-exhausted', evidence: { attempts: [{ reason: 'invalid_input' }] } });
  expect(calls).toBe(0);
});

test('shared quote contract routes US and KR input to the declared market source', async () => {
  const finnhub = createFinnhubDeclarations({ apiKey: 'fixture-key', fetcher: fixture({ c: 260.5, t: 1794182400 }) });
  const kis = createKisDeclarations({ appKey: 'fixture-app', appSecret: 'fixture-secret',
    fetcher: async (url) => ({ ok: true, json: async () => url.includes('/tokenP')
      ? { access_token: 'fixture-token', expires_in: 3600 } : { rt_cd: '0', output: { stck_prpr: '72000' } } }),
    now: () => new Date('2026-11-09T08:00:00Z') });
  const registry = marketDataRegistry([...finnhub, ...kis]);
  expect(await dispatchGraphContract('market.quote@1', context({ market: 'US', symbol: 'AAPL' }), registry))
    .toMatchObject({ ok: true, result: { source: 'finnhub' } });
  expect(await dispatchGraphContract('market.quote@1', context({ market: 'KR', symbol: '005930' }), registry))
    .toMatchObject({ ok: true, result: { source: 'kis' } });
});
