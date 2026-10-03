import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow, runWorkflowToCompletion } from './executor.js';
import { validateWorkflow } from './schema.js';
import { setWorkflowPin } from './pin-data.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import type { WorkflowDefinition, WorkflowDeps } from './types.js';

const dirs: string[] = [];
const dir = () => { const path = mkdtempSync(join(tmpdir(), 'wf-w8-')); dirs.push(path); return path; };
afterEach(() => { resetElanousConfigDir(); for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
const base = (nodes: WorkflowDefinition['nodes'], concurrency?: number): WorkflowDefinition => ({ name: 'w8-test', description: 'w8', nodes, ...(concurrency ? { concurrency } : {}) });
const deps = (runBash: WorkflowDeps['runBash']): WorkflowDeps => ({ callLLM: async () => '', runBash });
const run = (workflow: WorkflowDefinition, dependency: WorkflowDeps, extra: Record<string, unknown> = {}) =>
  runWorkflowToCompletion({ workflow, arguments: '', artifactsDir: dir(), ...extra }, dependency);

test('concurrency 2 overlaps independent nodes, waits for dependencies and keeps paired events', async () => {
  const times: Record<string, { start: number; end: number }> = {};
  const workflow = base([
    { id: 'a', bash: 'a' }, { id: 'b', bash: 'b' },
    { id: 'join', bash: 'join', depends_on: ['a', 'b'] },
  ], 2);
  const result = await run(workflow, deps(async body => {
    times[body] = { start: performance.now(), end: 0 };
    await Bun.sleep(body === 'a' ? 35 : 20);
    times[body]!.end = performance.now();
    return { stdout: body, stderr: '', exitCode: 0 };
  }));
  expect(result.ok).toBe(true);
  expect(times.a!.start).toBeLessThan(times.b!.end);
  expect(times.b!.start).toBeLessThan(times.a!.end);
  expect(times.join!.start).toBeGreaterThanOrEqual(Math.max(times.a!.end, times.b!.end));
  const events = result.events.filter(e => e.type === 'node_start' || e.type === 'node_done').map(e => `${e.type}:${e.nodeId}`);
  expect(events).toEqual(['node_start:a', 'node_start:b', 'node_done:b', 'node_done:a', 'node_start:join', 'node_done:join']);
});

test('node_done preserves completion order when the event consumer pauses', async () => {
  const finish = new Map<string, () => void>();
  const finished: string[] = [];
  const workflow = base([{ id: 'a', bash: 'a' }, { id: 'b', bash: 'b' }, { id: 'c', bash: 'c' }], 3);
  const generator = runWorkflow({ workflow, arguments: '', artifactsDir: dir() }, deps(async body => {
    await new Promise<void>(resolve => { finish.set(body, resolve); });
    finished.push(body);
    return { stdout: body, stderr: '', exitCode: 0 };
  }));
  for (const type of ['workflow_start', 'node_start', 'node_start', 'node_start']) {
    const event = await generator.next();
    if (event.done) throw new Error('workflow ended before starting all nodes');
    expect(event.value).toMatchObject({ type });
  }
  finish.get('b')!();
  expect((await generator.next()).value).toMatchObject({ type: 'node_done', nodeId: 'b' });
  // No generator.next() while the other two nodes complete in reverse dispatch order.
  finish.get('c')!();
  await Bun.sleep(0);
  finish.get('a')!();
  await Bun.sleep(0);
  expect(finished).toEqual(['b', 'c', 'a']);
  expect((await generator.next()).value).toMatchObject({ type: 'node_done', nodeId: 'c' });
  expect((await generator.next()).value).toMatchObject({ type: 'node_done', nodeId: 'a' });
  expect((await generator.next()).value?.type).toBe('workflow_done');
});

test('queued failure is consumed before dispatch after node_done consumer pauses', async () => {
  const finish = new Map<string, () => void>();
  const started: string[] = [];
  const workflow = base([{ id: 'a', bash: 'a' }, { id: 'b', bash: 'b' }, { id: 'c', bash: 'c' }], 2);
  const generator = runWorkflow({ workflow, arguments: '', artifactsDir: dir() }, deps(async body => {
    started.push(body);
    if (body !== 'c') await new Promise<void>(resolve => { finish.set(body, resolve); });
    return { stdout: body, stderr: '', exitCode: body === 'a' ? 1 : 0 };
  }));
  expect((await generator.next()).value?.type).toBe('workflow_start');
  expect((await generator.next()).value).toMatchObject({ type: 'node_start', nodeId: 'a' });
  expect((await generator.next()).value).toMatchObject({ type: 'node_start', nodeId: 'b' });
  const bDone = generator.next();
  await Bun.sleep(0);
  finish.get('b')!();
  expect((await bDone).value).toMatchObject({ type: 'node_done', nodeId: 'b' });
  finish.get('a')!();
  await Bun.sleep(0);
  const rest = [];
  for await (const event of generator) rest.push(event);
  expect(started).toEqual(['a', 'b']);
  expect(rest.map(event => `${event.type}:${'nodeId' in event ? event.nodeId : ''}`))
    .toEqual(['node_done:a', 'workflow_failed:']);
});

test('default concurrency retains serial event sequence', async () => {
  const result = await run(base([{ id: 'a', bash: 'a' }, { id: 'b', bash: 'b' }]), deps(async body => ({ stdout: body, stderr: '', exitCode: 0 })));
  expect(result.events.map(e => e.type)).toEqual(['workflow_start', 'node_start', 'node_done', 'node_start', 'node_done', 'workflow_done']);
});

test('failed output reaches on_error and downstream finishes', async () => {
  const workflow = base([
    { id: 'bad', bash: 'bad', on_error: 'handle' },
    { id: 'handle', bash: 'handled=$bad.output', depends_on: ['bad'] },
    { id: 'last', bash: 'last', depends_on: ['handle'] },
  ], 2);
  const result = await run(workflow, deps(async body => ({ stdout: body === 'bad' ? 'partial' : body, stderr: '', exitCode: body === 'bad' ? 1 : 0 })));
  expect(result.ok).toBe(true);
  expect(result.outputs.bad?.ok).toBe(false);
  expect(result.outputs.handle?.output).toBe('handled=partial');
  expect(result.outputs.last?.ok).toBe(true);
  expect(result.events.at(-1)?.type).toBe('workflow_done');
});

test('default concurrency routes failure to a handler without explicit depends_on', async () => {
  const workflow = base([
    { id: 'bad', bash: 'bad', on_error: 'handle' },
    { id: 'handle', bash: 'handled=$bad.output' },
    { id: 'last', bash: 'last', depends_on: ['handle'] },
  ]);
  const result = await run(workflow, deps(async body => ({ stdout: body === 'bad' ? 'partial' : body, stderr: '', exitCode: body === 'bad' ? 1 : 0 })));
  expect(result.ok).toBe(true);
  expect(result.outputs.handle?.output).toBe('handled=partial');
  expect(result.outputs.last?.ok).toBe(true);
  expect(result.events.map(e => e.type)).toEqual(['workflow_start', 'node_start', 'node_done', 'node_start', 'node_done', 'node_start', 'node_done', 'workflow_done']);
});

test('failed independent branch is not swallowed by another on_error handler', async () => {
  const workflow = base([
    { id: 'bad', bash: 'bad', on_error: 'handle' },
    { id: 'other', bash: 'other' },
    { id: 'handle', bash: 'never', depends_on: ['bad', 'other'] },
  ], 2);
  const result = await run(workflow, deps(async body => ({ stdout: body, stderr: '', exitCode: body === 'other' ? 1 : 0 })));
  expect(result.ok).toBe(false);
  expect(result.outputs.handle).toBeUndefined();
  expect(result.events.at(-1)?.type).toBe('workflow_failed');
});

test('skipped handler cannot claim a failed source when its when expression is false', async () => {
  const workflow = base([
    { id: 'bad', bash: 'bad', on_error: 'handle' },
    { id: 'other', bash: 'other' },
    { id: 'handle', bash: 'never', depends_on: ['bad', 'other'], when: "$other.output == 'go'" },
  ], 2);
  const result = await run(workflow, deps(async body => ({ stdout: body, stderr: '', exitCode: body === 'bad' ? 1 : 0 })));
  expect(result.ok).toBe(false);
  expect(result.outputs.handle).toBeUndefined();
  expect(result.events.some(e => e.type === 'node_skipped' && e.nodeId === 'handle')).toBe(true);
  expect(result.events.at(-1)?.type).toBe('workflow_failed');
});

test('shared on_error handler receives both failures and runs once', async () => {
  const workflow = base([
    { id: 'bad-a', bash: 'bad-a', on_error: 'handle' },
    { id: 'bad-b', bash: 'bad-b', on_error: 'handle' },
    { id: 'handle', bash: 'handle=$bad-a.output,$bad-b.output', depends_on: ['bad-a', 'bad-b'] },
  ], 2);
  const result = await run(workflow, deps(async body => ({ stdout: body, stderr: '', exitCode: body.startsWith('bad-') ? 1 : 0 })));
  expect(result.ok).toBe(true);
  expect(result.outputs.handle?.output).toBe('handle=bad-a,bad-b');
  expect(result.events.filter(e => e.type === 'node_start' && e.nodeId === 'handle')).toHaveLength(1);
  expect(result.events.at(-1)?.type).toBe('workflow_done');
});

test('unrelated all_done cannot suppress a failed branch', async () => {
  const workflow = base([
    { id: 'bad', bash: 'bad' },
    { id: 'other', bash: 'other' },
    { id: 'gather-other', bash: 'gather', depends_on: ['other'], trigger_rule: 'all_done' },
  ], 2);
  const result = await run(workflow, deps(async body => ({ stdout: body, stderr: '', exitCode: body === 'bad' ? 1 : 0 })));
  expect(result.ok).toBe(false);
  expect(result.events.at(-1)?.type).toBe('workflow_failed');
});

test('default concurrency does not let an unrelated all_done swallow failure', async () => {
  const workflow = base([
    { id: 'bad', bash: 'bad' },
    { id: 'other', bash: 'other' },
    { id: 'gather-other', bash: 'gather', depends_on: ['other'], trigger_rule: 'all_done' },
  ]);
  const result = await run(workflow, deps(async body => ({ stdout: body, stderr: '', exitCode: body === 'bad' ? 1 : 0 })));
  expect(result.ok).toBe(false);
  expect(result.events.at(-1)?.type).toBe('workflow_failed');
});

test('a dependent all_done gathers a failed node', async () => {
  const workflow = base([
    { id: 'bad', bash: 'bad' },
    { id: 'gather', bash: 'gather=$bad.error', depends_on: ['bad'], trigger_rule: 'all_done' },
  ], 2);
  const result = await run(workflow, deps(async body => ({ stdout: body, stderr: body === 'bad' ? 'broken' : '', exitCode: body === 'bad' ? 1 : 0 })));
  expect(result.ok).toBe(true);
  expect(result.outputs.gather?.ok).toBe(true);
});

test('one_success handler still receives its failed on_error source', async () => {
  const workflow = base([
    { id: 'bad', bash: 'bad', on_error: 'handle' },
    { id: 'handle', bash: 'handled=$bad.output', depends_on: ['bad'], trigger_rule: 'one_success' },
  ], 2);
  const result = await run(workflow, deps(async body => ({ stdout: body, stderr: '', exitCode: body === 'bad' ? 1 : 0 })));
  expect(result.ok).toBe(true);
  expect(result.outputs.handle?.output).toBe('handled=bad');
});

test('failed handler does not claim a failed source', async () => {
  const workflow = base([{ id: 'bad', bash: 'bad', on_error: 'handle' }, { id: 'handle', bash: 'handle' }], 2);
  const result = await run(workflow, deps(async body => ({ stdout: body, stderr: '', exitCode: 1 })));
  expect(result.ok).toBe(false);
  expect(result.outputs.handle?.ok).toBe(false);
  expect(result.events.at(-1)?.type).toBe('workflow_failed');
});

test('successful source leaves its on_error handler inactive', async () => {
  const workflow = base([{ id: 'work', bash: 'work', on_error: 'handle' }, { id: 'handle', bash: 'never' }], 2);
  const result = await run(workflow, deps(async body => ({ stdout: body, stderr: '', exitCode: 0 })));
  expect(result.outputs.handle).toBeUndefined();
  expect(result.events.some(e => e.type === 'node_skipped' && e.nodeId === 'handle')).toBe(true);
});

test('schema rejects unknown and cyclic on_error and invalid concurrency', () => {
  const raw = { name: 'w8-test', description: 'w8', nodes: [{ id: 'bad', bash: 'bad', on_error: 'missing' }] };
  expect(validateWorkflow(raw).issues.some(i => i.path === 'nodes.bad.on_error')).toBe(true);
  expect(validateWorkflow({ ...raw, nodes: [{ id: 'a', bash: 'a', on_error: 'b' }, { id: 'b', bash: 'b', depends_on: ['a'], on_error: 'a' }] }).issues.some(i => i.message.includes('cycle'))).toBe(true);
  for (const concurrency of [0, 9, 1.5, '2']) expect(validateWorkflow({ ...raw, concurrency }).issues.some(i => i.path === 'concurrency')).toBe(true);
  expect(validateWorkflow({ ...raw, nodes: [{ id: 'bad', bash: 'bad' }], concurrency: 8 }).workflow?.concurrency).toBe(8);
});

test('failed only-node run does not silently claim its excluded handler', async () => {
  const workflow = base([{ id: 'bad', bash: 'bad', on_error: 'handle' }, { id: 'handle', bash: 'handle' }], 2);
  const result = await run(workflow, deps(async body => ({ stdout: body, stderr: '', exitCode: 1 })), { onlyNode: 'bad', mode: 'only' });
  expect(result.ok).toBe(false);
  expect(result.outputs.handle).toBeUndefined();
});

test('test mode still blocks unpinned side effects and accepts pins under concurrency', async () => {
  setElanousConfigDir(dir());
  const workflow = base([{ id: 'a', bash: 'a' }, { id: 'b', bash: 'b' }], 2);
  const calls: string[] = [];
  const dependency = deps(async body => { calls.push(body); return { stdout: body, stderr: '', exitCode: 0 }; });
  const blocked = await run(workflow, dependency, { mode: 'test' });
  expect(blocked.ok).toBe(false);
  expect(blocked.outputs.a?.error).toBe('pin required');
  expect(calls).toEqual([]);
  setWorkflowPin(workflow.name, 'a', 'pinned-a');
  setWorkflowPin(workflow.name, 'b', 'pinned-b');
  const pinned = await run(workflow, dependency, { mode: 'test' });
  expect(pinned.ok).toBe(true);
  expect(pinned.outputs.a?.output).toBe('pinned-a');
  expect(pinned.outputs.b?.output).toBe('pinned-b');
  expect(calls).toEqual([]);
});

test('only/from modes keep selection and pinned outputs with concurrency', async () => {
  setElanousConfigDir(dir());
  const workflow = base([{ id: 'a', bash: 'a' }, { id: 'b', bash: 'b', depends_on: ['a'] }, { id: 'c', bash: 'c', depends_on: ['b'] }], 2);
  setWorkflowPin(workflow.name, 'b', 'pinned');
  const calls: string[] = [];
  const dependency = deps(async body => { calls.push(body); return { stdout: body, stderr: '', exitCode: 0 }; });
  const only = await run(workflow, dependency, { onlyNode: 'b', mode: 'only' });
  expect(only.outputs.b?.output).toBe('pinned');
  expect(Object.keys(only.outputs)).toEqual(['b']);
  const from = await run(workflow, dependency, { fromNode: 'b', mode: 'from', previousOutputs: { a: { ok: true, output: 'prior', durationMs: 1 } } });
  expect(from.outputs.a?.output).toBe('prior');
  expect(from.outputs.b?.output).toBe('pinned');
  expect(from.outputs.c?.output).toBe('c');
  expect(calls).toEqual(['c']);
});

test('W8 must-fix: serial path fails when the only all_done consumer of a failure was skipped by when', async () => {
  const workflow = base([
    { id: 'gate', bash: 'gate' },
    { id: 'bad', bash: 'bad' },
    { id: 'sweep', bash: 'sweep', depends_on: ['bad', 'gate'], trigger_rule: 'all_done', when: "$gate.output == 'go'" },
  ]);
  const result = await run(workflow, deps(async body => ({ stdout: body === 'gate' ? 'stop' : body, stderr: '', exitCode: body === 'bad' ? 1 : 0 })));
  expect(result.outputs.bad?.ok).toBe(false);
  expect(result.events.some(e => e.type === 'node_skipped' && e.nodeId === 'sweep')).toBe(true);
  expect(result.ok).toBe(false);
  expect(result.events.at(-1)?.type).toBe('workflow_failed');
});

test('W8 must-fix: a node whose pre-dispatch step throws in the parallel path ends as failed instead of hanging', async () => {
  const pins = await import('./pin-data.js');
  const real = pins.readWorkflowPin;
  const spy = spyOn(pins, 'readWorkflowPin').mockImplementation(((name: string, nodeId: string, ...rest: unknown[]) => {
    if (nodeId === 'boom') throw new Error('pin store unreadable');
    return (real as (...a: unknown[]) => unknown)(name, nodeId, ...rest);
  }) as never);
  try {
    const workflow = base([
      { id: 'a', bash: 'a' },
      { id: 'boom', bash: 'boom' },
    ], 2);
    const result = await Promise.race([
      run(workflow, deps(async body => ({ stdout: body, stderr: '', exitCode: 0 }))),
      new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 5_000)),
    ]);
    expect(result).not.toBe('hung');
    if (result === 'hung') return;
    expect(result.outputs.boom?.ok).toBe(false);
    expect(result.outputs.boom?.error).toContain('pin store unreadable');
    expect(result.events.at(-1)?.type).toBe('workflow_failed');
  } finally { spy.mockRestore(); }
});
