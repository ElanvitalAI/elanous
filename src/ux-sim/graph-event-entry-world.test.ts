import { expect, test } from 'bun:test';
import { createGraphEventEntryWorld, graphExternalEventScript } from './graph-event-entry-world.js';

const graph = [
  'graph_id: event-entry-world', 'version: 1', 'entry_node: work', 'terminal_nodes: [done]',
  'nodes:', "  - { node_id: work, kind: agent, recipe: 'cmd:work', max_visits: 1 }",
  '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
  'edges:', '  - { from: work, on: outcome, map: { ok: done } }',
].join('\n');

test('event entry world exposes out-of-order resend without deciding deduplication', async () => {
  const world = createGraphEventEntryWorld(graph);
  try {
    const rows = await world.play(async ({ start }) => ({ decision: 'started', runId: (await start()).runId }));
    expect(graphExternalEventScript.map(({ sequence }) => sequence)).toEqual([12, 11, 12]);
    expect(new Set(rows.map(({ runId }) => runId)).size).toBe(3);
    expect(world.calls).toHaveLength(3);
  } finally { world.close(); }
});

test('internal graph subscription retains runId and cannot enter the external start path', async () => {
  const world = createGraphEventEntryWorld(graph);
  const seen = new Map<string, string>();
  try {
    const rows = await world.play(async ({ event, start }) => {
      const existing = seen.get(event.dedupeKey);
      if (existing) return { decision: 'duplicate', runId: existing, reason: 'redelivery' };
      const run = await start();
      seen.set(event.dedupeKey, run.runId);
      return { decision: 'started', runId: run.runId };
    });
    const firstRunId = rows[0]!.runId!;
    const internal = await world.publishInsideRun(firstRunId, 'node-event-1', 'work');
    expect(rows.map(({ decision }) => decision)).toEqual(['started', 'started', 'duplicate']);
    expect(world.calls).toHaveLength(2);
    expect(internal.runId).toBe(firstRunId);
    expect(world.internalEvents.map(({ eventId }) => eventId)).toEqual(['node-event-1']);
    expect(world.calls).toHaveLength(2);
  } finally { world.close(); }
});

test('internal event uses the actual started graph and executed node identities', async () => {
  const otherGraph = graph.replaceAll('event-entry-world', 'alternate-graph')
    .replace('entry_node: work', 'entry_node: analyze')
    .replace('node_id: work', 'node_id: analyze').replace('from: work', 'from: analyze');
  const world = createGraphEventEntryWorld(otherGraph);
  try {
    const row = await world.deliver(graphExternalEventScript[0]!, async ({ start }) =>
      ({ decision: 'started', runId: (await start()).runId }));
    const internal = await world.publishInsideRun(row.runId!, 'internal-1', 'analyze');
    expect(internal.graphId).toBe('alternate-graph');
    expect(internal.source).toEqual({ kind: 'node', nodeId: 'analyze' });
    expect(internal.runId).toBe(row.runId);
    expect(world.calls).toHaveLength(1);
    expect(world.internalEvents).toHaveLength(1);
    await expect(world.publishInsideRun('unknown-run', 'internal-2', 'work')).rejects.toThrow('no started run');
    await expect(world.publishInsideRun(row.runId!, 'internal-3', 'absent')).rejects.toThrow('source node was not executed');
  } finally { world.close(); }
});
