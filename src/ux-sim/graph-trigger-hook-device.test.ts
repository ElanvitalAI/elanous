import { expect, test } from 'bun:test';
import { createGraphTriggerHookDevice } from './graph-trigger-hook-device.js';

const graph = [
  'graph_id: trigger-hook-sim',
  'version: 1',
  'entry_node: work',
  'terminal_nodes: [done]',
  'nodes:',
  "  - { node_id: work, kind: agent, recipe: 'cmd:work', max_visits: 1 }",
  '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
  'edges:',
  '  - { from: work, on: outcome, map: { ok: done } }',
  '',
].join('\n');

test('graph trigger device drives the real runner from a fake clock and ingress with an event collector', async () => {
  const device = createGraphTriggerHookDevice(graph);
  try {
    const first = await device.fire('schedule', { release_version: '1.2.3' });
    device.advanceTo('2026-11-09T06:01:00.000Z');
    const second = await device.fire('webhook', { release_version: '1.2.4' });
    expect([first.status, second.status]).toEqual(['done', 'done']);
    expect(device.calls.map(call => [call.ingress, call.at])).toEqual([
      ['schedule', '2026-11-09T06:00:00.000Z'],
      ['webhook', '2026-11-09T06:01:00.000Z'],
    ]);
    expect(device.events.filter(event => event.runId === first.runId && event.type.startsWith('node-')).map(event => event.type)).toEqual([
      'node-arrival', 'node-start', 'node-end', 'node-leave',
      'node-arrival', 'node-start', 'node-end', 'node-leave',
    ]);
    expect(first.input).toEqual({ release_version: '1.2.3' });
    expect(device.events.filter(event => event.runId === first.runId && event.type.startsWith('node-')).every(event => event.emittedAt === '2026-11-09T06:00:00.000Z')).toBe(true);
    expect(device.events.filter(event => event.runId === second.runId && event.type.startsWith('node-')).every(event => event.emittedAt === '2026-11-09T06:01:00.000Z')).toBe(true);
  } finally { device.close(); }
});
