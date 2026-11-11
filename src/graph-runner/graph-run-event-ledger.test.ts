import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendGraphRunEvent, graphRunEventLedgerPath, readGraphRunEvents, watchGraphRunEvents } from './graph-run-event-ledger.js';
import type { GraphEvent } from './graph-events.js';
import { runGraph } from './runner.js';
import { simCli } from '../ux-sim/in-process-cli.js';

test('fake run replays ten ordered events and follows only newly appended matches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-event-watch-'));
  const path = graphRunEventLedgerPath(root, 'fake-graph', 'fake-run');
  const controller = new AbortController();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(join(dirname(path), 'fake-run.json'), JSON.stringify({ status: 'running' }));
    const events: GraphEvent[] = Array.from({ length: 10 }, (_, index) => ({
      eventId: `fake-graph:fake-run:${index + 1}`, sequence: index + 1,
      emittedAt: new Date(index * 1000).toISOString(), graphId: 'fake-graph', runId: 'fake-run',
      type: index % 2 ? 'node-end' : 'node-start', source: { kind: 'node', nodeId: `node-${index}` },
    }));
    for (const event of events.slice(0, 8)) appendGraphRunEvent(path, event);
    appendGraphRunEvent(path, events[7]!); // replay of one pending outbox envelope is idempotent
    expect(readGraphRunEvents(path).map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    appendFileSync(path, '{"interrupted":'); // an interrupted append is repaired before the next envelope
    const observed: number[] = [];
    const following = (async () => {
      for await (const event of watchGraphRunEvents(root, 'fake-graph', 'fake-run',
        { follow: true, type: 'node-end', signal: controller.signal })) observed.push(event.sequence);
    })();
    // The first next() registers the watcher before this append reaches the ledger.
    await new Promise(resolve => setTimeout(resolve, 20));
    for (const event of events.slice(8)) appendGraphRunEvent(path, event);
    writeFileSync(join(dirname(path), 'fake-run.json'), JSON.stringify({ status: 'done' }));
    await following;
    expect(observed).toEqual([2, 4, 6, 8, 10]);
    expect(readGraphRunEvents(path).map(event => event.sequence)).toEqual(events.map(event => event.sequence));
  } finally {
    controller.abort();
    rmSync(root, { recursive: true, force: true });
  }
});

test('real runner resume reconciles outbox and CLI watch replays ordered events once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-run-event-integration-'));
  try {
    const graphDir = join(root, 'graphs');
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(join(graphDir, 'recipes.yaml'), 'action:\n  command: action\n');
    const graph = join(graphDir, 'graph.yaml');
    writeFileSync(graph, [
      'graph_id: event-watch-integration', 'version: 1', 'entry_node: action', 'terminal_nodes: [done, failed]',
      'nodes:', '  - { node_id: action, kind: gate, recipe: cmd:action, max_visits: 2 }',
      '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
      '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }',
      'edges:', '  - { from: action, on: outcome, map: { ok: done, fail: failed, error: failed } }', '',
    ].join('\n'));
    const runId = 'integrated-run';
    const first = await runGraph(graph, { runId, deps: { root, runBash: async () =>
      ({ exitCode: 1, stdout: '{"outcome":"fail"}', stderr: '' }) } });
    expect(first.status).toBe('failed');
    const path = graphRunEventLedgerPath(root, first.graphId, runId);
    const prior = readGraphRunEvents(path);
    expect(prior.length).toBeGreaterThan(0); // Source: #36809 real runner emits lifecycle events before the failed-run resume.
    const pending = prior.at(-1)!;
    // Simulate a crash after state persistence but before the ledger append.
    const missing: GraphEvent = { ...pending, eventId: `${first.graphId}:${runId}:${pending.sequence + 1}`,
      sequence: pending.sequence + 1, emittedAt: new Date().toISOString() };
    const state = JSON.parse(readFileSync(first.statePath, 'utf8')) as typeof first;
    state.graphEventSequence = missing.sequence;
    state.pendingGraphEvents = [pending, missing];
    writeFileSync(first.statePath, `${JSON.stringify(state)}\n`);
    expect(readGraphRunEvents(path).some(event => event.eventId === missing.eventId)).toBe(false);
    const resumed = await runGraph(graph, { resumeRunId: runId, fromNodeId: 'action', deps: { root,
      runBash: async () => ({ exitCode: 0, stdout: '{"outcome":"ok"}', stderr: '' }) } });
    expect(resumed.status).toBe('done');
    const saved = readGraphRunEvents(path);
    expect(saved.map(event => event.sequence)).toEqual(saved.map(event => event.sequence).sort((a, b) => a - b));
    expect(new Set(saved.map(event => event.eventId)).size).toBe(saved.length);
    expect(saved.filter(event => event.eventId === pending.eventId)).toHaveLength(1);
    expect(saved.filter(event => event.eventId === missing.eventId)).toHaveLength(1);
    expect(saved.findIndex(event => event.eventId === missing.eventId)).toBe(prior.length);
    const cli = await simCli(['graph', 'runs', 'watch', runId, '--json'], {
      stateRoot: root, allowPaths: [['graph', 'runs', 'watch']],
    });
    expect(cli.exitCode).toBe(0);
    const replay = cli.stdout.trim().split('\n').map(line => JSON.parse(line) as GraphEvent);
    expect(replay.map(event => event.eventId)).toEqual(saved.map(event => event.eventId));
    expect(replay.filter(event => event.eventId === missing.eventId)).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('follow drains the final event when the run completes while a yielded event is consumed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-event-complete-'));
  const path = graphRunEventLedgerPath(root, 'fake-graph', 'fake-run');
  try {
    mkdirSync(dirname(path), { recursive: true });
    const statePath = join(dirname(path), 'fake-run.json');
    writeFileSync(statePath, JSON.stringify({ status: 'running' }));
    const event = (sequence: number): GraphEvent => ({ eventId: `fake-graph:fake-run:${sequence}`, sequence,
      emittedAt: new Date(sequence * 1000).toISOString(), graphId: 'fake-graph', runId: 'fake-run',
      type: 'node-end', source: { kind: 'node', nodeId: 'node-a' } });
    appendGraphRunEvent(path, event(1));
    const iterator = watchGraphRunEvents(root, 'fake-graph', 'fake-run', { follow: true });
    expect((await iterator.next()).value?.sequence).toBe(1);
    appendGraphRunEvent(path, event(2));
    writeFileSync(statePath, JSON.stringify({ status: 'done' }));
    expect((await iterator.next()).value?.sequence).toBe(2);
    expect((await iterator.next()).done).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
