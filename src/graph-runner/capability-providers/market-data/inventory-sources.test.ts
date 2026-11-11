import { expect, test } from 'bun:test';
import { dispatchGraphContract } from '../../capabilities.js';
import type { InProcessHandlerContext } from '../../in-process-registry.js';
import { marketDataRegistry } from './registry.js';
import { createTwelveDataDeclarations, createFdsDeclarations, createYahooDeclarations } from './omni-sources.js';
import { createPykrxDeclarations } from './kr-daily-sources.js';
import type { StockFetch } from './stock-common.js';

const context = (input: unknown): InProcessHandlerContext => ({ graphId: 'inventory-sim', runId: 'sim', nodeId: 'source', input, outputs: {} });
const fixed = (value: unknown) => ({ ok: true, json: async () => value });

test('TwelveData US quote and intraday use secret slot and fixed responses', async () => {
  const paths: string[] = [];
  const fetcher: StockFetch = async (url) => { const parsed = new URL(url); paths.push(parsed.pathname);
    expect(parsed.searchParams.get('apikey')).toBe('fixture-key');
    return fixed(parsed.pathname === '/quote'
      ? { symbol: 'AAPL', timestamp: 1794182400, close: '260.5' }
      : { meta: { symbol: 'AAPL' }, values: [{ datetime: '2026-11-09 09:35:00', open: '1', high: '2', low: '1', close: '2', volume: '3' }] }); };
  const registry = marketDataRegistry(createTwelveDataDeclarations({ fetcher, lookupSecret: async () => 'fixture-key' }));
  expect(await dispatchGraphContract('market.quote@1', context({ market: 'US', symbol: 'AAPL' }), registry))
    .toMatchObject({ ok: true, result: { source: 'twelvedata', price: 260.5 } });
  expect(await dispatchGraphContract('market.intraday@1', context({ market: 'US', symbol: 'AAPL', from: '2026-11-09', to: '2026-11-09' }), registry))
    .toMatchObject({ ok: true, result: { bars: [{ close: 2 }] } });
  expect(paths).toEqual(['/quote', '/time_series']);
});

test('FDS US quote, OHLCV and fundamentals use X-API-KEY and fixed responses', async () => {
  const paths: string[] = [];
  const fetcher: StockFetch = async (url, init) => { const parsed = new URL(url); paths.push(parsed.pathname);
    expect((init?.headers as Record<string, string>)['X-API-KEY']).toBe('fixture-key');
    return fixed(parsed.pathname.endsWith('snapshot') ? { snapshot: { close: 260.5 } }
      : parsed.pathname.endsWith('/facts') ? { company_facts: { ticker: 'AAPL', name: 'Apple' } }
      : { prices: [{ time: '2026-11-09T00:00:00Z', open: 258, high: 262, low: 257, close: 260, volume: 100 }] }); };
  const registry = marketDataRegistry(createFdsDeclarations({ fetcher, lookupSecret: async () => 'fixture-key', now: () => new Date('2026-11-09T00:00:00Z') }));
  expect(await dispatchGraphContract('market.quote@1', context({ market: 'US', symbol: 'AAPL' }), registry))
    .toMatchObject({ ok: true, result: { source: 'fds', price: 260.5 } });
  expect(await dispatchGraphContract('market.ohlcv@1', context({ market: 'US', symbol: 'AAPL', from: '2026-11-09', to: '2026-11-09' }), registry))
    .toMatchObject({ ok: true, result: { bars: [{ close: 260 }] } });
  expect(await dispatchGraphContract('market.fundamentals@1', context({ market: 'US', symbol: 'AAPL' }), registry))
    .toMatchObject({ ok: true, result: { facts: { name: 'Apple' } } });
  expect(paths).toEqual(['/prices/snapshot', '/prices', '/company/facts']);
});

test('Yahoo keyless index and futures chart use fixed response', async () => {
  const symbols: string[] = [];
  const fetcher: StockFetch = async (url) => { const symbol = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!); symbols.push(symbol);
    return fixed({ chart: { result: [{ meta: { symbol, regularMarketPrice: 6000, regularMarketTime: 1794182400 } }] } }); };
  const registry = marketDataRegistry(createYahooDeclarations({ fetcher }));
  expect(await dispatchGraphContract('market.index@1', context({ market: 'GLOBAL', symbol: 'GSPC.INDX' }), registry))
    .toMatchObject({ ok: true, result: { source: 'yahoo', price: 6000 } });
  expect(await dispatchGraphContract('kr.derivatives.futures@1', context({ market: 'GLOBAL', symbol: 'CL.FUT' }), registry))
    .toMatchObject({ ok: true, result: { symbol: 'CL=F' } });
  expect(symbols).toEqual(['^GSPC', 'CL=F']);
});

test('pykrx optional local daily fallback resolves fixed bars without key', async () => {
  const registry = marketDataRegistry(createPykrxDeclarations({ available: () => true,
    readDaily: async (from, to, symbol) => { expect([from, to, symbol]).toEqual(['20261109', '20261109', '005930']);
      return [{ date: '2026-11-09', open: 71000, high: 73000, low: 70000, close: 72000, volume: 125000 }]; } }));
  expect(await dispatchGraphContract('market.ohlcv@1', context({ market: 'KR', symbol: '005930', from: '2026-11-09', to: '2026-11-09' }), registry))
    .toMatchObject({ ok: true, result: { source: 'pykrx', bars: [{ close: 72000 }] } });
});
