import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { debug } from '../debug/log.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { getUserConfig } from '../user-config.js';
import { runWorkflowToCompletion } from '../workflow-runtime/executor.js';
import { join } from 'node:path';
import { parseWorkflowYaml } from '../workflow-runtime/parser.js';
import { workflowToGraph, walkWorkflowGraph } from './wf-to-graph.js';
import type { WorkflowDefinition, WorkflowDeps } from '../workflow-runtime/types.js';

const workflow = (nodes: WorkflowDefinition['nodes']): WorkflowDefinition => ({ name: 'branch', description: 'branch', nodes });

test('projection orders join dependencies without dropping the original recipes or mutating YAML', () => {
  const input = workflow([
    { id: 'first', bash: 'echo first' },
    { id: 'second', bash: '$first.output', depends_on: ['first'] },
    { id: 'third', bash: '$first.output', depends_on: ['first'] },
    { id: 'join', bash: '$second.output $third.output', depends_on: ['second', 'third'] },
  ]);
  const before = JSON.stringify(input);
  const result = workflowToGraph(input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(walkWorkflowGraph(result.graph)).toEqual(['first', 'second', 'third', 'join']);
  expect(result.graph.template.edges).toEqual([
    { from: 'first', to: 'second' }, { from: 'second', to: 'third' }, { from: 'third', to: 'join' },
  ]);
  expect(result.graph.recipes.join).toBe(input.nodes[3]);
  expect(JSON.stringify(input)).toBe(before);
});

test('workflow conditional, approval and trigger stay distinct from graph hitl and cursor outcomes', () => {
  const input = workflow([
    { id: 'start', manualTrigger: {} },
    { id: 'approve', approval: { message: 'go?', delivery: 'telegram' }, depends_on: ['start'] },
    { id: 'branch', bash: 'echo ok', depends_on: ['approve'], when: "$approve.output == 'go'" },
  ]);
  const result = workflowToGraph(input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.graph.template.nodes.map(node => node.kind)).toEqual(['manualTrigger', 'approval', 'bash']);
  expect(result.graph.recipes.approve).toEqual(input.nodes[1]);
  expect(result.graph.recipes.branch).toEqual(input.nodes[2]);
});

test('trigger scheduling remains with workflow runtime; graph projection does not advertise an unregistered cron', () => {
  const definition = workflow([
    { id: 'trigger', scheduleTrigger: { type: 'cron', cron: '0 8 * * *' } },
    { id: 'work', bash: 'echo work', depends_on: ['trigger'] },
  ]);
  const converted = workflowToGraph(definition);
  expect(converted.ok).toBe(true);
  if (!converted.ok) return;
  expect(converted.graph.template.loop?.trigger).toBeUndefined();
  expect(converted.graph.recipes.trigger).toBe(definition.nodes[0]);
  expect(walkWorkflowGraph(converted.graph)).toEqual(['trigger', 'work']);
});

test('graph metadata guards recipe dispatch and rejects a changed visit budget or kind', () => {
  const result = workflowToGraph(workflow([{ id: 'first', bash: 'one' }]));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const spec = result.graph.template.nodes[0]!;
  for (const changed of [
    { ...spec, kind: 'prompt' },
    { ...spec, recipe: 'cmd:other' },
    { ...spec, maxVisits: 2 },
  ]) {
    const graph = { ...result.graph, template: { ...result.graph.template, nodes: [changed] } };
    expect(() => walkWorkflowGraph(graph)).toThrow();
  }
  expect(walkWorkflowGraph(result.graph)).toEqual(['first']);
});

test('iteration stays a workflow recipe, not a graph visit budget or unconsumed fanOut', async () => {
  const definition = workflow([{ id: 'each', iteration: { items: '["a","b"]', body: 'echo $item' } }]);
  const converted = workflowToGraph(definition);
  expect(converted.ok).toBe(true);
  if (!converted.ok) return;
  expect(converted.graph.template.nodes[0]).toEqual({ nodeId: 'each', kind: 'iteration', recipe: 'workflow:each', maxVisits: 1 });
  const calls: string[] = [];
  const deps: WorkflowDeps = { callLLM: async () => '', runBash: async body => {
    calls.push(body);
    return { stdout: body, stderr: '', exitCode: 0 };
  } };
  const dir = mkdtempSync(join(tmpdir(), 'wf2g-iteration-'));
  try {
    setElanousConfigDir(join(dir, 'config'));
    const opts = { workflow: definition, arguments: '', artifactsDir: dir };
    const graph = await runWorkflowToCompletion(opts, deps);
    expect(graph.outputs.each?.output).toEqual(['echo a', 'echo b']);
    expect(calls).toEqual(['echo a', 'echo b']);
  } finally { resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); }
});

test('changing the workflow recipe body changes the compatibility executor result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf2g-recipe-'));
  const configDir = join(dir, 'config');
  const deps: WorkflowDeps = { callLLM: async () => '', runBash: async body =>
    ({ stdout: body, stderr: '', exitCode: 0 }) };
  try {
    setElanousConfigDir(configDir);
    const run = (body: string) => runWorkflowToCompletion({
      workflow: workflow([{ id: 'step', bash: body }]), arguments: '', artifactsDir: dir,
    }, deps);
    const first = await run('alpha');
    const changed = await run('beta');
    expect(first.outputs.step?.output).toBe('alpha');
    expect(changed.outputs.step?.output).toBe('beta');
    expect(first.events.map(event => event.type)).toEqual(changed.events.map(event => event.type));
  } finally { resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); }
});

test('workflow condition remains executable through the graph recipe adapter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf2g-when-'));
  const configDir = join(dir, 'config');
  const calls: string[] = [];
  const deps: WorkflowDeps = { callLLM: async () => '', runBash: async body => {
    calls.push(body);
    return { stdout: body, stderr: '', exitCode: 0 };
  } };
  try {
    setElanousConfigDir(configDir);
    const run = (condition: string) => runWorkflowToCompletion({ workflow: workflow([
      { id: 'first', bash: 'one' },
      { id: 'conditional', bash: 'two', depends_on: ['first'], when: condition },
    ]), arguments: '', artifactsDir: dir }, deps);
    const skipped = await run("$first.output == 'other'");
    expect(skipped.events.some(event => event.type === 'node_skipped' && event.nodeId === 'conditional')).toBe(true);
    const executed = await run("$first.output == 'one'");
    expect(executed.outputs.conditional?.output).toBe('two');
    expect(calls).toEqual(['one', 'one', 'two']);
  } finally { resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); }
});

test('graph compatibility preserves fromNode and onlyNode selection and upstream output substitution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf2g-selection-'));
  const configDir = join(dir, 'config');
  const calls: string[] = [];
  const deps: WorkflowDeps = { callLLM: async () => '', runBash: async body => {
    calls.push(body);
    return { stdout: body, stderr: '', exitCode: 0 };
  } };
  const definition = workflow([
    { id: 'first', bash: 'one' },
    { id: 'last', bash: '$first.output', depends_on: ['first'] },
  ]);
  try {
    setElanousConfigDir(configDir);
    const upstream = { first: { ok: true, output: 'saved', durationMs: 0 } };
    const from = await runWorkflowToCompletion({ workflow: definition, arguments: '', artifactsDir: dir,
      fromNode: 'last', previousOutputs: upstream }, deps);
    expect(from.outputs.last?.output).toBe('saved');
    const only = await runWorkflowToCompletion({ workflow: definition, arguments: '', artifactsDir: dir,
      onlyNode: 'last' }, deps);
    expect(only.events.filter(event => event.type === 'node_start').map(event => event.nodeId)).toEqual(['last']);
    expect(calls).toEqual(['saved', '']);
  } finally { resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); }
});

test('unsafe parallel/error routing cannot be projected as a serial graph', () => {
  expect(workflowToGraph({ ...workflow([{ id: 'a', bash: 'a' }]), concurrency: 2 })).toEqual({ ok: false, reason: 'concurrency > 1' });
  expect(workflowToGraph(workflow([{ id: 'a', bash: 'a', on_error: 'b' }, { id: 'b', bash: 'b' }])).ok).toBe(false);
});

test('concurrent workflows fall back with a reason and preserve overlapping execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf2g-concurrency-'));
  const configDir = join(dir, 'config');
  let active = 0;
  let peak = 0;
  const deps: WorkflowDeps = { callLLM: async () => '', runBash: async body => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return { stdout: body, stderr: '', exitCode: 0 };
  } };
  const definition = { ...workflow([{ id: 'a', bash: 'a' }, { id: 'b', bash: 'b' }]), concurrency: 2 };
  try {
    setElanousConfigDir(configDir);
    const before = debug.events(100).filter(event => event.category === 'graph.unify' && event.event === 'wf-fallback').length;
    const result = await runWorkflowToCompletion({ workflow: definition, arguments: '', artifactsDir: dir }, deps);
    expect(result.ok).toBe(true);
    expect(Object.keys(result.outputs)).toEqual(['a', 'b']);
    expect(peak).toBe(2);
    const logs = debug.events(100).filter(event => event.category === 'graph.unify' && event.event === 'wf-fallback');
    expect(logs).toHaveLength(before + 1);
    expect(logs.at(-1)?.data).toMatchObject({ file: definition.name, reason: 'concurrency > 1' });
  } finally { resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); }
});

test('runWorkflow reads one config switch, logs unsupported conversion, and retains wf event/output shape', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf2g-'));
  const configDir = join(dir, 'config');
  const calls: string[] = [];
  const deps: WorkflowDeps = { callLLM: async () => '', runBash: async body => {
    calls.push(body);
    return { stdout: body, stderr: '', exitCode: 0 };
  } };
  const supported = workflow([{ id: 'first', bash: 'one' }, { id: 'last', bash: '$first.output', depends_on: ['first'] }]);
  const unsupported = { ...supported, concurrency: 2 };
  try {
    setElanousConfigDir(configDir);
    const run = (definition: WorkflowDefinition) => runWorkflowToCompletion({ workflow: definition, arguments: '', artifactsDir: dir }, deps);
    const graph = await run(supported);
    expect(graph.ok).toBe(true);
    expect(graph.outputs.last?.output).toBe('one');
    expect(graph.events.filter(event => event.type === 'node_start').map(event => event.nodeId)).toEqual(['first', 'last']);
    const before = debug.events(100).filter(event => event.category === 'graph.unify' && event.event === 'wf-fallback').length;
    const fallback = await run(unsupported);
    expect(fallback.ok).toBe(true);
    expect(fallback.events.map(event => event.type)).toEqual(graph.events.map(event => event.type));
    expect(debug.events(100).filter(event => event.category === 'graph.unify' && event.event === 'wf-fallback').length).toBe(before + 1);
    const onError = workflow([{ id: 'failed', bash: 'broken', on_error: 'recover' }, { id: 'recover', bash: 'recovered' }]);
    const failureDeps: WorkflowDeps = { ...deps, runBash: async body => ({ stdout: body, stderr: '', exitCode: body === 'broken' ? 1 : 0 }) };
    const recover = () => runWorkflowToCompletion({ workflow: onError, arguments: '', artifactsDir: dir }, failureDeps);
    const recovered = await recover();
    expect(recovered.outputs.recover?.output).toBe('recovered');
    expect(debug.events(100).filter(event => event.category === 'graph.unify' && event.event === 'wf-fallback').at(-1)?.data)
      .toMatchObject({ file: onError.name, reason: 'error routing' });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ workflowGraphEnabled: false }));
    expect(getUserConfig().raw.workflowGraphEnabled).toBe(false);
    const disabledSupported = await run(supported);
    expect(disabledSupported.ok).toBe(graph.ok);
    expect(Object.fromEntries(Object.entries(disabledSupported.outputs).map(([id, value]) => [id, { ok: value.ok, output: value.output }])))
      .toEqual(Object.fromEntries(Object.entries(graph.outputs).map(([id, value]) => [id, { ok: value.ok, output: value.output }])));
    expect(disabledSupported.events.map(event => event.type)).toEqual(graph.events.map(event => event.type));
    const legacyRecovered = await recover();
    expect(legacyRecovered.ok).toBe(recovered.ok);
    expect(Object.fromEntries(Object.entries(legacyRecovered.outputs).map(([id, value]) => [id, { ok: value.ok, output: value.output }])))
      .toEqual(Object.fromEntries(Object.entries(recovered.outputs).map(([id, value]) => [id, { ok: value.ok, output: value.output }])));
    expect(legacyRecovered.events.map(event => event.type)).toEqual(recovered.events.map(event => event.type));
    const legacy = await run(unsupported);
    expect(Object.fromEntries(Object.entries(legacy.outputs).map(([id, value]) => [id, { ok: value.ok, output: value.output }])))
      .toEqual(Object.fromEntries(Object.entries(fallback.outputs).map(([id, value]) => [id, { ok: value.ok, output: value.output }])));
    const legacySerial = await run(supported);
    expect(Object.fromEntries(Object.entries(legacySerial.outputs).map(([id, value]) => [id, { ok: value.ok, output: value.output }])))
      .toEqual(Object.fromEntries(Object.entries(graph.outputs).map(([id, value]) => [id, { ok: value.ok, output: value.output }])));
    expect(legacySerial.events.map(event => event.type)).toEqual(graph.events.map(event => event.type));
    expect(debug.events(100).filter(event => event.category === 'graph.unify' && event.event === 'wf-fallback').length).toBe(before + 2);
    expect(calls).toEqual(Array(10).fill('one'));
  } finally { resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); }
});

test('all 21 repository workflow YAML files have a measured conversion rate', () => {
  const root = join(import.meta.dir, '../../samples/workflows');
  const paths = [root, join(root, 'templates')].flatMap(dir => readdirSync(dir).filter(name => name.endsWith('.yaml')).map(name => join(dir, name)));
  expect(paths).toHaveLength(21);
  const results = paths.map(file => {
    const parsed = parseWorkflowYaml(readFileSync(file, 'utf8'));
    expect(parsed.workflow).toBeDefined();
    return { file, converted: parsed.workflow ? workflowToGraph(parsed.workflow) : null };
  });
  const converted = results.filter(result => result.converted?.ok).length;
  expect(converted).toBe(21);
  expect(results.filter(result => !result.converted?.ok).map(result => result.file)).toEqual([]);
  for (const result of results) {
    if (!result.converted?.ok) continue;
    expect(walkWorkflowGraph(result.converted.graph)).toHaveLength(result.converted.graph.template.nodes.length);
  }
});
