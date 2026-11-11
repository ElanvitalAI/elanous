import { expect, test } from 'bun:test';
import { createGraphTriggerHookDevice, createGraphTriggerRegistryWorld, graphTriggerRegistryScript } from './graph-trigger-hook-device.js';

const graph = [
  'graph_id: trigger-registry-world',
  'version: 1',
  'entry_node: work',
  'terminal_nodes: [done]',
  'nodes:',
  "  - { node_id: work, kind: agent, recipe: 'cmd:work', max_visits: 1 }",
  '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
  'edges:',
  '  - { from: work, on: outcome, map: { ok: done } }',
].join('\n');

test('registry world exposes all four ingress retry/order cases without hiding duplicate starts', async () => {
  const world = createGraphTriggerRegistryWorld(graph);
  try {
    const observations = await world.play(async ({ start }) => {
      const run = await start();
      return { decision: 'started', runId: run.runId };
    });
    expect(graphTriggerRegistryScript.map(({ ingress }) => ingress)).toEqual([
      'schedule', 'schedule', 'webhook', 'webhook', 'api', 'api', 'event', 'event', 'event',
    ]);
    expect(graphTriggerRegistryScript.slice(-3).map(({ payload }) => payload.sequence)).toEqual([12, 11, 12]);
    expect(observations).toHaveLength(9);
    expect(new Set(observations.map(({ runId }) => runId)).size).toBe(9);
    expect(world.calls.map(({ ingress }) => ingress)).toEqual(graphTriggerRegistryScript.map(({ ingress }) => ingress));
    expect(world.events.filter(({ type }) => type === 'node-start')).toHaveLength(18);
  } finally { world.close(); }
});

test('registry adapter can reject duplicate delivery before runner entry and retain an explicit reason', async () => {
  const world = createGraphTriggerRegistryWorld(graph);
  const seen = new Map<string, string>();
  try {
    const observations = await world.play(async ({ delivery, start }) => {
      const key = `${delivery.triggerId}:${delivery.dedupeKey}`;
      const previous = seen.get(key);
      if (previous) return { decision: 'duplicate', runId: previous, reason: 'same-trigger-and-key' };
      const run = await start();
      seen.set(key, run.runId);
      return { decision: 'started', runId: run.runId };
    });
    expect(observations.filter(({ decision }) => decision === 'duplicate')).toHaveLength(4);
    expect(world.calls).toHaveLength(5);
    expect(observations.filter(({ decision }) => decision === 'duplicate').every(({ starts, reason }) =>
      starts.length === 0 && reason === 'same-trigger-and-key')).toBe(true);
  } finally { world.close(); }
});

test('schedule, webhook, API and event retries share the durable dispatch entry and start one graph run per key', async () => {
  const device = createGraphTriggerHookDevice(graph);
  const results = [];
  try {
    for (const delivery of graphTriggerRegistryScript) {
      results.push(await device.deliver(delivery.ingress, {
        triggerId: delivery.triggerId, dedupeKey: delivery.dedupeKey, graphId: 'trigger-registry-world',
      }, { ...delivery.payload, eventId: delivery.eventId }));
    }
    expect(results).toHaveLength(graphTriggerRegistryScript.length);
    expect(results.filter(result => result.registration.created)).toHaveLength(5);
    expect(results.filter(result => !result.registration.created)).toHaveLength(4);
    expect(new Set(results.map(result => result.registration.runId)).size).toBe(5);
    expect(device.calls.map(({ ingress }) => ingress)).toEqual(graphTriggerRegistryScript.map(({ ingress }) => ingress));
    expect(device.events.filter(({ type }) => type === 'node-start')).toHaveLength(10);
  } finally { device.close(); }
});

test('the common trigger dispatcher resumes a persisted running run with the same runId after interrupted delivery', async () => {
  const device = createGraphTriggerHookDevice(graph);
  const identity = { triggerId: 'batch-hook', dedupeKey: 'batch-7', graphId: 'trigger-registry-world' };
  try {
    const original = await device.deliver('webhook', identity, { batch: 'B' });
    expect(original.mode).toBe('start');
    expect(original.state?.status).toBe('done');
    device.restoreInitialRunningSnapshot(original.registration.runId);

    const resumed = await device.deliver('webhook', identity, { batch: 'B' });
    expect(resumed.mode).toBe('resume');
    expect(resumed.registration.created).toBe(false);
    expect(resumed.state).toMatchObject({ runId: original.registration.runId, status: 'done', resume: { previousStatus: 'running' } });
    expect(device.events.filter(({ type }) => type === 'node-start')).toHaveLength(4);
  } finally { device.close(); }
});
