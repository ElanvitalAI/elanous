import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runGraph, validateUnitCalls } from '../src/graph-runner/runner';
import { parseGraphTemplateYaml } from '../src/self-implement/graph-yaml';

test('LOOPS: four landing refusal routes resolve the same bounded recover@1 contract', () => {
  for (const name of ['research', 'document', 'operate', 'default']) {
    const path = resolve(import.meta.dir, '..', 'graphs', `${name}-loop.yaml`);
    const parsed = parseGraphTemplateYaml(readFileSync(path, 'utf8'), path);
    expect(parsed.errors).toEqual([]);
    const graph = parsed.template!;
    const call = validateUnitCalls(graph, path).get('recover');
    expect(call?.template.graphId).toBe('recover');
    expect(graph.edges.find(edge => edge.from === 'merge')?.map).toMatchObject({
      merged: 'landed', 'land-refused': 'recover',
      ok: name === 'default' ? 'stopped' : 'needs-human',
      fail: name === 'default' ? 'stopped' : 'needs-human',
      ...(name === 'default' ? { blocked: 'stopped' } : {}),
    });
    expect(graph.edges.find(edge => edge.from === 'recover')?.map).toMatchObject({
      done: name === 'default' ? 'stopped' : 'needs-human',
      rework: name === 'default' ? 'stopped' : 'needs-human',
      'needs-human': name === 'default' ? 'stopped' : 'needs-human',
      failed: name === 'default' ? 'stopped' : 'needs-human',
    });
  }
});

test('LOOPS: isolated parent fixture executes the checked-in recover@1 unit for a pinned PR refusal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-loop-recover-'));
  const graph = join(root, 'parent.yaml');
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  writeFileSync(join(root, 'recipes.yaml'), `refuse:\n  command: >-\n    printf '%s' '{"outcome":"land-refused","result":"landing refused"}'\n`);
  writeFileSync(graph, `graph_id: recovery-parent-test\nversion: 1\nentry_node: merge\nterminal_nodes: [failed]\nnodes:\n  - { node_id: merge, kind: agent, recipe: 'cmd:refuse', max_visits: 1 }\n  - node_id: recover\n    kind: subgraph\n    recipe: none\n    max_visits: 1\n    call: recover@1\n    budget: { inner_steps: 4 }\n    contract: { inputs: [ask, context, prior], tools: read-only, outputs: [result, evidence] }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: merge, on: outcome, map: { land-refused: recover, fail: failed } }\n  - { from: recover, on: outcome, map: { done: failed, rework: failed, needs-human: failed, failed: failed } }\n`);
  try {
    const parent = await runGraph(graph, {
      input: { ask: 'Classify this PR landing refusal', context: {
        refusal: '✗ heavy-remote: 원격 게이트 gate-host-busy', pr: 29103, head: 'a'.repeat(40),
      } },
      deps: { root, log: (event, data) => { events.push({ event, data }); } },
    });
    expect(parent.path).toEqual(['merge', 'recover', 'failed']);
    expect(parent.status).toBe('failed');
    expect(parent.unitCalls).toMatchObject([{ unit: 'recover', exit: 'rework', steps: 2 }]);
    expect(JSON.parse(String(parent.nodes.find(node => node.nodeId === 'recover')?.output))).toMatchObject({
      outcome: 'rework', result: { action: 'wait-retry', pr: 29103, head: 'a'.repeat(40) },
      evidence: { label: 'gate-host-busy', source: 'graph' },
    });
    expect(events.filter(entry => entry.event === 'graph.unit').map(entry => entry.data.phase)).toEqual(['enter', 'exit']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
