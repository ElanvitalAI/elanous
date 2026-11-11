import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration } from '../../capabilities.js';
import type { GraphCapabilityProviderDeclaration } from '../../capabilities.js';
import { runGraph } from '../../runner.js';
import { lowerGraphV2 } from '../../../graph-v2/lower.js';
import { createKisDeclarations } from './kis.js';
import { marketDataRegistry } from './registry.js';
import type { StockFetch } from './stock-common.js';

export const ARG_STOCK_DISCLAIMER = '정보 제공·판단 보조이며 투자 권유 아님';
export const ARG_STOCK_FIXTURE_DATE = '2026-11-09';

const stocks = [
  { symbol: '005930', name: '삼성전자', quote: 72000, open: 71000, high: 73000, low: 70000,
    volume: 125000, foreign: 1500, institution: -300 },
  { symbol: '000660', name: 'SK하이닉스', quote: 180000, open: 182000, high: 184000, low: 178000,
    volume: 86000, foreign: -900, institution: 400 },
] as const;

export interface ArgStockMemo {
  readonly date: string;
  readonly title: string;
  readonly observations: readonly string[];
  readonly judgment: string;
  readonly limits: string;
  readonly disclaimer: string;
}

export interface ArgStockSimulation {
  readonly status: string;
  readonly runId: string;
  readonly executedNodes: readonly string[];
  readonly providerCalls: Readonly<Record<string, number>>;
  readonly registeredProviderIds: readonly string[];
  readonly selectedSources: Readonly<Record<string, string>>;
  readonly memo: ArgStockMemo;
  readonly loweredGraph: {
    readonly graphId: string;
    readonly nodeKinds: readonly { readonly nodeId: string; readonly kind: string; readonly requires?: string }[];
  };
}

function graphYaml(): string {
  const nodeLines = stocks.flatMap(({ symbol }, index) => {
    const suffix = index + 1;
    return [
      `  - id: quote${suffix}\n    type: market-data\n    requires: market.quote@1\n    with: { market: KR, symbol: '${symbol}' }`,
      `  - id: ohlcv${suffix}\n    type: market-data\n    requires: market.ohlcv@1\n    with: { market: KR, symbol: '${symbol}', from: '${ARG_STOCK_FIXTURE_DATE}', to: '${ARG_STOCK_FIXTURE_DATE}' }`,
      `  - id: flow${suffix}\n    type: market-data\n    requires: market.kr-flow@1\n    with: { market: KR, symbol: '${symbol}' }`,
    ];
  });
  const ordered = ['quote1', 'ohlcv1', 'flow1', 'quote2', 'ohlcv2', 'flow2', 'memo'];
  const edges = ordered.map((node, index) =>
    `  - { from: ${node}, on: outcome, map: { ok: ${ordered[index + 1] ?? 'done'}, failed: failed } }`);
  return `apiVersion: elanous.dev/graph/v2
graph: { id: arg-stock-1121-sim, version: 1.0.0, layer: flow, purpose: 'fixed-response Korean stock ARG simulation' }
entry: quote1
nodes:
${nodeLines.join('\n')}
  - id: memo
    type: llm-judge
    requires: arg.stock-memo@1
    with: { date: '${ARG_STOCK_FIXTURE_DATE}' }
  - { id: done, type: gate }
  - { id: failed, type: gate }
edges:
${edges.join('\n')}
terminal: [done, failed]
`;
}

function resultOf(outputs: Record<string, unknown>, nodeId: string): Record<string, unknown> {
  const envelope = outputs[nodeId];
  if (!envelope || typeof envelope !== 'object' || (envelope as { outcome?: unknown }).outcome !== 'ok')
    throw new Error(`missing_${nodeId}`);
  const result = (envelope as { result?: unknown }).result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`invalid_${nodeId}`);
  return result as Record<string, unknown>;
}

function composeMemo(outputs: Record<string, unknown>): ArgStockMemo {
  const observations = stocks.map((stock, index) => {
    const suffix = index + 1;
    const quote = resultOf(outputs, `quote${suffix}`);
    const ohlcv = resultOf(outputs, `ohlcv${suffix}`);
    const flow = resultOf(outputs, `flow${suffix}`);
    const bars = ohlcv.bars;
    if (quote.symbol !== stock.symbol || ohlcv.symbol !== stock.symbol || flow.symbol !== stock.symbol ||
      !Array.isArray(bars) || bars.length !== 1 || bars[0]?.date !== ARG_STOCK_FIXTURE_DATE ||
      flow.asOf !== ARG_STOCK_FIXTURE_DATE || quote.price !== bars[0]?.close)
      throw new Error(`inconsistent_${stock.symbol}`);
    const change = ((Number(bars[0].close) / Number(bars[0].open)) - 1) * 100;
    const signed = (value: number) => `${value > 0 ? '+' : ''}${value.toLocaleString('ko-KR')}`;
    return `${stock.name}(${stock.symbol}): 종가 ${Number(quote.price).toLocaleString('ko-KR')}원, 시가 대비 ${signed(Number(change.toFixed(2)))}%, 외국인 순매수량 ${signed(Number(flow.foreignNetVolume))}주, 기관 순매수량 ${signed(Number(flow.institutionNetVolume))}주.`;
  });
  return { date: ARG_STOCK_FIXTURE_DATE, title: 'ARG 투자 판단 그래프 · 하루치 관측 메모', observations,
    judgment: '삼성전자는 당일 가격 상승과 외국인 순매수가 함께 관측됐다. SK하이닉스는 당일 가격 하락과 외국인 순매도, 기관 순매수가 섞였다. 추가 기간과 기업 실적 자료를 확인하기 전까지 매매 결론을 보류한다.',
    limits: '모든 가격·수급 수치는 고정 응답 픽스처다. 하루치 관측만으로 추세, 적정가치, 향후 수익률을 판단할 수 없다.',
    disclaimer: ARG_STOCK_DISCLAIMER };
}

/** Execute the full graph using synthetic KIS responses or injected fixed provider declarations. */
export async function runArgStockSimulation(options: {
  readonly providers?: readonly GraphCapabilityProviderDeclaration[];
  readonly providerCalls?: Record<string, number>;
} = {}): Promise<ArgStockSimulation> {
  const root = mkdtempSync(join(tmpdir(), 'arg-stock-1121-'));
  const providerCalls: Record<string, number> = options.providerCalls ?? { token: 0, quote: 0, ohlcv: 0, flow: 0 };
  try {
    const fetcher: StockFetch = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/tokenP')) {
        providerCalls.token++;
        return { ok: true, json: async () => ({ access_token: 'fixture-token', expires_in: 3600 }) };
      }
      const stock = stocks.find((item) => item.symbol === parsed.searchParams.get('FID_INPUT_ISCD'));
      if (!stock) throw new Error('unexpected_fixture_symbol');
      if (parsed.pathname.endsWith('/inquire-price')) {
        providerCalls.quote++;
        return { ok: true, json: async () => ({ rt_cd: '0', output: { stck_prpr: String(stock.quote) } }) };
      }
      if (parsed.pathname.endsWith('/inquire-daily-itemchartprice')) {
        providerCalls.ohlcv++;
        return { ok: true, json: async () => ({ rt_cd: '0', output2: [{ stck_bsop_date: '20261109',
          stck_oprc: String(stock.open), stck_hgpr: String(stock.high), stck_lwpr: String(stock.low),
          stck_clpr: String(stock.quote), acml_vol: String(stock.volume) }] }) };
      }
      if (parsed.pathname.endsWith('/inquire-investor')) {
        providerCalls.flow++;
        return { ok: true, json: async () => ({ rt_cd: '0', output: [{ stck_bsop_date: '20261109',
          frgn_ntby_qty: String(stock.foreign), orgn_ntby_qty: String(stock.institution) }] }) };
      }
      throw new Error('unexpected_fixture_endpoint');
    };
    const providers = options.providers ?? createKisDeclarations({ fetcher, appKey: 'fixture-app', appSecret: 'fixture-secret',
      now: () => new Date('2026-11-09T08:00:00Z') });
    let registry = marketDataRegistry(providers);
    registry = registerGraphCapabilityContract(registry, { id: 'arg.stock-memo@1',
      input: { type: 'object', required: ['date'], properties: { date: { type: 'string' } } },
      output: { type: 'object', required: ['date', 'title', 'observations', 'judgment', 'limits', 'disclaimer'],
        properties: { date: { type: 'string' }, observations: { type: 'array', items: { type: 'string' } },
          disclaimer: { type: 'string' } } }, guarantees: { sourceAttribution: true } });
    const memoProvider: GraphCapabilityProviderDeclaration = { id: 'arg-stock-memo-fixture',
      provides: ['arg.stock-memo@1'], tier: 'free', latency: 1, guarantees: { sourceAttribution: true },
      invoke: ({ outputs }) => ({ ok: true, outcome: 'ok', result: composeMemo(outputs), evidence: { source: 'fixture' } }) };
    registry = registerGraphCapabilityProviderDeclaration(registry, memoProvider);
    const graphPath = join(root, 'graph.yaml');
    const graphSource = graphYaml();
    const lowered = lowerGraphV2(graphSource, { label: 'arg-stock-1121-sim' });
    if (!lowered.template || lowered.errors.length)
      throw new Error(`graph_lowering_failed:${lowered.errors.map((issue) => `${issue.path}:${issue.message}`).join('|')}`);
    writeFileSync(graphPath, graphSource);
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    const run = await runGraph(graphPath, { input: { purpose: 'simulation', date: ARG_STOCK_FIXTURE_DATE }, quiet: true,
      deps: { root: join(root, 'state'), capabilityProviders: registry } });
    if (run.status !== 'done') throw new Error(`graph_${run.status}:${JSON.stringify(run.nodes.map((node) => ({ id: node.nodeId, output: node.output })))}`);
    const memoNode = run.nodes.find((node) => node.nodeId === 'memo');
    if (!memoNode?.output) throw new Error('memo_missing');
    const memo = (JSON.parse(String(memoNode.output)) as { result: ArgStockMemo }).result;
    if (memo.disclaimer !== ARG_STOCK_DISCLAIMER) throw new Error('disclaimer_missing');
    const selectedSources: Record<string, string> = {};
    for (const node of run.nodes) {
      if (!/^(quote|ohlcv|flow)[12]$/.test(node.nodeId) || !node.output) continue;
      const parsed = JSON.parse(String(node.output)) as { result?: { source?: unknown } };
      if (typeof parsed.result?.source !== 'string') throw new Error(`missing_source_${node.nodeId}`);
      selectedSources[node.nodeId] = parsed.result.source;
    }
    return { status: run.status, runId: run.runId, executedNodes: run.nodes.map((node) => node.nodeId),
      providerCalls, registeredProviderIds: providers.map((provider) => provider.id), selectedSources, memo,
      loweredGraph: { graphId: lowered.template.graphId,
        nodeKinds: lowered.template.nodes.map(({ nodeId, kind, requires }) => ({ nodeId, kind, ...(requires ? { requires } : {}) })) } };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) console.log(JSON.stringify(await runArgStockSimulation(), null, 2));
