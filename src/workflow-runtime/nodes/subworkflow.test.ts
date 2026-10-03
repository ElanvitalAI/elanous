import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { runWorkflowToCompletion } from '../executor.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../../elanous-config-dir.js';
import { setWorkflowPin } from '../pin-data.js';
import { registerNodeKind } from '../../graph-kinds/registry.js';
import { isPluginKindNode } from '../plugin-kind-node.js';
import { validateWorkflow } from '../schema.js';
import type { WorkflowDefinition, WorkflowDeps } from '../types.js';

const root = mkdtempSync(join(tmpdir(), 'subworkflow-'));
const oldCwd = process.cwd();
beforeEach(() => {
  process.chdir(root);
  setElanousConfigDir(join(root, 'config'));
});
mkdirSync(join(root, '.elanous', 'workflows'), { recursive: true });
afterAll(() => {
  resetElanousConfigDir();
  process.chdir(oldCwd);
  rmSync(root, { recursive: true, force: true });
});

const deps: WorkflowDeps = {
  callLLM: async () => '',
  runBash: async () => ({ stdout: '', stderr: 'child failed', exitCode: 1 }),
};
const workflow = (name: string, nodes: WorkflowDefinition['nodes']): WorkflowDefinition => ({ name, description: name, nodes });
const save = (w: WorkflowDefinition) => writeFileSync(join(root, '.elanous', 'workflows', `${w.name}.yaml`), stringify(w));
const execute = (w: WorkflowDefinition, options: Partial<Parameters<typeof runWorkflowToCompletion>[0]> = {}, runtimeDeps: WorkflowDeps = deps) =>
  runWorkflowToCompletion({ workflow: w, arguments: 'hello', artifactsDir: join(root, 'artifacts'), ...options }, runtimeDeps);

test('child outputs feed the next parent node and carry the child run id', async () => {
  save(workflow('child', [{ id: 'echo', template: { template: '{{ARGUMENTS}}' } }]));
  const parent = workflow('parent', [
    { id: 'call', kind: 'subworkflow', workflow: 'child', inputs: { value: '$ARGUMENTS' } },
    { id: 'next', depends_on: ['call'], template: { template: '{{call.output.echo.output}}' } },
  ]);
  expect(isPluginKindNode(parent.nodes[0]!)).toBe(false);
  expect(validateWorkflow(parent).ok).toBe(true);
  const result = await execute(parent);
  expect(result.ok).toBe(true);
  expect(result.outputs.next?.output).toBe('{"value":"hello"}');
  expect(result.outputs.call?.output).toMatchObject({ echo: { ok: true, output: '{"value":"hello"}' } });
  const done = result.events.find(e => e.type === 'node_done' && e.nodeId === 'call');
  const start = result.events.find(e => e.type === 'node_start' && e.nodeId === 'call');
  expect(done?.type === 'node_done' && done.childRunId).toMatch(/^wf-/);
  expect(start?.type === 'node_start' && start.childRunId).toBe(done?.type === 'node_done' && done.childRunId);
  expect(start).toMatchObject({ nodeType: 'subworkflow' });
  expect(result.events.find(e => e.type === 'workflow_start')).toMatchObject({ mode: 'full' });
});

test('parent and child runs persist distinct run ids and child output', async () => {
  save(workflow('persisted-child', [{ id: 'leaf', template: { template: 'done' } }]));
  const runDir = join(root, 'runs', 'parent-id');
  const result = await execute(workflow('persisted-parent', [
    { id: 'call', kind: 'subworkflow', workflow: 'persisted-child', inputs: {} },
  ]), { runId: 'parent-id', runDir });
  const childRunId = result.outputs.call?.childRunId;
  expect(childRunId).toMatch(/^wf-/);
  const parentRun = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  const childRun = JSON.parse(readFileSync(join(runDir, 'children', childRunId!, 'run.json'), 'utf8'));
  expect(parentRun.runId).toBe('parent-id');
  expect(childRun).toMatchObject({ runId: childRunId, status: 'done', outputs: { leaf: { output: 'done' } } });
});

test('plugin-kind child output feeds parent and plugin failure propagates through the subworkflow', async () => {
  expect(registerNodeKind({
    graph: 'workflow', kind: 'subworkflow-test:echo', plugin: 'subworkflow-test',
    description: 'Echo a child input', core: false, run: { bash: 'printf %s {{inputs.value}}' },
  })).toEqual({ ok: true });
  const child = workflow('plugin-child', [{ id: 'echo', kind: 'subworkflow-test:echo', inputs: { value: 'child value' } }]);
  expect(isPluginKindNode(child.nodes[0]!)).toBe(true);
  save(child);
  const parent = workflow('plugin-parent', [
    { id: 'call', kind: 'subworkflow', workflow: 'plugin-child', inputs: {} },
    { id: 'next', depends_on: ['call'], template: { template: '{{call.output.echo.output}}' } },
  ]);
  const passed = await execute(parent, {}, {
    ...deps, runBash: async () => ({ stdout: 'child value', stderr: '', exitCode: 0 }),
  });
  expect(passed.ok).toBe(true);
  expect(passed.outputs.next?.output).toBe('child value');
  expect(passed.outputs.call?.output).toMatchObject({ echo: { ok: true, output: 'child value' } });
  const failed = await execute(parent);
  expect(failed.ok).toBe(false);
  expect(failed.outputs.call).toMatchObject({ ok: false, output: { echo: { ok: false, error: 'bash exit 1: child failed' } } });
  expect(failed.events.find(e => e.type === 'workflow_failed')).toMatchObject({ error: expect.stringContaining("node 'call' failed") });
});

test('schema rejects self and mutual subworkflow cycles', () => {
  const self = workflow('self', [{ id: 'call', kind: 'subworkflow', workflow: 'self', inputs: {} }]);
  expect(validateWorkflow(self).issues.some(i => i.message.includes('subworkflow cycle'))).toBe(true);
  save(workflow('second', [{ id: 'back', kind: 'subworkflow', workflow: 'first', inputs: {} }]));
  const first = workflow('first', [{ id: 'call', kind: 'subworkflow', workflow: 'second', inputs: {} }]);
  expect(validateWorkflow(first).issues.some(i => i.message.includes('first -> second -> first'))).toBe(true);
});

test('kind subworkflow cannot also declare a body variant', () => {
  const bad = validateWorkflow({ name: 'parent', description: 'parent', nodes: [
    { id: 'call', kind: 'subworkflow', workflow: 'child', inputs: {}, subworkflow: {} },
  ] });
  expect(bad.issues.some(issue => issue.message.includes('pick one'))).toBe(true);
  const wrongShape = validateWorkflow({ name: 'parent', description: 'parent', nodes: [
    { id: 'call', subworkflow: { workflow: 'child', inputs: {} } },
  ] });
  expect(wrongShape.issues.some(issue => issue.path === 'nodes[0].subworkflow')).toBe(true);
});

test('malformed subworkflow inputs and names are rejected by the schema', () => {
  const invalid = validateWorkflow({ name: 'parent', description: 'parent', nodes: [
    { id: 'call', kind: 'subworkflow', workflow: 'bad/name', inputs: { value: 42 } },
  ] });
  expect(invalid.issues.map(issue => issue.path)).toEqual(['nodes[0].workflow', 'nodes[0].inputs']);
});

test('runtime rejects self and mutual cycles even when schema is bypassed', async () => {
  const self = await execute(workflow('self', [{ id: 'call', kind: 'subworkflow', workflow: 'self', inputs: {} }]));
  expect(self.outputs.call?.error).toContain('self -> self');
  save(workflow('second', [{ id: 'back', kind: 'subworkflow', workflow: 'first', inputs: {} }]));
  const mutual = await execute(workflow('first', [{ id: 'call', kind: 'subworkflow', workflow: 'second', inputs: {} }]));
  expect(mutual.ok).toBe(false);
  expect(mutual.outputs.call?.error).toContain('first -> second -> first');
});

test('sixth nested subworkflow call fails at depth limit', async () => {
  for (let i = 2; i <= 7; i++) {
    save(workflow(`level-${i}`, i === 7
      ? [{ id: 'leaf', template: { template: 'done' } }]
      : [{ id: 'call', kind: 'subworkflow', workflow: `level-${i + 1}`, inputs: {} }]));
  }
  const result = await execute(workflow('level-1', [{ id: 'call', kind: 'subworkflow', workflow: 'level-2', inputs: {} }]));
  expect(result.ok).toBe(false);
  expect(result.events.some(e => e.type === 'workflow_failed')).toBe(true);
  const level2 = (result.outputs.call?.output as Record<string, { output: unknown }>)?.call;
  const level3 = (level2?.output as Record<string, { output: unknown }>)?.call;
  const level4 = (level3?.output as Record<string, { output: unknown }>)?.call;
  const level5 = (level4?.output as Record<string, { output: unknown }>)?.call;
  const level6 = (level5?.output as Record<string, { error?: string }>)?.call;
  expect(level6?.error).toContain('depth exceeds 5');

  save(workflow('level-6', [{ id: 'leaf', template: { template: 'done' } }]));
  const five = await execute(workflow('level-1', [
    { id: 'call', kind: 'subworkflow', workflow: 'level-2', inputs: {} },
  ]));
  expect(five.ok).toBe(true);
});

test('child failure with an all_done consumer still fails the parent node', async () => {
  save(workflow('recoverable', [
    { id: 'bad', bash: 'exit 1' },
    { id: 'cleanup', depends_on: ['bad'], trigger_rule: 'all_done', template: { template: 'cleaned' } },
  ]));
  const result = await execute(workflow('parent', [
    { id: 'call', kind: 'subworkflow', workflow: 'recoverable', inputs: {} },
  ]));
  expect(result.outputs.call?.ok).toBe(false);
  expect(result.outputs.call?.output).toMatchObject({ cleanup: { output: 'cleaned' } });
});

test('missing child workflow fails as a parent node with a child run id', async () => {
  const result = await execute(workflow('parent', [
    { id: 'call', kind: 'subworkflow', workflow: 'missing', inputs: {} },
  ]));
  expect(result.ok).toBe(false);
  expect(result.outputs.call?.error).toContain("subworkflow 'missing' not found");
  expect(result.outputs.call?.childRunId).toMatch(/^wf-/);
});

test('child failure becomes parent node failure', async () => {
  save(workflow('broken', [{ id: 'bad', bash: 'exit 1' }]));
  const result = await execute(workflow('parent', [
    { id: 'call', kind: 'subworkflow', workflow: 'broken', inputs: {} },
    { id: 'next', depends_on: ['call'], template: { template: 'not reached' } },
  ]));
  expect(result.ok).toBe(false);
  expect(result.outputs.call).toMatchObject({ ok: false, output: { bad: { ok: false } } });
  expect(result.outputs.next).toBeUndefined();
  expect(result.events.find(e => e.type === 'workflow_failed')).toMatchObject({ error: expect.stringContaining("node 'call' failed") });
});

test('only/from and parent pin do not select or pin child nodes', async () => {
  save(workflow('child', [{ id: 'one', template: { template: 'one' } }, { id: 'two', template: { template: 'two' } }]));
  const parent = workflow('parent', [
    { id: 'before', template: { template: 'before' } },
    { id: 'call', kind: 'subworkflow', workflow: 'child', inputs: {} },
  ]);
  setWorkflowPin('child', 'one', 'wrong child pin');
  setWorkflowPin('parent', 'before', 'parent pin');
  const full = await execute(parent);
  expect(full.outputs.before?.output).toBe('parent pin');
  expect(full.outputs.call?.output).toMatchObject({ one: { output: 'one' }, two: { output: 'two' } });
  for (const options of [{ onlyNode: 'call' }, { fromNode: 'call', previousOutputs: { before: { ok: true, output: 'before', durationMs: 0 } } }]) {
    const result = await execute(parent, options);
    expect(result.ok).toBe(true);
    expect(result.outputs.call?.output).toMatchObject({ one: { output: 'one' }, two: { output: 'two' } });
  }
});

test('W8 parallel path (concurrency 2) runs a subworkflow node with its own child run id', async () => {
  save(workflow('child-par', [{ id: 'echo', template: { template: '{{ARGUMENTS}}' } }]));
  const parent: WorkflowDefinition = { ...workflow('parent-par', [
    { id: 'call', kind: 'subworkflow', workflow: 'child-par', inputs: { value: '$ARGUMENTS' } },
    { id: 'side', template: { template: 'side' } },
    { id: 'next', depends_on: ['call', 'side'], template: { template: '{{call.output.echo.output}}' } },
  ]), concurrency: 2 };
  const result = await execute(parent);
  expect(result.ok).toBe(true);
  expect(result.outputs.next?.output).toBe(result.outputs.call && JSON.parse(JSON.stringify(result.outputs.call)).output?.echo?.output);
  const start = result.events.find(e => e.type === 'node_start' && e.nodeId === 'call') as { childRunId?: string } | undefined;
  const done = result.events.find(e => e.type === 'node_done' && e.nodeId === 'call') as { childRunId?: string } | undefined;
  expect(start?.childRunId).toBeTruthy();
  expect(done?.childRunId).toBe(start?.childRunId);
});
