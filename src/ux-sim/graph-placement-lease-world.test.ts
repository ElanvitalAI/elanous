import { expect, test } from 'bun:test';
import { createGraphPlacementLeaseWorld, graphPlacementLeaseCases } from './graph-placement-lease-world.js';

const graph = [
  'graph_id: placement-lease-world', 'version: 1', 'entry_node: work', 'terminal_nodes: [done]',
  'nodes:', "  - { node_id: work, kind: agent, recipe: 'cmd:work', max_visits: 1 }",
  '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
  'edges:', '  - { from: work, on: outcome, map: { ok: done } }',
].join('\n');

test('placement world exposes local, pod, remote and user-cloud candidates plus missing or mismatched leases', async () => {
  const world = createGraphPlacementLeaseWorld(graph);
  try {
    const rows = await world.play(async ({ request, admitHostLease, enterNode }) => {
      if (!admitHostLease()) return { decision: 'denied', reason: 'guardian-lease' };
      const run = await enterNode();
      return { decision: 'entered', runId: run.runId };
    });
    expect(rows.map(({ request }) => request.id)).toEqual(graphPlacementLeaseCases.map(({ id }) => id));
    expect(rows.slice(0, 4).map(({ request }) => request.placement)).toEqual(['local', 'pod', 'remote:aws1', 'user-cloud']);
    expect(rows.filter(({ decision }) => decision === 'denied').map(({ request }) => request.id))
      .toEqual(['missing-lease', 'expired-lease', 'wrong-run', 'wrong-consumer']);
    expect(rows.filter(({ decision }) => decision === 'entered')).toHaveLength(7);
    expect(world.calls).toHaveLength(7);
    // The existing host lease ledger does not know pod generation or profile/host admission yet: these stay visible gaps.
    expect(rows.filter(({ request, decision }) =>
      ['stale-generation', 'over-profile', 'offline-host'].includes(request.id) && decision === 'entered')).toHaveLength(3);
    expect(world.ledgerEvents().filter(({ event }) => event === 'guardian-host-lease-admission-denied')).toHaveLength(4);
  } finally { world.close(); }
});

test('a placement adapter can refuse generation, profile and offline host before node entry', async () => {
  const world = createGraphPlacementLeaseWorld(graph);
  try {
    const rows = await world.play(async ({ request, hostOnline, admitHostLease, enterNode }) => {
      if (request.podGeneration !== request.expectedGeneration) return { decision: 'denied', reason: 'generation' };
      if (request.cpu > request.profileMaxCpu) return { decision: 'denied', reason: 'profile-cap' };
      if (!hostOnline) return { decision: 'denied', reason: 'host-offline' };
      if (!admitHostLease()) return { decision: 'denied', reason: 'guardian-lease' };
      return { decision: 'entered', runId: (await enterNode()).runId };
    });
    expect(rows.filter(({ decision }) => decision === 'entered').map(({ request }) => request.id))
      .toEqual(['valid-local', 'valid-pod', 'valid-remote', 'valid-user-cloud']);
    expect(rows.slice(4).every(({ enters }) => enters.length === 0)).toBe(true);
    expect(rows.slice(8).map(({ reason }) => reason)).toEqual(['generation', 'profile-cap', 'host-offline']);
    expect(world.calls).toHaveLength(4);
    expect(world.events.filter(({ type }) => type === 'node-start')).toHaveLength(8);
  } finally { world.close(); }
});
