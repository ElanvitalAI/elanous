import { afterEach, expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerGraphCommands } from './graph-cli.js';
import { createGraphEventBus } from './graph-events.js';
import { listGraphRuns } from './runner.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); process.exitCode = 0; });

function fixture(exitCode = 0) {
  const root = mkdtempSync(join(tmpdir(), 'graph-event-entry-cli-'));
  roots.push(root);
  const graphs = join(root, 'graphs');
  mkdirSync(graphs);
  const graph = join(graphs, 'external.yaml');
  writeFileSync(graph, [
    'graph_id: external-entry', 'version: 1', 'entry_node: work', 'terminal_nodes: [done]',
    'loop:', '  trigger:', '    events: [batch-closed]', 'nodes:',
    '  - { node_id: work, kind: agent, recipe: "cmd:work", max_visits: 1 }',
    '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
    'edges:', '  - { from: work, on: outcome, map: { ok: done } }',
  ].join('\n'));
  writeFileSync(join(graphs, 'recipes.yaml'), 'work:\n  command: fake-work\n');
  const eventFile = join(root, 'event.json');
  const event = { eventId: 'delivery-1', type: 'batch-closed', dedupeKey: 'batch-1',
    at: '2026-11-14T02:00:00Z', sequence: 1, payload: { batch: 'one' } };
  let effects = 0;
  async function deliver(value: unknown, options: { raw?: string; eventFile?: string } = {}) {
    writeFileSync(eventFile, options.raw ?? JSON.stringify(value));
    const out: string[] = [], err: string[] = [];
    const previousWrite = process.stdout.write, previousError = console.error;
    const previousExitCode = process.exitCode;
    process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      out.push(String(chunk)); callback?.(); return true;
    }) as typeof process.stdout.write;
    console.error = (...parts) => { err.push(parts.join(' ')); };
    process.exitCode = 0;
    try {
      const program = new Command().exitOverride();
      registerGraphCommands(program, { root, runBash: async () => {
        effects++;
        return { stdout: JSON.stringify({ outcome: exitCode === 0 ? 'ok' : 'fail' }), stderr: '', exitCode };
      } });
      await program.parseAsync(['node', 'elanous', 'graph', 'event', graph, '--event-file', options.eventFile ?? eventFile, '--json']);
      return { out: out.join(''), err, exit: process.exitCode };
    } finally {
      process.stdout.write = previousWrite; console.error = previousError; process.exitCode = previousExitCode ?? 0;
    }
  }
  return { root, graph, graphs, event, deliver, effects: () => effects };
}

test('registered event command starts one declared run, consumes payload, and deduplicates redelivery', async () => {
  const f = fixture();
  const first = await f.deliver(f.event);
  expect(first.exit).toBe(0);
  expect(first.err).toEqual([]);
  const started = JSON.parse(first.out);
  expect(started).toMatchObject({ disposition: 'started', graphId: 'external-entry', state: { status: 'done',
    input: { batch: 'one', graphEvent: { eventId: 'delivery-1', type: 'batch-closed', dedupeKey: 'batch-1', sequence: 1 } } } });
  expect(started.runId).toBeTruthy();
  const replay = JSON.parse((await f.deliver(f.event)).out);
  expect(replay).toMatchObject({ disposition: 'duplicate', runId: started.runId });
  expect(f.effects()).toBe(1);
  expect(listGraphRuns(f.root).runs).toHaveLength(1);

  const next = JSON.parse((await f.deliver({ ...f.event, eventId: 'delivery-2', dedupeKey: 'batch-2' })).out);
  expect(next.disposition).toBe('started');
  expect(next.runId).not.toBe(started.runId);
  expect(f.effects()).toBe(2);

  const bus = createGraphEventBus();
  bus.registerType(f.event.type);
  const received: string[] = [];
  bus.subscribe(event => { received.push(event.runId); }, { type: f.event.type });
  await bus.publish({ graphId: 'external-entry', runId: started.runId, type: f.event.type, source: { kind: 'node', nodeId: 'work' } });
  await bus.flush();
  expect(received).toEqual([started.runId]);
  expect(listGraphRuns(f.root).runs).toHaveLength(2);
  expect(f.effects()).toBe(2);
});

test('undeclared event and malformed external envelopes never start a graph', async () => {
  const f = fixture();
  const ignored = await f.deliver({ ...f.event, type: 'unknown-event' });
  expect(ignored.exit).toBe(0);
  expect(JSON.parse(ignored.out)).toMatchObject({ disposition: 'ignored', reason: 'event-not-declared' });
  for (const event of [null, [], { ...f.event, eventId: 1 }, { ...f.event, type: '' },
    { ...f.event, dedupeKey: [] }, { ...f.event, at: 1 }, { ...f.event, payload: [] },
    { ...f.event, sequence: -1 }, { ...f.event, sequence: 0.5 },
    { graphId: 'existing', runId: 'existing-run', type: 'batch-closed', source: { kind: 'node' } }]) {
    const rejected = await f.deliver(event);
    expect(rejected.exit).toBe(1);
    expect(rejected.err.join('\n')).toContain('external graph event requires');
    expect(rejected.out).toBe('');
  }
  expect(f.effects()).toBe(0);
  expect(listGraphRuns(f.root).runs).toEqual([]);
});

test('event ingress preserves the declared human gate and redelivery does not bypass it', async () => {
  const f = fixture();
  writeFileSync(f.graph, readFileSync(f.graph, 'utf8')
    .replace('entry_node: work', 'entry_node: approve')
    .replace('\nnodes:', '\nnodes:\n  - { node_id: approve, kind: hitl, recipe: "approval:allow", max_visits: 1, notify: false }')
    .replace('edges:', 'edges:\n  - { from: approve, on: outcome, map: { ok: work } }'));
  writeFileSync(join(f.graphs, 'recipes.yaml'), 'allow:\n  approval: "Allow work?"\nwork:\n  command: fake-work\n');
  const first = await f.deliver(f.event);
  expect(first.err).toEqual([]);
  expect(first.exit).toBe(0);
  const waiting = JSON.parse(first.out);
  expect(waiting).toMatchObject({ disposition: 'started', state: { status: 'awaiting-approval', pending: { nodeId: 'approve' } } });
  const duplicate = JSON.parse((await f.deliver(f.event)).out);
  expect(duplicate).toMatchObject({ disposition: 'duplicate', runId: waiting.runId, state: { status: 'awaiting-approval' } });
  expect(f.effects()).toBe(0);
  expect(listGraphRuns(f.root).runs).toHaveLength(1);
});

test('event-file read and parse failures are explicit errors without a graph run', async () => {
  const f = fixture();
  const malformed = await f.deliver(f.event, { raw: '{"private":"synthetic-secret",broken' });
  expect(malformed.exit).toBe(1);
  expect(malformed.err).toEqual(['graph event: --event-file must contain a JSON event envelope']);
  expect(malformed.out).toBe('');
  for (const eventFile of [join(f.root, 'absent.json'), f.graphs]) {
    const unreadable = await f.deliver(f.event, { eventFile });
    expect(unreadable.exit).toBe(1);
    expect(unreadable.out).toBe('');
    expect(unreadable.err.join('\n')).toContain('graph event:');
  }
  expect(f.effects()).toBe(0);
  expect(listGraphRuns(f.root).runs).toEqual([]);
});

test('a failed graph execution propagates a failing command exit and keeps its run identity on replay', async () => {
  const f = fixture(1);
  const first = await f.deliver(f.event);
  expect(first.exit).toBe(1);
  const failed = JSON.parse(first.out);
  expect(failed).toMatchObject({ disposition: 'started', state: { status: 'failed' } });
  const replay = await f.deliver(f.event);
  expect(replay.exit).toBe(1);
  expect(JSON.parse(replay.out)).toMatchObject({ disposition: 'duplicate', runId: failed.runId, state: { status: 'failed' } });
  expect(f.effects()).toBe(1);
});

test('malformed graph trigger declarations are errors rather than undeclared-event acknowledgements', async () => {
  const f = fixture();
  const source = readFileSync(f.graph, 'utf8');
  for (const declaration of ['loop: broken', 'loop: { trigger: [] }', 'loop: { trigger: { events: batch-closed } }',
    'loop: { trigger: { events: [batch-closed, 1] } }']) {
    writeFileSync(f.graph, source.replace('loop:\n  trigger:\n    events: [batch-closed]', declaration));
    const rejected = await f.deliver(f.event);
    expect(rejected.exit).toBe(1);
    expect(rejected.out).toBe('');
    expect(rejected.err.join('\n')).toContain('external graph event target requires');
  }
  expect(f.effects()).toBe(0);
  expect(listGraphRuns(f.root).runs).toEqual([]);
});
