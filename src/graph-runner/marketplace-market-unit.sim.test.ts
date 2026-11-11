import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadGraphPluginFromDir } from './graph-manifest-loader.js';
import { runGraph } from './runner.js';
import {
  emptyGraphCapabilityRegistry,
  registerGraphCapabilityContract,
  registerGraphCapabilityProviderDeclaration,
} from './capabilities.js';
import { resolveGraphUnit } from '../self-implement/graph-unit-resolver.js';
import { marketDataContracts } from './capability-providers/market-data/registry.js';

const pluginRoot = resolve(import.meta.dir, '../../plugins/marketplace-market-data');
// Source: graph-unit-resolver parses marketplace unit files using the repository's integer version contract.
const MARKET_GRAPH_VERSION = 1;
// Source: the packaged unit executes one capability node and its selected success terminal.
const MARKET_UNIT_STEP_BUDGET = 2;
// Source: simulation caller and unit nodes each execute at most once.
const MARKET_NODE_VISITS = 1;
const stateRoots: string[] = [];
afterEach(() => { for (const root of stateRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('SIM-GRAPH-COMPOSE-C5-MARKET: marketplace manifest discovers and runs its market unit', async () => {
  const loaded = loadGraphPluginFromDir(pluginRoot);
  expect(Object.keys(loaded.graphs)).toEqual(['market-quote', 'market-ohlcv']);
  const declaration = loaded.graphs['market-quote'];
  expect(declaration?.template.unit).toMatchObject({ inputs: ['ask'], outputs: ['result', 'evidence'], exits: ['done', 'rework', 'needs-human', 'failed'] });
  expect(declaration?.manifest).toMatchObject({ graphId: 'market-quote', allow: { recipes: [], maxSideEffects: 'none' }, hitl: [] });

  const marketUnit = loaded.graphs['market-ohlcv'];
  expect(marketUnit?.template.unit).toMatchObject({ inputs: ['market', 'symbol', 'from', 'to'],
    outputs: ['result', 'evidence'], exits: ['done', 'rework', 'needs-human', 'failed'] });
  expect(marketUnit?.manifest).toMatchObject({ graphId: 'market-ohlcv', allow: { recipes: [], maxSideEffects: 'none' }, hitl: [] });
  const callerPath = join(pluginRoot, 'graphs', 'marketplace-caller.yaml');
  const unit = resolveGraphUnit('market-ohlcv@^1', callerPath);
  expect(unit.path).toBe(join(pluginRoot, 'graphs', 'units', 'market-ohlcv.yaml'));
  expect(unit.template.unit).toEqual(marketUnit?.template.unit);

  const contract = marketDataContracts.find(item => item.id === 'market.ohlcv@1');
  expect(contract).toBeDefined();
  const stateRoot = mkdtempSync(join(tmpdir(), 'graph-compose-c5-market-'));
  stateRoots.push(stateRoot);
  const graphRoot = join(stateRoot, 'graphs');
  const unitsRoot = join(graphRoot, 'units');
  mkdirSync(unitsRoot, { recursive: true });
  writeFileSync(join(unitsRoot, 'market-quote.yaml'), readFileSync(join(pluginRoot, 'graphs/units/market-quote.yaml'), 'utf8'));
  writeFileSync(join(unitsRoot, 'market-ohlcv.yaml'), readFileSync(unit.path, 'utf8'));
  writeFileSync(join(unitsRoot, 'recipes.yaml'), readFileSync(join(pluginRoot, 'graphs/units/recipes.yaml'), 'utf8'));
  writeFileSync(join(graphRoot, 'recipes.yaml'), '{}\n');
  const parentPath = join(graphRoot, 'parent.yaml');
  writeFileSync(parentPath, `graph_id: marketplace-market-caller
version: ${MARKET_GRAPH_VERSION}
entry_node: invoke
terminal_nodes: [done, failed]
nodes:
  - node_id: invoke
    kind: subgraph
    recipe: none
    max_visits: ${MARKET_NODE_VISITS}
    call: market-ohlcv@^1
    budget: { inner_steps: ${MARKET_UNIT_STEP_BUDGET} }
    contract: { inputs: [market, symbol, from, to], tools: none, outputs: [result, evidence] }
  - { node_id: done, kind: gate, recipe: none, max_visits: ${MARKET_NODE_VISITS} }
  - { node_id: failed, kind: gate, recipe: none, max_visits: ${MARKET_NODE_VISITS} }
edges:
  - { from: invoke, on: outcome, map: { done: done, rework: failed, needs-human: failed, failed: failed } }
`);
  const input = { market: 'US', symbol: 'SIM', from: '2026-11-09', to: '2026-11-09' };
  for (const outcome of ['ok', 'rework', 'needs-human', 'failed'] as const) {
    let observedCapabilityInput: unknown;
    const providers = registerGraphCapabilityProviderDeclaration(
      registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), contract!),
      { id: 'fixture-market', provides: ['market.ohlcv@1'], tier: 'free', guarantees: { sourceAttribution: true },
        invoke: context => {
          observedCapabilityInput = context.input;
          return outcome === 'failed'
            ? { ok: false, outcome, error: 'fixture market failure' }
            : { ok: true, outcome, result: { source: 'fixture-market', market: 'US', symbol: 'SIM',
              bars: [{ date: '2026-11-09', open: 41, high: 43, low: 40, close: 42, volume: 1234 }] },
            evidence: { source: 'marketplace-unit-sim' } };
        } },
    );
    const state = await runGraph(parentPath, { input, quiet: true,
      deps: { root: join(stateRoot, outcome), capabilityProviders: providers } });
    expect(observedCapabilityInput).toMatchObject(input);
    expect(state.unitCalls?.[0]?.unit).toBe('market-ohlcv');
    expect(state.unitCalls?.[0]?.exit).toBe(outcome === 'ok' ? 'done' : outcome);
    if (outcome === 'ok') {
      expect(state.status).toBe('done');
      expect(JSON.parse(String(state.nodes.find(node => node.nodeId === 'invoke')?.output))).toMatchObject({
        outcome: 'done', result: { source: 'fixture-market', market: 'US', symbol: 'SIM',
          bars: [{ date: '2026-11-09', open: 41, high: 43, low: 40, close: 42, volume: 1234 }] },
        evidence: { source: 'marketplace-unit-sim' },
      });
    } else {
      expect(state.status).toBe('failed');
    }
  }
});
