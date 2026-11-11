import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { runGraph } from './runner.js';

test('declared subgraph value schemas reject bad input before dispatch and bad child output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-unit-schema-'));
  const unitDir = join(root, 'units');
  const graph = join(root, 'graph.yaml');
  try {
    mkdirSync(unitDir);
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    writeFileSync(join(unitDir, 'recipes.yaml'), 'produce:\n  command: "printf produced"\n');
    writeFileSync(graph, `graph_id: parent
version: 1
entry_node: invoke
terminal_nodes: [done, failed]
nodes:
  - node_id: invoke
    kind: subgraph
    recipe: none
    max_visits: 1
    call: worker@1
    budget: { inner_steps: 3 }
    contract: { inputs: [request], tools: read-only, outputs: [answer], input_schema: { type: object, required: [request], properties: { request: { type: string } } }, output_schema: { type: object, required: [answer], properties: { answer: { type: string } } } }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: invoke, on: outcome, map: { done: done, failed: failed } }
`);
    writeFileSync(join(unitDir, 'worker.yaml'), `graph_id: worker
version: 1
unit: { inputs: [request], outputs: [answer], exits: [done, failed] }
entry_node: produce
terminal_nodes: [done, failed]
nodes:
  - { node_id: produce, kind: agent, recipe: 'cmd:produce', max_visits: 1 }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: produce, on: outcome, map: { ok: done, fail: failed } }
`);
    const deps = { root, runBash: async () => ({ stdout: '{"answer":"world"}', stderr: '', exitCode: 0 }) };
    const valid = await runGraph(graph, { input: { request: 'hello' }, deps, quiet: true });
    expect(valid.status).toBe('done');
    const invalidInput = await runGraph(graph, { input: { request: 42 }, deps, quiet: true });
    expect(invalidInput.status).toBe('failed');
    expect(invalidInput.nodes[0]?.error).toContain('unit input schema mismatch');
    expect(invalidInput.unitCalls).toBeUndefined();
    const invalidOutput = await runGraph(graph, { input: { request: 'hello' }, quiet: true, deps: { root,
      runBash: async () => ({ stdout: '{"answer":42}', stderr: '', exitCode: 0 }) } });
    expect(invalidOutput.status).toBe('failed');
    expect(invalidOutput.nodes[0]?.error).toContain('unit output schema mismatch');
    writeFileSync(graph, readFileSync(graph, 'utf8').replace('type: string', 'type: made-up'));
    await expect(runGraph(graph, { input: { request: 'hello' }, deps, quiet: true })).rejects.toThrow('contract/input_schema');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
