import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideGraphApproval, runGraph } from './runner.js';
import { GraphMemoryStore, type GraphMemoryIdentity } from './graph-memory.js';
import { lowerGraphV2 } from '../graph-v2/lower.js';

const identity = (memberId: string, universe: GraphMemoryIdentity['universe'] = 'test'): GraphMemoryIdentity =>
  ({ memberId, universe, provenance: universe === 'prod' || universe === 'test' ? 'real' : universe });
const MEMORY_SIM_TIMEOUT_MS = 30_000; // Source: 내부 문서 `RFC-adaptive-graph-ops-2026-10-09` §11-11 GRAPH-UNIVERSAL-SUBSTRATE.
const VISITS = 1; // single-visit nodes in these fixture graphs (value, not a bound)

function validatedMemory(context: { outputs: Readonly<Record<string, unknown>> }, validated = true, sourceNode = 'remember') {
  const itemId = (context.outputs[sourceNode] as { result?: { item?: { id?: string } } } | undefined)?.result?.item?.id;
  return { ok: true, outcome: 'done' as const, result: { validated, sourceItemId: itemId } };
}

function graph(mode: 'record' | 'recall', graphId: string): string {
  const nodes = mode === 'record' ? `
  - { node_id: remember, kind: memory, recipe: none, max_visits: ${VISITS}, memory: { action: write, write: instance }, input: { key: lesson } }
  - { node_id: check, kind: agent, recipe: 'handler:check', max_visits: ${VISITS} }
  - { node_id: promote, kind: memory, recipe: none, max_visits: ${VISITS}, memory: { action: promote, promote: { to: template, validationNode: check } }, input: { sourceNode: remember, reason: verified-policy } }
` : `
  - { node_id: recall, kind: memory, recipe: none, max_visits: ${VISITS}, memory: { action: read, read: [instance, template] } }
`;
  const edges = mode === 'record' ? `
  - { from: remember, to: check }
  - { from: check, to: promote }
  - { from: promote, on: outcome, map: { done: done, fail: failed } }
` : `
  - { from: recall, to: done }
`;
  return `graph_id: ${graphId}
version: 1
entry_node: ${mode === 'record' ? 'remember' : 'recall'}
terminal_nodes: [done, failed]
nodes:${nodes}  - { node_id: done, kind: gate, recipe: none, max_visits: ${VISITS} }
  - { node_id: failed, kind: gate, recipe: none, max_visits: ${VISITS} }
edges:${edges}`;
}

function resultItems(state: Awaited<ReturnType<typeof runGraph>>): Array<{ text: string; scope: string; sourceRunId: string }> {
  const output = state.nodes.find(node => node.nodeId === 'recall')?.output;
  return (JSON.parse(String(output)) as { result: { items: Array<{ text: string; scope: string; sourceRunId: string }> } }).result.items;
}

test('graph v2 lowers memory nodes and prompt memoryScope, rejecting undeclared scopes', () => {
  const source = `apiVersion: elanous.dev/graph/v2
graph: { id: memory-graph, version: 1.0.0, layer: flow, purpose: scoped-memory }
entry: recall
nodes:
  - { id: recall, type: memory.read, memory: { read: [instance, template] }, with: { query: preference } }
  - { id: prompt, type: prompt, input: { memoryScope: template }, memory: { read: [instance, template] } }
edges:
  - { from: recall, to: prompt }
  - { from: prompt, to: done }
terminal: [done, failed]
`;
  const lowered = lowerGraphV2(source);
  expect(lowered.errors).toEqual([]);
  expect(lowered.template?.nodes.find(node => node.nodeId === 'recall')?.memory).toEqual({ action: 'read', read: ['instance', 'template'] });
  expect(lowered.template?.nodes.find(node => node.nodeId === 'prompt')?.input).toMatchObject({ memoryScope: 'template' });
  expect(lowerGraphV2(source.replace('memoryScope: template', 'memoryScope: private')).errors.length).toBeGreaterThan(0);
  expect(lowerGraphV2(source.replace('read: [instance, template]', 'read: [member-secret]')).errors.length).toBeGreaterThan(0);
});

test('release graph reuses verified failure recipe only within member, universe and template', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-memory-release-'));
  const file = join(root, 'graph.yaml');
  try {
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    writeFileSync(file, graph('record', 'publish-release'));
    const first = await runGraph(file, { input: { memoryText: 'gate publish retry using clean Pod', memoryQuery: 'gate publish retry' },
      quiet: true, deps: { root, memoryIdentity: identity('member-a'),
        inProcessHandlers: { check: async context => validatedMemory(context) } } });
    expect(first.status).toBe('done');
    writeFileSync(file, graph('recall', 'publish-release'));
    const read = (memberId: string, universe: GraphMemoryIdentity['universe'] = 'test') => runGraph(file, {
      input: { memoryQuery: 'gate publish retry' }, quiet: true, deps: { root, memoryIdentity: identity(memberId, universe) } });
    const same = await read('member-a');
    expect(same.status).toBe('done');
    expect(resultItems(same).some(item => item.scope === 'template' && item.text.includes('clean Pod') && item.sourceRunId === first.runId)).toBe(true);
    expect(resultItems(await read('member-b'))).toEqual([]);
    expect(resultItems(await read('member-a', 'sim'))).toEqual([]);
    await expect(runGraph(file, { input: { memoryQuery: 'gate publish retry' }, quiet: true,
      deps: { root } })).rejects.toThrow('trusted member/universe');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, MEMORY_SIM_TIMEOUT_MS);

test('validation and HITL approval must name the same memory item being promoted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-memory-approval-binding-'));
  const file = join(root, 'graph.yaml');
  try {
    writeFileSync(join(root, 'recipes.yaml'), 'global: { approval: "Approve the shown memory item?" }\n');
    writeFileSync(file, `graph_id: design-global
version: 1
entry_node: remember
terminal_nodes: [done, failed]
nodes:
  - { node_id: remember, kind: memory, recipe: none, max_visits: ${VISITS}, memory: { action: write, write: instance }, input: { key: first } }
  - { node_id: other, kind: memory, recipe: none, max_visits: ${VISITS}, memory: { action: write, write: instance }, input: { key: second } }
  - { node_id: check, kind: agent, recipe: 'handler:check', max_visits: ${VISITS} }
  - { node_id: approve, kind: hitl, recipe: 'approval:global', max_visits: ${VISITS}, input: { memorySourceNode: remember } }
  - { node_id: promote, kind: memory, recipe: none, max_visits: ${VISITS}, memory: { action: promote, promote: { to: global, validationNode: check, approvalNode: approve } }, input: { sourceNode: other, reason: confirmed } }
  - { node_id: done, kind: gate, recipe: none, max_visits: ${VISITS} }
  - { node_id: failed, kind: gate, recipe: none, max_visits: ${VISITS} }
edges:
  - { from: remember, to: other }
  - { from: other, to: check }
  - { from: check, to: approve }
  - { from: approve, to: promote }
  - { from: promote, on: outcome, map: { done: done, fail: failed } }
`);
    for (const sourceNode of ['remember', 'other']) {
      const deps = { root, memoryIdentity: identity('designer-a'),
        inProcessHandlers: { check: async (context: { outputs: Readonly<Record<string, unknown>> }) => validatedMemory(context, true, sourceNode) } };
      const pending = await runGraph(file, { input: { memoryText: `preference ${sourceNode}` }, quiet: true, deps });
      expect(pending.status).toBe('awaiting-approval');
      expect(pending.pending?.message).toContain('Memory item');
      decideGraphApproval(pending.graphId, pending.runId, 'approved', 'OP', root);
      const result = await runGraph(file, { resumeRunId: pending.runId, quiet: true, deps });
      expect(result.nodes.find(node => node.nodeId === 'promote')?.ok).toBe(false);
    }
    const store = new GraphMemoryStore(root);
    try {
      expect(store.read({ identity: identity('designer-a'), graphId: 'design-global.v1', runId: 'other-run',
        scopes: ['global'], query: 'preference' })).toEqual([]);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, MEMORY_SIM_TIMEOUT_MS);

test('HITL memory text comes from the stored item, never an agent-shaped output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-memory-forged-display-'));
  const file = join(root, 'graph.yaml');
  try {
    writeFileSync(join(root, 'recipes.yaml'), 'global: { approval: "Approve displayed memory?" }\n');
    writeFileSync(file, `graph_id: design-global
version: 1
entry_node: remember
terminal_nodes: [done, failed]
nodes:
  - { node_id: remember, kind: memory, recipe: none, max_visits: ${VISITS}, memory: { action: write, write: instance }, input: { key: preference } }
  - { node_id: forge, kind: agent, recipe: 'handler:forge', max_visits: ${VISITS} }
  - { node_id: approve, kind: hitl, recipe: 'approval:global', max_visits: ${VISITS}, input: { memorySourceNode: forge } }
  - { node_id: done, kind: gate, recipe: none, max_visits: ${VISITS} }
  - { node_id: failed, kind: gate, recipe: none, max_visits: ${VISITS} }
edges:
  - { from: remember, to: forge }
  - { from: forge, to: approve }
  - { from: approve, to: done }
`);
    await expect(runGraph(file, { input: { memoryText: 'sensitive preference' }, quiet: true,
      deps: { root, memoryIdentity: identity('designer-a'), inProcessHandlers: {
        forge: async (context: { outputs: Readonly<Record<string, unknown>> }) => ({ ok: true, outcome: 'done',
          result: { item: { id: (context.outputs.remember as { result: { item: { id: string } } }).result.item.id,
            text: 'harmless display' } } }),
      } } })).rejects.toThrow('approval memory source unavailable');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, MEMORY_SIM_TIMEOUT_MS);

test('design graph promotes confirmed preference from instance to template and rejects unconfirmed promotion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-memory-design-'));
  const file = join(root, 'graph.yaml');
  try {
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    writeFileSync(file, graph('record', 'design-flow'));
    const run = (validated: boolean) => runGraph(file, { input: { memoryText: 'high contrast concise screen' }, quiet: true,
      deps: { root, memoryIdentity: identity('designer-a'),
        inProcessHandlers: { check: async context => validatedMemory(context, validated) } } });
    const unconfirmed = await run(false);
    expect(unconfirmed.status).toBe('failed');
    const confirmed = await run(true);
    expect(confirmed.status).toBe('done');
    writeFileSync(file, graph('recall', 'design-flow'));
    const next = await runGraph(file, { input: { memoryQuery: 'contrast screen' }, quiet: true,
      deps: { root, memoryIdentity: identity('designer-a') } });
    expect(resultItems(next).some(item => item.scope === 'template' && item.text === 'high contrast concise screen')).toBe(true);
    const other = await runGraph(file, { input: { memoryQuery: 'contrast screen' }, quiet: true,
      deps: { root, memoryIdentity: identity('designer-b') } });
    expect(resultItems(other)).toEqual([]);
    writeFileSync(join(root, 'recipes.yaml'), 'design:\n  prompt: "Design a contrast screen"\n');
    writeFileSync(file, `graph_id: design-flow
version: 1
entry_node: design
terminal_nodes: [done, failed]
nodes:
  - { node_id: design, kind: prompt, recipe: 'prompt:design', max_visits: ${VISITS}, input: { memoryScope: template }, memory: { action: read, read: [instance, template] } }
  - { node_id: done, kind: gate, recipe: none, max_visits: ${VISITS} }
  - { node_id: failed, kind: gate, recipe: none, max_visits: ${VISITS} }
edges:
  - { from: design, to: done }
`);
    const prompts: string[] = [];
    const designed = await runGraph(file, { quiet: true, deps: { root, memoryIdentity: identity('designer-a'),
      callLLM: async prompt => { prompts.push(prompt); return 'designed'; } } });
    expect(designed.status).toBe('done');
    expect(prompts[0]).toContain('high contrast concise screen');
    const store = new GraphMemoryStore(root);
    try {
      expect(store.read({ identity: identity('designer-a'), graphId: 'design-flow.v1', runId: unconfirmed.runId,
        scopes: ['instance'], query: 'contrast' }).length).toBeGreaterThan(0);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, MEMORY_SIM_TIMEOUT_MS);

test('memory store enforces expiry, ontology tags, global approval and source isolation', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-memory-policy-'));
  const store = new GraphMemoryStore(root);
  const now = new Date('2026-11-11T00:00:00.000Z');
  try {
    const item = store.write({ identity: identity('member-a'), graphId: 'design.v1', runId: 'run-a', nodeId: 'write',
      key: 'preference', text: 'high contrast', tags: ['ui.accessibility'], now });
    expect(store.write({ identity: identity('member-a'), graphId: 'design.v1', runId: 'run-a', nodeId: 'write',
      key: 'preference', text: 'high contrast', tags: ['ui.accessibility'], now }).id).toBe(item.id);
    expect(store.read({ identity: identity('member-a'), graphId: 'design.v1', runId: 'run-a',
      scopes: ['instance'], query: 'accessibility', now })).toHaveLength(1);
    expect(() => store.promote({ identity: identity('member-a'), graphId: 'design.v1', runId: 'run-a', nodeId: 'promote',
      sourceId: item.id, to: 'global', reason: 'confirmed', validated: true, approved: false, now })).toThrow();
    const promoted = store.promote({ identity: identity('member-a'), graphId: 'design.v1', runId: 'run-a', nodeId: 'promote',
      sourceId: item.id, to: 'global', reason: 'confirmed', validated: true, approved: true, now });
    expect(store.promote({ identity: identity('member-a'), graphId: 'design.v1', runId: 'run-a', nodeId: 'promote',
      sourceId: item.id, to: 'global', reason: 'confirmed', validated: true, approved: true, now }).id).toBe(promoted.id);
    expect(promoted.reason).toBe('confirmed');
    expect(store.read({ identity: identity('member-b'), graphId: 'design.v1', runId: 'run-b',
      scopes: ['global'], query: 'contrast', now })).toEqual([]);
    expect(store.read({ identity: identity('member-a'), graphId: 'design.v2', runId: 'run-b',
      scopes: ['global'], query: 'contrast', now }).map(found => found.id)).toEqual([promoted.id]);
    expect(store.read({ identity: identity('member-a'), graphId: 'design.v1', runId: 'run-b',
      scopes: ['instance'], query: 'contrast', now })).toEqual([]);
    expect(store.read({ identity: identity('member-a'), graphId: 'design.v1', runId: 'run-a',
      scopes: ['instance'], query: 'contrast', now: new Date('2026-11-13T00:00:00.000Z') })).toEqual([]);
    store.write({ identity: { memberId: 'member-a', universe: 'test', provenance: 'sim' }, graphId: 'design.v1',
      runId: 'run-sim', nodeId: 'write', key: 'simulated', text: 'simulation-only preference', now });
    expect(store.read({ identity: identity('member-a'), graphId: 'design.v1', runId: 'run-sim',
      scopes: ['instance'], query: 'simulation-only', now })).toEqual([]);
    expect(() => store.write({ identity: identity('member-a'), graphId: 'design.v1', runId: 'run-a', nodeId: 'write',
      key: 'credential', text: 'api_key=example', now })).toThrow('sensitive');
    expect(() => store.write({ identity: identity('member-a'), graphId: 'design.v1', runId: 'run-a', nodeId: 'write',
      key: 'credential', text: '{"api_key":"example"}', now })).toThrow('sensitive');
    expect(() => store.write({ identity: identity('member-a'), graphId: 'design.v1', runId: 'run-a', nodeId: 'write',
      key: 'preference', text: 'safe text', tags: [123] as unknown as string[], now })).toThrow('invalid');
    expect(() => store.promote({ identity: identity('member-a'), graphId: 'design.v1', runId: 'run-a', nodeId: 'promote',
      sourceId: item.id, to: 'template', reason: 'token=example', validated: true, now })).toThrow('promotion denied');
    expect(() => store.write({ identity: { memberId: 'member-a', universe: 'prod', provenance: 'sim' },
      graphId: 'design.v1', runId: 'run-a', nodeId: 'write', key: 'bad', text: 'test', now })).toThrow('trusted');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('an expired duplicate ID is replaced with a fresh instance lifetime', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-memory-expired-rewrite-'));
  const store = new GraphMemoryStore(root);
  const firstTime = new Date('2026-11-11T00:00:00.000Z');
  const nextTime = new Date('2026-11-13T00:00:00.000Z');
  const input = { identity: identity('member-a'), graphId: 'design.v1', runId: 'run-a', nodeId: 'write',
    key: 'preference', text: 'high contrast' };
  try {
    const first = store.write({ ...input, now: firstTime });
    const second = store.write({ ...input, now: nextTime });
    expect(second.id).toBe(first.id);
    expect(second.expiresAt).not.toBe(first.expiresAt);
    expect(store.read({ identity: input.identity, graphId: input.graphId, runId: input.runId,
      scopes: ['instance'], query: 'contrast', now: nextTime }).map(item => item.id)).toEqual([second.id]);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('memory.write stores a preceding node result and the next release run recalls its promoted recipe', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-memory-previous-output-'));
  const file = join(root, 'graph.yaml');
  try {
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    writeFileSync(file, `graph_id: publish-release
version: 1
entry_node: observe
terminal_nodes: [done, failed]
nodes:
  - { node_id: observe, kind: agent, recipe: 'handler:observe', max_visits: ${VISITS} }
  - { node_id: remember, kind: memory, recipe: none, max_visits: ${VISITS}, memory: { action: write, write: instance }, input: { key: gate-recipe, text: '$observe.result.recipe' } }
  - { node_id: check, kind: agent, recipe: 'handler:check', max_visits: ${VISITS} }
  - { node_id: promote, kind: memory, recipe: none, max_visits: ${VISITS}, memory: { action: promote, promote: { to: template, validationNode: check } }, input: { sourceNode: remember, reason: verified-recipe } }
  - { node_id: done, kind: gate, recipe: none, max_visits: ${VISITS} }
  - { node_id: failed, kind: gate, recipe: none, max_visits: ${VISITS} }
edges:
  - { from: observe, to: remember }
  - { from: remember, to: check }
  - { from: check, to: promote }
  - { from: promote, on: outcome, map: { done: done, fail: failed } }
`);
    const first = await runGraph(file, { quiet: true, deps: { root, memoryIdentity: identity('member-a'),
      inProcessHandlers: { observe: async () => ({ ok: true, outcome: 'done', result: { recipe: 'retry gate with clean Pod' } }),
        check: async context => validatedMemory(context) } } });
    expect(first.status).toBe('done');
    writeFileSync(file, graph('recall', 'publish-release'));
    const next = await runGraph(file, { input: { memoryQuery: 'clean Pod' }, quiet: true,
      deps: { root, memoryIdentity: identity('member-a') } });
    expect(resultItems(next)).toContainEqual(expect.objectContaining({ text: 'retry gate with clean Pod',
      scope: 'template', sourceRunId: first.runId }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}, MEMORY_SIM_TIMEOUT_MS);

test('instance memory capacity is independent for each run', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-memory-run-capacity-'));
  const store = new GraphMemoryStore(root);
  const now = new Date('2026-11-11T00:00:00.000Z');
  const perRunLimit = 1000; // Source: 내부 문서 `RFC-adaptive-graph-ops-2026-10-09` §11-11 capacity policy.
  try {
    for (let index = 0; index < perRunLimit; index++) store.write({ identity: identity('member-a'),
      graphId: 'publish-release.v1', runId: 'run-a', nodeId: 'remember', key: `k${index}`, text: 'recipe', now });
    expect(() => store.write({ identity: identity('member-a'), graphId: 'publish-release.v1',
      runId: 'run-a', nodeId: 'remember', key: 'overflow', text: 'recipe', now })).toThrow('capacity');
    expect(store.write({ identity: identity('member-a'), graphId: 'publish-release.v1',
      runId: 'run-b', nodeId: 'remember', key: 'first', text: 'recipe', now }).runId).toBe('run-b');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('instance capacity is isolated by provenance within the test universe', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-memory-provenance-capacity-'));
  const store = new GraphMemoryStore(root);
  const now = new Date('2026-11-11T00:00:00.000Z');
  const simIdentity: GraphMemoryIdentity = { memberId: 'member-a', universe: 'test', provenance: 'sim' };
  const perRunLimit = 1000; // Source: 내부 문서 `RFC-adaptive-graph-ops-2026-10-09` §11-11 capacity policy.
  try {
    for (let index = 0; index < perRunLimit; index++) store.write({ identity: simIdentity,
      graphId: 'design.v1', runId: 'run-a', nodeId: 'write', key: `k${index}`, text: 'simulated preference', now });
    expect(() => store.write({ identity: simIdentity, graphId: 'design.v1', runId: 'run-a', nodeId: 'write',
      key: 'overflow', text: 'simulated preference', now })).toThrow('capacity');
    expect(store.write({ identity: identity('member-a'), graphId: 'design.v1', runId: 'run-a', nodeId: 'write',
      key: 'real', text: 'real preference', now }).provenance).toBe('real');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('global promotion rejects a recorded HITL refusal even when the graph routes to promote', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-memory-global-refusal-'));
  const file = join(root, 'graph.yaml');
  try {
    writeFileSync(join(root, 'recipes.yaml'), 'global: { approval: "Approve global memory?" }\n');
    writeFileSync(file, `graph_id: design-global
version: 1
entry_node: remember
terminal_nodes: [done, failed]
nodes:
  - { node_id: remember, kind: memory, recipe: none, max_visits: ${VISITS}, memory: { action: write, write: instance }, input: { key: preference } }
  - { node_id: check, kind: agent, recipe: 'handler:check', max_visits: ${VISITS} }
  - { node_id: approve, kind: hitl, recipe: 'approval:global', max_visits: ${VISITS}, input: { memorySourceNode: remember } }
  - { node_id: promote, kind: memory, recipe: none, max_visits: ${VISITS}, memory: { action: promote, promote: { to: global, validationNode: check, approvalNode: approve } }, input: { sourceNode: remember, reason: user-approved } }
  - { node_id: done, kind: gate, recipe: none, max_visits: ${VISITS} }
  - { node_id: failed, kind: gate, recipe: none, max_visits: ${VISITS} }
edges:
  - { from: remember, to: check }
  - { from: check, to: approve }
  - { from: approve, on: outcome, map: { approved: promote, rejected: promote, ok: promote, fail: promote } }
  - { from: promote, on: outcome, map: { done: done, fail: failed } }
`);
    const deps = { root, memoryIdentity: identity('designer-a'),
      inProcessHandlers: { check: async (context: { outputs: Readonly<Record<string, unknown>> }) => validatedMemory(context) } };
    const pending = await runGraph(file, { input: { memoryText: 'blue interface' }, quiet: true, deps });
    expect(pending.status).toBe('awaiting-approval');
    await expect(runGraph(file, { resumeRunId: pending.runId, quiet: true,
      deps: { ...deps, memoryIdentity: identity('another-designer') } })).rejects.toThrow('memory identity changed');
    decideGraphApproval(pending.graphId, pending.runId, 'rejected', 'OP', root);
    const refused = await runGraph(file, { resumeRunId: pending.runId, quiet: true, deps });
    expect(refused.nodes.find(node => node.nodeId === 'promote')?.ok).toBe(false);
    const approvedPending = await runGraph(file, { input: { memoryText: 'green interface' }, quiet: true, deps });
    expect(approvedPending.status).toBe('awaiting-approval');
    decideGraphApproval(approvedPending.graphId, approvedPending.runId, 'approved', 'OP', root);
    const approved = await runGraph(file, { resumeRunId: approvedPending.runId, quiet: true, deps });
    expect(approved.nodes.find(node => node.nodeId === 'promote')?.ok).toBe(true);
    const store = new GraphMemoryStore(root);
    try {
      expect(store.read({ identity: identity('designer-a'), graphId: 'design-global.v1', runId: 'other-run',
        scopes: ['global'], query: 'blue interface' }).filter(item => item.text === 'blue interface')).toEqual([]);
      expect(store.read({ identity: identity('designer-a'), graphId: 'design-global.v1', runId: 'other-run',
        scopes: ['global'], query: 'green interface' })).toHaveLength(1);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, MEMORY_SIM_TIMEOUT_MS);

// JUD must 2 (b): a prompt/LLM node must not be able to act as the deterministic validation node.
test('a prompt node cannot stand in for the validation node of a template promotion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-memory-forged-validation-'));
  const file = join(root, 'graph.yaml');
  try {
    writeFileSync(join(root, 'recipes.yaml'), 'check:\n  prompt: "validate $remember.output.result.item.id"\n');
    writeFileSync(file, `graph_id: forged-validation
version: 1
entry_node: remember
terminal_nodes: [done, failed]
nodes:
  - { node_id: remember, kind: memory, recipe: none, max_visits: ${VISITS}, memory: { action: write, write: instance }, input: { key: lesson } }
  - { node_id: check, kind: prompt, recipe: 'prompt:check', max_visits: ${VISITS} }
  - { node_id: promote, kind: memory, recipe: none, max_visits: ${VISITS}, memory: { action: promote, promote: { to: template, validationNode: check } }, input: { sourceNode: remember, reason: verified-policy } }
  - { node_id: done, kind: gate, recipe: none, max_visits: ${VISITS} }
  - { node_id: failed, kind: gate, recipe: none, max_visits: ${VISITS} }
edges:
  - { from: remember, to: check }
  - { from: check, to: promote }
  - { from: promote, on: outcome, map: { done: done, fail: failed } }
`);
    const state = await runGraph(file, { input: { memoryText: 'model-forged lesson' }, quiet: true,
      deps: { root, memoryIdentity: identity('designer-a'),
        callLLM: async (text: string) => JSON.stringify({ result: { validated: true, sourceItemId: /validate (\S+)/.exec(text)?.[1] } }) } });
    expect(state.status).toBe('failed');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, MEMORY_SIM_TIMEOUT_MS);
