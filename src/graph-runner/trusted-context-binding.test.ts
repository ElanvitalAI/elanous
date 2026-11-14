import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from './runner.js';
import { emptyGraphCapabilityRegistry, registerGraphCapabilityContract,
  registerGraphCapabilityProviderDeclaration } from './capabilities.js';

test('a capability event uses the running graph ID and node clock, never caller context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-trusted-context-'));
  const graph = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  writeFileSync(graph, `graph_id: trusted-context\nversion: 1\nentry_node: emit\nterminal_nodes: [done]\nnodes:\n  - node_id: emit\n    kind: capability\n    recipe: none\n    requires: demo.event@1\n    max_visits: 1\n    input: { runId: "$context.runId", startedAt: "$context.nodeStartedAt" }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: emit, to: done }\n`);
  let observed: Record<string, unknown> | undefined;
  const registry = registerGraphCapabilityProviderDeclaration(
    registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
      id: 'demo.event@1', input: { type: 'object', required: ['runId', 'startedAt'] }, output: { type: 'object' },
    }), {
      id: 'demo-event', provides: ['demo.event@1'], tier: 'free', invoke: context => {
        observed = context.nodeInput as Record<string, unknown>;
        return { ok: true, outcome: 'done', result: { stored: true } };
      },
    });
  try {
    const state = await runGraph(graph, { runId: 'trusted-run',
      input: { context: { runId: 'caller-forged', nodeStartedAt: 'caller-forged' } }, quiet: true,
      deps: { root: join(root, 'state'), capabilityProviders: registry } });
    expect(state.status).toBe('done');
    expect(observed?.runId).toBe(state.runId);
    expect(observed?.runId).toBe('trusted-run');
    expect(observed?.startedAt).toBe(state.nodes[0]?.startedAt);
    expect(observed?.startedAt).not.toBe('caller-forged');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
