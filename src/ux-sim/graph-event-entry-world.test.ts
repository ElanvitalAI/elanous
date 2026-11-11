import { expect, test } from 'bun:test';
import { createGraphEventEntryWorld, graphExternalEventScript } from './graph-event-entry-world.js';

const graph = [
  'graph_id: event-entry-world', 'version: 1', 'entry_node: work', 'terminal_nodes: [done]',
  'loop:', '  trigger:', '    events: [batch-closed]',
  'nodes:', "  - { node_id: work, kind: agent, recipe: 'cmd:work', max_visits: 1 }",
  '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
  'edges:', '  - { from: work, on: outcome, map: { ok: done } }',
].join('\n');

test('declared external event starts one new run per dedupe key, independent of arrival order', async () => {
  const world = createGraphEventEntryWorld(graph);
  try {
    const rows = await world.play();
    expect(graphExternalEventScript.map(({ sequence }) => sequence)).toEqual([12, 11, 12]);
    expect(rows.map(({ decision }) => decision)).toEqual(['started', 'started', 'duplicate']);
    const [first, second, duplicate] = rows;
    expect(first!.runId).toBe(duplicate!.runId);
    expect(second!.runId).not.toBe(first!.runId);
    expect(world.calls.map(({ eventId }) => eventId)).toEqual(graphExternalEventScript.map(({ eventId }) => eventId));
    const observedRunIds = new Set(world.runnerEvents.filter(event => event.type === 'node-start').map(event => event.runId));
    expect(observedRunIds).toEqual(new Set([first!.runId!, second!.runId!]));
  } finally { world.close(); }
});

test('concurrent redelivery of one declared event starts at most one graph run', async () => {
  const world = createGraphEventEntryWorld(graph);
  try {
    const event = graphExternalEventScript.find(candidate => candidate.eventId === 'event-12')!;
    const results = await Promise.all([
      world.deliver(event),
      world.deliver({ ...event, at: '2026-11-10T08:00:02.000Z' }),
    ]);
    const started = results.find(result => result.decision === 'started');
    expect(started).toBeDefined();
    const runId = started!.runId!;
    expect(new Set(results.map(result => result.runId))).toEqual(new Set([runId]));
    expect(results.filter(result => result.decision === 'started').map(result => result.runId)).toEqual([runId]);
    expect(new Set(world.runnerEvents.filter(event => event.type === 'node-start').map(event => event.runId)))
      .toEqual(new Set([runId]));
    // Source: one durable dispatch claim per graph event dedupe key produces one run start.
    expect(world.runnerEvents.filter(event => event.type === 'node-start' && event.source.nodeId === 'work')).toHaveLength(1);
  } finally { world.close(); }
});

test('internal graph event stays scoped to its existing run and never enters external dispatch', async () => {
  const world = createGraphEventEntryWorld(graph);
  try {
    const event = graphExternalEventScript.find(candidate => candidate.eventId === 'event-12')!;
    const row = await world.deliver(event);
    const internal = await world.publishInsideRun(row.runId!, 'node-event-1', 'work');
    expect(internal.graphId).toBe('event-entry-world');
    expect(internal.runId).toBe(row.runId!);
    expect(internal.source).toEqual({ kind: 'node', nodeId: 'work' });
    expect(world.internalEvents.filter(({ eventId }) => eventId === 'node-event-1').map(({ eventId }) => eventId)).toEqual(['node-event-1']);
    expect(world.calls).toEqual([event]);
  } finally { world.close(); }
});

test('undeclared external event is ignored without starting a run', async () => {
  const world = createGraphEventEntryWorld(graph);
  try {
    const event = graphExternalEventScript.find(candidate => candidate.eventId === 'event-12')!;
    const result = await world.deliver({ ...event, type: 'unknown-event', dedupeKey: 'unknown-1' });
    expect(result).toMatchObject({ decision: 'ignored', reason: 'event-not-declared' });
    expect(world.runnerEvents).toEqual([]);
  } finally { world.close(); }
});
