import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from './runner.js';
import { setPluginCredentials } from '../plugins/install/plugin-credentials.js';

async function withWorld(run: (root: string, healthy: string, broken: string, outside: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'graph-credential-scope-'));
  const keys = ['ELANOUS_STATE_DIR', 'SCOPE_EXA_KEY', 'SCOPE_FIRECRAWL_KEY', 'ELANOUS_PLUGIN_BROKEN_PLUGIN_OPTIONAL'];
  const previous = keys.map(key => process.env[key]);
  process.env.ELANOUS_STATE_DIR = root;
  try {
    const install = (name: string, connectors: unknown[]) => {
      const path = join(root, 'plugins', 'local', name, '1.0.0');
      mkdirSync(join(path, 'graphs'), { recursive: true });
      writeFileSync(join(path, 'plugin.ts'), 'export default {}');
      writeFileSync(join(path, 'plugin.json'), JSON.stringify({ id: name, version: '1.0.0', main: './plugin.ts', contributes: { connectors } }));
      return path;
    };
    const healthy = install('healthy-plugin', [{ id: 'own', fields: [{ name: 'KEY', env: 'SCOPE_HEALTHY_KEY' }] }]);
    const broken = install('broken-plugin', [
      { id: 'exa', fields: [{ name: 'apiKey', env: 'SCOPE_EXA_KEY' }] },
      { id: 'firecrawl', fields: [{ name: 'apiKey', env: 'SCOPE_FIRECRAWL_KEY' }] },
      { id: 'optional', userConfig: [{ key: 'OPTIONAL', type: 'string' }] },
    ]);
    setPluginCredentials('healthy-plugin', { KEY: 'synthetic-owner-secret' }, root);
    mkdirSync(join(root, 'plugins', 'credentials'), { recursive: true });
    // An unrelated plugin's private credential storage must not even be read.
    writeFileSync(join(root, 'plugins', 'credentials', 'broken-plugin.json'), '{invalid-json');
    for (const key of keys.slice(1)) process.env[key] = 'synthetic-inherited-secret';
    const graph = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'recipes.yaml'), 'work:\n  command: "exit 0"\n');
      const path = join(dir, 'scope.yaml');
      writeFileSync(path, 'graph_id: credential-scope\nversion: 1\nentry_node: work\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: work, kind: agent, recipe: "cmd:work", max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - from: work\n    on: outcome\n    map: { ok: done, fail: failed }\n');
      return path;
    };
    await run(root, graph(join(healthy, 'graphs')), graph(join(broken, 'graphs')), graph(join(root, 'outside')));
  } finally {
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    rmSync(root, { recursive: true, force: true });
  }
}

test('healthy and standalone graphs ignore unrelated credential collisions and strip every inherited credential env', async () => {
  await withWorld(async (root, healthy, _broken, outside) => {
    for (const graph of [healthy, outside]) {
      let calls = 0;
      const state = await runGraph(graph, { deps: { root, runBash: async (_body, options) => {
        calls++;
        expect(options.env?.SCOPE_EXA_KEY).toBeUndefined();
        expect(options.env?.SCOPE_FIRECRAWL_KEY).toBeUndefined();
        expect(options.env?.ELANOUS_PLUGIN_BROKEN_PLUGIN_OPTIONAL).toBeUndefined();
        expect(options.env?.SCOPE_HEALTHY_KEY).toBe(graph === healthy ? 'synthetic-owner-secret' : undefined);
        return { stdout: 'synthetic-owner-secret', stderr: '', exitCode: 0 };
      } } });
      expect(state.status).toBe('done');
      expect(calls).toBe(1);
      if (graph === healthy) expect(JSON.stringify(state)).not.toContain('synthetic-owner-secret');
    }
  });
});

test('the executing plugin still rejects its own conflicting credential declaration before effects', async () => {
  await withWorld(async (root, _healthy, broken) => {
    let calls = 0;
    await expect(runGraph(broken, { deps: { root, runBash: async () => {
      calls++; return { stdout: '', stderr: '', exitCode: 0 };
    } } })).rejects.toThrow('conflicting plugin credential environment name');
    expect(calls).toBe(0);
  });
});
