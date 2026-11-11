import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from './runner.js';
import {
  dispatchGraphContract,
  emptyGraphCapabilityRegistry,
  registerGraphCapabilityContract,
  registerGraphCapabilityProviderDeclaration,
  STORE_EVENTS_CONTRACT,
  type GraphCapabilityContract,
} from './capabilities.js';

const contract: GraphCapabilityContract = {
  id: 'extract.url@1',
  input: { type: 'object', required: ['urls'], properties: { urls: { type: 'array', items: { type: 'string' } } } },
  output: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
  guarantees: {
    sourceAttribution: true,
    // Source: 내부 문서 `RFC-adaptive-graph-ops-2026-10-09` §3 — fixture ceiling admits both declared provider latencies during tier selection.
    maxLatencyMs: 40,
  },
};

test('contract registry selects the best eligible tier and validates provider output', async () => {
  let selected = '';
  const base = registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), contract);
  const registry = registerGraphCapabilityProviderDeclaration(
    registerGraphCapabilityProviderDeclaration(base, {
      id: 'paid-provider', provides: ['extract.url@1'], tier: 'paid', latency: 10,
      invoke: () => { selected = 'paid'; return { ok: true, outcome: 'ok', result: { text: 'paid' } }; },
    }), {
      id: 'free-provider', provides: ['extract.url@1'], tier: 'free', latency: 30,
      guarantees: { sourceAttribution: true },
      invoke: () => { selected = 'free'; return { ok: true, outcome: 'ok', result: { text: 'free' }, evidence: { source: 'fixture' } }; },
    });
  const result = await dispatchGraphContract('extract.url@1', {
    graphId: 'contract-sim', runId: 'run', nodeId: 'extract', input: { urls: ['https://example.test'] }, outputs: {},
  }, registry);
  expect(selected).toBe('free');
  expect(result).toMatchObject({ ok: true, outcome: 'ok', result: { text: 'free' }, evidence: { source: 'fixture' } });
});

test('contract registry retries the next eligible provider after a named failure', async () => {
  const calls: string[] = [];
  let registry = registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), contract);
  registry = registerGraphCapabilityProviderDeclaration(registry, {
    id: 'free-empty', provides: ['extract.url@1'], tier: 'free', latency: 1, guarantees: { sourceAttribution: true },
    invoke: () => { calls.push('free'); return { ok: false, outcome: 'failed', error: 'empty' }; },
  });
  registry = registerGraphCapabilityProviderDeclaration(registry, {
    id: 'byok-filled', provides: ['extract.url@1'], tier: 'byok', latency: 1, guarantees: { sourceAttribution: true },
    invoke: () => { calls.push('byok'); return { ok: true, outcome: 'ok', result: { text: 'filled' }, evidence: { source: 'fixture' } }; },
  });
  const output = await dispatchGraphContract('extract.url@1', {
    graphId: 'contract-sim', runId: 'run', nodeId: 'extract', input: { urls: ['https://example.test'] }, outputs: {},
  }, registry);
  expect(output).toMatchObject({ ok: true, result: { text: 'filled' } });
  expect(calls).toEqual(['free', 'byok']);
});

test('contract provider receives the validated node request and original graph input separately', async () => {
  let seen: { input?: unknown; graphInput?: unknown } = {};
  const registry = registerGraphCapabilityProviderDeclaration(
    registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), contract),
    { id: 'context-provider', provides: ['extract.url@1'], tier: 'free', latency: 1,
      guarantees: { sourceAttribution: true },
      invoke: ({ input, graphInput }) => {
        seen = { input, graphInput };
        return { ok: true, outcome: 'ok', result: { text: 'ok' }, evidence: { source: 'fixture' } };
      } },
  );
  const result = await dispatchGraphContract('extract.url@1', {
    graphId: 'contract-sim', runId: 'run', nodeId: 'extract',
    input: { memberId: 'member-7', suggestionId: 'suggestion-3' },
    nodeInput: { urls: ['https://example.test'] }, outputs: {},
  }, registry);
  expect(result).toMatchObject({ ok: true, result: { text: 'ok' } });
  expect(seen).toEqual({ input: { urls: ['https://example.test'] },
    graphInput: { memberId: 'member-7', suggestionId: 'suggestion-3' } });
});

test('provider conditions can match request input without provider names in the graph node', async () => {
  let registry = registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), contract);
  registry = registerGraphCapabilityProviderDeclaration(registry, {
    id: 'reddit-public', provides: ['extract.url@1'], tier: 'free', latency: 1, conditions: { socialSite: 'reddit' }, guarantees: { sourceAttribution: true },
    invoke: () => ({ ok: true, outcome: 'ok', result: { text: 'reddit' }, evidence: { source: 'fixture' } }),
  });
  const result = await dispatchGraphContract('extract.url@1', {
    graphId: 'contract-sim', runId: 'run', nodeId: 'extract', input: { urls: ['https://example.test'], socialSite: 'reddit' }, outputs: {},
  }, registry);
  expect(result).toMatchObject({ ok: true, result: { text: 'reddit' } });
});

test('contract registry fails closed for missing providers and schema violations', async () => {
  const registry = registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), contract);
  const context = { graphId: 'contract-sim', runId: 'run', nodeId: 'extract', input: { urls: ['https://example.test'] }, outputs: {} };
  expect(await dispatchGraphContract('extract.url@1', context, registry)).toMatchObject({ ok: false, error: 'unprovided' });
  const badInput = await dispatchGraphContract('extract.url@1', { ...context, input: { urls: [4] } },
    registerGraphCapabilityProviderDeclaration(registry, {
      id: 'bad-input-provider', provides: ['extract.url@1'], tier: 'free', latency: 1,
      invoke: () => ({ ok: true, outcome: 'ok', result: { text: 'unreachable' } }),
    }));
  expect(badInput).toMatchObject({ ok: false, error: 'contract-violation', evidence: { side: 'input' } });
  const badOutputRegistry = registerGraphCapabilityProviderDeclaration(registry, {
    id: 'bad-output-provider', provides: ['extract.url@1'], tier: 'free', latency: 1,
    guarantees: { sourceAttribution: true },
    invoke: () => ({ ok: true, outcome: 'ok', result: { title: 'missing text' } }),
  });
  expect(await dispatchGraphContract('extract.url@1', context, badOutputRegistry))
    .toMatchObject({ ok: false, error: 'contract-violation', evidence: { side: 'output' } });
});

test('guarded store writes are checked at dispatch and hide the proof field from providers', async () => {
  const fields = ['op', 'collection', 'owner', 'key', 'value', 'ownerScoped'] as const;
  const validatedPayload = { op: 'upsert', collection: 'design-packs', owner: 'member-7', key: 'brief-7',
    value: { appId: 'app-7', title: 'verified' }, ownerScoped: true };
  let calls = 0;
  let received: unknown;
  const writeContract: GraphCapabilityContract = { id: 'store.write@1', input: { type: 'object' }, output: { type: 'object' } };
  const registry = registerGraphCapabilityProviderDeclaration(
    registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), writeContract), {
      id: 'store-writer', provides: ['store.write@1'], tier: 'free',
      invoke: ({ input }) => { calls++; received = input; return { ok: true, outcome: 'done', result: { persisted: true } }; },
    });
  const context = (nodeInput: Record<string, unknown>) => ({ graphId: 'guarded-store-write', runId: 'run', nodeId: 'persist',
    input: { context: { memberId: 'member-7' } }, nodeInput, outputs: {} });

  expect(await dispatchGraphContract('store.write@1', context(validatedPayload), registry))
    .toMatchObject({ ok: false, outcome: 'failed', error: 'store write is missing its validated payload' });
  expect(calls).toBe(0);
  expect(await dispatchGraphContract('store.write@1', context({ ...validatedPayload, __validatedWrite: validatedPayload }), registry))
    .toMatchObject({ ok: true, outcome: 'done' });
  expect(calls).toBe(1);
  expect(received).toEqual(validatedPayload);
  for (const field of fields) {
    const changed = { ...validatedPayload, __validatedWrite: validatedPayload,
      [field]: field === 'value' ? { appId: 'app-7', title: 'tampered' }
        : field === 'ownerScoped' ? false : `${validatedPayload[field]}-tampered` };
    expect(await dispatchGraphContract('store.write@1', context(changed), registry))
      .toMatchObject({ ok: false, outcome: 'failed', error: 'store write input differs from its validated payload' });
  }
  expect(await dispatchGraphContract('store.write@1', context({ ...validatedPayload, __validatedWrite: validatedPayload,
    bypassPolicy: true }), registry))
    .toMatchObject({ ok: false, outcome: 'failed', error: 'store write input differs from its validated payload' });
  const sparseWithUndefined = new Array<unknown>(2);
  sparseWithUndefined[1] = 'safe';
  const comparisonCases: Array<{ name: string; expected: unknown; actual: unknown; extraField?: boolean; accepted: boolean }> = [
    { name: 'Date instant is tagged and compared', expected: { at: new Date('2026-11-11T00:00:00.000Z') },
      actual: { at: new Date('2026-11-12T00:00:00.000Z') }, accepted: false },
    { name: 'Date does not equal its ISO string', expected: { at: new Date('2026-11-11T00:00:00.000Z') },
      actual: { at: '2026-11-11T00:00:00.000Z' }, accepted: false },
    { name: 'array hole differs from explicit undefined', expected: { tags: [undefined, 'safe'] },
      actual: { tags: sparseWithUndefined }, accepted: false },
    { name: 'unproved extra field is rejected', expected: { tags: ['safe'] }, actual: { tags: ['safe'] },
      extraField: true, accepted: false },
    { name: 'object key order is normalized', expected: { first: 'a', second: 'b' },
      actual: { second: 'b', first: 'a' }, accepted: true },
    { name: 'NaN has a stable typed representation', expected: { score: Number.NaN },
      actual: { score: Number.NaN }, accepted: true },
    { name: 'NaN differs from null', expected: { score: Number.NaN }, actual: { score: null }, accepted: false },
    { name: 'negative zero differs from positive zero', expected: { score: -0 }, actual: { score: 0 }, accepted: false },
  ];
  for (const testCase of comparisonCases) {
    const proof = { ...validatedPayload, value: testCase.expected };
    const request = { ...validatedPayload, value: testCase.actual, __validatedWrite: proof,
      ...(testCase.extraField ? { bypassPolicy: true } : {}) };
    const result = await dispatchGraphContract('store.write@1', context(request), registry);
    expect(result.ok).toBe(testCase.accepted);
    if (!testCase.accepted)
      expect(result).toMatchObject({ error: 'store write input differs from its validated payload' });
  }
  expect(calls).toBe(3);
});

test('store.events@1 is a member-scoped shared contract and providers may omit unmeasured latency', async () => {
  let registry = registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), STORE_EVENTS_CONTRACT);
  registry = registerGraphCapabilityProviderDeclaration(registry, {
    id: 'event-store', provides: ['store.events@1'], tier: 'free',
    invoke: ({ input }) => ({ ok: true, outcome: 'ok', result: { events: [], request: input } }),
  });
  expect(registry.providers[0]?.latency).toBeUndefined();
  const result = await dispatchGraphContract('store.events@1', {
    graphId: 'store-contract', runId: 'run', nodeId: 'query',
    input: { operation: 'query', memberId: 'member-7', type: 'scrap-added', since: '2026-11-01T00:00:00.000Z' }, outputs: {},
  }, registry);
  expect(result).toMatchObject({ ok: true, result: { events: [], request: { memberId: 'member-7' } } });
  const missingMember = await dispatchGraphContract('store.events@1', {
    graphId: 'store-contract', runId: 'run', nodeId: 'query', input: { operation: 'query' }, outputs: {},
  }, registry);
  expect(missingMember).toMatchObject({ ok: false, error: 'contract-violation', evidence: { side: 'input' } });
});

test('contract latency guarantee aborts and fails an invocation that exceeds its deadline', async () => {
  const registry = registerGraphCapabilityProviderDeclaration(
    registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
      ...contract,
      guarantees: {
        // Source: 내부 문서 `RFC-adaptive-graph-ops-2026-10-09` §3 — deadline bounds an unresolved provider in this timeout fixture.
        maxLatencyMs: 5,
      },
    }),
    { id: 'slow-provider', provides: ['extract.url@1'], tier: 'free', latency: 1,
      invoke: ({ signal }) => new Promise((resolve) => {
        signal?.addEventListener('abort', () => resolve({ ok: true, outcome: 'ok', result: { text: 'late' } }), { once: true });
      }) },
  );
  const result = await dispatchGraphContract('extract.url@1', {
    graphId: 'contract-sim', runId: 'run', nodeId: 'extract', input: { urls: ['https://example.test'] }, outputs: {},
  }, registry);
  expect(result).toMatchObject({ ok: false, outcome: 'failed', error: 'latency-exceeded' });
});

test('required contract result envelope survives collect → map → extract through runGraph outputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-contract-envelope-'));
  try {
    const graphPath = join(root, 'graph.yaml');
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    writeFileSync(graphPath, `graph_id: contract-envelope\nversion: 1\nentry_node: collect\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: collect, kind: capability, recipe: none, requires: scrap.items@1, max_visits: 1 }\n  - { node_id: map, kind: capability, recipe: none, requires: scrap.items@1, max_visits: 1 }\n  - { node_id: extract, kind: capability, recipe: none, requires: extract.url@1, max_visits: 1 }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: collect, on: outcome, map: { ok: map, failed: failed } }\n  - { from: map, on: outcome, map: { ok: extract, failed: failed } }\n  - { from: extract, on: outcome, map: { ok: done, failed: failed } }\n`);
    const listContract: GraphCapabilityContract = { id: 'scrap.items@1', input: { type: 'object' },
      output: { type: 'object', required: ['items'], properties: { items: { type: 'array' } } } };
    let registry = registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), listContract);
    registry = registerGraphCapabilityContract(registry, contract);
    registry = registerGraphCapabilityProviderDeclaration(registry, {
      id: 'scrap-store', provides: ['scrap.items@1'], tier: 'free', latency: 1,
      invoke: ({ nodeId, outputs }) => {
        const items = nodeId === 'collect' ? [{ url: 'https://example.test' }] :
          (outputs.collect as { result?: { items?: unknown[] } }).result?.items ?? [];
        return { ok: true, outcome: 'ok', result: { items }, evidence: { count: items.length } };
      },
    });
    registry = registerGraphCapabilityProviderDeclaration(registry, {
      id: 'url-extractor', provides: ['extract.url@1'], tier: 'byok', latency: 1,
      guarantees: { sourceAttribution: true },
      invoke: ({ outputs }) => {
        const mapped = outputs.map as { result?: { items?: unknown[] } };
        return { ok: true, outcome: 'ok', result: { text: 'extracted', count: mapped.result?.items?.length }, evidence: { source: 'test' } };
      },
    });
    const state = await runGraph(graphPath, { input: { urls: ['https://example.test'] }, quiet: true,
      deps: { root: join(root, 'state'), capabilityProviders: registry } });
    expect(state.status).toBe('done');
    expect(JSON.parse(String(state.nodes[0]?.output))).toMatchObject({ result: { items: [{ url: 'https://example.test' }] }, evidence: { count: 1 }, outcome: 'ok' });
    expect(JSON.parse(String(state.nodes[1]?.output))).toMatchObject({ result: { items: [{ url: 'https://example.test' }] }, evidence: { count: 1 }, outcome: 'ok' });
    expect(JSON.parse(String(state.nodes[2]?.output))).toMatchObject({ result: { text: 'extracted', count: 1 }, evidence: { source: 'test' }, outcome: 'ok' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runner rejects invalid capability kind, recipe, and requires combinations before dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-contract-kind-guard-'));
  try {
    const graphPath = join(root, 'graph.yaml');
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    const graph = (kind: string, recipe: string) => `graph_id: capability-kind-guard\nversion: 1\nentry_node: action\nterminal_nodes: [done]\nnodes:\n  - { node_id: action, kind: ${kind}, recipe: '${recipe}', requires: extract.url@1, max_visits: 1 }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: action, to: done }\n`;
    writeFileSync(graphPath, graph('agent', 'none'));
    await expect(runGraph(graphPath, { quiet: true, deps: { root: join(root, 'wrong-kind') } }))
      .rejects.toThrow('requires is only valid on capability nodes');
    writeFileSync(graphPath, graph('capability', 'cap:unknown'));
    await expect(runGraph(graphPath, { quiet: true, deps: { root: join(root, 'wrong-recipe') } }))
      .rejects.toThrow('contract capability node must not name a provider recipe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
