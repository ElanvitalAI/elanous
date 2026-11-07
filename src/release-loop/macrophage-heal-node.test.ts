import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from '../graph-runner/runner.js';
import { createMacrophageRuntime } from './macrophage-heal-node.js';

test('release phase node-end reaches the macrophage subscriber and records the actual bus trace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'macrophage-bus-'));
  const runId = 'macrophage-bus-test';
  const graphId = 'macrophage-bus-test-graph';
  const now = new Date('2026-11-06T00:00:00Z');
  const graphDir = join(root, 'graphs');
  mkdirSync(graphDir, { recursive: true });
  writeFileSync(join(graphDir, 'recipes.yaml'), 'noop:\n  command: "noop"\n');
  const graphPath = join(graphDir, 'release-loop.yaml');
  writeFileSync(graphPath, `graph_id: ${graphId}\nversion: 1\nentry_node: pre-gate-join\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: pre-gate-join, kind: gate, recipe: 'cmd:noop', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - { from: pre-gate-join, on: outcome, map: { ok: done, fail: failed, error: failed } }\n`);
  const runtime = createMacrophageRuntime({ runId, graphId, now: () => now, inventory: () => [
    { id: 'live-worktree', kind: 'orphan-worktree', owner: 'seat-live', evidence: { ownerRunStatus: 'running', ownershipVerified: true } },
  ] });
  const phaseEventIds = new Map<string, string>();
  const unsubscribe = runtime.eventBus.subscribe((event) => {
    if (event.type === 'node-end' && event.source.nodeId) phaseEventIds.set(event.source.nodeId, event.eventId);
  }, { type: 'node-end' });
  try {
    const state = await runGraph(graphPath, { runId, eventBus: runtime.eventBus, deps: {
      root, runBash: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } });
    expect(state.status).toBe('done');
    const phaseEventId = phaseEventIds.get('pre-gate-join');
    expect(phaseEventId).toBeDefined();
    expect(runtime.decisions.map((event) => event.data)).toEqual([{
      sourceEventId: phaseEventId, phaseNodeId: 'pre-gate-join', status: 'planned', id: 'live-worktree',
      kind: 'orphan-worktree', evidence: 'kind=orphan-worktree; owner run=running; owner=seat-live',
      result: 'planned retain; no cleanup applied', action: 'retain', applied: false,
    }]);
    expect(runtime.decisions[0]?.data?.sourceEventId).toBe(phaseEventId);
  } finally {
    unsubscribe();
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('live node invokes the cleanup adapter only for a verified merged queue row', async () => {
  let cleanupCalls = 0;
  const runtime = createMacrophageRuntime({ runId: 'safe-cleanup-test', liveCleanup: (scrap) => {
    cleanupCalls += 1;
    expect(scrap.kind).toBe('merged-land-queue-row');
    return 'removed exact stale queue row';
  }, inventory: () => [{ id: 'queue-row', kind: 'merged-land-queue-row',
    evidence: { mergedMainline: true, queueRow: `123\t${'a'.repeat(40)}\t/tree\t/evidence` } }] });
  try {
    await runtime.eventBus.publish({ graphId: 'release-loop', runId: 'safe-cleanup-test', type: 'node-end',
      source: { kind: 'node', nodeId: 'pre-gate-join' }, data: { ok: true } });
    expect(cleanupCalls).toBe(1);
    expect(runtime.decisions[0]?.data).toMatchObject({ action: 'remove-queue-row', applied: true, result: 'removed exact stale queue row' });
  } finally { runtime.dispose(); }
});
