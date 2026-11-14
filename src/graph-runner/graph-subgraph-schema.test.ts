import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { manageGraphRun, runGraph } from './runner.js';

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

test('subgraph resume keeps the original child definition, schema, steps, and exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-unit-resume-'));
  const graph = join(root, 'graph.yaml');
  const unitDir = join(root, 'units');
  const childPath = join(unitDir, 'worker.yaml');
  try {
    mkdirSync(unitDir);
    writeFileSync(join(root, 'recipes.yaml'), 'post:\n  command: "printf posted"\n');
    writeFileSync(join(unitDir, 'recipes.yaml'), 'produce:\n  command: "printf produced"\n');
    writeFileSync(graph, `graph_id: parent
version: 1
entry_node: invoke
terminal_nodes: [done, failed]
nodes:
  - node_id: invoke
    kind: subgraph
    recipe: none
    max_visits: 2
    call: worker@1
    budget: { inner_steps: 3 }
    contract: { inputs: [request], tools: read-only, outputs: [answer], input_schema: { type: object, required: [request], properties: { request: { type: string } } }, output_schema: { type: object, required: [answer], properties: { answer: { type: string } } } }
  - { node_id: post, kind: agent, recipe: 'cmd:post', max_visits: 2 }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: invoke, on: outcome, map: { done: post, failed: failed } }
  - { from: post, on: outcome, map: { ok: done, fail: failed } }
`);
    const childSource = `graph_id: worker
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
`;
    writeFileSync(childPath, childSource);
    let postRuns = 0;
    let holdPost = false;
    let releasePost!: () => void;
    let postStarted!: () => void;
    const blockedPost = new Promise<void>(resolve => { releasePost = resolve; });
    const postStart = new Promise<void>(resolve => { postStarted = resolve; });
    const commands: string[] = [];
    const deps = { root, runBash: async (command: string) => {
      commands.push(command);
      if (command === 'printf posted' && holdPost) { postStarted(); await blockedPost; }
      return command === 'printf posted'
        ? { stdout: '', stderr: '', exitCode: postRuns++ === 0 ? 1 : 0 }
        : { stdout: '{"answer":"world"}', stderr: '', exitCode: 0 };
    } };
    const first = await runGraph(graph, { input: { request: 'hello' }, deps, quiet: true });
    expect(first.status).toBe('failed');
    expect(first.path).toEqual(['invoke', 'post', 'failed']);
    expect(first.unitCalls?.[0]).toMatchObject({ unit: 'worker', version: 1, steps: 2, exit: 'done' });
    expect(first.unitPins?.invoke).toMatchObject({ unit: 'worker', version: 1, path: childPath, hash: first.unitCalls?.[0]?.hash });
    writeFileSync(childPath, childSource.replace('max_visits: 1 }', 'max_visits: 2 }'));
    const before = readFileSync(first.statePath, 'utf8');
    await expect(runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'invoke', deps, quiet: true }))
      .rejects.toThrow('unit source changed since run started: invoke');
    expect(readFileSync(first.statePath, 'utf8')).toBe(before);
    expect(commands).toHaveLength(2);
    writeFileSync(childPath, childSource);
    const resumed = await runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'invoke', deps, quiet: true });
    expect(resumed.status).toBe('done');
    expect(resumed.path).toEqual(['invoke', 'post', 'done']);
    expect(resumed.unitCalls?.[0]).toMatchObject({ unit: 'worker', version: 1, steps: 2, exit: 'done', hash: first.unitCalls?.[0]?.hash });
    expect(resumed.unitCalls?.[0]?.childRunId).not.toBe(first.unitCalls?.[0]?.childRunId);
    expect(commands).toHaveLength(4);
    holdPost = true;
    const running = runGraph(graph, { runId: 'parent-stopped', input: { request: 'hello' }, deps, quiet: true });
    await postStart;
    let stopped;
    try { stopped = manageGraphRun('parent', 'parent-stopped', 'stop', root, () => null); }
    finally { releasePost(); }
    await expect(running).rejects.toThrow('run was stopped or ownership changed');
    expect(stopped.status).toBe('failed');
    expect(stopped.unitCalls?.[0]).toMatchObject({ unit: 'worker', version: 1, steps: 2, exit: 'done' });
    const stoppedChildRunId = stopped.unitCalls?.[0]?.childRunId;
    const continued = await runGraph(graph, { resumeRunId: stopped.runId, fromNodeId: 'post', deps, quiet: true });
    expect(continued.status).toBe('done');
    expect(continued.unitCalls?.[0]).toMatchObject({ childRunId: stoppedChildRunId, steps: 2, exit: 'done' });
    expect(commands.filter(command => command === 'printf produced')).toHaveLength(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
