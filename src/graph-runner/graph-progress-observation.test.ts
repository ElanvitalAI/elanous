import { expect, test } from 'bun:test';
import { createGraphProgressCollector, graphProgressObservation, graphProgressStatus, isGraphProgressObservation } from './graph-progress-observation.js';
import type { GraphNodeLifecycleEvent } from './runner-types.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onGraphRunIdleWake, runGraph, type GraphRunIdleWake } from './runner.js';

const event = (phase: GraphNodeLifecycleEvent['phase'], seq: number, attempt = 1,
  outcome?: GraphNodeLifecycleEvent['outcome']): GraphNodeLifecycleEvent => ({
  kind: 'node.lifecycle', source: 'graph-runner', eventId: `app-build:run-a:${seq}`, seq,
  graphId: 'app-build', runId: 'run-a', nodeId: 'verify', phase, attempt, visit: attempt,
  dryRun: false, at: '2026-11-16T01:00:00.000Z', outcome,
  reason: 'Authorization: secret-token', data: { phase, visit: attempt, dryRun: false,
    at: '2026-11-16T01:00:00.000Z', reason: 'Authorization: secret-token' },
});

test('one safe event contract covers start, completion and failure without guessing retry from visit', () => {
  const observations = [event('start', 1), event('end', 2, 1, 'ok'),
    event('end', 3, 1, 'fail'), event('start', 4, 2)]
    .map(graphProgressObservation);
  expect(observations.map(item => item?.kind)).toEqual(['started', 'completed', 'failed', 'started']);
  expect(JSON.stringify(observations)).not.toContain('secret-token');
  expect(graphProgressStatus(observations[3]!)).toContain('verify 시작');
  expect(graphProgressObservation(event('arrival', 5))).toBeNull();
});

test('the supervisor snapshot is bounded, ordered and pinned to one run', () => {
  const displayed: string[] = [];
  const collector = createGraphProgressCollector({ graphId: 'app-build', runId: 'run-a' },
    item => displayed.push(item.kind), 2);
  collector.observe(event('start', 10));
  collector.observe(event('end', 11, 1, 'fail'));
  collector.observe(event('end', 11, 1, 'fail'));
  collector.observe({ ...event('start', 12, 2), runId: 'foreign-run' });
  collector.observe(event('start', 12, 2));
  expect(displayed).toEqual(['started', 'failed', 'retrying']);
  expect(collector.snapshot()).toMatchObject({ graphId: 'app-build', runId: 'run-a',
    lastSequence: 12, truncated: true, sequenceGapObserved: true, outOfOrderIgnored: true,
    events: [{ kind: 'failed' }, { kind: 'retrying' }] });
});

test('malformed or control-bearing runner identity cannot reach the display or supervisor', () => {
  expect(graphProgressObservation({ ...event('start', 1), nodeId: 'bad\u001b[2J' })).toBeNull();
  expect(graphProgressObservation({ ...event('start', 2), eventId: 'app-build:run-a:1' })).toBeNull();
  expect(graphProgressObservation({ ...event('start', 1), seq: 0 })).toBeNull();
  expect(graphProgressObservation({ ...event('end', 1), outcome: undefined })).toBeNull();
  expect(isGraphProgressObservation({ ...graphProgressObservation(event('start', 1)), reason: 'secret-token' })).toBe(false);
});

test('an invalid high sequence cannot poison a later valid event', () => {
  const collector = createGraphProgressCollector({ graphId: 'app-build', runId: 'run-a' });
  expect(collector.observe(event('start', 1))).not.toBeNull();
  expect(collector.observe({ ...event('end', 999, 1, 'ok'), at: '2026-11-16T01:00:00.000Z '.repeat(20) })).toBeNull();
  expect(collector.observe(event('end', 2, 1, 'ok'))?.kind).toBe('completed');
  expect(collector.snapshot()).toMatchObject({ lastSequence: 2, sequenceGapObserved: false,
    outOfOrderIgnored: false, events: [{ kind: 'started' }, { kind: 'completed' }] });
});

test('timestamps must be bounded canonical UTC milliseconds in both contracts', () => {
  for (const at of [' 2026-11-16T01:00:00.000Z', '2026-11-16T01:00:00.000+00:00',
    '2026-02-30T01:00:00.000Z', '2026-11-16T01:00:00.000Z'.repeat(30)]) {
    expect(graphProgressObservation({ ...event('start', 1), at })).toBeNull();
    expect(isGraphProgressObservation({ ...graphProgressObservation(event('start', 1)), at })).toBe(false);
  }
  expect(graphProgressObservation(event('start', 1))?.at).toBe('2026-11-16T01:00:00.000Z');
});

test('real runner failure and same-run retry retain the expected identity and attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-p5-retry-'));
  try {
    const graph = join(root, 'graph.yaml');
    writeFileSync(join(root, 'recipes.yaml'), 'verify:\n  command: "fixture"\n');
    writeFileSync(graph, [
      'graph_id: graph-p5', 'version: 1', 'entry_node: verify', 'terminal_nodes: [done, failed]',
      'nodes:',
      "  - { node_id: verify, kind: agent, recipe: 'cmd:verify', max_visits: 2 }",
      '  - { node_id: done, kind: gate, max_visits: 1 }',
      '  - { node_id: failed, kind: gate, max_visits: 1 }',
      'edges:',
      '  - { from: verify, on: outcome, map: { ok: done, fail: failed } }', '',
    ].join('\n'));
    const runId = 'p5-retry';
    const collector = createGraphProgressCollector({ graphId: 'graph-p5', runId });
    const first = await runGraph(graph, { runId, quiet: true, deps: { root,
      nodeLifecycle: event => { collector.observe(event); },
      runBash: async () => ({ stdout: '', stderr: 'private credential value', exitCode: 1 }),
    } });
    expect(first.status).toBe('failed');
    const second = await runGraph(graph, { resumeRunId: runId, fromNodeId: 'verify', quiet: true, deps: { root,
      nodeLifecycle: event => { collector.observe(event); },
      runBash: async () => ({ stdout: '{"outcome":"ok"}', stderr: '', exitCode: 0 }),
    } });
    expect(second.status).toBe('done');
    const snapshot = collector.snapshot();
    expect(snapshot.events.map(item => item.kind)).toContain('failed');
    expect(snapshot.events).toContainEqual(expect.objectContaining({ kind: 'retrying', attempt: 1 }));
    expect(JSON.stringify(snapshot)).not.toContain('private credential value');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real runner successful loop revisit is a start rather than a retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-p5-revisit-'));
  try {
    const graph = join(root, 'graph.yaml');
    writeFileSync(join(root, 'recipes.yaml'), 'verify:\n  command: "fixture"\n');
    writeFileSync(graph, [
      'graph_id: graph-p5-loop', 'version: 1', 'entry_node: verify', 'terminal_nodes: [done, failed]',
      'nodes:',
      "  - { node_id: verify, kind: agent, recipe: 'cmd:verify', max_visits: 2 }",
      '  - { node_id: loop, kind: gate, max_visits: 1 }',
      '  - { node_id: done, kind: gate, max_visits: 1 }',
      '  - { node_id: failed, kind: gate, max_visits: 1 }',
      'edges:',
      '  - { from: verify, on: outcome, map: { again: loop, ok: done, fail: failed } }',
      '  - { from: loop, on: outcome, map: { ok: verify } }', '',
    ].join('\n'));
    const collector = createGraphProgressCollector({ graphId: 'graph-p5-loop', runId: 'p5-revisit' });
    let calls = 0;
    const result = await runGraph(graph, { runId: 'p5-revisit', quiet: true, deps: { root,
      nodeLifecycle: event => { collector.observe(event); },
      runBash: async () => ({ stdout: JSON.stringify({ outcome: ++calls === 1 ? 'again' : 'ok' }),
        stderr: '', exitCode: 0 }),
    } });
    expect(result.status).toBe('done');
    expect(result.path).toEqual(['verify', 'loop', 'verify', 'done']);
    expect(collector.snapshot().events.filter(item => item.nodeId === 'verify' && item.kind === 'started')).toHaveLength(2);
    expect(collector.snapshot().events.some(item => item.kind === 'retrying')).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a real run knocks the idle door once on the way out, never per node and never for a dry run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-idle-wake-'));
  const wakes: GraphRunIdleWake[] = [];
  const off = onGraphRunIdleWake((wake) => { wakes.push(wake); });
  try {
    const graph = join(root, 'graph.yaml');
    writeFileSync(join(root, 'recipes.yaml'), 'verify:\n  command: "fixture"\n');
    writeFileSync(graph, [
      'graph_id: graph-idle', 'version: 1', 'entry_node: verify', 'terminal_nodes: [done, failed]',
      'nodes:',
      "  - { node_id: verify, kind: agent, recipe: 'cmd:verify', max_visits: 1 }",
      '  - { node_id: done, kind: gate, max_visits: 1 }',
      '  - { node_id: failed, kind: gate, max_visits: 1 }',
      'edges:',
      '  - { from: verify, on: outcome, map: { ok: done, fail: failed } }', '',
    ].join('\n'));
    const dry = await runGraph(graph, { runId: 'idle-dry', dryRun: true, quiet: true, deps: { root } });
    expect(dry.dryRun).toBe(true);
    expect(wakes).toEqual([]);
    const done = await runGraph(graph, { runId: 'idle-done', quiet: true, deps: { root,
      runBash: async () => ({ stdout: '{"outcome":"ok"}', stderr: '', exitCode: 0 }),
    } });
    expect(done.status).toBe('done');
    expect(done.path).toEqual(['verify', 'done']);
    expect(wakes).toEqual([{ graphId: 'graph-idle', runId: 'idle-done', status: 'done', dryRun: false }]);
  } finally { off(); rmSync(root, { recursive: true, force: true }); }
});
