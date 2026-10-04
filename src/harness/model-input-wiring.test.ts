import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import type { LogRecord } from '../mss/logging/record.js';
import { runGraph } from '../graph-runner/runner.js';
import { graphTick } from '../graph-runner/graph-tick.js';

function collectModelInput() {
  const records: LogRecord[] = [];
  const off = debug.registerSink({
    name: `model-input-wiring-${Math.random()}`,
    emit(record) { if (record.category === 'harness.model-input' && record.event === 'recorded') records.push(record); },
  });
  return { records, off };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'graph-model-input-'));
  const graph = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), 'work:\n  command: "printf work"\n');
  writeFileSync(graph, `graph_id: input-observation
version: 1
entry_node: work
terminal_nodes: [done, failed]
nodes:
  - { node_id: work, kind: agent, recipe: 'cmd:work', max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - { from: work, to: done }
`);
  return { root, graph };
}

const unmeasured = { status: 'unmeasured', inputTokens: null, reason: 'usage-unavailable' };

describe('graph execution model input observation', () => {
  test('real graph node executions emit per-node records with missing usage, without changing the run ledger', async () => {
    const { records, off } = collectModelInput();
    const { root, graph } = fixture();
    try {
      const state = await runGraph(graph, { runId: 'input-run', deps: {
        root, runBash: async () => ({ stdout: 'work', stderr: '', exitCode: 0 }),
      } });
      expect(state.status).toBe('done');
      expect(state.nodes.map(node => node.nodeId)).toEqual(['work', 'done']);
      const persisted = JSON.parse(readFileSync(state.statePath, 'utf8'));
      expect(persisted.nodes.map((node: { nodeId: string; ok: boolean }) => ({ nodeId: node.nodeId, ok: node.ok })))
        .toEqual(state.nodes.map(node => ({ nodeId: node.nodeId, ok: node.ok })));
      expect(records).toHaveLength(2);
      expect(records[0]?.data).toMatchObject({ scope: 'harness-node', nodeKind: 'agent', runId: 'input-run', nodeId: 'work', ...unmeasured });
      expect(records[1]?.data).toMatchObject({ scope: 'harness-node', nodeKind: 'gate', runId: 'input-run', nodeId: 'done', ...unmeasured });
    } finally {
      off();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('each real graph tick emits an unmeasured record, including idle and started ticks', async () => {
    const { records, off } = collectModelInput();
    const { root, graph } = fixture();
    try {
      const deps = { root, runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }) };
      expect(await graphTick(graph, { deps })).toEqual({ action: 'idle' });
      expect((await graphTick(graph, { startIfIdle: true, deps })).status).toBe('done');
      const ticks = records.map(record => record.data as { scope: string; nodeKind: string; graphId: string; tickId: string; status: string; inputTokens: number | null; reason: string })
        .filter(data => data.scope === 'loop-tick');
      expect(ticks).toHaveLength(2);
      expect(ticks[0]!.tickId).not.toBe(ticks[1]!.tickId);
      for (const tick of ticks) expect(tick).toMatchObject({ scope: 'loop-tick', nodeKind: 'graph-tick', graphId: 'input-observation', tickId: expect.any(String), ...unmeasured });
      expect(records.filter(record => (record.data as { scope?: string })?.scope === 'harness-node')).toHaveLength(2);
      expect(records.map(record => (record.data as { inputTokens: number | null }).inputTokens)).toEqual([null, null, null, null]);
    } finally {
      off();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
