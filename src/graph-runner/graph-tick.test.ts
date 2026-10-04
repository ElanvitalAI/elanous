import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphTick } from './graph-tick.js';
import { decideGraphApproval, latestGraphRun, runGraph } from './runner.js';
import type { DecisionEntry } from '../decisions/decision-ledger.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(): { graph: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'graph-tick-'));
  dirs.push(root);
  const graph = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), 'a:\n  command: "printf a"\ngate:\n  approval: "Publish?"\nb:\n  command: "printf b"\n');
  writeFileSync(graph, `graph_id: tick-test
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

const ok = async () => ({ stdout: '', stderr: '', exitCode: 0 });

test('idle ticks notify once and leave the run directory empty without an explicit start', async () => {
  const { graph, root } = fixture();
  let notified = 0;
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const deps = { root, notify: () => { notified++; }, log: (event: string, data: Record<string, unknown>) => { events.push({ event, data }); },
    runBash: async () => { throw new Error('unexpected command'); } };
  expect(await graphTick(graph, { deps })).toEqual({ action: 'idle' });
  expect(await graphTick(graph, { deps })).toEqual({ action: 'idle' });
  expect(notified).toBe(2);
  expect(events).toEqual([
    { event: 'tick', data: { graphId: 'tick-test', action: 'idle' } },
    { event: 'tick', data: { graphId: 'tick-test', action: 'idle' } },
  ]);
  expect(latestGraphRun('tick-test', root)).toBeNull();
});

test('explicit start passes input once, then waits without replaying commands even if start is requested again', async () => {
  const { graph, root } = fixture();
  const calls: string[] = [];
  let notified = 0;
  const deps = { root, notify: () => { notified++; }, runBash: async (body: string) => { calls.push(body); return ok(); } };
  const started = await graphTick(graph, { startIfIdle: true, input: { ticket: 7 }, deps });
  expect(started).toMatchObject({ action: 'started', status: 'awaiting-approval' });
  const waiting = await graphTick(graph, { startIfIdle: true, deps });
  expect(waiting).toEqual({ action: 'waiting', runId: started.runId, status: 'awaiting-approval' });
  expect(latestGraphRun('tick-test', root)?.input).toEqual({ ticket: 7 });
  expect(calls).toEqual(['printf a']);
  expect(notified).toBe(2);
});

test('an approved run resumes, preserves run id and never replays the first command', async () => {
  const { graph, root } = fixture();
  const calls: string[] = [];
  let notified = 0;
  const deps = { root, notify: () => { notified++; }, runBash: async (body: string) => { calls.push(body); return ok(); } };
  const started = await graphTick(graph, { startIfIdle: true, deps });
  decideGraphApproval('tick-test', started.runId!, 'approved', 'owner', root);
  expect(await graphTick(graph, { deps })).toEqual({ action: 'resumed', runId: started.runId, status: 'done' });
  expect(await graphTick(graph, { deps })).toEqual({ action: 'idle' });
  expect(calls).toEqual(['printf a', 'printf b']);
  expect(notified).toBe(3);
});

test('a tick resumes a parked growth after the decision card is answered', async () => {
  const { graph, root } = fixture();
  writeFileSync(graph, `grow: on\n${readFileSync(graph, 'utf8').replace("  - { from: a, to: gate }", "  - { from: a, on: outcome, map: { ok: gate }, fallback: [{ node: gate, requires: [] }] }")}`);
  writeFileSync(join(root, 'recipes.yaml'), `${readFileSync(join(root, 'recipes.yaml'), 'utf8')}grow:\n  command: 'printf grow'\n`);
  const entries: DecisionEntry[] = [];
  const ledger = { raiseOnce: (value: Record<string, unknown>) => {
    const entry = { ...value, id: 'D-tick', status: 'open' } as DecisionEntry;
    entries.push(entry);
    return entry;
  } };
  const deps = { root, growthDecision: { ledger, list: () => entries },
    runBash: async (body: string) => ({ stdout: body === 'printf a' ? '{"outcome":"new"}\n' : '', stderr: '', exitCode: 0 }),
    growthProposer: () => ({ node: { nodeId: 'grown', kind: 'agent', recipe: 'cmd:grow', maxVisits: 1,
      contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'gate', reason: 'grow before approval' }) };
  const first = await graphTick(graph, { startIfIdle: true, deps });
  expect(first).toMatchObject({ action: 'started', status: 'awaiting-approval' });
  expect(entries).toHaveLength(1);
  expect(await graphTick(graph, { deps })).toMatchObject({ action: 'waiting', runId: first.runId });
  entries[0] = { ...entries[0]!, status: 'decided', choice: 'a', decidedBy: { kind: 'human' } };
  expect(await graphTick(graph, { deps })).toMatchObject({ action: 'resumed', runId: first.runId });
  expect(latestGraphRun('tick-test', root)?.path.slice(0, 2)).toEqual(['a', 'grown']);
  expect(entries).toHaveLength(1);
});

test('after a terminal run, a new run starts only when explicitly requested', async () => {
  const { graph, root } = fixture();
  const deps = { root, runBash: ok };
  const first = await graphTick(graph, { startIfIdle: true, deps });
  decideGraphApproval('tick-test', first.runId!, 'rejected', 'owner', root);
  expect(await graphTick(graph, { deps })).toEqual({ action: 'resumed', runId: first.runId, status: 'failed' });
  expect(await graphTick(graph, { deps })).toEqual({ action: 'idle' });
  const next = await graphTick(graph, { startIfIdle: true, deps });
  expect(next).toMatchObject({ action: 'started', status: 'awaiting-approval' });
  expect(next.runId).not.toBe(first.runId);
});

test('a stale running run resumes through runGraph, not through a new run', async () => {
  const { graph, root } = fixture();
  const original = await runGraph(graph, { runId: 'stale', deps: { root, runBash: ok } });
  const state = JSON.parse(readFileSync(original.statePath, 'utf8'));
  state.status = 'running';
  state.path = ['a'];
  state.nodes = [state.nodes[0]];
  state.executed = 1;
  delete state.pending;
  writeFileSync(original.statePath, JSON.stringify(state));
  const calls: string[] = [];
  let notified = 0;
  const result = await graphTick(graph, { startIfIdle: true, deps: { root, notify: () => { notified++; }, runBash: async (body: string) => { calls.push(body); return ok(); } } });
  expect(result).toEqual({ action: 'resumed', runId: 'stale', status: 'awaiting-approval' });
  expect(calls).toEqual([]);
  expect(latestGraphRun('tick-test', root)?.nodes.filter((node) => node.nodeId === 'a')).toHaveLength(1);
  expect(notified).toBe(1);
});

test('tick lock excludes a concurrent tick and is removed after both success and notifier failure', async () => {
  const { graph, root } = fixture();
  const lock = join(root, 'graph-runs', 'tick-test', '.tick.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner'), '424242');
  let notified = 0;
  await expect(graphTick(graph, { startIfIdle: true, deps: { root, isAlive: () => true, notify: () => { notified++; } } })).rejects.toThrow('graph tick already running');
  expect(notified).toBe(0);
  rmSync(lock, { recursive: true });
  await expect(graphTick(graph, { deps: { root, notify: () => { notified++; throw new Error('delivery failed'); } } })).rejects.toThrow('delivery failed');
  expect(existsSync(lock)).toBe(false);
  expect(await graphTick(graph, { deps: { root, notify: () => { notified++; } } })).toEqual({ action: 'idle' });
  expect(notified).toBe(2);
});

test('a tick held in the injected notifier prevents another tick from making a decision', async () => {
  const { graph, root } = fixture();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const active = graphTick(graph, { deps: { root, notify: async () => { entered(); await held; } } });
  await started;
  try {
    await expect(graphTick(graph, { startIfIdle: true, deps: { root } })).rejects.toThrow('graph tick already running');
  } finally { release(); }
  expect(await active).toEqual({ action: 'idle' });
  expect(latestGraphRun('tick-test', root)).toBeNull();
});

test('a dead tick lock is reclaimed before resuming its orphaned running run', async () => {
  const { graph, root } = fixture();
  const original = await runGraph(graph, { runId: 'crashed', deps: { root, runBash: ok } });
  const state = JSON.parse(readFileSync(original.statePath, 'utf8'));
  state.status = 'running';
  state.path = ['a'];
  state.nodes = [state.nodes[0]];
  state.executed = 1;
  delete state.pending;
  writeFileSync(original.statePath, JSON.stringify(state));
  const lock = join(root, 'graph-runs', 'tick-test', '.tick.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner'), '424242');
  const calls: string[] = [];
  expect(await graphTick(graph, { startIfIdle: true, deps: { root, isAlive: (pid) => pid !== 424242,
    runBash: async (body: string) => { calls.push(body); return ok(); } } }))
    .toEqual({ action: 'resumed', runId: 'crashed', status: 'awaiting-approval' });
  expect(calls).toEqual([]);
  expect(existsSync(lock)).toBe(false);
});

test('a crash just after creating an empty owner file permits the next tick', async () => {
  const { graph, root } = fixture();
  const lock = join(root, 'graph-runs', 'tick-test', '.tick.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner'), '');
  let notified = 0;
  expect(await graphTick(graph, { deps: { root, notify: () => { notified++; },
    isAlive: () => { throw new Error('empty owner has no pid'); } } })).toEqual({ action: 'idle' });
  expect(notified).toBe(1);
  expect(existsSync(lock)).toBe(false);
});

test('a crash after unlinking the owner still permits recovery', async () => {
  const { graph, root } = fixture();
  const lock = join(root, 'graph-runs', 'tick-test', '.tick.lock');
  mkdirSync(join(root, 'graph-runs', 'tick-test'), { recursive: true });
  mkdirSync(lock);
  expect(await graphTick(graph, { deps: { root } })).toEqual({ action: 'idle' });
  expect(existsSync(lock)).toBe(false);
});

test('a concurrent recovery cannot reclaim a lock held under flock', async () => {
  const { graph, root } = fixture();
  const lock = join(root, 'graph-runs', 'tick-test', '.tick.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner'), '424242');
  let competing: Promise<unknown> | undefined;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const active = graphTick(graph, { deps: { root, isAlive: () => {
    competing = graphTick(graph, { deps: { root, isAlive: () => false } });
    return false;
  }, notify: () => { entered(); return held; } } });
  await started;
  try {
    expect(competing).toBeDefined();
    await expect(competing!).rejects.toThrow('graph tick already running');
  } finally { release(); }
  expect(await active).toEqual({ action: 'idle' });
  expect(existsSync(lock)).toBe(false);
  expect(await graphTick(graph, { deps: { root } })).toEqual({ action: 'idle' });
});

test('a lock left by a crashed tick (dead owner pid) is taken over; a live owner still excludes', async () => {
  const { graph, root } = fixture();
  const lock = join(root, 'graph-runs', 'tick-test', '.tick.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner'), '424242');
  await expect(graphTick(graph, { deps: { root, isAlive: () => true } })).rejects.toThrow('graph tick already running: tick-test (pid 424242)');
  expect(await graphTick(graph, { deps: { root, isAlive: (pid) => pid !== 424242 } })).toEqual({ action: 'idle' });
  expect(existsSync(lock)).toBe(false);
});
