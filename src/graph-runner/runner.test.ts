import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { setPluginCredentials } from '../plugins/install/plugin-credentials.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { decideGraphApproval, latestGraphRun, runGraph } from './runner.js';
import { getElanousConfigDir, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';

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
    writeFileSync(join(graph, '..', 'recipes.yaml'), readFileSync(join(source, '..', 'recipes.yaml'), 'utf8'));
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

test('two successful commands reach done and persist both outcomes', async () => {
  const { graph, root } = fixture('exit 0');
  const result = await runGraph(graph, { runId: 'success', deps: { root } });
  expect(result.status).toBe('done');
  expect(result.path).toEqual(['first', 'second', 'done']);
  expect(result.executed).toBe(2);
  expect(JSON.parse(readFileSync(result.statePath, 'utf8')).nodes.slice(0, 2)).toEqual([
    { nodeId: 'first', ok: true, exit: 0, executed: true, output: '' },
    { nodeId: 'second', ok: true, exit: 0, executed: true, output: '' },
  ]);
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
  await expect(runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'first', deps: { root } })).rejects.toThrow('graph or recipes changed');
  expect(readFileSync(first.statePath, 'utf8')).toBe(before);
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

test('missing outcome mapping uses fallback without executing the second command', async () => {
  const { graph, root } = fixture('exit 1');
  writeFileSync(graph, readFileSync(graph, 'utf8').replace('map: { ok: second, fail: failed }', 'map: { ok: second }\n    fallback:\n      - { node: failed, requires: [] }'));
  const result = await runGraph(graph, { deps: { root } });
  expect(result.status).toBe('failed');
  expect(result.path).toEqual(['first', 'failed']);
  expect(result.executed).toBe(1);
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
  await expect(runGraph(graph, { resumeRunId: first.runId, deps: { root } })).rejects.toThrow('approval source changed since run was paused');
  expect(JSON.parse(readFileSync(first.statePath, 'utf8')).status).toBe('awaiting-approval');
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
    await expect(runGraph(graph, { resumeRunId: first.runId, deps })).rejects.toThrow('approval source changed since run was paused');
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

// 09-30 🅢: 작업 트리 `graph run … --config-dir ~/.elanous` 의 `cmd:` 자식이 코드 위치로 시험 우주를 새로 골랐다.
test('an explicit config dir is pinned into every cmd child env; without one the child env is left as the parent had it', async () => {
  const { graph, root } = fixture('exit 0');
  const explicit = mkdtempSync(join(tmpdir(), 'graph-universe-'));
  const envs: NodeJS.ProcessEnv[] = [];
  const priorConfig = process.env.ELANOUS_CONFIG_DIR;
  delete process.env.ELANOUS_CONFIG_DIR;
  try {
    setElanousConfigDir(explicit);
    const expectedConfig = getElanousConfigDir();
    const expectedState = effectiveInstanceRoot();
    const pinned = await runGraph(graph, { deps: { root, runBash: async (_body, opts) => { envs.push(opts.env!); return { stdout: '', stderr: '', exitCode: 0 }; } } });
    expect(pinned.status).toBe('done');
    expect(envs.length).toBeGreaterThan(0);
    expect(envs.every((env) => env.ELANOUS_CONFIG_DIR === expectedConfig && env.ELANOUS_STATE_DIR === expectedState)).toBe(true);
    resetElanousConfigDir();
    envs.length = 0;
    await runGraph(graph, { deps: { root, runBash: async (_body, opts) => { envs.push(opts.env!); return { stdout: '', stderr: '', exitCode: 0 }; } } });
    expect(envs.every((env) => env.ELANOUS_CONFIG_DIR === undefined)).toBe(true);
  } finally {
    resetElanousConfigDir();
    if (priorConfig === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = priorConfig;
    rmSync(explicit, { recursive: true, force: true });
  }
});
