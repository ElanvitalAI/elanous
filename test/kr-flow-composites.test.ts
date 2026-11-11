import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from '../src/graph-runner/runner.js';
import { marketDataRegistry } from '../src/graph-runner/capability-providers/market-data/registry.js';
import type { GraphCapabilityProviderDeclaration } from '../src/graph-runner/capabilities.js';
import { parse as parseYaml } from 'yaml';

const stocks: Record<string, { price: number; foreign: number; institution: number }> = {
  '005930': { price: 72000, foreign: 1500, institution: -300 },
  '373220': { price: 360000, foreign: 2000, institution: 500 },
  '006400': { price: 250000, foreign: -1000, institution: 200 },
  '086520': { price: 85000, foreign: 300, institution: -100 },
};
const bars = [68000, 69000, 70000, 71000, 71500, 72000].map((close, index) => ({
  date: ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09'][index]!,
  open: close - 500, high: close + 500, low: close - 1000, close, volume: 100000 + index,
}));
const providers: GraphCapabilityProviderDeclaration[] = [
  { id: 'fixture-kr-quote', provides: ['market.quote@1'], tier: 'free', latency: 1, conditions: { market: 'KR' }, guarantees: { sourceAttribution: true },
    invoke: ({ nodeInput }) => { const symbol = (nodeInput as { symbol: string }).symbol; const stock = stocks[symbol];
      if (!stock) return { ok: false, outcome: 'failed', error: 'unknown_symbol' };
      return { ok: true, outcome: 'ok', result: { source: 'fixture-quote', market: 'KR', symbol, price: stock.price,
        currency: 'KRW', asOf: '2026-11-09T15:30:00+09:00' }, evidence: { source: 'fixture-quote' } }; } },
  { id: 'fixture-kr-flow', provides: ['market.kr-flow@1'], tier: 'free', latency: 1, conditions: { market: 'KR' }, guarantees: { sourceAttribution: true },
    invoke: ({ nodeInput }) => { const symbol = (nodeInput as { symbol: string }).symbol; const stock = stocks[symbol];
      if (!stock) return { ok: false, outcome: 'failed', error: 'unknown_symbol' };
      return { ok: true, outcome: 'ok', result: { source: 'fixture-flow', market: 'KR', symbol, asOf: '2026-11-09',
        foreignNetVolume: stock.foreign, institutionNetVolume: stock.institution }, evidence: { source: 'fixture-flow' } }; } },
  { id: 'fixture-kr-ohlcv', provides: ['market.ohlcv@1'], tier: 'free', latency: 1, conditions: { market: 'KR' }, guarantees: { sourceAttribution: true },
    invoke: ({ nodeInput }) => { const { symbol, from, to } = nodeInput as { symbol: string; from: string; to: string };
      if (symbol !== '471990') return { ok: false, outcome: 'failed', error: 'unknown_symbol' };
      expect([from, to]).toEqual(['2026-11-02', '2026-11-09']);
      return { ok: true, outcome: 'ok', result: { source: 'fixture', market: 'KR', symbol, bars }, evidence: { source: 'fixture' } }; } },
];
const graphDir = join(import.meta.dir, '../plugins/kr-flow-composites/graphs');
const cases = [
  { name: 'sector-flow', compose: 'sector-compose', count: 4, observed: ['"netVolume":2500', '"netVolume":1200'] },
  { name: 'battery-signal', compose: 'battery-compose', count: 6, observed: ['"weightedNetVolume":1000', '"signal":"순매수 우세 관측"'] },
  { name: 'etf-price', compose: 'etf-compose', count: 1, observed: ['"close":72000', '"oneDayPct":0.7', '"oneWeekPct":5.88'] },
] as const;

for (const { name, compose, count, observed } of cases) test(`${name} runs as a plugin graph with fixed market contracts`, async () => {
  const path = join(graphDir, `${name}.yaml`);
  const graph = parseYaml(readFileSync(path, 'utf8')) as { nodes: Array<{ node_id: string; kind: string; requires?: string }> };
  expect(graph.nodes.filter((node) => node.kind === 'capability')).toHaveLength(count);
  expect(graph.nodes.find((node) => node.node_id === compose)?.kind).toBe('agent');
  const root = mkdtempSync(join(tmpdir(), `kr-flow-${name}-`));
  try {
    const result = await runGraph(path, { input: { purpose: 'fixed-response-simulation' }, quiet: true,
      deps: { root, capabilityProviders: marketDataRegistry(providers) } });
    expect(result.status).toBe('done');
    expect(result.nodes.at(-1)?.nodeId).toBe('done');
    const output = result.nodes.find((node) => node.nodeId === compose)?.output;
    expect(output).toBeTruthy();
    expect(String(output)).toContain('정보 제공·판단 보조이며 투자 권유 아님');
    for (const field of observed) expect(String(output)).toContain(field);
    if (name !== 'etf-price') {
      expect(String(output)).toContain('"quoteSource":"fixture-quote"');
      expect(String(output)).toContain('"flowSource":"fixture-flow"');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a missing market provider stops the composition before any memo is emitted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kr-flow-missing-'));
  try {
    const result = await runGraph(join(graphDir, 'battery-signal.yaml'), {
      input: { purpose: 'fixed-response-simulation' }, quiet: true,
      deps: { root, capabilityProviders: marketDataRegistry([]) },
    });
    expect(result.status).toBe('failed');
    expect(result.nodes.some((node) => node.nodeId === 'battery-compose')).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [label, badDate] of [['duplicate', '2026-11-06'], ['invalid', '2026-11-31'], ['weekend', '2026-11-08']] as const)
  test(`ETF graph rejects a ${label} daily-bar date`, async () => {
    const root = mkdtempSync(join(tmpdir(), `kr-flow-etf-${label}-`));
    const malformed: GraphCapabilityProviderDeclaration = { ...providers[2]!, id: `fixture-kr-ohlcv-${label}`,
      invoke: () => ({ ok: true, outcome: 'ok', result: { source: 'fixture', market: 'KR', symbol: '471990',
        bars: [...bars.slice(0, 5), { ...bars[5]!, date: badDate }] }, evidence: { source: 'fixture' } }) };
    try {
      const result = await runGraph(join(graphDir, 'etf-price.yaml'), { input: { purpose: 'fixed-response-simulation' }, quiet: true,
        deps: { root, capabilityProviders: marketDataRegistry([malformed]) } });
      expect(result.status).toBe('failed');
      expect(result.nodes.find((node) => node.nodeId === 'etf-compose')?.output).toContain('etf_date');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
