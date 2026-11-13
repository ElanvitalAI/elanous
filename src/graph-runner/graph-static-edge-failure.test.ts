import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from './runner.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('a failed node on a static edge stops before downstream effects and leaves the graph failed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-static-failure-'));
  roots.push(root);
  writeFileSync(join(root, 'recipes.yaml'), 'write:\n  command: write\nnotify:\n  command: notify\n');
  const graph = join(root, 'graph.yaml');
  writeFileSync(graph, [
    'graph_id: static-failure', 'version: 1', 'entry_node: write', 'terminal_nodes: [done, failed]', 'nodes:',
    '  - { node_id: write, kind: agent, recipe: "cmd:write", max_visits: 1 }',
    '  - { node_id: notify, kind: agent, recipe: "cmd:notify", max_visits: 1 }',
    '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }',
    'edges:', '  - { from: write, to: notify }', '  - { from: notify, to: done }', '',
  ].join('\n'));
  const calls: string[] = [];
  const failed = await runGraph(graph, { deps: { root, runBash: async (command) => {
    calls.push(command);
    return { stdout: '', stderr: 'write rejected', exitCode: 1 };
  } } });
  expect(failed.status).toBe('failed');
  expect(failed.path).toEqual(['write']);
  expect(failed.nodes[0]).toMatchObject({ nodeId: 'write', ok: false });
  expect(calls).toEqual(['write']);

  const succeeded = await runGraph(graph, { deps: { root, runBash: async (command) => {
    calls.push(command);
    return { stdout: '', stderr: '', exitCode: 0 };
  } } });
  expect(succeeded.status).toBe('done');
  expect(succeeded.path).toEqual(['write', 'notify', 'done']);
  expect(calls).toEqual(['write', 'write', 'notify']);
});
