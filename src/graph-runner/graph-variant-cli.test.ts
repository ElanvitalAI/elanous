import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const repo = resolve(import.meta.dir, '../..');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'graph-variant-cli-'));
  dirs.push(dir);
  const graph = join(dir, 'graph.yaml');
  const state = join(dir, 'state');
  writeFileSync(graph, `graph_id: variant-cli\nversion: 1\nentry_node: start\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: start, kind: agent, recipe: 'cmd:start', max_visits: 1 }\n  - { node_id: a, kind: agent, recipe: 'cmd:a', max_visits: 1 }\n  - { node_id: b, kind: agent, recipe: 'cmd:b', max_visits: 1 }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - from: start\n    on: outcome\n    map: { alpha: a, beta: b, ok: a, fail: failed }\n  - { from: a, to: done }\n  - { from: b, to: done }\n`);
  writeFileSync(join(dir, 'recipes.yaml'), 'start:\n  command: "printf \'{\\"outcome\\":\\"alpha\\"}\\n\'"\na:\n  command: "printf a"\nb:\n  command: "printf b"\n');
  const spawn = (plan: unknown, mode: '--dry-run' | '--run' = '--run') => {
    const result = Bun.spawnSync(['bun', join(repo, 'bin/elanous.mjs'), `--test=${state}`, 'graph', 'variant', graph, '--plan', JSON.stringify(plan), mode, '--json'],
      { cwd: repo, env: { ...process.env, ELANOUS_STATE_DIR: state }, stdout: 'pipe', stderr: 'pipe' });
    return { code: result.exitCode, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
  };
  return { dir, graph, state, spawn };
}

test('two plans on the same template execute distinct persisted variant graphs through fake nodes', () => {
  const { graph, spawn } = fixture();
  const first = spawn({ routes: [{ from: 'start', outcome: 'alpha', to: 'a' }], maxVisits: { a: 2 } });
  const second = spawn({ routes: [{ from: 'start', outcome: 'alpha', to: 'b' }] });
  expect(first.code, first.stderr).toBe(0);
  expect(second.code, second.stderr).toBe(0);
  const a = JSON.parse(first.stdout);
  const b = JSON.parse(second.stdout);
  expect(a).toMatchObject({ status: 'done', path: ['start', 'a', 'done'], executed: 2 });
  expect(b).toMatchObject({ status: 'done', path: ['start', 'b', 'done'], executed: 2 });
  const aGraph = readFileSync(join(`${a.statePath}.graph`, 'graph.yaml'), 'utf8');
  const bGraph = readFileSync(join(`${b.statePath}.graph`, 'graph.yaml'), 'utf8');
  expect(aGraph).not.toBe(bGraph);
  expect(parseYaml(aGraph).edges[0].map.alpha).toBe('a');
  expect(parseYaml(aGraph).nodes[1].max_visits).toBe(2);
  expect(parseYaml(bGraph).edges[0].map.alpha).toBe('b');
  expect(JSON.parse(readFileSync(a.statePath, 'utf8')).variant.overlayId).toBeString();
  expect(JSON.parse(readFileSync(a.statePath, 'utf8')).graphSnapshot.graphSha).not.toBe(JSON.parse(readFileSync(b.statePath, 'utf8')).graphSnapshot.graphSha);
  expect(readFileSync(graph, 'utf8')).toContain('alpha: a');
});

test('a route plan without a budget also executes the changed route', () => {
  const { spawn } = fixture();
  const result = spawn({ routes: [{ from: 'start', outcome: 'alpha', to: 'b' }] });
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: 'done', path: ['start', 'b', 'done'], executed: 2 });
});

test('ambiguous outcome plan is rejected before ledger or node execution', () => {
  const { graph, state, spawn } = fixture();
  const original = readFileSync(graph, 'utf8');
  writeFileSync(graph, original.replace('  - { from: a, to: done }', '  - from: start\n    on: outcome\n    map: { alpha: b }\n  - { from: a, to: done }'));
  const rejected = spawn({ routes: [{ from: 'start', outcome: 'alpha', to: 'b' }] });
  expect(rejected.code).toBe(1);
  expect(rejected.stderr).toContain('ambiguous-outcome');
  expect(rejected.stdout).toBe('');
  expect(existsSync(join(state, 'graph-runs'))).toBe(false);
});

test('variant preserves unrelated node and edge metadata in its runnable snapshot', () => {
  const { graph, spawn } = fixture();
  const original = readFileSync(graph, 'utf8');
  writeFileSync(graph, original.replace("recipe: 'cmd:a', max_visits: 1", "recipe: 'cmd:a', max_visits: 1, progress: [processing]")
    .replace('map: { alpha: a, beta: b, ok: a, fail: failed }', 'map: { alpha: a, beta: b, ok: a, fail: failed }\n    observed: 3'));
  const result = spawn({ routes: [{ from: 'start', outcome: 'alpha', to: 'b' }] });
  expect(result.code, result.stderr).toBe(0);
  const state = JSON.parse(result.stdout);
  expect(state.path).toEqual(['start', 'b', 'done']);
  const saved = parseYaml(readFileSync(join(`${state.statePath}.graph`, 'graph.yaml'), 'utf8'));
  expect(saved.nodes[1].progress).toEqual(['processing']);
  expect(saved.edges[0].observed).toBe(3);
});

test('growth plan executes a new contracted fake node and persists its runnable YAML', () => {
  const { graph, spawn } = fixture();
  const recipes = join(graph, '../recipes.yaml');
  writeFileSync(recipes, 'start:\n  command: "printf \'{\\"outcome\\":\\"gamma\\"}\\n\'"\na:\n  command: "printf a"\nb:\n  command: "printf b"\nc:\n  command: "printf c"\n');
  const result = spawn({ growth: {
    node: { nodeId: 'c', kind: 'agent', recipe: 'cmd:c', maxVisits: 1,
      contract: { inputs: [], tools: 'fake', outputs: [] } },
    from: 'start', outcome: 'gamma', returnTo: 'done',
  } });
  expect(result.code, result.stderr).toBe(0);
  const state = JSON.parse(result.stdout);
  expect(state).toMatchObject({ status: 'done', path: ['start', 'c', 'done'], executed: 2 });
  const saved = parseYaml(readFileSync(join(`${state.statePath}.graph`, 'graph.yaml'), 'utf8'));
  expect(saved.nodes.find((node: { node_id: string }) => node.node_id === 'c').contract.tools).toBe('fake');
  expect(saved.edges[0].map.gamma).toBe('c');
  expect(saved.edges.at(-1)).toMatchObject({ from: 'c', to: 'done' });
});

test('unknown plan fields are rejected without starting a graph run', () => {
  const { state, spawn } = fixture();
  const invalid = spawn({ routes: [], ignored: true });
  expect(invalid.code).toBe(1);
  expect(invalid.stderr).toContain('--plan must be a JSON variant plan');
  expect(existsSync(join(state, 'graph-runs'))).toBe(false);
});

test('a paused variant resumes from its saved graph after the original template changes', () => {
  const { graph, state, spawn } = fixture();
  const recipes = join(graph, '../recipes.yaml');
  writeFileSync(recipes, 'start:\n  command: "printf \'{\\"outcome\\":\\"alpha\\"}\\n\'"\na:\n  command: "printf a"\nb:\n  command: "printf b"\nstop:\n  approval: "Continue?"\n');
  const original = readFileSync(graph, 'utf8');
  writeFileSync(graph, original.replace("recipe: 'cmd:b'", "recipe: 'approval:stop'"));
  const first = spawn({ routes: [{ from: 'start', outcome: 'alpha', to: 'b' }] });
  expect(first.code, first.stderr).toBe(0);
  const pending = JSON.parse(first.stdout);
  expect(pending).toMatchObject({ status: 'awaiting-approval', path: ['start', 'b'] });
  writeFileSync(graph, original);
  const cli = (...args: string[]) => Bun.spawnSync(['bun', join(repo, 'bin/elanous.mjs'), `--test=${state}`, 'graph', ...args],
    { cwd: repo, env: { ...process.env, ELANOUS_STATE_DIR: state }, stdout: 'pipe', stderr: 'pipe' });
  expect(cli('approve', pending.graphId, pending.runId).exitCode).toBe(0);
  const resumed = cli('runs', 'resume', pending.runId, '--json');
  expect(resumed.exitCode, new TextDecoder().decode(resumed.stderr)).toBe(0);
  expect(JSON.parse(new TextDecoder().decode(resumed.stdout))).toMatchObject({ status: 'done', path: ['start', 'b', 'done'] });
});

test('ordinary graph run preserves its unmodified template snapshot and omits variant metadata', () => {
  const { graph, state } = fixture();
  const original = readFileSync(graph, 'utf8');
  const proc = Bun.spawnSync(['bun', join(repo, 'bin/elanous.mjs'), `--test=${state}`, 'graph', 'run', graph, '--json'],
    { cwd: repo, env: { ...process.env, ELANOUS_STATE_DIR: state }, stdout: 'pipe', stderr: 'pipe' });
  expect(proc.exitCode, new TextDecoder().decode(proc.stderr)).toBe(0);
  const result = JSON.parse(new TextDecoder().decode(proc.stdout));
  expect(result).toMatchObject({ status: 'done', path: ['start', 'a', 'done'], executed: 2 });
  expect(result).not.toHaveProperty('variant');
  expect(readFileSync(join(`${result.statePath}.graph`, 'graph.yaml'), 'utf8')).toBe(original);
});

test('dry-run keeps commands unexecuted and retains the proposed graph beside its ledger', () => {
  const { spawn } = fixture();
  const result = spawn({ maxVisits: { a: 3 } }, '--dry-run');
  expect(result.code, result.stderr).toBe(0);
  const state = JSON.parse(result.stdout);
  expect(state).toMatchObject({ status: 'done', executed: 0, dryRun: true });
  expect(parseYaml(readFileSync(join(`${state.statePath}.graph`, 'graph.yaml'), 'utf8')).nodes[1].max_visits).toBe(3);
});
