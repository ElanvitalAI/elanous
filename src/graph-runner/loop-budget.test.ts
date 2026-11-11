import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lowerGraphV2 } from '../graph-v2/lower.js';
import { emptyGraphCapabilityRegistry, registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration } from './capabilities.js';
import { runGraph } from './runner.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function writeGraph(root: string, graphId: string, budget: string, nodes: string, edges: string): string {
  const dir = join(root, 'plugin', 'graphs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'recipes.yaml'), '{}\n');
  const path = join(dir, `${graphId}.yaml`);
  writeFileSync(path, [
    'apiVersion: elanous.dev/graph/v2',
    `graph: { id: ${graphId}, version: 1.0.0, layer: flow, purpose: budget-test }`,
    'entry: classify',
    `loop: { budget: { ${budget} } }`,
    'nodes:', nodes,
    'edges:', edges,
    'terminal: [done, failed]',
    '',
  ].join('\n'));
  return path;
}

const classifyNodes = [
  '  - { id: classify, type: classify }',
  '  - { id: classify-again, type: classify }',
  '  - { id: done, type: gate }',
  '  - { id: failed, type: observe }',
].join('\n');

test('graph v2 lowerer preserves supported daily-run and provider-call budgets', () => {
  const source = [
    'apiVersion: elanous.dev/graph/v2',
    'graph: { id: budget-lower, version: 1.0.0, layer: flow, purpose: budget test }',
    'entry: classify',
    'loop: { budget: { runs_per_day: 2, llm_calls: 3 } }',
    'nodes: [{ id: classify, type: classify }, { id: done, type: gate }, { id: failed, type: observe }]',
    'edges: [{ from: classify, to: done }]',
    'terminal: [done, failed]',
  ].join('\n');
  const lowered = lowerGraphV2(source);
  expect(lowered.errors).toEqual([]);
  expect(lowered.template?.loop?.budget).toEqual({ runs_per_day: 2, llm_calls: 3 });
  expect(lowerGraphV2(source.replace('llm_calls: 3', 'llm_calls: 0')).errors).toContainEqual(expect.objectContaining({
    path: '<graph-v2>/loop/budget/llm_calls',
  }));
});

test('runGraph counts provider invocations across nodes and refuses the call beyond llm_calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-loop-budget-llm-'));
  roots.push(root);
  const graph = writeGraph(root, 'budget-llm', 'llm_calls: 1', classifyNodes,
    ['  - { from: classify, to: classify-again }',
      '  - { from: classify-again, on: outcome, map: { ok: done, fail: failed } }'].join('\n'));
  let providerCalls = 0;
  const state = await runGraph(graph, { runId: 'llm-budget-run', input: {
    arguments: 'classify this', classify: { input: '$ARGUMENTS', classes: ['ok'] },
  }, deps: { root, callLLM: async () => { providerCalls++; return 'ok'; } } });
  expect(providerCalls).toBe(1);
  expect(state.status).toBe('failed');
  expect(state.nodes.find((node) => node.nodeId === 'classify-again')?.error).toContain('loop budget llm_calls exceeded');
});

test('runGraph counts failed starts against the KST daily run limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-loop-budget-runs-'));
  roots.push(root);
  const graph = writeGraph(root, 'budget-runs', 'runs_per_day: 1',
    ['  - { id: classify, type: classify }', '  - { id: done, type: gate }', '  - { id: failed, type: observe }'].join('\n'),
    '  - { from: classify, on: outcome, map: { ok: done, fail: failed } }');
  writeFileSync(graph, readFileSync(graph, 'utf8').replace(
    'loop: { budget: { runs_per_day: 1 } }',
    'loop: { ext: { absorb.budget: { runs_per_day: 1 } } }',
  ));
  const first = await runGraph(graph, { runId: 'failed-first-run', input: {
    arguments: 'classify this', classify: { input: '$ARGUMENTS', classes: ['ok'] },
  }, deps: { root, callLLM: async () => { throw new Error('provider failed'); } } });
  expect(first.status).toBe('failed');
  const ledger = JSON.parse(readFileSync(join(root, 'graph-runs', '.loop-budget-ledger.json'), 'utf8')) as {
    runsPerDay: Record<string, Record<string, string[]>>;
  };
  const kst = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(first.startedAt!)).map((part) => [part.type, part.value]));
  expect(ledger.runsPerDay['budget-runs']?.[`${kst.year}-${kst.month}-${kst.day}`]).toEqual(['failed-first-run']);
  await expect(runGraph(graph, { runId: 'second-run', input: {
    arguments: 'classify this', classify: { input: '$ARGUMENTS', classes: ['ok'] },
  }, deps: { root, callLLM: async () => 'ok' } })).rejects.toThrow('loop budget runs_per_day exceeded');
  rmSync(join(root, 'graph-runs', '.loop-budget-ledger.json'));
  await expect(runGraph(graph, { runId: 'after-ledger-loss', input: {
    arguments: 'classify this', classify: { input: '$ARGUMENTS', classes: ['ok'] },
  }, deps: { root, callLLM: async () => 'ok' } })).rejects.toThrow('graph loop budget ledger missing after initialization');
});

test('runGraph serializes simultaneous starts against the daily run limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-loop-budget-concurrent-'));
  roots.push(root);
  const graph = writeGraph(root, 'constructor', 'runs_per_day: 1',
    ['  - { id: classify, type: classify }', '  - { id: done, type: gate }', '  - { id: failed, type: observe }'].join('\n'),
    '  - { from: classify, to: done }');
  const input = { arguments: 'classify this', classify: { input: '$ARGUMENTS', classes: ['ok'] } };
  const results = await Promise.allSettled([
    runGraph(graph, { runId: 'concurrent-run-a', input, skipDailyRunBudget: true,
      deps: { root, callLLM: async () => 'ok' } } as unknown as NonNullable<Parameters<typeof runGraph>[1]>),
    runGraph(graph, { runId: 'concurrent-run-b', input, deps: { root, callLLM: async () => 'ok' } }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  const rejected = results.find((result) => result.status === 'rejected');
  expect(rejected?.status === 'rejected' ? String(rejected.reason) : '').toContain('loop budget runs_per_day exceeded');
});

test('runGraph fails closed on a corrupt loop budget ledger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-loop-budget-corrupt-'));
  roots.push(root);
  const graph = writeGraph(root, 'budget-corrupt', 'runs_per_day: 1', classifyNodes,
    '  - { from: classify, to: done }');
  const ledgerPath = join(root, 'graph-runs', '.loop-budget-ledger.json');
  mkdirSync(join(root, 'graph-runs'), { recursive: true });
  writeFileSync(ledgerPath, '{invalid-json');
  await expect(runGraph(graph, { runId: 'corrupt-ledger-run', input: {
    arguments: 'classify this', classify: { input: '$ARGUMENTS', classes: ['ok'] },
  }, deps: { root, callLLM: async () => 'ok' } })).rejects.toThrow('graph loop budget ledger is unreadable');
});

const graphV2CapabilityRuntimePresent = existsSync(join(import.meta.dir, 'capabilities.ts'));
const graphV2FanoutTest = graphV2CapabilityRuntimePresent ? test : test.skip;
graphV2FanoutTest('runGraph counts a static-map fan-out as one parent daily start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-loop-budget-map-'));
  roots.push(root);
  const graph = join(root, 'brief.yaml');
  writeFileSync(graph, [
    'apiVersion: elanous.dev/graph/v2',
    'graph: { id: budget-map, version: 1.0.0, layer: flow, purpose: map budget test }',
    'loop: { budget: { runs_per_day: 1 } }',
    'entry: collect',
    'nodes:',
    '  - { id: collect, type: store, requires: scrap.items@1, with: { op: list, collection: scraps } }',
    "  - id: extract\n    type: extract\n    requires: extract.url@1\n    map: { over: '$collect.result.items', as: scrap, max_parallel: 2 }",
    'edges:',
    '  - { from: collect, to: extract }',
    '  - { from: extract, on: outcome, map: { ok: done, fail: failed } }',
    'terminal: [done, failed]',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  let providers = registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'scrap.items@1', input: { type: 'object' },
    output: { type: 'object', required: ['items'], properties: { items: { type: 'array' } } },
  });
  providers = registerGraphCapabilityContract(providers, {
    id: 'extract.url@1', input: { type: 'object' },
    output: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  });
  providers = registerGraphCapabilityProviderDeclaration(providers, {
    id: 'test-store', provides: ['scrap.items@1'], tier: 'free',
    invoke: async () => ({ ok: true, outcome: 'done', result: { items: [{ id: 'a' }, { id: 'b' }] } }),
  });
  providers = registerGraphCapabilityProviderDeclaration(providers, {
    id: 'test-extract', provides: ['extract.url@1'], tier: 'free',
    invoke: async (context: { nodeInput?: unknown }) => {
      const scrap = (context.nodeInput as { scrap?: { id: string } }).scrap;
      if (!scrap) throw new Error('static map did not bind scrap');
      return { ok: true, outcome: 'done', result: { id: scrap.id } };
    },
  });
  const runId = 'daily-map-parent';
  const options = ({ runId, quiet: true, deps: { root, capabilityProviders: providers } } as unknown as NonNullable<Parameters<typeof runGraph>[1]>);
  const state = await runGraph(graph, options);
  expect(state.status).toBe('done');
  const ledger = JSON.parse(readFileSync(join(root, 'graph-runs', '.loop-budget-ledger.json'), 'utf8')) as {
    runsPerDay: Record<string, Record<string, string[]>>;
  };
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(state.startedAt!)).map((part) => [part.type, part.value]));
  expect(ledger.runsPerDay['budget-map']?.[`${parts.year}-${parts.month}-${parts.day}`]).toEqual([runId]);
});
