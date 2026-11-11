import { expect, test } from 'bun:test';
import { ARG_STOCK_DISCLAIMER, runArgStockSimulation } from './arg-stock-sim.js';

test('ARG stock graph v2 lowers and completes both Korean equities from fixed responses', async () => {
  const result = await runArgStockSimulation();
  expect(result.status).toBe('done');
  expect(result.loweredGraph.graphId).toBe('arg-stock-1121-sim');
  expect(result.loweredGraph.nodeKinds.filter((node) => node.kind === 'capability'))
    .toEqual([
      { nodeId: 'quote1', kind: 'capability', requires: 'market.quote@1' },
      { nodeId: 'ohlcv1', kind: 'capability', requires: 'market.ohlcv@1' },
      { nodeId: 'flow1', kind: 'capability', requires: 'market.kr-flow@1' },
      { nodeId: 'quote2', kind: 'capability', requires: 'market.quote@1' },
      { nodeId: 'ohlcv2', kind: 'capability', requires: 'market.ohlcv@1' },
      { nodeId: 'flow2', kind: 'capability', requires: 'market.kr-flow@1' },
      { nodeId: 'memo', kind: 'capability', requires: 'arg.stock-memo@1' },
    ]);
  expect(result.executedNodes).toEqual(['quote1', 'ohlcv1', 'flow1', 'quote2', 'ohlcv2', 'flow2', 'memo', 'done']);
  expect(result.providerCalls).toEqual({ token: 1, quote: 2, ohlcv: 2, flow: 2 });
  expect(result.memo.observations).toHaveLength(2);
  expect(result.memo.observations[0]).toContain('삼성전자(005930)');
  expect(result.memo.observations[1]).toContain('SK하이닉스(000660)');
  expect(result.memo.judgment).toContain('매매 결론을 보류');
  expect(result.memo.disclaimer).toBe(ARG_STOCK_DISCLAIMER);
});
