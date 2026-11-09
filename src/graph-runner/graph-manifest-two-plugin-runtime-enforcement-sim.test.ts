import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraphPluginFromDir } from './graph-manifest-loader.js';
import { runGraph } from './runner.js';

function graph(id: string, recipe: string): string {
  return `graph_id: ${id}\nversion: 1\nentry_node: work\nterminal_nodes: [done, failed]\nnodes:\n` +
    `  - { node_id: work, kind: agent, recipe: '${recipe}', max_visits: 1 }\n` +
    `  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n` +
    `  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\n` +
    `edges:\n  - from: work\n    on: outcome\n    map: { ok: done, fail: failed, error: failed }\n`;
}

test('release and train plugins share the loader; runtime rejects an undeclared call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-two-plugin-sim-'));
  const calls: string[] = [];
  try {
    for (const id of ['release-sim', 'train-sim']) {
      const dir = join(root, id);
      mkdirSync(dir);
      writeFileSync(join(dir, 'graph.yaml'), graph(id, 'cmd:allowed'));
      writeFileSync(join(dir, 'recipes.yaml'), 'allowed:\n  command: allowed\noutside:\n  command: outside\n');
      writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: id, version: '1.0.0', extensions: {
        'ai.elanous': { graphs: ['./graph.yaml'], graphManifests: { [id]: {
          purpose: `${id} simulation`, allow: { recipes: ['cmd:allowed'] }, hitl: [],
        } } },
      } }));
      expect(loadGraphPluginFromDir(dir).graphs[id]?.template.graphId).toBe(id);
      const path = join(dir, 'graph.yaml');
      const deps = { root: join(root, `state-${id}`), runBash: async (command: string) => {
        calls.push(`${id}:${command}`);
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      } };
      const result = await runGraph(path, { deps });
      expect(result.status).toBe('done');
      expect(calls).toContain(`${id}:allowed`);
      const before = calls.length;
      await expect(runGraph(path, { deps, graphSource: graph(id, 'cmd:outside') }))
        .rejects.toThrow('graph.manifest-denied: recipe cmd:outside');
      expect(calls).toHaveLength(before);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
