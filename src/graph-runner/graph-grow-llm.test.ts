import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphTemplateSpec } from '../self-implement/graph-yaml.js';
import { proposeGrowth } from './graph-grow.js';
import { createLLMGrowthProposer, graphGrowthLlmOptions } from './graph-grow-llm.js';
import { getUserConfig, isModelRole, MODEL_ROLES } from '../user-config.js';
import { runGraph } from './runner.js';
import { subscribeInsideEvent } from '../nexus/api/inside-events.js';

const graph: GraphTemplateSpec = {
  graphId: 'growth', version: 1, entryNode: 'judge', terminalNodes: ['done'],
  nodes: [
    { nodeId: 'judge', kind: 'judge', recipe: 'cmd:judge', maxVisits: 2 },
    { nodeId: 'done', kind: 'gate', recipe: 'none', maxVisits: 1 },
  ],
  edges: [{ from: 'judge', on: 'outcome', map: { ok: 'done' } }],
};
const input = { graph, nodeId: 'judge', outcome: 'needs-research', runId: 'run-1', output: `prefix-${'x'.repeat(5000)}-last-line` };
const answer = JSON.stringify({ node: { nodeId: 'research', kind: 'agent', recipe: 'none', maxVisits: 1,
  contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'done', reason: 'research the missing evidence' });

test('graph-grow role chooses its configured provider and model; missing role keeps the default chain', () => {
  const config = getUserConfig();
  expect(MODEL_ROLES).toContain('graph-grow');
  expect(isModelRole('graph-grow')).toBe(true);
  expect(graphGrowthLlmOptions({ ...config, roleLlm: undefined })).toEqual({});
  expect(graphGrowthLlmOptions({ ...config, roleLlm: { 'graph-grow': { provider: 'grok', model: 'grok-test' } } }))
    .toEqual({ provider: 'grok', model: 'grok-test' });
});

test('fake LLM sees graph nodes, recipe kinds, edges, blocked output tail and unseen outcome; its proposal grows the graph', async () => {
  const prompts: string[] = [];
  const proposer = createLLMGrowthProposer(async (prompt) => { prompts.push(prompt); return answer; });
  const result = await proposeGrowth(input, proposer);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain('"graphId":"growth","version":1,"entryNode":"judge"');
  expect(prompts[0]).toContain('"nodeId":"judge","kind":"judge","recipe":"cmd:judge"');
  expect(prompts[0]).toContain('"from":"judge","on":"outcome","map":{"ok":"done"}');
  expect(prompts[0]).toContain('needs-research');
  const tail = JSON.parse(prompts[0]!.split('Blocked node output tail: ')[1]!) as string;
  expect(tail).toBe(input.output.slice(-2000));
  expect(tail).toEndWith('-last-line');
  expect(tail).not.toContain('prefix-');
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.growth.node.nodeId).toBe('research');
    expect(result.growth.reason).toBe('research the missing evidence');
    expect(result.graph.edges.at(-1)).toEqual({ from: 'research', to: 'done' });
    expect(graph.edges[0]?.map).toEqual({ ok: 'done' });
  }
});

test('runner forwards the blocked output to the LLM proposer on an unseen outcome', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-grow-llm-'));
  const insideEvents: Array<{ kind: string }> = [];
  const unsubscribe = subscribeInsideEvent(event => { insideEvents.push(event); });
  try {
    const path = join(root, 'graph.yaml');
    writeFileSync(join(root, 'recipes.yaml'), 'judge:\n  command: "exit 0"\n');
    writeFileSync(path, `grow: on\ngraph_id: growth\nversion: 1\nentry_node: judge\nterminal_nodes: [done]\nnodes:\n  - { node_id: judge, kind: judge, recipe: 'cmd:judge', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\nedges:\n  - from: judge\n    on: outcome\n    map: { ok: done }\n`);
    const prompts: string[] = [];
    const run = await runGraph(path, { deps: { root,
      runBash: async () => ({ stdout: 'blocked output tail\n{"outcome":"needs-research"}\n', stderr: '', exitCode: 0 }),
      growthLLM: async prompt => { prompts.push(prompt); return answer; },
    } });
    expect(run.status).toBe('done');
    expect(run.growthRejections).toBeUndefined();
    expect(run.path).toEqual(['judge', 'research', 'done']);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('blocked output tail');
    expect(prompts[0]).toContain('needs-research');
    expect(readFileSync(run.statePath, 'utf8')).toContain('research');
    expect(insideEvents).toContainEqual(expect.objectContaining({ kind: 'edge-added', graphId: 'growth', runId: run.runId,
      from: 'judge', outcome: 'needs-research', to: 'research' }));
  } finally { unsubscribe(); rmSync(root, { recursive: true, force: true }); }
});

test('grow off keeps the existing fallback and never calls the fake LLM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-grow-off-'));
  try {
    const path = join(root, 'graph.yaml');
    writeFileSync(join(root, 'recipes.yaml'), 'judge:\n  command: "exit 0"\n');
    writeFileSync(path, `graph_id: growth\nversion: 1\nentry_node: judge\nterminal_nodes: [done]\nnodes:\n  - { node_id: judge, kind: judge, recipe: 'cmd:judge', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\nedges:\n  - from: judge\n    on: outcome\n    map: { ok: done }\n`);
    let calls = 0;
    const run = await runGraph(path, { deps: { root,
      runBash: async () => ({ stdout: '{"outcome":"needs-research"}\n', stderr: '', exitCode: 0 }),
      growthLLM: async () => { calls++; return answer; },
    } });
    expect(run.status).toBe('done');
    expect(run.path).toEqual(['judge', 'done']);
    expect(run.growth).toBeUndefined();
    expect(calls).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('grow on rejects malformed LLM JSON via the existing fallback and parks a side-effect recipe', async () => {
  for (const [reply, expected] of [
    ['not json', 'done'],
    ['throw', 'done'],
    [answer.replace('"recipe":"none"', '"recipe":"cmd:publish"'), 'awaiting-approval'],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), 'graph-grow-llm-reject-'));
    try {
      const path = join(root, 'graph.yaml');
      writeFileSync(join(root, 'recipes.yaml'), 'judge:\n  command: "exit 0"\npublish:\n  command: "exit 0"\n');
      writeFileSync(path, `grow: on\ngraph_id: growth\nversion: 1\nentry_node: judge\nterminal_nodes: [done]\nnodes:\n  - { node_id: judge, kind: judge, recipe: 'cmd:judge', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\nedges:\n  - from: judge\n    on: outcome\n    map: { ok: done }\n`);
      const run = await runGraph(path, { deps: { root,
        runBash: async () => ({ stdout: '{"outcome":"needs-research"}\n', stderr: '', exitCode: 0 }),
        growthLLM: async () => { if (reply === 'throw') throw new Error('offline'); return reply; },
      } });
      expect(run.status).toBe(expected);
      expect(run.growth).toBeUndefined();
      expect(run.growthRejections).toHaveLength(1);
      if (expected === 'done') {
        expect(run.path).toEqual(['judge', 'done']);
        expect(run.growthRejections?.[0]?.reason).toBe(reply === 'throw' ? 'proposer failed: Error: offline' : 'no proposal');
      } else {
        expect(run.path).toEqual(['judge']);
        expect(run.growthPark?.reason).toContain('사람 확인 필요');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('malformed, empty and invalid model replies are not accepted as growth', async () => {
  for (const reply of ['not json', '{}', JSON.stringify({ node: {}, reason: 'x' })]) {
    const result = await proposeGrowth(input, createLLMGrowthProposer(async () => reply));
    expect(result).toMatchObject({ ok: false, reason: 'no proposal' });
  }
});

test('fake LLM cannot bypass trusted side-effect classification', async () => {
  const result = await proposeGrowth(input, createLLMGrowthProposer(async () =>
    answer.replace('"recipe":"none"', '"recipe":"cmd:publish"')));
  expect(result).toMatchObject({ ok: false, park: true, reason: expect.stringContaining('사람 확인 필요') });
});

test('LLM errors and invalid graph variants keep the original graph with a reason', async () => {
  const error = await proposeGrowth(input, createLLMGrowthProposer(async () => { throw new Error('offline'); }));
  expect(error).toMatchObject({ ok: false, reason: expect.stringContaining('offline') });
  const invalid = await proposeGrowth(input, createLLMGrowthProposer(async () =>
    answer.replace('"nodeId":"research"', '"nodeId":"done"')));
  expect(invalid).toMatchObject({ ok: false, reason: expect.stringContaining('invalid-growth') });
  const malformedNode = await proposeGrowth(input, createLLMGrowthProposer(async () =>
    answer.replace('"nodeId":"research"', '"nodeId":null')));
  expect(malformedNode).toMatchObject({ ok: false, reason: expect.stringContaining('growth rejected:') });
  expect(graph.nodes).toHaveLength(2);
  expect(graph.edges[0]?.map).toEqual({ ok: 'done' });
});
