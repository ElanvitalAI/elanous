import { expect, test } from 'bun:test';
import { ARG_STOCK_DISCLAIMER } from './arg-stock-sim.js';
import { runArgStockAllProvidersSimulation } from './arg-stock-all-providers-sim.js';
import { createDefaultMarketDataRegistry } from './registry.js';

test('ARG stock graph selects Toss quote/OHLCV and KIS flow among every landed provider declaration', async () => {
  const result = await runArgStockAllProvidersSimulation();
  expect(result.status).toBe('done');
  expect(result.executedNodes).toEqual(['quote1', 'ohlcv1', 'flow1', 'quote2', 'ohlcv2', 'flow2', 'memo', 'done']);
  expect(result.registeredProviderIds).toEqual(createDefaultMarketDataRegistry().providers.map((provider) => provider.id));
  expect(result.selectedSources).toEqual({ quote1: 'toss', ohlcv1: 'toss', flow1: 'kis',
    quote2: 'toss', ohlcv2: 'toss', flow2: 'kis' });
  expect(result.providerCalls).toEqual({ tossToken: 1, tossQuote: 2, tossOhlcv: 2, kisToken: 1, kisFlow: 2 });
  expect(result.memo.observations).toEqual([
    '삼성전자(005930): 종가 72,000원, 시가 대비 +1.41%, 외국인 순매수량 +1,500주, 기관 순매수량 -300주.',
    'SK하이닉스(000660): 종가 180,000원, 시가 대비 -1.1%, 외국인 순매수량 -900주, 기관 순매수량 +400주.',
  ]);
  expect(result.memo.disclaimer).toBe(ARG_STOCK_DISCLAIMER);
});
