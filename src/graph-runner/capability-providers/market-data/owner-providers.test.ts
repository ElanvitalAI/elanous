import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../../../elanous-config-dir.js';
import { dispatchGraphContract } from '../../capabilities.js';
import type { InProcessHandlerContext } from '../../in-process-registry.js';
import { createEodhdDeclarations } from './eodhd.js';
import { createTossDeclarations } from './toss.js';
import { createKisDeclarations } from './kis.js';
import { marketDataRegistry } from './registry.js';
import type { MarketSecretLookup } from './market-secrets.js';
import type { StockFetch } from './stock-common.js';

function context(input: unknown): InProcessHandlerContext {
  return { graphId: 'owner-market-sim', runId: 'sim', nodeId: 'quote', input, outputs: {} };
}
const fixtureSecrets: MarketSecretLookup = async (id) => ({
  'cred:eodhd.api_key': 'fixture-eodhd', 'cred:toss.client_id': 'fixture-id',
  'cred:toss.client_secret': 'fixture-secret', 'cred:kis.app_key': 'fixture-app',
  'cred:kis.app_secret': 'fixture-secret',
} as Record<string, string>)[id];

function tossFixture(): { fetcher: StockFetch; calls: string[] } {
  const calls: string[] = [];
  const fetcher: StockFetch = async (url, init) => {
    const parsed = new URL(url); calls.push(parsed.pathname);
    if (parsed.pathname.endsWith('/token')) {
      expect(init?.method).toBe('POST');
      return { ok: true, json: async () => ({ access_token: 'fixture-token', expires_in: 3600 }) };
    }
    if (parsed.pathname.endsWith('/prices')) return { ok: true, json: async () => ({ result: [{ symbol: parsed.searchParams.get('symbols'),
      timestamp: '2026-11-09T15:30:00+09:00', lastPrice: '72000', currency: 'KRW' }] }) };
    if (parsed.pathname.endsWith('/candles')) return { ok: true, json: async () => ({ result: { candles: [{
      timestamp: '2026-11-09T00:00:00+09:00', openPrice: '71000', highPrice: '73000',
      lowPrice: '70000', closePrice: '72000', volume: '125000', currency: 'KRW',
    }], nextBefore: '2026-11-09T00:00:00+09:00' } }) };
    throw new Error('unexpected_fixture_url');
  };
  return { fetcher, calls };
}

test('EODHD secret-backed delayed quote and daily OHLCV resolve through contracts', async () => {
  const calls: string[] = [];
  const fetcher: StockFetch = async (url) => {
    const parsed = new URL(url); calls.push(parsed.pathname);
    expect(parsed.searchParams.has('api_token')).toBe(true);
    return { ok: true, json: async () => parsed.pathname.includes('/real-time/')
      ? { code: 'AAPL.US', timestamp: 1794182400, close: 260.5 }
      : [{ date: '2026-11-09', open: 258, high: 262, low: 257, close: 260, volume: 12345 }] };
  };
  const registry = marketDataRegistry(createEodhdDeclarations({ fetcher, lookupSecret: fixtureSecrets }));
  expect(await dispatchGraphContract('market.quote@1', context({ market: 'US', symbol: 'AAPL' }), registry))
    .toMatchObject({ ok: true, result: { source: 'eodhd', price: 260.5 } });
  expect(await dispatchGraphContract('market.ohlcv@1', context({ market: 'US', symbol: 'AAPL',
    from: '2026-11-09', to: '2026-11-09' }), registry))
    .toMatchObject({ ok: true, result: { bars: [{ close: 260, volume: 12345 }] } });
  expect(calls).toEqual(['/api/real-time/AAPL.US', '/api/eod/AAPL.US']);
  const absent = marketDataRegistry(createEodhdDeclarations({ fetcher, lookupSecret: async () => undefined }));
  expect(await dispatchGraphContract('market.quote@1', context({ market: 'US', symbol: 'AAPL' }), absent))
    .toMatchObject({ ok: false, error: 'unprovided' });
  const malformed = marketDataRegistry(createEodhdDeclarations({ lookupSecret: fixtureSecrets,
    fetcher: async () => ({ ok: true, json: async () => ({ code: 'OTHER.US', close: 260.5, timestamp: 1794182400 }) }) }));
  const failed = await dispatchGraphContract('market.quote@1', context({ market: 'US', symbol: 'AAPL' }), malformed);
  expect(failed).toMatchObject({ ok: false, error: 'contract-exhausted', evidence: {
    attempts: [{ provider: 'eodhd-us-quote', reason: 'provider_failed' }],
  } });
  expect(JSON.stringify(failed)).not.toContain('fixture-eodhd');
});

test('Toss secret-backed quote and daily candle reuse one fixed OAuth token', async () => {
  const { fetcher, calls } = tossFixture();
  let token: { token: string; expiresAt: number } | undefined;
  const registry = marketDataRegistry(createTossDeclarations({ fetcher, lookupSecret: fixtureSecrets,
    tokenCache: { get: () => token, set: (value, expiresAt) => { token = { token: value, expiresAt }; } },
    now: () => new Date('2026-11-09T08:00:00Z') }));
  expect(await dispatchGraphContract('market.quote@1', context({ market: 'KR', symbol: '005930' }), registry))
    .toMatchObject({ ok: true, result: { source: 'toss', price: 72000, currency: 'KRW' } });
  expect(await dispatchGraphContract('market.ohlcv@1', context({ market: 'KR', symbol: '005930',
    from: '2026-11-09', to: '2026-11-09' }), registry))
    .toMatchObject({ ok: true, result: { bars: [{ close: 72000 }] } });
  expect(calls).toEqual(['/oauth2/token', '/api/v1/prices', '/api/v1/candles']);
  const absent = marketDataRegistry(createTossDeclarations({ fetcher, lookupSecret: async () => undefined,
    tokenCache: { get: () => undefined, set: () => {} } }));
  expect(await dispatchGraphContract('market.quote@1', context({ market: 'KR', symbol: '005930' }), absent))
    .toMatchObject({ ok: false, error: 'unprovided' });
});

test('missing Toss credential lets the KR quote contract select KIS', async () => {
  const toss = createTossDeclarations({ lookupSecret: async () => undefined,
    tokenCache: { get: () => undefined, set: () => {} },
    fetcher: async () => { throw new Error('unreachable'); } });
  const kis = createKisDeclarations({ lookupSecret: fixtureSecrets, now: () => new Date('2026-11-09T08:00:00Z'),
    fetcher: async (url) => ({ ok: true, json: async () => url.includes('/tokenP')
      ? { access_token: 'fixture-token', expires_in: 3600 }
      : { rt_cd: '0', output: { stck_prpr: '72000' } } }) });
  const result = await dispatchGraphContract('market.quote@1', context({ market: 'KR', symbol: '005930' }),
    marketDataRegistry([...toss, ...kis]));
  expect(result).toMatchObject({ ok: true, result: { source: 'kis', price: 72000 } });
});

test('Toss daily OHLCV follows the bounded cursor and omits bars outside the requested window', async () => {
  const cursors: string[] = [];
  const candle = (date: string) => ({ timestamp: `${date}T00:00:00+09:00`, openPrice: '71000',
    highPrice: '73000', lowPrice: '70000', closePrice: '72000', volume: '125000' });
  const fetcher: StockFetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/token')) return { ok: true, json: async () => ({ access_token: 'fixture-token', expires_in: 3600 }) };
    const before = parsed.searchParams.get('before') ?? '';
    cursors.push(before);
    return { ok: true, json: async () => ({ result: before.startsWith('2026-11-09')
      ? { candles: [candle('2026-11-09')], nextBefore: '2026-11-08T00:00:00+09:00' }
      : { candles: [candle('2026-11-08'), candle('2026-11-07')], nextBefore: null } }) };
  };
  const registry = marketDataRegistry(createTossDeclarations({ fetcher, lookupSecret: fixtureSecrets,
    tokenCache: { get: () => undefined, set: () => {} }, now: () => new Date('2026-11-09T08:00:00Z') }));
  const result = await dispatchGraphContract('market.ohlcv@1', context({ market: 'KR', symbol: '005930',
    from: '2026-11-08', to: '2026-11-09' }), registry);
  expect(result).toMatchObject({ ok: true, result: { bars: [{ date: '2026-11-08' }, { date: '2026-11-09' }] } });
  expect(cursors).toHaveLength(2);
});

test('KIS uses credential slots and remains eligible for KR investor flow', async () => {
  const fetcher: StockFetch = async (url) => ({ ok: true, json: async () => url.includes('/tokenP')
    ? { access_token: 'fixture-token', expires_in: 3600 }
    : { rt_cd: '0', output: [{ stck_bsop_date: '20261109', frgn_ntby_qty: '1500', orgn_ntby_qty: '-300' }] } });
  const registry = marketDataRegistry(createKisDeclarations({ fetcher, lookupSecret: fixtureSecrets,
    now: () => new Date('2026-11-09T08:00:00Z') }));
  expect(await dispatchGraphContract('market.kr-flow@1', context({ market: 'KR', symbol: '005930' }), registry))
    .toMatchObject({ ok: true, result: { source: 'kis', foreignNetVolume: 1500 } });
  expect(registry.providers[0]?.secretRefs).toEqual(['cred:kis.app_key', 'cred:kis.app_secret']);
});

test('KIS VTS mode changes only the configured read-only host', async () => {
  const hosts: string[] = [];
  const fetcher: StockFetch = async (url) => {
    const parsed = new URL(url); hosts.push(parsed.host);
    return { ok: true, json: async () => parsed.pathname.endsWith('/tokenP')
      ? { access_token: 'fixture-token', expires_in: 3600 }
      : { rt_cd: '0', output: { stck_prpr: '72000' } } };
  };
  const registry = marketDataRegistry(createKisDeclarations({ fetcher, lookupSecret: fixtureSecrets,
    mode: 'vts', now: () => new Date('2026-11-09T08:00:00Z') }));
  expect(await dispatchGraphContract('market.quote@1', context({ market: 'KR', symbol: '005930' }), registry))
    .toMatchObject({ ok: true, result: { price: 72000 } });
  expect(hosts).toEqual(['openapivts.koreainvestment.com:29443', 'openapivts.koreainvestment.com:29443']);
});

test('KIS default mode reads market-data config from the selected config universe', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kis-config-universe-'));
  const hosts: string[] = [];
  const fetcher: StockFetch = async (url) => {
    const parsed = new URL(url); hosts.push(parsed.host);
    return { ok: true, json: async () => parsed.pathname.endsWith('/tokenP')
      ? { access_token: 'fixture-token', expires_in: 3600 }
      : { rt_cd: '0', output: { stck_prpr: '72000' } } };
  };
  try {
    setElanousConfigDir(root);
    writeFileSync(join(root, 'market-data.json'), JSON.stringify({ kis: { mode: 'vts' } }));
    const vts = marketDataRegistry(createKisDeclarations({ fetcher, lookupSecret: fixtureSecrets }));
    expect(await dispatchGraphContract('market.quote@1', context({ market: 'KR', symbol: '005930' }), vts))
      .toMatchObject({ ok: true });
    expect(hosts.splice(0)).toEqual(['openapivts.koreainvestment.com:29443', 'openapivts.koreainvestment.com:29443']);
    writeFileSync(join(root, 'market-data.json'), JSON.stringify({ kis: { mode: 'real' } }));
    const real = marketDataRegistry(createKisDeclarations({ fetcher, lookupSecret: fixtureSecrets }));
    expect(await dispatchGraphContract('market.quote@1', context({ market: 'KR', symbol: '005930' }), real))
      .toMatchObject({ ok: true });
    expect(hosts).toEqual(['openapi.koreainvestment.com:9443', 'openapi.koreainvestment.com:9443']);
  } finally {
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Toss and KIS market providers contain no order or account route', () => {
  for (const name of ['toss.ts', 'kis.ts']) {
    const source = readFileSync(new URL(name, import.meta.url), 'utf8');
    expect(source).not.toMatch(/\/(?:api\/v1\/)?(?:orders?|accounts?|holdings?|buying-power)(?:[/?'"`]|$)/i);
    expect(source).not.toContain('cred:toss.account_seq');
    expect(source).not.toContain('cred:kis.account');
  }
  const marketContracts = [...createTossDeclarations({ lookupSecret: async () => undefined,
    tokenCache: { get: () => undefined, set: () => {} } }),
  ...createKisDeclarations({ lookupSecret: async () => undefined })]
    .flatMap((provider) => provider.provides);
  expect(new Set(marketContracts)).toEqual(new Set(['market.quote@1', 'market.ohlcv@1', 'market.kr-flow@1']));
});

test('Toss and KIS fixed-response calls reach only token and quotation paths', async () => {
  const toss = tossFixture();
  const tossRegistry = marketDataRegistry(createTossDeclarations({ fetcher: toss.fetcher, lookupSecret: fixtureSecrets,
    tokenCache: { get: () => undefined, set: () => {} } }));
  expect(await dispatchGraphContract('market.quote@1', context({ market: 'KR', symbol: '005930' }), tossRegistry))
    .toMatchObject({ ok: true });
  expect(toss.calls).toEqual(['/oauth2/token', '/api/v1/prices']);
  const kisCalls: string[] = [];
  const kisRegistry = marketDataRegistry(createKisDeclarations({ lookupSecret: fixtureSecrets,
    fetcher: async (url) => { const path = new URL(url).pathname; kisCalls.push(path);
      return { ok: true, json: async () => path.endsWith('/tokenP')
        ? { access_token: 'fixture-token', expires_in: 3600 }
        : { rt_cd: '0', output: { stck_prpr: '72000' } } }; } }));
  expect(await dispatchGraphContract('market.quote@1', context({ market: 'KR', symbol: '005930' }), kisRegistry))
    .toMatchObject({ ok: true });
  expect(kisCalls).toEqual(['/oauth2/tokenP', '/uapi/domestic-stock/v1/quotations/inquire-price']);
});
