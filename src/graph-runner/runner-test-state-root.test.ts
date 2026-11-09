import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from './runner.js';
import { setTestStateRoot } from '../nexus/paths.js';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';

const roots: string[] = [];
afterEach(() => {
  setTestStateRoot(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('runGraph stores its ledger and pins child state to setTestStateRoot', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'graph-runner-test-state-root-'));
  roots.push(fixture);
  const graphDir = join(fixture, 'graph');
  const stateRoot = join(fixture, 'test-state');
  const stampedRoot = join(fixture, 'parent-stamp');
  const configRoot = join(fixture, 'config-override');
  mkdirSync(graphDir, { recursive: true });
  writeFileSync(join(graphDir, 'recipes.yaml'), 'action:\n  command: "printf safe"\n');
  const graph = join(graphDir, 'graph.yaml');
  writeFileSync(graph, [
    'graph_id: test-state-root-sim',
    'version: 1',
    'entry_node: action',
    'terminal_nodes: [done, failed]',
    'nodes:',
    '  - { node_id: action, kind: agent, recipe: "cmd:action", max_visits: 1 }',
    '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }',
    'edges:',
    '  - { from: action, on: outcome, map: { ok: done, fail: failed } }',
    '',
  ].join('\n'));

  const previousState = process.env.ELANOUS_STATE_DIR;
  const previousConfig = getElanousConfigDirOverride();
  process.env.ELANOUS_STATE_DIR = stampedRoot;
  setElanousConfigDir(configRoot);
  setTestStateRoot(stateRoot);
  let childStateRoot: string | undefined;
  try {
    const result = await runGraph(graph, {
      runId: 'isolated-run',
      deps: { runBash: async (_command, options) => {
        childStateRoot = options.env?.ELANOUS_STATE_DIR;
        return { stdout: '{"outcome":"ok"}', stderr: '', exitCode: 0 };
      } },
    });

    expect(result.status).toBe('done');
    expect(result.statePath).toBe(join(stateRoot, 'graph-runs', 'test-state-root-sim', 'isolated-run.json'));
    expect(childStateRoot).toBe(stateRoot);
    expect(existsSync(join(stampedRoot, 'graph-runs'))).toBe(false);
  } finally {
    setTestStateRoot(null);
    if (previousConfig === undefined) resetElanousConfigDir();
    else setElanousConfigDir(previousConfig);
    if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousState;
  }
});
