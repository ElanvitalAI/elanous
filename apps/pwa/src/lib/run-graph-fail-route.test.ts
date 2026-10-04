import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from '../../../../src/graph-runner/runner';
import { readRunGraphYaml, runGraphFailTarget, setRunGraphFailTarget, writeRunGraphYaml } from './run-graph-yaml-edit';

test('a failed node follows the failure target saved by the graph editor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-editor-fail-'));
  try {
    const file = join(root, 'graph.yaml');
    const source = `graph_id: editor-fail
version: 1
entry_node: start
terminal_nodes: [done, failed]
nodes:
  - { node_id: start, kind: agent, recipe: 'cmd:start', max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - { from: start, to: done }
`;
    writeFileSync(join(root, 'recipes.yaml'), 'start:\n  command: "exit 1"\n');
    const doc = readRunGraphYaml(source);
    setRunGraphFailTarget(doc, 'start', 'failed');
    const saved = writeRunGraphYaml(doc);
    expect(runGraphFailTarget(readRunGraphYaml(saved), 'start')).toBe('failed');
    writeFileSync(file, saved);
    const state = await runGraph(file, { deps: { root, runBash: async () => ({ stdout: '', stderr: '', exitCode: 1 }) } });
    expect(state.path).toEqual(['start', 'failed']);
    expect(state.status).toBe('failed');
    expect(state.nodes[0]).toMatchObject({ nodeId: 'start', ok: false, exit: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
