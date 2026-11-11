import { describe, expect, test } from 'bun:test';
import type { InProcessHandlerContext } from '../../in-process-registry.js';
import { dispatchGraphContract } from '../../capabilities.js';
import type { MarketDataFetch } from './contract.js';
import { createCoinGeckoProvider, createEcosProvider, createFredProvider, createFreeMarketDeclarations,
  createUpbitProvider, marketDataRegistry } from './index.js';

function fixture(body: unknown, inspect?: (url: URL) => void): MarketDataFetch {
  return async (url) => {
    inspect?.(new URL(url));
    return { ok: true, json: async () => body };
  };
}

function context(input: unknown): InProcessHandlerContext {
  return { graphId: 'market-sim', runId: 'run-1', nodeId: 'market', input, outputs: {} };
}

describe('free market data declarations and fixed response simulation', () => {
  test('FRED rates and macro require a free registration key, then parse observations', async () => {
    const provider = createFredProvider(fixture({ observations: [{ date: '2026-11-06', value: '3.75' }] }, (url) => {
      expect(url.searchParams.get('series_id')).toBe('DFF');
      expect(url.searchParams.get('api_key')).toBe('test-key');
    }), 'test-key');
    expect(provider.declaration).toMatchObject({ provides: ['rates', 'macro'], tier: 'free-key', latency: 'daily', keyEnv: 'FRED_API_KEY' });
    expect(await provider.read({ requires: 'rates', symbol: 'DFF' })).toMatchObject({ source: 'fred', value: 3.75, asOf: '2026-11-06' });
    await expect(createFredProvider(fixture({}), '').read({ requires: 'macro', symbol: 'GDP' })).rejects.toThrow('key_required');
  });

  test('FRED skips missing latest observations and returns the latest valid value', async () => {
    const provider = createFredProvider(fixture({ observations: [
      { date: '2026-11-09', value: '.' }, { date: '2026-11-06', value: '3.75' },
    ] }, (url) => expect(url.searchParams.get('limit')).toBe('1000')), 'test-key');
    expect(await provider.read({ requires: 'rates', symbol: 'DFF' }))
      .toMatchObject({ value: 3.75, asOf: '2026-11-06' });
  });

  test('ECOS macro, rates and FX parse StatisticSearch rows with its registration key', async () => {
    const provider = createEcosProvider(fixture({ StatisticSearch: { row: [{ TIME: '202610', DATA_VALUE: '1390.2', UNIT_NAME: '원' }] } }, (url) => {
      expect(url.pathname).toContain('/test-key/json/kr/1/1000/731Y001/M/');
      expect(url.pathname).toEndWith('/0000001');
    }), 'test-key');
    expect(provider.declaration).toMatchObject({ provides: ['macro', 'rates', 'fx'], tier: 'free-key', keyEnv: 'ECOS_API_KEY' });
    expect(await provider.read({ requires: 'fx', symbol: '731Y001.0000001' })).toMatchObject({ value: 1390.2, asOf: '202610', unit: '원' });
    await expect(provider.read({ requires: 'fx', symbol: 'invalid' })).rejects.toThrow('invalid_symbol');
    await expect(provider.read({ requires: 'fx', symbol: '731Y001.0000001.extra' })).rejects.toThrow('invalid_symbol');
  });

  test('ECOS pages through the bounded monthly range and selects the latest observation', async () => {
    const oldRows = Array.from({ length: 1000 }, () => ({ TIME: '202509', DATA_VALUE: '1200' }));
    const calls: string[] = [];
    const provider = createEcosProvider(async (url) => {
      calls.push(url);
      return { ok: true, json: async () => ({ StatisticSearch: { list_total_count: '1001',
        row: url.includes('/1001/2000/') ? [{ TIME: '202610', DATA_VALUE: '1390.2' }] : oldRows } }) };
    }, 'test-key');
    expect(await provider.read({ requires: 'fx', symbol: '731Y001.0000001' })).toMatchObject({ value: 1390.2, asOf: '202610' });
    expect(calls).toHaveLength(2);
  });

  test('blank FRED and ECOS observations fail instead of becoming zero', async () => {
    const fred = createFredProvider(fixture({ observations: [{ date: '2026-11-06', value: '  ' }] }), 'test-key');
    const ecos = createEcosProvider(fixture({ StatisticSearch: { row: [{ TIME: '202610', DATA_VALUE: '' }] } }), 'test-key');
    await expect(fred.read({ requires: 'rates', symbol: 'DFF' })).rejects.toThrow('invalid_value');
    await expect(ecos.read({ requires: 'fx', symbol: '731Y001.0000001' })).rejects.toThrow('invalid_value');
  });

  test('Upbit keyless crypto quotation parses a fixed ticker', async () => {
    const provider = createUpbitProvider(fixture([{ market: 'KRW-BTC', trade_price: 90000000, timestamp: 1794182400000 }]));
    expect(provider.declaration).toMatchObject({ provides: ['crypto'], tier: 'free', latency: 'realtime' });
    expect(provider.declaration).not.toHaveProperty('keyEnv');
    expect(await provider.read({ requires: 'crypto', symbol: 'KRW-BTC' })).toMatchObject({ value: 90000000, unit: 'KRW', source: 'upbit' });
  });

  test('CoinGecko keyless crypto quotation parses a fixed simple-price response', async () => {
    const provider = createCoinGeckoProvider(fixture({ bitcoin: { usd: 105000, last_updated_at: 1794182400 } }));
    expect(provider.declaration).toMatchObject({ provides: ['crypto'], tier: 'free', latency: 'delayed' });
    expect(provider.declaration).not.toHaveProperty('keyEnv');
    expect(await provider.read({ requires: 'crypto', symbol: 'bitcoin' })).toMatchObject({ value: 105000, unit: 'USD', source: 'coingecko' });
  });

  test('the contract registry selects declared free sources by market and owner-key availability', async () => {
    const priorFred = process.env.FRED_API_KEY;
    const priorEcos = process.env.ECOS_API_KEY;
    process.env.FRED_API_KEY = 'test-key'; process.env.ECOS_API_KEY = 'test-key';
    try {
    const fred = createFredProvider(fixture({ observations: [{ date: '2026-11-06', value: '3.75' }] }), 'test-key');
    const ecos = createEcosProvider(fixture({ StatisticSearch: { row: [{ TIME: '202610', DATA_VALUE: '1390.2' }] } }), 'test-key');
    const upbit = createUpbitProvider(fixture([{ market: 'KRW-BTC', trade_price: 90000000, timestamp: 1794182400000 }]));
    const coingecko = createCoinGeckoProvider(fixture({ bitcoin: { usd: 105000, last_updated_at: 1794182400 } }));
    const declarations = createFreeMarketDeclarations({ fred, ecos, upbit, coingecko });
    expect(declarations).toHaveLength(7);
    expect(declarations.find((item) => item.id === 'fred-rates')).toMatchObject({ provides: ['market.rates@1'], tier: 'free', keyEnv: ['FRED_API_KEY'] });
    const registry = marketDataRegistry(declarations);
    expect(await dispatchGraphContract('market.rates@1', context({ market: 'US', symbol: 'DFF' }), registry))
      .toMatchObject({ ok: true, result: { source: 'fred', value: 3.75 } });
    expect(await dispatchGraphContract('market.fx@1', context({ market: 'KR', symbol: '731Y001.0000001' }), registry))
      .toMatchObject({ ok: true, result: { source: 'ecos', value: 1390.2 } });
    expect(await dispatchGraphContract('market.crypto@1', context({ market: 'KR', symbol: 'KRW-BTC' }), registry))
      .toMatchObject({ ok: true, result: { source: 'upbit', value: 90000000 } });
    expect(await dispatchGraphContract('market.crypto@1', context({ market: 'GLOBAL', symbol: 'bitcoin' }), registry))
      .toMatchObject({ ok: true, result: { source: 'coingecko', value: 105000 } });
    delete process.env.FRED_API_KEY;
    expect(await dispatchGraphContract('market.rates@1', context({ market: 'US', symbol: 'DFF' }), registry))
      .toMatchObject({ ok: false, error: 'unprovided' });
    } finally {
      if (priorFred === undefined) delete process.env.FRED_API_KEY; else process.env.FRED_API_KEY = priorFred;
      if (priorEcos === undefined) delete process.env.ECOS_API_KEY; else process.env.ECOS_API_KEY = priorEcos;
    }
  });
});
