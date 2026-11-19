import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from './runner.js';

// GRAPH-LLM-JSON-OUTPUT PR-2: the real runner — a prompt recipe's `output` spec, its retry, and the `outcome` edges read.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function graphWith(node: string, map: string, recipes: string): { graph: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'graph-json-output-'));
  dirs.push(root);
  writeFileSync(join(root, 'recipes.yaml'), recipes);
  const graph = join(root, 'graph.yaml');
  writeFileSync(graph, `graph_id: json-output\nversion: 1\nentry_node: judge\nterminal_nodes: [done, failed]\nnodes:\n`
    + `  - ${node}\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: rejected, kind: gate, max_visits: 1 }\n`
    + `  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - from: judge\n    on: outcome\n    map: ${map}\n  - from: rejected\n    to: failed\n`);
  return { graph, root };
}
const promptNode = "{ node_id: judge, kind: prompt, recipe: 'prompt:judge', max_visits: 1 }";
const judgeRecipe = (output: string) => `judge:\n  prompt: 'Judge $ARGUMENTS'\n  output: ${output}\n`;
const noBash = async () => { throw new Error('prompt must not run bash'); };

test('a prompt with an output spec retries a prose reply, stores the JSON, and routes on its outcome', async () => {
  const { graph, root } = graphWith(promptNode, '{ approve: done, reject: rejected, ok: done, fail: failed }',
    judgeRecipe('{ fields: { verdict: [approve, reject], reason: string }, outcome: verdict, retries: 1 }'));
  const replies = ['Looks risky to me.', '{"verdict":"reject","reason":"no tests"}'];
  const prompts: string[] = [];
  const state = await runGraph(graph, { input: 'PR 1', deps: { root, runBash: noBash, callLLM: async (text) => { prompts.push(text); return replies.shift()!; } } });
  expect(state.path).toEqual(['judge', 'rejected', 'failed']);
  expect(state.nodes[0]).toMatchObject({ nodeId: 'judge', ok: true, output: '{"verdict":"reject","reason":"no tests","outcome":"reject"}' });
  expect(prompts.map((text) => text.split('\n\n')[1])).toEqual([
    'Reply with only one JSON object: { "verdict": "approve" | "reject", "reason": string }.',
    'Your previous reply was not usable: no JSON object in the reply. Reply with only one JSON object: { "verdict": "approve" | "reject", "reason": string }.',
  ]);
});

test('a reply that never meets the spec fails the node with the reason and takes the fail edge', async () => {
  const { graph, root } = graphWith(promptNode, '{ approve: done, ok: done, fail: failed }',
    judgeRecipe('{ fields: { verdict: [approve, reject] }, outcome: verdict, retries: 0 }'));
  const state = await runGraph(graph, { input: 'PR 2', deps: { root, runBash: noBash, callLLM: async () => '{"verdict":"maybe"}' } });
  expect(state.path).toEqual(['judge', 'failed']);
  expect(state.nodes[0]).toMatchObject({ ok: false, output: '{"attempts":1}',
    error: 'output schema not met after 1 attempts: field verdict must be one of approve|reject' });
});

test('a malformed output spec refuses the recipe before anything runs', async () => {
  const { graph, root } = graphWith(promptNode, '{ ok: done, fail: failed }', judgeRecipe('{ fields: { verdict: string }, outcome: verdict }'));
  await expect(runGraph(graph, { input: 'x', deps: { root, runBash: noBash, callLLM: async () => '{}' } }))
    .rejects.toThrow('invalid recipe: judge: output.outcome must be an enum (list) field');
});

test('classify: the class becomes the outcome only where the edge maps it; ok/fail maps keep the exit outcome', async () => {
  const classifyNode = "{ node_id: judge, kind: classify, recipe: 'none', max_visits: 1 }";
  const input = { arguments: 'login page is blank', classify: { input: '$ARGUMENTS', classes: ['bug', 'feature'] } };
  const deps = (root: string) => ({ root, runBash: noBash, callLLM: async () => 'bug' });
  const mapped = graphWith(classifyNode, '{ bug: rejected, ok: done, fail: failed }', '{}\n');
  const routed = await runGraph(mapped.graph, { input, deps: deps(mapped.root) });
  expect([routed.path, JSON.parse(String(routed.nodes[0]?.output)).outcome]).toEqual([['judge', 'rejected', 'failed'], 'bug']);
  const plain = graphWith(classifyNode, '{ ok: done, fail: failed }', '{}\n');
  const unchanged = await runGraph(plain.graph, { input, deps: deps(plain.root) });
  expect([unchanged.path, JSON.parse(String(unchanged.nodes[0]?.output)).outcome]).toEqual([['judge', 'done'], undefined]);
});
