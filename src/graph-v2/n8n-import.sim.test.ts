import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from '../graph-runner/runner.js';
import {
  emptyGraphCapabilityRegistry,
  registerGraphCapabilityContract,
  registerGraphCapabilityProviderDeclaration,
} from '../graph-runner/capabilities.js';
import { lowerGraphV2 } from './lower.js';
import { importN8nExecuteWorkflow } from './n8n-import.js';

const MARKET_UNIT_BUDGET = 2; // Source: packaged market-quote unit has one capability step and one terminal step.
const MARKET_UNIT_TARGET = {
  call: 'market-quote@^1', budget: MARKET_UNIT_BUDGET,
  exits: ['done', 'rework', 'needs-human', 'failed'],
} as const;
const packageUnitDirectory = join(import.meta.dir, '../../plugins/marketplace-market-data/graphs/units');

function fakeMarketProvider(outcome: 'ok' | 'rework' | 'needs-human' | 'failed' = 'ok') {
  const contract = {
    id: 'market.ohlcv@1' as const,
    input: { type: 'object' },
    output: { type: 'object', required: ['quote'], properties: { quote: { type: 'string' } } },
  };
  return registerGraphCapabilityProviderDeclaration(
    registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), contract),
    { id: 'fixture-market', provides: ['market.ohlcv@1'], tier: 'free',
      invoke: () => outcome === 'failed' ? ({ ok: false, outcome, error: 'fixture market unavailable' })
        : ({ ok: true, outcome, result: { quote: '42.00' }, evidence: { source: 'simulated-market' } }) },
  );
}

function createIsolatedCaller(graphSource: string, graphName: string) {
  const root = mkdtempSync(join(tmpdir(), `graph-compose-c5-${graphName}-`));
  const unitDirectory = join(root, 'units');
  mkdirSync(unitDirectory);
  writeFileSync(join(unitDirectory, 'market-quote.yaml'), readFileSync(join(packageUnitDirectory, 'market-quote.yaml'), 'utf8'));
  writeFileSync(join(unitDirectory, 'recipes.yaml'), readFileSync(join(packageUnitDirectory, 'recipes.yaml'), 'utf8'));
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  const graphPath = join(root, 'parent.yaml');
  writeFileSync(graphPath, graphSource);
  return { root, graphPath };
}

test('SIM-GRAPH-COMPOSE-C5: two n8n Execute Workflow samples lower and run through the marketplace unit', async () => {
  const cases = [
    { fixture: 'execute-workflow-default.json', graph: 'n8n-default-envelope', contract: { inputs: ['ask'], outputs: ['result', 'evidence'] } },
    { fixture: 'execute-workflow-explicit-contract.json', graph: 'n8n-explicit-envelope', contract: { inputs: ['ask'], outputs: ['result', 'evidence'] } },
  ] as const;
  for (const sample of cases) {
    const json = readFileSync(join(import.meta.dir, `../../plugins/marketplace-market-data/sims/n8n/${sample.fixture}`), 'utf8');
    const imported = importN8nExecuteWorkflow(json, { units: { 'market-quote': MARKET_UNIT_TARGET } });
    const lowered = lowerGraphV2(imported, { label: sample.fixture });
    expect(lowered.errors, sample.fixture).toEqual([]);
    expect(lowered.template?.nodes.find((node) => node.nodeId === 'execute-market-quote')?.contract)
      .toMatchObject(sample.contract);
    expect(lowered.template?.nodes.find((node) => node.nodeId === 'execute-market-quote')?.call).toBe('market-quote@^1');

    const { root, graphPath } = createIsolatedCaller(imported, sample.graph);
    try {
      const state = await runGraph(graphPath, { graphSource: imported, input: { ask: { symbol: 'SIM' } }, quiet: true,
        deps: { root: join(root, 'state'), capabilityProviders: fakeMarketProvider() } });
      expect(state.status, sample.fixture).toBe('done');
      expect(state.path).toContain('execute-market-quote');
      const call = state.nodes.find((node) => node.nodeId === 'execute-market-quote');
      expect(JSON.parse(String(call?.output))).toMatchObject({ outcome: 'done',
        result: { quote: '42.00' }, evidence: { source: 'simulated-market' } });
      expect(state.unitCalls?.at(-1)).toMatchObject({ unit: 'market-quote', exit: 'done' });
      expect(lowered.template?.edges.find((edge) => edge.from === 'execute-market-quote')?.map)
        .toEqual({ done: 'done', rework: 'failed', 'needs-human': 'failed', failed: 'failed' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('SIM-GRAPH-COMPOSE-C5: failed Execute Workflow units terminate on the failed branch', async () => {
  const source = readFileSync(join(import.meta.dir, '../../plugins/marketplace-market-data/sims/n8n/execute-workflow-default.json'), 'utf8');
  const imported = importN8nExecuteWorkflow(source, { units: { 'market-quote': MARKET_UNIT_TARGET } });
  const { root, graphPath } = createIsolatedCaller(imported, 'failure');
  try {
    const state = await runGraph(graphPath, { graphSource: imported, input: { ask: { symbol: 'SIM' } }, quiet: true,
      deps: { root: join(root, 'state'), capabilityProviders: fakeMarketProvider('failed') } });
    expect(state.status).toBe('failed');
    expect(state.unitCalls?.at(-1)).toMatchObject({ unit: 'market-quote', exit: 'failed' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('SIM-GRAPH-COMPOSE-C5: rework and needs-human unit exits stay named and never route to success', async () => {
  const source = readFileSync(join(import.meta.dir, '../../plugins/marketplace-market-data/sims/n8n/execute-workflow-default.json'), 'utf8');
  const imported = importN8nExecuteWorkflow(source, { units: { 'market-quote': MARKET_UNIT_TARGET } });
  for (const outcome of ['rework', 'needs-human'] as const) {
    const { root, graphPath } = createIsolatedCaller(imported, outcome);
    try {
      const state = await runGraph(graphPath, { graphSource: imported, input: { ask: { symbol: 'SIM' } }, quiet: true,
        deps: { root: join(root, 'state'), capabilityProviders: fakeMarketProvider(outcome) } });
      expect(state.status).toBe('failed');
      expect(state.unitCalls?.at(-1)).toMatchObject({ unit: 'market-quote', exit: outcome });
      const call = state.nodes.find((node) => node.nodeId === 'execute-market-quote');
      expect(JSON.parse(String(call?.output))).toMatchObject({ outcome,
        result: { quote: '42.00' }, evidence: { source: 'simulated-market' } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('SIM-GRAPH-COMPOSE-C5: reject Code nodes and Execute Workflow references without an installed unit', () => {
  const source = readFileSync(join(import.meta.dir, '../../plugins/marketplace-market-data/sims/n8n/execute-workflow-default.json'), 'utf8');
  expect(() => importN8nExecuteWorkflow(source.replace('n8n-nodes-base.executeWorkflow', 'n8n-nodes-base.code'),
    { units: { 'market-quote': MARKET_UNIT_TARGET } })).toThrow('unsupported n8n node type');
  expect(() => importN8nExecuteWorkflow(source, { units: {} })).toThrow('not an installed unit');
  expect(() => importN8nExecuteWorkflow(source.replace('"connections": {}', '"connections": {"Execute market quote": {"main": []}}'),
    { units: { 'market-quote': MARKET_UNIT_TARGET } })).toThrow('does not support workflow connections');
  expect(() => importN8nExecuteWorkflow(source.replace('"workflowId": "market-quote"',
    '"workflowId": "market-quote", "workflowInputs": {"mappingMode": "defineBelow"}'),
    { units: { 'market-quote': MARKET_UNIT_TARGET } })).toThrow('unsupported Execute Workflow parameters');
  expect(() => importN8nExecuteWorkflow(source.replace('"workflowId": "market-quote"',
    '"workflowId": "={{ $json.target }}"'),
    { units: { 'market-quote': MARKET_UNIT_TARGET } })).toThrow('expressions are unsupported');
  expect(() => importN8nExecuteWorkflow(source.replace('"parameters": { "workflowId": "market-quote" }',
    '"parameters": { "workflowId": "market-quote", "contract": { "inputs": ["ask"], "outputs": "result" } }'),
    { units: { 'market-quote': MARKET_UNIT_TARGET } })).toThrow('safe field names');
  const explicit = readFileSync(join(import.meta.dir, '../../plugins/marketplace-market-data/sims/n8n/execute-workflow-explicit-contract.json'), 'utf8');
  expect(() => importN8nExecuteWorkflow(explicit.replace('"ask"', '"={{ $json.secret }}"'),
    { units: { 'market-quote': MARKET_UNIT_TARGET } })).toThrow('safe field names');
  expect(() => importN8nExecuteWorkflow(explicit.replace('"ask"', '" "'),
    { units: { 'market-quote': MARKET_UNIT_TARGET } })).toThrow('safe field names');
  expect(() => importN8nExecuteWorkflow(source.replace('"name": "Execute market quote",',
    '"name": "Execute market quote", "credentials": { "market": { "id": "secret-ref", "name": "fixture" } },'),
    { units: { 'market-quote': MARKET_UNIT_TARGET } })).toThrow('including credentials/options');
  for (const reservedId of ['done', 'failed'] as const) {
    expect(() => importN8nExecuteWorkflow(source.replace('"id": "execute-market-quote"', `"id": "${reservedId}"`),
      { units: { 'market-quote': MARKET_UNIT_TARGET } })).toThrow('node id is reserved by graph terminals');
  }
  expect(() => importN8nExecuteWorkflow(source.replace('"typeVersion": 1', '"typeVersion": 2'),
    { units: { 'market-quote': MARKET_UNIT_TARGET } })).toThrow('unsupported Execute Workflow typeVersion');
});
