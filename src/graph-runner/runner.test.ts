import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setPluginCredentials } from '../plugins/install/plugin-credentials.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { decideGraphApproval, latestGraphRun, manageGraphRun, runGraph } from './runner.js';
import { getElanousConfigDir, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { debug } from '../debug/log.js';
import { readFailureInbox, recordFailureEvent } from '../self-implement/heal-intake.js';
import type { DecisionEntry } from '../decisions/decision-ledger.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(command: string, loop = false): { graph: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'graph-runner-'));
  dirs.push(root);
  writeFileSync(join(root, 'recipes.yaml'), `first:\n  command: "${command}"\nsecond:\n  command: "exit 0"\n`);
  const graph = join(root, 'graph.yaml');
  writeFileSync(graph, `graph_id: test-graph\nversion: 1\nentry_node: first\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: first, kind: agent, recipe: 'cmd:first', max_visits: 1 }\n  - { node_id: second, kind: agent, recipe: 'cmd:second', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - from: first\n    on: outcome\n    map: { ok: ${loop ? 'first' : 'second'}, fail: failed }\n  - from: second\n    on: outcome\n    map: { ok: done, fail: failed }\n`);
  return { graph, root };
}

// A real ledger resolves release versions from git (seconds); park tests only need a card id.
function fakeGrowthDecision() {
  const entries: DecisionEntry[] = [];
  return { ledger: { raiseOnce: (value: Record<string, unknown>) => {
    const entry = { ...value, id: `D-fake-${entries.length + 1}`, status: 'open' } as DecisionEntry;
    entries.push(entry);
    return entry;
  } }, list: () => entries };
}

function approvalFixture(): { graph: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'graph-approval-'));
  dirs.push(root);
  writeFileSync(join(root, 'recipes.yaml'), 'a:\n  command: "exit 0"\ngate:\n  approval: "Publish now?"\nb:\n  command: "exit 0"\n');
  const graph = join(root, 'graph.yaml');
  writeFileSync(graph, `graph_id: approval-graph
version: 1
entry_node: a
terminal_nodes: [done, failed]
nodes:
  - { node_id: a, kind: agent, recipe: 'cmd:a', max_visits: 1 }
  - { node_id: gate, kind: judge, recipe: 'approval:gate', max_visits: 1 }
  - { node_id: b, kind: agent, recipe: 'cmd:b', max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - { from: a, to: gate }
  - from: gate
    on: outcome
    map: { ok: b, fail: failed }
  - { from: b, to: done }
`);
  return { graph, root };
}

test('installed plugin graphs receive only their own credential environment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-credential-'));
  dirs.push(root);
  const previous = process.env.ELANOUS_STATE_DIR;
  const previousOwn = process.env.SAMPLE_PLUGIN_KEY;
  const previousOther = process.env.OTHER_PLUGIN_KEY;
  process.env.ELANOUS_STATE_DIR = root;
  try {
    for (const name of ['sample-plugin', 'other-plugin']) {
      const path = join(root, 'plugins', 'local', name, '1.0.0');
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'plugin.ts'), 'export default {}');
      writeFileSync(join(path, 'plugin.json'), JSON.stringify({ id: name, version: '1.0.0', main: './plugin.ts',
        contributes: { connectors: [{ id: 'service', fields: [{ name: 'KEY', env: `${name.replace('-', '_').toUpperCase()}_KEY` }] }] } }));
    }
    setPluginCredentials('sample-plugin', { KEY: 'sample-secret' }, root);
    setPluginCredentials('other-plugin', { KEY: 'other-secret' }, root);
    const { graph: source } = fixture('exit 0');
    const graph = join(root, 'plugins', 'local', 'sample-plugin', '1.0.0', 'graphs', 'graph.yaml');
    mkdirSync(join(graph, '..'), { recursive: true });
    writeFileSync(graph, readFileSync(source, 'utf8'));
    writeFileSync(join(graph, '..', 'recipes.yaml'), readFileSync(join(source, '..', 'recipes.yaml'), 'utf8')
      .replaceAll('command: "exit 0"', 'command: "exit 0"\n  dry_run_command: "exit 0"'));
    const envs: NodeJS.ProcessEnv[] = [];
    process.env.OTHER_PLUGIN_KEY = 'inherited-other-secret';
    process.env.SAMPLE_PLUGIN_KEY = 'inherited-own-secret';
    const run = await runGraph(graph, { deps: { root, runBash: async (_body, opts) => {
      envs.push(opts.env!);
      return { stdout: 'sample-secret', stderr: '', exitCode: 0 };
    } } });
    expect(run.status).toBe('done');
    expect(envs).toHaveLength(2);
    expect(envs[0]?.SAMPLE_PLUGIN_KEY).toBe('sample-secret');
    expect(envs[0]?.OTHER_PLUGIN_KEY).toBeUndefined();
    expect(JSON.stringify(run.nodes)).toContain('[REDACTED]');
    expect(JSON.stringify(run)).not.toContain('sample-secret');
    expect(JSON.stringify(run)).not.toContain('other-secret');
    envs.length = 0;
    const preview = await runGraph(graph, { dryRun: true, deps: { root, runBash: async (_body, opts) => {
      envs.push(opts.env!);
      return { stdout: 'sample-secret', stderr: '', exitCode: 0 };
    } } });
    expect(preview.status).toBe('done');
    expect(envs).toHaveLength(2);
    expect(envs[0]?.SAMPLE_PLUGIN_KEY).toBe('sample-secret');
    expect(envs[0]?.OTHER_PLUGIN_KEY).toBeUndefined();
    expect(JSON.stringify(preview)).not.toContain('sample-secret');
    const outside = await runGraph(source, { deps: { root, runBash: async (_body, opts) => {
      expect(opts.env?.SAMPLE_PLUGIN_KEY).toBeUndefined();
      expect(opts.env?.OTHER_PLUGIN_KEY).toBeUndefined();
      return { stdout: '', stderr: '', exitCode: 0 };
    } } });
    expect(outside.status).toBe('done');
  } finally {
    if (previousOther === undefined) delete process.env.OTHER_PLUGIN_KEY;
    else process.env.OTHER_PLUGIN_KEY = previousOther;
    if (previousOwn === undefined) delete process.env.SAMPLE_PLUGIN_KEY;
    else process.env.SAMPLE_PLUGIN_KEY = previousOwn;
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
  }
});

test('first write and approval resume stamp the runner pid and its process start', async () => {
  const { graph, root } = approvalFixture();
  let started = 1_000_000;
  const deps = { root, processStartMs: () => started, runBash: async () => {
    const files = join(root, 'graph-runs', 'approval-graph');
    const initial = JSON.parse(readFileSync(join(files, 'owner-check.json'), 'utf8'));
    expect(initial).toMatchObject({ pid: process.pid, pidStartedAt: new Date(started).toISOString() });
    return { stdout: '', stderr: '', exitCode: 0 };
  } };
  const first = await runGraph(graph, { runId: 'owner-check', deps });
  expect(JSON.parse(readFileSync(first.statePath, 'utf8'))).toMatchObject({ pid: process.pid, pidStartedAt: new Date(started).toISOString() });
  decideGraphApproval(first.graphId, first.runId, 'approved', 'operator', root);
  started += 10_000;
  const resumed = await runGraph(graph, { resumeRunId: first.runId, deps });
  expect(resumed.pid).toBe(process.pid);
  expect(JSON.parse(readFileSync(first.statePath, 'utf8')).pidStartedAt).toBe(new Date(started).toISOString());
});

test('stop during a new run prevents its node completion from overwriting the failed ledger', async () => {
  const { graph, root } = fixture('exit 0');
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const ongoing = runGraph(graph, { runId: 'concurrent-stop', deps: { root, runBash: async () => {
    entered();
    await blocked;
    return { stdout: '', stderr: '', exitCode: 0 };
  } } });
  await started;
  const file = join(root, 'graph-runs', 'test-graph', 'concurrent-stop.json');
  try {
    manageGraphRun('test-graph', 'concurrent-stop', 'stop', root, () => null);
  } finally { release(); }
  await expect(ongoing).rejects.toThrow('run was stopped or ownership changed');
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ status: 'failed', stoppedAt: expect.any(String) });
});

test('a command that exits before its pid start can be measured still completes', async () => {
  const { graph, root } = fixture('true');
  const state = await runGraph(graph, { deps: { root, processStartMs: pid => pid === process.pid ? Date.now() - process.uptime() * 1_000 : null } });
  expect(state.status).toBe('done');
  expect(state.nodes[0]).toMatchObject({ nodeId: 'first', ok: true, exit: 0 });
});

test('an unverified child still running is terminated rather than accepted as an unowned node', async () => {
  const { graph, root } = fixture('sleep 5');
  const state = await runGraph(graph, { deps: { root, processStartMs: pid => pid === process.pid ? Date.now() - process.uptime() * 1_000 : null } });
  expect(state.status).toBe('failed');
  expect(state.nodes[0]?.ok).toBe(false);
});

test('two successful commands reach done and persist both outcomes', async () => {
  const { graph, root } = fixture('exit 0');
  const result = await runGraph(graph, { runId: 'success', deps: { root } });
  expect(result.status).toBe('done');
  expect(result.path).toEqual(['first', 'second', 'done']);
  expect(result.executed).toBe(2);
  expect(existsSync(join(root, 'heal', 'inbox.jsonl'))).toBe(false);
  expect(JSON.parse(readFileSync(result.statePath, 'utf8')).nodes.slice(0, 2)).toEqual([
    { nodeId: 'first', ok: true, exit: 0, executed: true, output: '', startedAt: expect.any(String), endedAt: expect.any(String), seconds: expect.any(Number) },
    { nodeId: 'second', ok: true, exit: 0, executed: true, output: '', startedAt: expect.any(String), endedAt: expect.any(String), seconds: expect.any(Number) },
  ]);
});

function expectNodeTimes(record: { startedAt?: string; endedAt?: string; seconds?: number } | undefined): void {
  expect(record?.startedAt).toBe(new Date(Date.parse(record!.startedAt!)).toISOString());
  expect(record?.endedAt).toBe(new Date(Date.parse(record!.endedAt!)).toISOString());
  expect(Date.parse(record!.startedAt!)).toBeLessThanOrEqual(Date.parse(record!.endedAt!));
  expect(record!.seconds).toBeGreaterThanOrEqual(0);
}

test('GRAPH-NODE-TIMES: each run node records start, end and seconds in the ledger, and no running node is left behind', async () => {
  const { graph, root } = fixture('sleep 0.2');
  const result = await runGraph(graph, { runId: 'timed', deps: { root } });
  const saved = JSON.parse(readFileSync(result.statePath, 'utf8'));
  for (const record of saved.nodes) expectNodeTimes(record);
  expect(saved.nodes[0].seconds).toBeGreaterThanOrEqual(0.15);
  expect(Date.parse(saved.nodes[0].endedAt)).toBeLessThanOrEqual(Date.parse(saved.nodes[1].startedAt));
  expect(saved.currentNode).toBeUndefined();
});

test('GRAPH-NODE-TIMES: the ledger names the running node and its start while it runs', async () => {
  const { graph, root } = fixture('exit 0');
  let seen: { currentNode?: { nodeId: string; startedAt: string }; nodes: unknown[] } | undefined;
  const result = await runGraph(graph, { runId: 'running', deps: { root, runBash: async () => {
    seen ??= JSON.parse(readFileSync(join(root, 'graph-runs', 'test-graph', 'running.json'), 'utf8'));
    return { stdout: '', stderr: '', exitCode: 0 };
  } } });
  expect(seen?.nodes).toEqual([]);
  expect(seen?.currentNode).toEqual({ nodeId: 'first', startedAt: expect.any(String) });
  expect(result.nodes[0]?.startedAt).toBe(seen!.currentNode!.startedAt);
});

test('GRAPH-NODE-TIMES: a failed node records its times too', async () => {
  const { graph, root } = fixture('exit 1');
  const result = await runGraph(graph, { deps: { root } });
  expect(result.nodes[0]).toMatchObject({ ok: false, exit: 1 });
  expectNodeTimes(result.nodes[0]);
});

test('GRAPH-NODE-TIMES: a stopped node keeps its start and ends at the stop', async () => {
  const { graph, root } = fixture('exit 0');
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const ongoing = runGraph(graph, { runId: 'timed-stop', deps: { root, runBash: async () => {
    entered();
    await blocked;
    return { stdout: '', stderr: '', exitCode: 0 };
  } } });
  await started;
  let stopped;
  try { stopped = manageGraphRun('test-graph', 'timed-stop', 'stop', root, () => null); }
  finally { release(); }
  await expect(ongoing).rejects.toThrow('run was stopped or ownership changed');
  expect(stopped.nodes[0]).toMatchObject({ nodeId: 'first', error: 'stopped before node completed', endedAt: stopped.stoppedAt });
  expectNodeTimes(stopped.nodes[0]);
  expect(stopped.currentNode).toBeUndefined();
});

test('GRAPH-NODE-TIMES: stopping a run whose older runner never named the running node records only the stop as its end', async () => {
  const { root } = fixture('exit 0');
  const dir = join(root, 'graph-runs', 'test-graph');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'legacy-stop.json');
  writeFileSync(file, JSON.stringify({ graphId: 'test-graph', runId: 'legacy-stop', startedAt: '2026-10-06T00:00:00.000Z', status: 'running',
    pid: 999999, pidStartedAt: '2026-10-06T00:00:00.000Z', path: ['first'], nodes: [], executed: 0, dryRun: false, statePath: file }, null, 2));
  const stopped = manageGraphRun('test-graph', 'legacy-stop', 'stop', root, () => null);
  expect(stopped.nodes).toEqual([{ nodeId: 'first', ok: false, exit: null, executed: false, error: 'stopped before node completed', endedAt: stopped.stoppedAt }]);
});

test('GRAPH-NODE-TIMES: --from keeps earlier node times and writes new times for re-run nodes; an old ledger without times still resumes', async () => {
  const { graph, root } = fixture('printf original');
  let calls = 0;
  const deps = { root, runBash: async () => {
    calls++;
    return { stdout: 'x', stderr: '', exitCode: calls === 2 ? 1 : 0 };
  } };
  const first = await runGraph(graph, { runId: 'timed-restart', deps });
  expect(first.status).toBe('failed');
  const ledger = JSON.parse(readFileSync(first.statePath, 'utf8'));
  // An older ledger: the preserved node has no times at all.
  const legacyFirst = { ...ledger.nodes[0] };
  delete legacyFirst.startedAt; delete legacyFirst.endedAt; delete legacyFirst.seconds;
  writeFileSync(first.statePath, JSON.stringify({ ...ledger, nodes: [legacyFirst, ...ledger.nodes.slice(1)] }, null, 2));
  const resumed = await runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'second', deps });
  expect(resumed.status).toBe('done');
  expect(resumed.nodes[0]).toEqual(legacyFirst);
  expectNodeTimes(resumed.nodes[1]);
  expect(Date.parse(resumed.nodes[1]!.startedAt!)).toBeGreaterThanOrEqual(Date.parse(ledger.nodes[1].endedAt));

  const timed = await runGraph(graph, { runId: 'timed-restart-2', deps: { root, runBash: async () => ({ stdout: '', stderr: '', exitCode: 1 }) } });
  expect(timed.status).toBe('failed');
  const again = await runGraph(graph, { resumeRunId: timed.runId, fromNodeId: 'first', deps: { root } });
  expectNodeTimes(again.nodes[0]);

  // A timed earlier node survives --from byte for byte.
  let third = 0;
  const thirdDeps = { root, runBash: async () => ({ stdout: '', stderr: '', exitCode: ++third === 2 ? 1 : 0 }) };
  const failedSecond = await runGraph(graph, { runId: 'timed-restart-3', deps: thirdDeps });
  expectNodeTimes(failedSecond.nodes[0]);
  const kept = await runGraph(graph, { resumeRunId: failedSecond.runId, fromNodeId: 'second', deps: thirdDeps });
  expect(kept.nodes[0]).toEqual(failedSecond.nodes[0]);
  expect(Date.parse(kept.nodes[1]!.startedAt!)).toBeGreaterThanOrEqual(Date.parse(failedSecond.nodes[1]!.endedAt!));
  expect(kept.resume?.at).toBeDefined();
  expectNodeTimes(kept.nodes[1]);
});

test('each cmd receives its own context file with input and previous stdout', async () => {
  const { graph, root } = fixture('printf first-output');
  writeFileSync(join(root, 'recipes.yaml'), `first:
  command: 'printf first-output'
second:
  command: 'printf "%s" "$ELANOUS_GRAPH_CONTEXT"'
`);
  const seen: Array<{ path: string; context: unknown }> = [];
  const result = await runGraph(graph, { runId: 'context-run', input: { request: 'hello' }, deps: {
    root,
    runBash: async (body, opts) => {
      const path = opts.env?.ELANOUS_GRAPH_CONTEXT;
      expect(path).toBeTruthy();
      seen.push({ path: path!, context: JSON.parse(readFileSync(path!, 'utf8')) });
      return { stdout: body.includes('first-output') ? 'first-output' : 'second-output', stderr: '', exitCode: 0 };
    },
  } });
  expect(seen).toHaveLength(2);
  expect(seen[0]?.path).not.toBe(seen[1]?.path);
  expect(seen[0]?.context).toEqual({ graphId: 'test-graph', runId: 'context-run', nodeId: 'first', input: { request: 'hello' }, outputs: {} });
  expect(seen[1]?.context).toEqual({ graphId: 'test-graph', runId: 'context-run', nodeId: 'second', input: { request: 'hello' }, outputs: { first: 'first-output' } });
  expect(result.input).toEqual({ request: 'hello' });
  expect(result.nodes.slice(0, 2).map((node) => node.output)).toEqual(['first-output', 'second-output']);
  expect(JSON.parse(readFileSync(result.statePath, 'utf8')).input).toEqual({ request: 'hello' });
});

test('real bash reads ELANOUS_GRAPH_CONTEXT and previous command output', async () => {
  const { graph, root } = fixture('printf first-output');
  writeFileSync(join(root, 'recipes.yaml'), `first:
  command: 'printf first-output'
second:
  command: 'cat "$ELANOUS_GRAPH_CONTEXT"'
`);
  const result = await runGraph(graph, { input: ['payload'], deps: { root } });
  expect(result.status).toBe('done');
  expect(JSON.parse(result.nodes[1]?.output as string)).toEqual({
    graphId: result.graphId, runId: result.runId, nodeId: 'second', input: ['payload'], outputs: { first: 'first-output' },
  });
});

test('failed run restarts at saved node, keeps preceding output, and reports node progress', async () => {
  const { graph, root } = fixture('printf original');
  const calls: string[] = [];
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const deps = { root, log: (event: string, data: Record<string, unknown>) => logs.push({ event, data }),
    runBash: async (body: string, opts: { env?: NodeJS.ProcessEnv }) => {
      calls.push(body);
      if (calls.length > 1) {
        expect(JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')).outputs.first).toBe('original');
        return { stdout: 'broken', stderr: '', exitCode: calls.length === 2 ? 1 : 0 };
      }
      return { stdout: 'original', stderr: '', exitCode: 0 };
    } };
  const first = await runGraph(graph, { runId: 'restart', deps });
  expect(first.status).toBe('failed');
  expect(first.path).toEqual(['first', 'second', 'failed']);
  const resumed = await runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'second', deps });
  expect(resumed.status).toBe('done');
  expect(resumed.path).toEqual(['first', 'second', 'done']);
  expect(resumed.executed).toBe(2);
  expect(calls).toHaveLength(3);
  expect(resumed.nodes[0]).toEqual(first.nodes[0]);
  expect(resumed.resume).toMatchObject({ from: 'second', previousStatus: 'failed', at: expect.any(String) });
  expect(JSON.parse(readFileSync(first.statePath, 'utf8')).resume).toEqual(resumed.resume);
  expect(logs.filter((entry) => entry.event === 'node-start' && entry.data.nodeId === 'first')).toHaveLength(1);
});

test('restart refuses nodes outside the failed path or changed graph and leaves state intact', async () => {
  const { graph, root } = fixture('exit 1');
  const first = await runGraph(graph, { deps: { root } });
  const before = readFileSync(first.statePath, 'utf8');
  for (const fromNodeId of ['second', 'failed', 'absent']) {
    await expect(runGraph(graph, { resumeRunId: first.runId, fromNodeId, deps: { root } })).rejects.toThrow('--from node');
    expect(readFileSync(first.statePath, 'utf8')).toBe(before);
  }
  await expect(runGraph(graph, { fromNodeId: 'first', deps: { root } })).rejects.toThrow('--from requires --resume');
  writeFileSync(join(root, 'recipes.yaml'), readFileSync(join(root, 'recipes.yaml'), 'utf8').replace('exit 1', 'exit 0'));
  await expect(runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'first', useCurrentGraph: true, deps: { root } })).rejects.toThrow('graph or recipes changed');
  expect(readFileSync(first.statePath, 'utf8')).toBe(before);
});

test('new runs preserve exact graph and recipe bytes and resume from that snapshot after installed files change', async () => {
  const { graph, root } = fixture('printf original');
  const originalGraph = readFileSync(graph, 'utf8');
  const recipes = join(root, 'recipes.yaml');
  const originalRecipes = readFileSync(recipes, 'utf8');
  const calls: string[] = [];
  const deps = { root, runBash: async (body: string) => {
    calls.push(body);
    return { stdout: body.includes('original') ? 'original' : '', stderr: '', exitCode: calls.length === 2 ? 1 : 0 };
  } };
  const first = await runGraph(graph, { deps });
  const snapshot = `${first.statePath}.graph`;
  expect(readFileSync(join(snapshot, 'graph.yaml'), 'utf8')).toBe(originalGraph);
  expect(readFileSync(join(snapshot, 'recipes.yaml'), 'utf8')).toBe(originalRecipes);
  expect(JSON.parse(readFileSync(first.statePath, 'utf8')).graphSnapshot).toEqual({
    graphSha: createHash('sha256').update(originalGraph).digest('hex'),
    recipesSha: createHash('sha256').update(originalRecipes).digest('hex'),
  });
  writeFileSync(graph, originalGraph.replace('graph_id: test-graph', 'graph_id: installed-graph'));
  writeFileSync(recipes, originalRecipes.replace('exit 0', 'exit 7'));
  await expect(runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'second', useCurrentGraph: true, deps })).rejects.toThrow('graph or recipes changed since failed run');
  const resumed = await runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'second', deps });
  expect(resumed.status).toBe('done');
  expect(resumed.resume?.graph).toBe('snapshot');
  expect(resumed.nodes[0]).toEqual(first.nodes[0]);
  expect(calls).toHaveLength(3);
});

test('tampered snapshot refuses resume before replaying any command', async () => {
  const { graph, root } = fixture('exit 1');
  const first = await runGraph(graph, { deps: { root } });
  const snapshot = join(`${first.statePath}.graph`, 'recipes.yaml');
  writeFileSync(snapshot, readFileSync(snapshot, 'utf8').replace('exit 1', 'exit 0'));
  const before = readFileSync(first.statePath, 'utf8');
  await expect(runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'first', deps: { root } })).rejects.toThrow('graph snapshot changed since run started');
  expect(readFileSync(first.statePath, 'utf8')).toBe(before);
});

test('snapshot source hash mismatch refuses --from without truncating the saved failed path', async () => {
  const { graph, root } = fixture('exit 1');
  const first = await runGraph(graph, { deps: { root } });
  expect(first.path).toEqual(['first', 'failed']);
  const snapshot = join(`${first.statePath}.graph`, 'recipes.yaml');
  const changed = readFileSync(snapshot, 'utf8').replace('exit 1', 'exit 0');
  writeFileSync(snapshot, changed);
  const ledger = JSON.parse(readFileSync(first.statePath, 'utf8'));
  ledger.graphSnapshot.recipesSha = createHash('sha256').update(changed).digest('hex');
  writeFileSync(first.statePath, JSON.stringify(ledger));
  const before = readFileSync(first.statePath, 'utf8');
  await expect(runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'first', deps: { root } }))
    .rejects.toThrow('graph snapshot changed since run started');
  expect(readFileSync(first.statePath, 'utf8')).toBe(before);
});

test('snapshot recipes still run current node scripts after repair', async () => {
  const { graph, root } = fixture('exit 0');
  const script = join(root, 'repair.sh');
  writeFileSync(script, 'exit 1\n');
  writeFileSync(join(root, 'recipes.yaml'), `first:\n  command: "exit 0"\nsecond:\n  command: "bash '${script}'"\n`);
  const first = await runGraph(graph, { deps: { root } });
  expect(first.status).toBe('failed');
  writeFileSync(script, 'exit 0\n');
  const resumed = await runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'second', deps: { root } });
  expect(resumed.status).toBe('done');
  expect(resumed.nodes[0]).toEqual(first.nodes[0]);
});

test('a legacy run without snapshot uses current graph and the original hash guard', async () => {
  const { graph, root } = fixture('exit 1');
  const first = await runGraph(graph, { deps: { root } });
  const legacy = JSON.parse(readFileSync(first.statePath, 'utf8'));
  delete legacy.graphSnapshot;
  rmSync(`${first.statePath}.graph`, { recursive: true });
  writeFileSync(first.statePath, JSON.stringify(legacy));
  writeFileSync(graph, readFileSync(graph, 'utf8') + '\n');
  await expect(runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'first', deps: { root } })).rejects.toThrow('graph or recipes changed since failed run');
  writeFileSync(graph, readFileSync(graph, 'utf8').slice(0, -1));
  const resumed = await runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'first', deps: { root } });
  expect(resumed.resume?.graph).toBe('current');
});

test('failed publication cannot skip or replay approval with --from', async () => {
  const { graph, root } = approvalFixture();
  writeFileSync(graph, readFileSync(graph, 'utf8').replace('- { from: b, to: done }', '- { from: b, on: outcome, map: { ok: done, fail: failed } }'));
  let calls = 0;
  const deps = { root, runBash: async () => ({ stdout: '', stderr: '', exitCode: ++calls === 2 ? 1 : 0 }) };
  const pending = await runGraph(graph, { deps });
  await expect(runGraph(graph, { resumeRunId: pending.runId, fromNodeId: 'b', deps })).rejects.toThrow('failed, non-dry run');
  decideGraphApproval(pending.graphId, pending.runId, 'approved', 'reviewer', root);
  const failed = await runGraph(graph, { resumeRunId: pending.runId, deps });
  expect(failed.status).toBe('failed');
  const original = readFileSync(failed.statePath, 'utf8');
  await expect(runGraph(graph, { resumeRunId: failed.runId, fromNodeId: 'a', deps })).rejects.toThrow('across an approval');
  await expect(runGraph(graph, { resumeRunId: failed.runId, fromNodeId: 'gate', deps })).rejects.toThrow('across an approval');
  expect(readFileSync(failed.statePath, 'utf8')).toBe(original);
  const resumed = await runGraph(graph, { resumeRunId: failed.runId, fromNodeId: 'b', deps });
  expect(resumed.status).toBe('done');
  expect(resumed.nodes[1]).toMatchObject({ nodeId: 'gate', ok: true, decidedBy: 'reviewer' });
  expect(calls).toBe(3);
});

test('failed first command branches to failed without executing second', async () => {
  const { graph, root } = fixture('exit 1');
  const result = await runGraph(graph, { deps: { root } });
  expect(result.status).toBe('failed');
  expect(result.path).toEqual(['first', 'failed']);
  expect(result.nodes[0]).toMatchObject({ ok: false, exit: 1 });
  expect(result.executed).toBe(1);
});

test('real release-loop failed node writes one heal inbox line without running downstream commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-release-heal-'));
  dirs.push(root);
  const graph = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  let calls = 0;
  const result = await runGraph(graph, { deps: { root, runBash: async () => {
    calls++;
    return { stdout: '', stderr: 'release failed', exitCode: 1 };
  } } });
  expect(result.status).toBe('failed');
  expect(result.path).toEqual(['version-release', 'failed']);
  expect(result.nodes[0]).toMatchObject({ ok: false, exit: 1 });
  expect(result.executed).toBe(1);
  expect(calls).toBe(1);
  expect(JSON.parse(readFileSync(result.statePath, 'utf8')).status).toBe('failed');
  const lines = readFileSync(join(root, 'heal', 'inbox.jsonl'), 'utf8').trimEnd().split('\n');
  expect(lines).toHaveLength(1);
  expect(readFailureInbox({}, root)).toEqual([{
    source: 'release-run', kind: 'graph-run', ref: `${result.graphId}/${result.runId}`,
    summary: `Graph ${result.graphId}/${result.runId} failed at failed`, at: result.finishedAt!,
  }]);
});

test('release-loop with no outgoing edge records the failed run exactly once', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, readFileSync(graph, 'utf8')
    .replace('graph_id: test-graph', 'graph_id: release-loop')
    .replace('map: { ok: second, fail: failed }', 'map: { fail: failed }'));
  const run = await runGraph(graph, { deps: { root } });
  expect(run.status).toBe('failed');
  expect(run.path).toEqual(['first']);
  expect(readFailureInbox({}, root)).toEqual([{
    source: 'release-run', kind: 'graph-run', ref: `${run.graphId}/${run.runId}`,
    summary: `Graph ${run.graphId}/${run.runId} failed after first (no outgoing edge)`, at: run.finishedAt!,
  }]);
  expect(readFileSync(join(root, 'heal', 'inbox.jsonl'), 'utf8').trimEnd().split('\n')).toHaveLength(1);
});

test('a broken heal inbox does not replace either persisted release failure verdict and exposes a replay path', async () => {
  for (const branch of ['terminal', 'no-edge']) {
    const { graph, root } = fixture(branch === 'terminal' ? 'exit 1' : 'exit 0');
    writeFileSync(graph, readFileSync(graph, 'utf8')
      .replace('graph_id: test-graph', 'graph_id: release-loop')
      .replace('map: { ok: second, fail: failed }', branch === 'no-edge' ? 'map: { fail: failed }' : 'map: { ok: second, fail: failed }'));
    mkdirSync(join(root, 'heal'));
    writeFileSync(join(root, 'heal', 'inbox.jsonl'), '{invalid-json}\n');
    const result = await runGraph(graph, { runId: `broken-${branch}`, deps: { root } });
    expect(result.status).toBe('failed');
    expect(JSON.parse(readFileSync(result.statePath, 'utf8')).status).toBe('failed');
    expect(readFileSync(join(root, 'heal', 'inbox.jsonl'), 'utf8')).toBe('{invalid-json}\n');
    expect(debug.events(500).filter(entry => entry.category === 'heal.intake' && entry.event === 'record-failed' &&
      (entry.data as { ref?: string })?.ref === `${result.graphId}/${result.runId}`)).toMatchObject([
      { level: 'error', data: { source: 'release-run', kind: 'graph-run', ref: `${result.graphId}/${result.runId}`,
        statePath: result.statePath, error: expect.stringContaining('SyntaxError') } },
    ]);
    writeFileSync(join(root, 'heal', 'inbox.jsonl'), '');
    expect(recordFailureEvent({ source: 'release-run', kind: 'graph-run', ref: `${result.graphId}/${result.runId}`,
      summary: `Graph ${result.graphId}/${result.runId} failed`, at: result.finishedAt! }, root)).toEqual({ folded: false });
    expect(readFailureInbox({}, root)).toHaveLength(1);
  }
});

test('missing outcome mapping uses fallback without executing the second command', async () => {
  const { graph, root } = fixture('exit 1');
  writeFileSync(graph, readFileSync(graph, 'utf8').replace('map: { ok: second, fail: failed }', 'map: { ok: second }\n    fallback:\n      - { node: failed, requires: [] }'));
  const result = await runGraph(graph, { deps: { root } });
  expect(result.status).toBe('failed');
  expect(result.path).toEqual(['first', 'failed']);
  expect(result.executed).toBe(1);
  expect(existsSync(join(root, 'heal', 'inbox.jsonl'))).toBe(false);
});

test('a revisit beyond max_visits is blocked before running again', async () => {
  const { graph, root } = fixture('exit 0', true);
  const result = await runGraph(graph, { deps: { root } });
  expect(result.status).toBe('budget-exceeded');
  expect(result.path).toEqual(['first']);
  expect(result.executed).toBe(1);
  expect(JSON.parse(readFileSync(result.statePath, 'utf8')).status).toBe('budget-exceeded');
});

test('unregistered inherited recipe is rejected before any command executes', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, readFileSync(graph, 'utf8').replace('cmd:second', 'cmd:toString'));
  let executed = 0;
  await expect(runGraph(graph, { deps: { root, runBash: async () => {
    executed++;
    return { stdout: '', stderr: '', exitCode: 0 };
  } } })).rejects.toThrow('unknown command recipe for second: cmd:toString');
  expect(executed).toBe(0);
});

test('unsupported terminal name cannot silently report a failed branch as done', async () => {
  const { graph, root } = fixture('exit 1');
  writeFileSync(graph, readFileSync(graph, 'utf8')
    .replace('terminal_nodes: [done, failed]', 'terminal_nodes: [done, rejected]')
    .replace('node_id: failed', 'node_id: rejected')
    .replaceAll('fail: failed', 'fail: rejected'));
  let executed = 0;
  await expect(runGraph(graph, { deps: { root, runBash: async () => {
    executed++;
    return { stdout: '', stderr: '', exitCode: 1 };
  } } })).rejects.toThrow('unsupported terminal node: rejected');
  expect(executed).toBe(0);
});

test('ops recipes register a human-readable publication approval', () => {
  const recipes = parseYaml(readFileSync(join(import.meta.dir, '../../graphs/ops/recipes.yaml'), 'utf8'));
  expect(recipes['publish-approval']).toEqual({ approval: '공개 발행을 승인하시겠습니까?' });
});

test('approval pauses without running b; undecided resume stays pending; decision resumes without replaying a', async () => {
  const { graph, root } = approvalFixture();
  const calls: string[] = [];
  const events: string[] = [];
  const deps = { root, runBash: async (body: string) => { calls.push(body); return { stdout: '', stderr: '', exitCode: 0 }; },
    log: (event: string) => { events.push(event); } };
  const first = await runGraph(graph, { runId: 'approved-run', deps });
  expect(first.status).toBe('awaiting-approval');
  expect(first.pending).toMatchObject({ nodeId: 'gate', message: 'Publish now?' });
  expect(first.pending?.since).toBeTruthy();
  expect(first.path).toEqual(['a', 'gate']);
  expect(first.executed).toBe(1);
  expect(calls).toEqual(['exit 0']);
  expect(events).toContain('approval-pending');
  const undecided = await runGraph(graph, { resumeRunId: first.runId, deps });
  expect(undecided.status).toBe('awaiting-approval');
  expect(undecided.path).toEqual(['a', 'gate']);
  expect(undecided.pending?.since).toBe(first.pending?.since);
  expect(calls).toHaveLength(1);
  decideGraphApproval(first.graphId, first.runId, 'approved', 'reviewer', root);
  const resumed = await runGraph(graph, { resumeRunId: first.runId, deps });
  expect(resumed.status).toBe('done');
  expect(resumed.path).toEqual(['a', 'gate', 'b', 'done']);
  expect(resumed.nodes[1]).toMatchObject({ nodeId: 'gate', ok: true, decidedBy: 'reviewer' });
  expect(resumed.nodes[1]?.decidedAt).toBeTruthy();
  expect(resumed.executed).toBe(2);
  expect(calls).toHaveLength(2);
  expect(JSON.parse(readFileSync(resumed.statePath, 'utf8')).status).toBe('done');
  expect(() => decideGraphApproval(first.graphId, first.runId, 'approved', 'reviewer', root)).toThrow('not awaiting');
});

test('resume keeps persisted input and exposes pre-approval outputs to the next cmd', async () => {
  const { graph, root } = approvalFixture();
  const contexts: Array<{ graphId: string; runId: string; nodeId: string; input: unknown; outputs: Record<string, unknown> }> = [];
  const deps = { root, runBash: async (_body: string, opts: { env?: NodeJS.ProcessEnv }) => {
    contexts.push(JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')));
    return { stdout: `output-${contexts.length}`, stderr: '', exitCode: 0 };
  } };
  const first = await runGraph(graph, { runId: 'resume-context', input: { original: true }, deps });
  expect(first.status).toBe('awaiting-approval');
  expect(JSON.parse(readFileSync(first.statePath, 'utf8')).input).toEqual({ original: true });
  decideGraphApproval(first.graphId, first.runId, 'approved', 'reviewer', root);
  const resumed = await runGraph(graph, { resumeRunId: first.runId, input: { original: false }, deps });
  expect(resumed.input).toEqual({ original: true });
  expect(contexts).toEqual([
    { graphId: first.graphId, runId: first.runId, nodeId: 'a', input: { original: true }, outputs: {} },
    { graphId: first.graphId, runId: first.runId, nodeId: 'b', input: { original: true }, outputs: { a: 'output-1', gate: expect.objectContaining({ outcome: 'approved', decidedBy: 'reviewer' }) } },
  ]);
  expect(JSON.parse(readFileSync(resumed.statePath, 'utf8')).input).toEqual({ original: true });
});

test('rejected approval routes to failed, and approval cannot be decided twice', async () => {
  const { graph, root } = approvalFixture();
  const calls: string[] = [];
  const deps = { root, runBash: async (body: string) => { calls.push(body); return { stdout: '', stderr: '', exitCode: 0 }; } };
  const first = await runGraph(graph, { deps });
  decideGraphApproval(first.graphId, first.runId, 'rejected', 'owner', root);
  expect(() => decideGraphApproval(first.graphId, first.runId, 'approved', 'owner', root)).toThrow('not awaiting an undecided approval');
  const result = await runGraph(graph, { resumeRunId: first.runId, deps });
  expect(result.status).toBe('failed');
  expect(result.path).toEqual(['a', 'gate', 'failed']);
  expect(result.nodes[1]).toMatchObject({ nodeId: 'gate', ok: false, decidedBy: 'owner' });
  expect(result.executed).toBe(1);
  expect(calls).toHaveLength(1);
});

test('decision claim remains authoritative when a stale undecided state is persisted', async () => {
  const { graph, root } = approvalFixture();
  const deps = { root, runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }) };
  const first = await runGraph(graph, { deps });
  const stale = readFileSync(first.statePath, 'utf8');
  const decided = decideGraphApproval(first.graphId, first.runId, 'approved', 'operator', root);
  expect(decided.pending?.decision).toBe('approved');
  writeFileSync(first.statePath, stale);
  expect(() => decideGraphApproval(first.graphId, first.runId, 'rejected', 'late', root)).toThrow('not awaiting an undecided approval');
  const resumed = await runGraph(graph, { resumeRunId: first.runId, deps });
  expect(resumed.status).toBe('done');
  expect(resumed.nodes[1]).toMatchObject({ ok: true, decidedBy: 'operator' });
});

test('a reused run id cannot overwrite a paused or decided run or inherit its decision', async () => {
  const { graph, root } = approvalFixture();
  const calls: string[] = [];
  const deps = { root, runBash: async (body: string) => { calls.push(body); return { stdout: '', stderr: '', exitCode: 0 }; } };
  const first = await runGraph(graph, { runId: 'fixed-id', deps });
  const original = readFileSync(first.statePath, 'utf8');
  await expect(runGraph(graph, { runId: first.runId, deps })).rejects.toThrow('run id already exists');
  expect(readFileSync(first.statePath, 'utf8')).toBe(original);
  decideGraphApproval(first.graphId, first.runId, 'approved', 'owner', root);
  await expect(runGraph(graph, { runId: first.runId, deps })).rejects.toThrow('run id already exists');
  expect(calls).toHaveLength(1);
  const result = await runGraph(graph, { resumeRunId: first.runId, deps });
  expect(result.status).toBe('done');
  expect(calls).toHaveLength(2);
  await expect(runGraph(graph, { runId: first.runId, deps })).rejects.toThrow('run id already exists');
  unlinkSync(first.statePath);
  await expect(runGraph(graph, { runId: first.runId, deps })).rejects.toThrow('run id already exists');
  expect(calls).toHaveLength(2);
});

test('concurrent resumes cannot run a downstream command twice', async () => {
  const { graph, root } = approvalFixture();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const deps = { root, runBash: async (body: string) => {
    calls.push(body);
    if (calls.length === 2) { entered(); await held; }
    return { stdout: '', stderr: '', exitCode: 0 };
  } };
  const first = await runGraph(graph, { deps });
  decideGraphApproval(first.graphId, first.runId, 'approved', 'owner', root);
  const ongoing = runGraph(graph, { resumeRunId: first.runId, deps });
  await started;
  try {
    await expect(runGraph(graph, { resumeRunId: first.runId, deps })).rejects.toThrow('run is already being resumed');
    expect(calls).toHaveLength(2);
  } finally { release(); }
  expect((await ongoing).status).toBe('done');
  expect(calls).toHaveLength(2);
  await expect(runGraph(graph, { resumeRunId: first.runId, deps })).rejects.toThrow('run is not awaiting approval');
});

test('approval dry run follows success path without executing commands or waiting', async () => {
  const { graph, root } = approvalFixture();
  const result = await runGraph(graph, { dryRun: true, deps: { root, runBash: async () => { throw new Error('executed'); } } });
  expect(result.status).toBe('done');
  expect(result.pending).toBeUndefined();
  expect(result.path).toEqual(['a', 'gate', 'b', 'done']);
  expect(result.executed).toBe(0);
});

test('approval recipe must exist in its own registry slot before running a command', async () => {
  const { graph, root } = approvalFixture();
  writeFileSync(graph, readFileSync(graph, 'utf8').replace('approval:gate', 'approval:toString'));
  let calls = 0;
  await expect(runGraph(graph, { deps: { root, runBash: async () => { calls++; return { stdout: '', stderr: '', exitCode: 0 }; } } }))
    .rejects.toThrow('unknown command recipe for gate: approval:toString');
  expect(calls).toBe(0);
  writeFileSync(graph, readFileSync(graph, 'utf8').replace('approval:toString', 'approval:a'));
  await expect(runGraph(graph, { deps: { root, runBash: async () => { calls++; return { stdout: '', stderr: '', exitCode: 0 }; } } }))
    .rejects.toThrow('unknown command recipe for gate: approval:a');
  expect(calls).toBe(0);
});

test('resuming against a changed approval message refuses to apply an old decision', async () => {
  const { graph, root } = approvalFixture();
  const first = await runGraph(graph, { deps: { root, runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }) } });
  decideGraphApproval(first.graphId, first.runId, 'approved', 'owner', root);
  writeFileSync(join(root, 'recipes.yaml'), readFileSync(join(root, 'recipes.yaml'), 'utf8').replace('Publish now?', 'Publish something else?'));
  await expect(runGraph(graph, { resumeRunId: first.runId, useCurrentGraph: true, deps: { root } })).rejects.toThrow('approval source changed since run was paused');
  expect(JSON.parse(readFileSync(first.statePath, 'utf8')).status).toBe('awaiting-approval');
});

test('snapshot resume keeps the original approval decision bound after installed recipes change', async () => {
  const { graph, root } = approvalFixture();
  const deps = { root, runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }) };
  const first = await runGraph(graph, { deps });
  decideGraphApproval(first.graphId, first.runId, 'approved', 'owner', root);
  const recipes = join(root, 'recipes.yaml');
  writeFileSync(recipes, readFileSync(recipes, 'utf8').replace('Publish now?', 'Changed message?'));
  const resumed = await runGraph(graph, { resumeRunId: first.runId, deps });
  expect(resumed.status).toBe('done');
  expect(resumed.resume?.graph).toBe('snapshot');
  expect(resumed.nodes[1]).toMatchObject({ nodeId: 'gate', ok: true, decidedBy: 'owner' });
});

test('old approval cannot authorize a changed downstream command or branch with the same graph id and prompt', async () => {
  for (const mutation of ['command', 'branch']) {
    const { graph, root } = approvalFixture();
    const calls: string[] = [];
    const deps = { root, runBash: async (body: string) => { calls.push(body); return { stdout: '', stderr: '', exitCode: 0 }; } };
    const first = await runGraph(graph, { deps });
    expect(first.approvalSourceHash).toMatch(/^[a-f0-9]{64}$/);
    decideGraphApproval(first.graphId, first.runId, 'approved', 'owner', root);
    const file = mutation === 'command' ? join(root, 'recipes.yaml') : graph;
    const before = readFileSync(file, 'utf8');
    writeFileSync(file, mutation === 'command'
      ? before.replace('b:\n  command: "exit 0"', 'b:\n  command: "exit 1"')
      : before.replace('map: { ok: b, fail: failed }', 'map: { ok: failed, fail: b }'));
    await expect(runGraph(graph, { resumeRunId: first.runId, useCurrentGraph: true, deps })).rejects.toThrow('approval source changed since run was paused');
    expect(calls).toEqual(['exit 0']);
    expect(JSON.parse(readFileSync(first.statePath, 'utf8'))).toMatchObject({ status: 'awaiting-approval', pending: { nodeId: 'gate' } });
    expect(() => decideGraphApproval(first.graphId, first.runId, 'rejected', 'late', root)).toThrow('not awaiting an undecided approval');
  }
});

test('visit budget persists over resumed approval and blocks a second traversal', async () => {
  const { graph, root } = approvalFixture();
  writeFileSync(graph, readFileSync(graph, 'utf8').replace('from: b, to: done', 'from: b, to: a'));
  const calls: string[] = [];
  const deps = { root, runBash: async (body: string) => { calls.push(body); return { stdout: '', stderr: '', exitCode: 0 }; } };
  const first = await runGraph(graph, { deps });
  decideGraphApproval(first.graphId, first.runId, 'approved', 'owner', root);
  const resumed = await runGraph(graph, { resumeRunId: first.runId, deps });
  expect(resumed.status).toBe('budget-exceeded');
  expect(resumed.path).toEqual(['a', 'gate', 'b']);
  expect(calls).toHaveLength(2);
});

test('dry run assumes ok and never invokes the injected command executor', async () => {
  const { graph, root } = fixture('exit 1');
  const result = await runGraph(graph, { dryRun: true, deps: { root, runBash: async () => { throw new Error('executed'); } } });
  expect(result.status).toBe('done');
  expect(result.path).toEqual(['first', 'second', 'done']);
  expect(result.executed).toBe(0);
});

// R1 의 빠진 칸(🅣 2026-09-26): 노드 산출의 마지막 JSON 줄 `outcome` 이 간선 map 의 키면 그 갈래로 간다 · 다음 노드는 구조 산출을 받는다.
function namedOutcomeFixture(): { graph: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'graph-named-outcome-'));
  const graph = join(root, 'g.yaml');
  writeFileSync(join(root, 'recipes.yaml'), [
    `classify:\n  command: "bun -e \\"const c=JSON.parse(require('fs').readFileSync(process.env.ELANOUS_GRAPH_CONTEXT,'utf8')); console.log('thinking'); console.log(JSON.stringify({outcome:c.input.kind, seen:c.input.kind}))\\""`,
    `a:\n  command: "echo a"`,
    `b:\n  command: "bun -e \\"const c=JSON.parse(require('fs').readFileSync(process.env.ELANOUS_GRAPH_CONTEXT,'utf8')); console.log(JSON.stringify({got:c.outputs.classify.seen}))\\""`,
  ].join('\n') + '\n');
  writeFileSync(graph, `graph_id: named-outcome\nversion: 1\nentry_node: classify\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: classify, kind: judge, recipe: 'cmd:classify', max_visits: 1 }\n  - { node_id: a, kind: agent, recipe: 'cmd:a', max_visits: 1 }\n  - { node_id: b, kind: agent, recipe: 'cmd:b', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - from: classify\n    on: outcome\n    map: { alpha: a, beta: b, ok: a, fail: failed }\n  - from: a\n    on: outcome\n    map: { ok: done, fail: failed }\n  - from: b\n    on: outcome\n    map: { ok: done, fail: failed }\n`);
  return { graph, root };
}

test('a catalog role with a sibling recipes.yaml command runs like cmd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-role-recipe-'));
  dirs.push(root);
  const graph = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), 'triage:\n  command: "printf \'{\\"outcome\\":\\"exhausted\\"}\'"\n');
  writeFileSync(graph, `graph_id: role-graph
version: 1
entry_node: judge
terminal_nodes: [done, failed]
nodes:
  - { node_id: judge, kind: judge, recipe: triage, max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - from: judge
    on: outcome
    map: { exhausted: failed, ok: done, fail: failed }
`);
  const result = await runGraph(graph, { deps: { root }, runId: 'role-ok' });
  expect(result.path).toEqual(['judge', 'failed']);
  expect(result.executed).toBe(1);
  expect(result.status).toBe('failed');
});

test('a bare recipe is rejected before execution when it is not a catalog role or has no command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-role-reject-'));
  dirs.push(root);
  const graph = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), 'not-a-role:\n  command: "exit 0"\ntriage:\n  approval: "not a command"\n');
  writeFileSync(graph, `graph_id: role-reject
version: 1
entry_node: n
terminal_nodes: [done, failed]
nodes:
  - { node_id: n, kind: judge, recipe: not-a-role, max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - from: n
    on: outcome
    map: { ok: done, fail: failed }
`);
  let executed = 0;
  await expect(runGraph(graph, { deps: { root, runBash: async () => { executed++; return { stdout: '', stderr: '', exitCode: 0 }; } } }))
    .rejects.toThrow('unknown command recipe for n: not-a-role');
  expect(executed).toBe(0);
  writeFileSync(graph, readFileSync(graph, 'utf8').replace('recipe: not-a-role', 'recipe: triage'));
  await expect(runGraph(graph, { deps: { root, runBash: async () => { executed++; return { stdout: '', stderr: '', exitCode: 0 }; } } }))
    .rejects.toThrow('unknown command recipe for n: triage');
  expect(executed).toBe(0);
});

test('pending.notifiedAt survives the notification persist path and readGraphRun reload', async () => {
  const { graph, root } = approvalFixture();
  const paused = await runGraph(graph, { runId: 'notify-stamp', deps: { root, runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }) } });
  expect(paused.status).toBe('awaiting-approval');
  const reloaded = latestGraphRun(paused.graphId, root);
  expect(reloaded?.runId).toBe(paused.runId);
  expect(reloaded?.pending?.notifiedAt).toBe(paused.pending?.notifiedAt);
  expect(reloaded?.pending?.notifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(JSON.parse(readFileSync(paused.statePath, 'utf8')).pending.notifiedAt).toBe(paused.pending?.notifiedAt);
  const again = await runGraph(graph, { resumeRunId: paused.runId, deps: { root, runBash: async () => { throw new Error('replayed'); } } });
  expect(again.pending?.notifiedAt).toBe(paused.pending?.notifiedAt);
  expect(latestGraphRun(paused.graphId, root)?.pending?.notifiedAt).toBe(paused.pending?.notifiedAt);
});

test('a stopped run cannot resume without --from, and a running run can still resume', async () => {
  const { graph, root } = fixture('printf first-output');
  const finished = await runGraph(graph, { runId: 'stop-vs-resume', deps: { root, runBash: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }) } });
  const state = JSON.parse(readFileSync(finished.statePath, 'utf8'));
  state.status = 'running';
  state.path = ['first'];
  state.nodes = [state.nodes[0]];
  state.executed = 1;
  writeFileSync(finished.statePath, JSON.stringify(state));
  const calls: string[] = [];
  const deps = { root, runBash: async (body: string) => { calls.push(body); return { stdout: 'ok', stderr: '', exitCode: 0 }; } };
  const running = await runGraph(graph, { resumeRunId: 'stop-vs-resume', deps });
  expect(running.status).toBe('done');
  expect(calls).toEqual(['exit 0']);
  state.status = 'failed';
  state.stoppedAt = new Date().toISOString();
  writeFileSync(finished.statePath, JSON.stringify(state));
  await expect(runGraph(graph, { resumeRunId: 'stop-vs-resume', deps })).rejects.toThrow('run is not awaiting approval');
  expect(calls).toEqual(['exit 0']);
});

test('resuming a running run skips completed command nodes', async () => {
  const { graph, root } = fixture('printf first-output');
  const calls: string[] = [];
  const finished = await runGraph(graph, { runId: 'running-resume', deps: { root, runBash: async (body: string) => {
    calls.push(body);
    return { stdout: body.includes('first-output') ? '{"outcome":"ok"}\n' : 'second-output', stderr: '', exitCode: 0 };
  } } });
  const saved = JSON.parse(readFileSync(finished.statePath, 'utf8'));
  saved.status = 'running';
  saved.path = ['first'];
  saved.nodes = [saved.nodes[0]];
  saved.executed = 1;
  delete saved.pending;
  writeFileSync(finished.statePath, `${JSON.stringify(saved)}\n`);
  const resumed = await runGraph(graph, { resumeRunId: 'running-resume', deps: { root, runBash: async (body: string) => {
    calls.push(body);
    return { stdout: 'resumed-second', stderr: '', exitCode: 0 };
  } } });
  expect(resumed.status).toBe('done');
  expect(resumed.path).toEqual(['first', 'second', 'done']);
  expect(resumed.executed).toBe(2);
  expect(resumed.nodes.filter((node) => node.nodeId === 'first')).toHaveLength(1);
  expect(calls.filter((body) => body.includes('first-output'))).toHaveLength(1);
  expect(JSON.parse(readFileSync(resumed.statePath, 'utf8')).nodes[0].output).toBe('{"outcome":"ok"}\n');
});

test('a loop resume branches from the last visit, not the first execution record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-loop-resume-'));
  dirs.push(root);
  const graph = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), 'judge:\n  command: "printf judge"\n');
  writeFileSync(graph, `graph_id: loop-resume
version: 1
entry_node: judge
terminal_nodes: [done, failed]
nodes:
  - { node_id: judge, kind: judge, recipe: 'cmd:judge', max_visits: 3 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - from: judge
    on: outcome
    map: { again: judge, stop: done, ok: done, fail: failed }
`);
  let calls = 0;
  const seeded = await runGraph(graph, { runId: 'loop-resume', deps: { root, runBash: async () => ({ stdout: '{"outcome":"again"}\n', stderr: '', exitCode: 0 }) } });
  const saved = JSON.parse(readFileSync(seeded.statePath, 'utf8'));
  saved.status = 'running';
  saved.path = ['judge', 'judge'];
  saved.nodes = [
    { nodeId: 'judge', ok: true, exit: 0, executed: true, output: '{"outcome":"again"}\n' },
    { nodeId: 'judge', ok: true, exit: 0, executed: true, output: '{"outcome":"stop"}\n' },
  ];
  saved.executed = 2;
  delete saved.pending;
  writeFileSync(seeded.statePath, `${JSON.stringify(saved)}\n`);
  const resumed = await runGraph(graph, { resumeRunId: 'loop-resume', deps: { root, runBash: async () => {
    calls++;
    throw new Error('replayed judge');
  } } });
  expect(resumed.status).toBe('done');
  expect(resumed.path).toEqual(['judge', 'judge', 'done']);
  expect(calls).toBe(0);
});

test('awaiting-approval without pending is refused, while running without pending resumes', async () => {
  const { graph, root } = fixture('printf first-output');
  const finished = await runGraph(graph, { runId: 'corrupt-approval', deps: { root, runBash: async () => ({ stdout: '{"outcome":"ok"}\n', stderr: '', exitCode: 0 }) } });
  const saved = JSON.parse(readFileSync(finished.statePath, 'utf8'));
  saved.status = 'awaiting-approval';
  saved.path = ['first'];
  saved.nodes = [saved.nodes[0]];
  saved.executed = 1;
  delete saved.pending;
  writeFileSync(finished.statePath, `${JSON.stringify(saved)}\n`);
  await expect(runGraph(graph, { resumeRunId: 'corrupt-approval', deps: { root, runBash: async () => { throw new Error('should not run'); } } })).rejects.toThrow('run is not awaiting approval');
  saved.status = 'running';
  writeFileSync(finished.statePath, `${JSON.stringify(saved)}\n`);
  const resumed = await runGraph(graph, { resumeRunId: 'corrupt-approval', deps: { root, runBash: async () => ({ stdout: 'second', stderr: '', exitCode: 0 }) } });
  expect(resumed.status).toBe('done');
  expect(resumed.path).toEqual(['first', 'second', 'done']);
});

test('a node\'s last-line JSON outcome picks the matching branch and the next node receives the structured output', async () => {
  const { graph, root } = namedOutcomeFixture();
  try {
    const state = await runGraph(graph, { input: { kind: 'beta' }, deps: { root } });
    expect(state.status).toBe('done');
    expect(state.path).toEqual(['classify', 'b', 'done']);
    expect(String(state.nodes.find((n) => n.nodeId === 'b')?.output)).toContain('"got":"beta"');
    // map 에 없는 이름은 종전 ok 간선으로
    const other = await runGraph(graph, { input: { kind: 'gamma' }, deps: { root }, runId: 'run-gamma' });
    expect(other.path).toEqual(['classify', 'a', 'done']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grow on follows an added outcome edge to done; off retains fallback', async () => {
  const { graph, root } = fixture('exit 0');
  const source = readFileSync(graph, 'utf8');
  const output = '{"outcome":"needs-research"}\n';
  const proposer = () => ({ node: { nodeId: 'research', kind: 'agent', recipe: 'none', maxVisits: 1,
    contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'second', reason: 'research is needed' });
  const calls: string[] = [];
  const runBash = async (body: string) => { calls.push(body); return { stdout: calls.length === 1 || calls.length === 3 ? output : '', stderr: '', exitCode: 0 }; };
  const off = await runGraph(graph, { deps: { root, runBash, growthProposer: () => { throw new Error('off invoked proposer'); } } });
  expect(off.path).toEqual(['first', 'second', 'done']);
  expect(off.growth).toBeUndefined();
  writeFileSync(graph, `grow: on\n${source}`);
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const on = await runGraph(graph, { deps: { root, runBash, growthProposer: proposer, log: (event, data) => { logs.push({ event, data }); } } });
  expect(on.status).toBe('done');
  const added = debug.events(500).filter((entry) => entry.category === 'graph.run' && entry.event === 'edge-added' &&
    (entry.data as { runId?: string })?.runId === on.runId);
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ data: { graphId: 'test-graph', runId: on.runId, from: 'first', outcome: 'needs-research', to: 'research' } });
  expect(on.path).toEqual(['first', 'research', 'second', 'done']);
  expect(on.growth).toHaveLength(1);
  expect(JSON.parse(readFileSync(on.statePath, 'utf8')).growth).toEqual(on.growth);
  expect(logs.filter((entry) => entry.event === 'edge-added')).toEqual([{ event: 'edge-added', data: {
    graphId: 'test-graph', runId: on.runId, from: 'first', outcome: 'needs-research', to: 'research',
  } }]);
});

test('grow off preserves the fallback edge for an unknown outcome without calling the proposer', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, readFileSync(graph, 'utf8').replace('map: { ok: second, fail: failed }',
    'map: { fail: failed }\n    fallback:\n      - { node: second, requires: [] }'));
  const result = await runGraph(graph, { deps: { root,
    runBash: async () => ({ stdout: '{"outcome":"needs-research"}\n', stderr: '', exitCode: 0 }),
    growthProposer: () => { throw new Error('off invoked proposer'); },
  } });
  expect(result.status).toBe('done');
  expect(result.path).toEqual(['first', 'second', 'done']);
  expect(result.growth).toBeUndefined();
});

test('rejected growth retains the original fallback and records its reason', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
  const result = await runGraph(graph, { deps: { root, runBash: async () => ({ stdout: '{"outcome":"new"}\n', stderr: '', exitCode: 0 }),
    growthProposer: () => ({ node: { nodeId: 'done', kind: 'agent', recipe: 'none', maxVisits: 1,
      contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'second', reason: 'invalid' }) } });
  expect(result.path).toEqual(['first', 'second', 'done']);
  expect(result.growth).toBeUndefined();
  expect(result.growthRejections?.[0]?.reason).toContain('invalid-growth');
});

test('an accepted growth survives an interrupted run and resume follows its saved edge without proposing again', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
  const deps = { root, runBash: async (body: string) => ({ stdout: body.includes('exit 0') ? '{"outcome":"new"}\n' : '', stderr: '', exitCode: 0 }),
    growthProposer: () => ({ node: { nodeId: 'research', kind: 'agent', recipe: 'none', maxVisits: 1,
      contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'second', reason: 'need research' }) };
  const first = await runGraph(graph, { deps });
  expect(first.path).toEqual(['first', 'research', 'second', 'done']);
  const saved = JSON.parse(readFileSync(first.statePath, 'utf8'));
  saved.status = 'running';
  saved.path = ['first'];
  saved.nodes = [saved.nodes[0]];
  saved.executed = 1;
  writeFileSync(first.statePath, JSON.stringify(saved));
  const resumed = await runGraph(graph, { resumeRunId: first.runId, deps: { root,
    runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    growthProposer: () => { throw new Error('already accepted growth proposed twice'); } } });
  expect(resumed.status).toBe('done');
  expect(resumed.path).toEqual(['first', 'research', 'second', 'done']);
  expect(resumed.growth).toEqual(first.growth);
});

test('missing return edge falls back and records a rejection instead of executing a dead-end node', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
  const run = await runGraph(graph, { deps: { root, runBash: async () => ({ stdout: '{"outcome":"new"}\n', stderr: '', exitCode: 0 }),
    growthProposer: () => ({ node: { nodeId: 'dead-end', kind: 'agent', recipe: 'none', maxVisits: 1,
      contract: { inputs: [], tools: 'read-only', outputs: [] } }, reason: 'missing return' }) } });
  expect(run.status).toBe('done');
  expect(run.path).toEqual(['first', 'second', 'done']);
  expect(run.growth).toBeUndefined();
  expect(run.growthRejections?.[0]?.reason).toContain('invalid-growth');
});

test('a human growth decision resumes into the added edge or the original fallback without a second card', async () => {
  for (const choice of ['a', 'b'] as const) {
    const { graph, root } = fixture('exit 0');
    writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
    writeFileSync(join(root, 'recipes.yaml'), `${readFileSync(join(root, 'recipes.yaml'), 'utf8')}publish:\n  command: 'printf published'\n`);
    const entries: DecisionEntry[] = [];
    const ledger = { raiseOnce: (value: Record<string, unknown>, ref: string) => {
      const existing = entries.find(entry => entry.refs?.includes(ref));
      if (existing) return existing;
      const entry = { ...value, id: 'D-growth', status: 'open' } as DecisionEntry;
      entries.push(entry);
      return entry;
    } };
    const calls: string[] = [];
    const deps = { root, growthDecision: { ledger, list: () => entries },
      runBash: async (body: string) => { calls.push(body); return { stdout: calls.length === 1 ? '{"outcome":"new"}\n' : '', stderr: '', exitCode: 0 }; },
      growthProposer: () => ({ node: { nodeId: 'publish', kind: 'agent', recipe: 'cmd:publish', maxVisits: 1,
        contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'second', reason: 'publish' }) };
    const parked = await runGraph(graph, { deps });
    expect(parked.status).toBe('awaiting-approval');
    expect(parked.growthPark?.decisionId).toBe('D-growth');
    expect(entries).toHaveLength(1);
    await expect(runGraph(graph, { resumeRunId: parked.runId, deps })).rejects.toThrow('growth is parked for human confirmation');
    entries[0] = { ...entries[0]!, status: 'decided', choice, decidedBy: { kind: 'auto', agent: 'robot', delegation: 'test' } };
    await expect(runGraph(graph, { resumeRunId: parked.runId, deps })).rejects.toThrow('growth is parked for human confirmation');
    entries[0] = { ...entries[0]!, decidedBy: { kind: 'human' } };
    const resumed = await runGraph(graph, { resumeRunId: parked.runId, deps });
    expect(resumed.status).toBe('done');
    expect(resumed.path).toEqual(choice === 'a' ? ['first', 'publish', 'second', 'done'] : ['first', 'second', 'done']);
    expect(resumed.growth ?? []).toHaveLength(choice === 'a' ? 1 : 0);
    expect(calls.some(body => body.includes('published'))).toBe(choice === 'a');
    expect(entries).toHaveLength(1);
  }
});

test('a recipe with both approval and command records its resolved command on the growth card and park', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
  writeFileSync(join(root, 'recipes.yaml'), `${readFileSync(join(root, 'recipes.yaml'), 'utf8')}publish:\n  approval: 'Publish now?'\n  command: 'printf published'\n`);
  const entries: DecisionEntry[] = [];
  const ledger = { raiseOnce: (value: Record<string, unknown>, ref: string) => {
    const entry = { ...value, id: 'D-approval-growth', status: 'open' } as DecisionEntry;
    entries.push(entry);
    return entry;
  } };
  const calls: string[] = [];
  const deps = { root, growthDecision: { ledger, list: () => entries },
    runBash: async (body: string) => { calls.push(body); return { stdout: calls.length === 1 ? '{"outcome":"new"}\n' : '', stderr: '', exitCode: 0 }; },
    growthProposer: () => ({ node: { nodeId: 'publish', kind: 'agent', recipe: 'approval:publish', maxVisits: 1,
      contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'second', reason: 'publish' }) };
  const parked = await runGraph(graph, { deps });
  expect(parked.status).toBe('awaiting-approval');
  expect(parked.growthPark).toMatchObject({ command: { command: 'printf published' }, approval: 'Publish now?' });
  expect(entries).toHaveLength(1);
  expect(entries[0]?.pendingQuestion).toContain('printf published');
  expect(entries[0]?.pendingQuestion).toContain('Publish now?');
  entries[0] = { ...entries[0]!, status: 'decided', choice: 'a', decidedBy: { kind: 'human' } };
  const resumed = await runGraph(graph, { resumeRunId: parked.runId, deps });
  expect(resumed.growth).toHaveLength(1);
  expect(resumed.path).toEqual(['first', 'publish']);
  expect(resumed.pending?.message).toBe('Publish now?');
  expect(calls).toEqual(['exit 0']);
  decideGraphApproval(resumed.graphId, resumed.runId, 'approved', 'person', root);
  const finished = await runGraph(graph, { resumeRunId: resumed.runId, deps });
  expect(finished.status).toBe('done');
  expect(finished.path).toEqual(['first', 'publish', 'second', 'done']);
  expect(calls).toEqual(['exit 0', 'printf published', 'exit 0']);
  expect(entries).toHaveLength(1);
});

test('a card cannot approve a changed parked node, command or approval', async () => {
  for (const mutation of ['node', 'command', 'approval'] as const) {
    const { graph, root } = fixture('exit 0');
    writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
    writeFileSync(join(root, 'recipes.yaml'), `${readFileSync(join(root, 'recipes.yaml'), 'utf8')}publish:\n  approval: 'Publish now?'\n  command: 'printf original'\n`);
    const entries: DecisionEntry[] = [];
    const ledger = { raiseOnce: (value: Record<string, unknown>) => {
      const entry = { ...value, id: 'D-target', status: 'open' } as DecisionEntry;
      entries.push(entry);
      return entry;
    } };
    const calls: string[] = [];
    const deps = { root, growthDecision: { ledger, list: () => entries },
      runBash: async (body: string) => { calls.push(body); return { stdout: '{"outcome":"new"}\n', stderr: '', exitCode: 0 }; },
      growthProposer: () => ({ node: { nodeId: 'publish', kind: 'agent', recipe: 'approval:publish', maxVisits: 1,
        contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'second', reason: 'publish' }) };
    const parked = await runGraph(graph, { deps });
    expect(parked.growthPark).toBeDefined();
    expect(entries).toHaveLength(1);
    entries[0] = { ...entries[0]!, status: 'decided', choice: 'a', decidedBy: { kind: 'human' } };
    const saved = JSON.parse(readFileSync(parked.statePath, 'utf8'));
    if (mutation === 'node') saved.growthPark.growth.node.contract.tools = 'git push';
    if (mutation === 'command') saved.growthPark.command.command = 'printf substituted';
    if (mutation === 'approval') saved.growthPark.approval = 'Approve something else?';
    writeFileSync(parked.statePath, JSON.stringify(saved));
    const before = readFileSync(parked.statePath, 'utf8');
    await expect(runGraph(graph, { resumeRunId: parked.runId, deps })).rejects.toThrow('growth approval target changed since card was raised');
    expect(readFileSync(parked.statePath, 'utf8')).toBe(before);
    expect(calls).toEqual(['exit 0']);
  }
});

test('a changed parked command cannot execute under its old human approval', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
  const recipes = join(root, 'recipes.yaml');
  writeFileSync(recipes, `${readFileSync(recipes, 'utf8')}publish:\n  command: 'printf original'\n`);
  const entries: DecisionEntry[] = [];
  const ledger = { raiseOnce: (value: Record<string, unknown>, ref: string) => {
    const existing = entries.find(entry => entry.refs?.includes(ref));
    if (existing) return existing;
    const entry = { ...value, id: `D-${entries.length + 1}`, status: 'open' } as DecisionEntry;
    entries.push(entry);
    return entry;
  } };
  const calls: string[] = [];
  const deps = { root, growthDecision: { ledger, list: () => entries },
    runBash: async (body: string) => { calls.push(body); return { stdout: calls.length === 1 ? '{"outcome":"new"}\n' : '', stderr: '', exitCode: 0 }; },
    growthProposer: () => ({ node: { nodeId: 'publish', kind: 'agent', recipe: 'cmd:publish', maxVisits: 1,
      contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'second', reason: 'publish' }) };
  const parked = await runGraph(graph, { deps });
  expect(parked.growthPark?.command?.command).toBe('printf original');
  expect(entries[0]?.pendingQuestion).toContain('printf original');
  entries[0] = { ...entries[0]!, status: 'decided', choice: 'a', decidedBy: { kind: 'human' } };
  writeFileSync(recipes, readFileSync(recipes, 'utf8').replace('printf original', 'printf changed'));
  const snapshot = join(`${parked.statePath}.graph`, 'recipes.yaml');
  writeFileSync(snapshot, readFileSync(snapshot, 'utf8').replace('printf original', 'printf changed'));
  const changedSource = readFileSync(snapshot, 'utf8');
  const saved = JSON.parse(readFileSync(parked.statePath, 'utf8'));
  saved.graphSnapshot.recipesSha = createHash('sha256').update(changedSource).digest('hex');
  saved.sourceHash = createHash('sha256').update(readFileSync(join(`${parked.statePath}.graph`, 'graph.yaml'), 'utf8')).update('\0').update(changedSource).digest('hex');
  writeFileSync(parked.statePath, JSON.stringify(saved));
  await expect(runGraph(graph, { resumeRunId: parked.runId, deps })).rejects.toThrow('growth command changed since approval');
  expect(calls).toEqual(['exit 0']);
  expect(JSON.parse(readFileSync(parked.statePath, 'utf8')).growthPark).toBeDefined();
});

test('an approval-only growth card cannot run a command added to its recipe after the card', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
  const recipes = join(root, 'recipes.yaml');
  writeFileSync(recipes, `${readFileSync(recipes, 'utf8')}publish:\n  approval: 'Publish now?'\n`);
  const entries: DecisionEntry[] = [];
  const ledger = { raiseOnce: (value: Record<string, unknown>) => {
    const entry = { ...value, id: 'D-added', status: 'open' } as DecisionEntry;
    entries.push(entry);
    return entry;
  } };
  const calls: string[] = [];
  const deps = { root, growthDecision: { ledger, list: () => entries },
    runBash: async (body: string) => { calls.push(body); return { stdout: calls.length === 1 ? '{"outcome":"new"}\n' : '', stderr: '', exitCode: 0 }; },
    growthProposer: () => ({ node: { nodeId: 'publish', kind: 'agent', recipe: 'approval:publish', maxVisits: 1,
      contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'second', reason: 'publish' }) };
  const parked = await runGraph(graph, { deps });
  expect(parked.growthPark?.approval).toBe('Publish now?');
  expect(parked.growthPark?.command).toBeUndefined();
  entries[0] = { ...entries[0]!, status: 'decided', choice: 'a', decidedBy: { kind: 'human' } };
  writeFileSync(recipes, readFileSync(recipes, 'utf8').replace("approval: 'Publish now?'\n", "approval: 'Publish now?'\n  command: 'printf added'\n"));
  const snapshot = join(`${parked.statePath}.graph`, 'recipes.yaml');
  writeFileSync(snapshot, readFileSync(recipes, 'utf8'));
  const changedSource = readFileSync(snapshot, 'utf8');
  const saved = JSON.parse(readFileSync(parked.statePath, 'utf8'));
  saved.graphSnapshot.recipesSha = createHash('sha256').update(changedSource).digest('hex');
  saved.sourceHash = createHash('sha256').update(readFileSync(join(`${parked.statePath}.graph`, 'graph.yaml'), 'utf8')).update('\0').update(changedSource).digest('hex');
  writeFileSync(parked.statePath, JSON.stringify(saved));
  await expect(runGraph(graph, { resumeRunId: parked.runId, deps })).rejects.toThrow('growth command changed since approval');
  expect(calls).toEqual(['exit 0']);
});

test('a recipe carrying an approval never runs as a bare cmd: command', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(join(root, 'recipes.yaml'), `first:\n  approval: 'Run first?'\n  command: 'printf leaked'\nsecond:\n  command: "exit 0"\n`);
  const calls: string[] = [];
  const deps = { root, runBash: async (body: string) => { calls.push(body); return { stdout: '', stderr: '', exitCode: 0 }; } };
  await expect(runGraph(graph, { deps })).rejects.toThrow('unknown command recipe for first');
  expect(calls).toEqual([]);
});

test('a rejected approval node never runs its command', async () => {
  const { graph, root } = approvalFixture();
  writeFileSync(join(root, 'recipes.yaml'), 'a:\n  command: "exit 0"\ngate:\n  approval: "Publish now?"\n  command: "printf gated"\nb:\n  command: "exit 0"\n');
  const calls: string[] = [];
  const deps = { root, runBash: async (body: string) => { calls.push(body); return { stdout: '', stderr: '', exitCode: 0 }; } };
  const first = await runGraph(graph, { deps });
  decideGraphApproval(first.graphId, first.runId, 'rejected', 'owner', root);
  const result = await runGraph(graph, { resumeRunId: first.runId, deps });
  expect(result.path).toEqual(['a', 'gate', 'failed']);
  expect(calls).toEqual(['exit 0']);
});

test('external side-effect growth parks and cannot be approved into execution', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
  const run = await runGraph(graph, { deps: { root, growthDecision: fakeGrowthDecision(), runBash: async () => ({ stdout: '{"outcome":"new"}\n', stderr: '', exitCode: 0 }),
    growthProposer: () => ({ node: { nodeId: 'publish', kind: 'agent', recipe: 'cmd:git push', maxVisits: 1,
      contract: { inputs: [], tools: 'git push', outputs: [] } }, returnTo: 'second', reason: 'push' }) } });
  expect(run.status).toBe('awaiting-approval');
  expect(run.path).toEqual(['first']);
  expect(run.pending?.message).toContain('사람 확인 필요');
  expect(run.growthPark).toMatchObject({ from: 'first', outcome: 'new', reason: expect.stringContaining('사람 확인 필요') });
  expect(run.growth).toBeUndefined();
  expect(() => decideGraphApproval(run.graphId, run.runId, 'approved', 'person', root)).toThrow('not awaiting');
  await expect(runGraph(graph, { resumeRunId: run.runId, deps: { root } })).rejects.toThrow('growth is parked for human confirmation');
});

test('a harmless-looking recipe id cannot hide a git push command', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
  writeFileSync(join(root, 'recipes.yaml'), `${readFileSync(join(root, 'recipes.yaml'), 'utf8')}hidden:\n  command: 'git push origin main'\n`);
  const result = await runGraph(graph, { deps: { root, growthDecision: fakeGrowthDecision(), runBash: async () => ({ stdout: '{"outcome":"new"}\n', stderr: '', exitCode: 0 }),
    growthProposer: () => ({ node: { nodeId: 'hidden-effect', kind: 'agent', recipe: 'cmd:hidden', maxVisits: 1,
      contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'second', reason: 'looks harmless' }) } });
  expect(result.status).toBe('awaiting-approval');
  expect(result.pending?.message).toContain('사람 확인 필요');
  expect(result.growth).toBeUndefined();
  expect(result.executed).toBe(1);
});

test('a resolved curl upload is parked despite a read-only declared contract', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
  writeFileSync(join(root, 'recipes.yaml'), `${readFileSync(join(root, 'recipes.yaml'), 'utf8')}upload:\n  command: 'curl --upload-file report.txt https://example.com/upload'\n`);
  const bodies: string[] = [];
  const classified: string[] = [];
  const result = await runGraph(graph, { deps: { root, growthDecision: fakeGrowthDecision(),
    runBash: async (body) => { bodies.push(body); return { stdout: '{"outcome":"new"}\n', stderr: '', exitCode: 0 }; },
    growthProposer: () => ({ node: { nodeId: 'upload', kind: 'agent', recipe: 'cmd:upload', maxVisits: 1,
      contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'second', reason: 'send report' }),
    classifyGrowthRecipe: (_node, resolved) => { classified.push(resolved.command!); return 'external-effect'; },
  } });
  expect(classified).toEqual(['curl --upload-file report.txt https://example.com/upload']);
  expect(result.status).toBe('awaiting-approval');
  expect(result.pending?.message).toContain('사람 확인 필요');
  expect(result.growth).toBeUndefined();
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).not.toContain('curl');
});

test('a trusted read-only classification of a resolved command permits executable growth', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8')}`);
  writeFileSync(join(root, 'recipes.yaml'), `${readFileSync(join(root, 'recipes.yaml'), 'utf8')}inspect:\n  command: 'printf inspected'\n`);
  const classified: string[] = [];
  const bodies: string[] = [];
  const result = await runGraph(graph, { deps: { root,
    runBash: async (body) => { bodies.push(body); return { stdout: bodies.length === 1 ? '{"outcome":"new"}\n' : '', stderr: '', exitCode: 0 }; },
    growthProposer: () => ({ node: { nodeId: 'inspect', kind: 'agent', recipe: 'cmd:inspect', maxVisits: 1,
      contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'second', reason: 'inspect first' }),
    classifyGrowthRecipe: (_node, resolved) => { classified.push(resolved.command!); return 'read-only'; },
  } });
  expect(classified).toEqual(['printf inspected']);
  expect(result.status).toBe('done');
  expect(result.path).toEqual(['first', 'inspect', 'second', 'done']);
  expect(bodies).toEqual(['exit 0', 'printf inspected', 'exit 0']);
  expect(result.growth).toHaveLength(1);
});

test('growth limit 3 and duplicate (node, outcome) reject without re-proposing', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8').replace('max_visits: 1 }', 'max_visits: 5 }')}`);
  let calls = 0;
  const run = await runGraph(graph, { deps: { root, runBash: async (_body, opts) => {
    const context = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8'));
    return { stdout: JSON.stringify({ outcome: context.nodeId === 'first' ? `new-${++calls}` : 'ok' }), stderr: '', exitCode: 0 };
  }, growthProposer: ({ outcome }) => ({ node: { nodeId: `added-${outcome}`, kind: 'agent', recipe: 'none', maxVisits: 1,
    contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'first', reason: outcome }) } });
  expect(run.growth).toHaveLength(3);
  expect(run.growthRejections?.at(-1)?.reason).toBe('growth limit 3 reached');
  expect(run.path).toEqual(['first', 'added-new-1', 'first', 'added-new-2', 'first', 'added-new-3', 'first', 'second', 'done']);
  expect(calls).toBe(4);
});

test('one (node, outcome) growth is reused on a revisit rather than proposed again', async () => {
  const { graph, root } = fixture('exit 0');
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8').replace('max_visits: 1 }', 'max_visits: 3 }')}`);
  let proposals = 0;
  const result = await runGraph(graph, { deps: { root, runBash: async (_body, opts) => ({
    stdout: JSON.stringify({ outcome: JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')).nodeId === 'first' ? 'new' : 'ok' }),
    stderr: '', exitCode: 0,
  }), growthProposer: () => { proposals++; return { node: { nodeId: 'research', kind: 'agent', recipe: 'none', maxVisits: 3,
    contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'first', reason: 'same outcome' }; } } });
  expect(proposals).toBe(1);
  expect(result.growth).toHaveLength(1);
  expect(result.status).toBe('budget-exceeded');
  expect(result.path).toEqual(['first', 'research', 'first', 'research', 'first', 'research']);
});

// 09-30 🅢: 작업 트리 `graph run … --config-dir ~/.elanous` 의 `cmd:` 자식이 코드 위치로 시험 우주를 새로 골랐다.
test('an explicit config dir pins the state-backed config root for every cmd child without forwarding an ignored config env', async () => {
  const { graph, root } = fixture('exit 0');
  const explicit = mkdtempSync(join(tmpdir(), 'graph-universe-'));
  const envs: NodeJS.ProcessEnv[] = [];
  const priorConfig = process.env.ELANOUS_CONFIG_DIR;
  const priorState = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_CONFIG_DIR = '/ignored/parent/config';
  try {
    setElanousConfigDir(explicit);
    const expectedConfig = getElanousConfigDir();
    const expectedState = effectiveInstanceRoot();
    const pinned = await runGraph(graph, { deps: { root, runBash: async (_body, opts) => { envs.push(opts.env!); return { stdout: '', stderr: '', exitCode: 0 }; } } });
    expect(pinned.status).toBe('done');
    expect(envs).toHaveLength(2);
    expect(envs.every((env) => env.ELANOUS_CONFIG_DIR === undefined && env.ELANOUS_STATE_DIR === expectedState)).toBe(true);
    expect(expectedConfig).toBe(expectedState);
    const child = Bun.spawnSync({
      cmd: [process.execPath, '-e', `import { getElanousConfigDir } from ${JSON.stringify(join(import.meta.dir, '../elanous-config-dir.ts'))}; console.log(getElanousConfigDir());`],
      env: envs[0], stdout: 'pipe', stderr: 'pipe',
    });
    expect(child.exitCode).toBe(0);
    expect(new TextDecoder().decode(child.stdout).trim()).toBe(expectedConfig);
    resetElanousConfigDir();
    envs.length = 0;
    process.env.ELANOUS_STATE_DIR = '/inherited/state';
    await runGraph(graph, { deps: { root, runBash: async (_body, opts) => { envs.push(opts.env!); return { stdout: '', stderr: '', exitCode: 0 }; } } });
    expect(envs).toHaveLength(2);
    expect(envs.every((env) => env.ELANOUS_CONFIG_DIR === undefined && env.ELANOUS_STATE_DIR === '/inherited/state')).toBe(true);
  } finally {
    resetElanousConfigDir();
    if (priorConfig === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = priorConfig;
    if (priorState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = priorState;
    rmSync(explicit, { recursive: true, force: true });
  }
});
