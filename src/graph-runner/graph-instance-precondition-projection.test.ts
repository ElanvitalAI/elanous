import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from './runner.js';
import { emptyGraphCapabilityRegistry, registerGraphCapabilityContract,
  registerGraphCapabilityProviderDeclaration } from './capabilities.js';
import { graphRunEventLedgerPath, readGraphRunEvents } from './graph-run-event-ledger.js';
import { handleGraphInstanceViewGet } from '../../plugins/graph-instance-view/handlers/http-get.js';
import { projectView, type ViewLedgers } from '../../plugins/graph-instance-view/handlers/project-ledgers.js';

test('real graph precondition ledger becomes safe check, fill, and block lines in the live view', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'graph-precondition-view-'));
  const graph = join(directory, 'graph.yaml');
  const stateRoot = join(directory, 'state');
  writeFileSync(join(directory, 'recipes.yaml'), '{}\n');
  writeFileSync(graph, 'graph_id: precondition-view\nversion: 1\nentry_node: task\nterminal_nodes: [done]\nnodes:\n  - { node_id: task, kind: capability, recipe: none, requires: demo.precondition@1, max_visits: 1, input: {} }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: task, to: done }\n');
  const registry = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.precondition@1', input: { type: 'object', required: ['appSlug'],
      properties: { appSlug: { type: 'string' } } }, output: { type: 'object' },
  }), { id: 'view-provider', provides: ['demo.precondition@1'], tier: 'free',
    requires: ['appSlug'], fill: { appSlug: ['host'] },
    invoke: () => ({ ok: true, outcome: 'done', result: {} }) });
  try {
    const filled = await runGraph(graph, { runId: 'filled', quiet: true, verifiedAppSlug: 'secret-app-value',
      deps: { root: stateRoot, capabilityProviders: registry } });
    const blocked = await runGraph(graph, { runId: 'blocked', quiet: true,
      deps: { root: stateRoot, capabilityProviders: registry } });
    const ledgers: ViewLedgers = {
      graphRuns: () => [filled, blocked],
      graphEvents: run => readGraphRunEvents(graphRunEventLedgerPath(stateRoot, run.graphId, run.runId)),
      harness: () => null, resources: () => [], hosts: () => [], now: () => '2026-11-16T00:00:00.000Z',
    };
    const filledView = projectView({ source: 'graph', graphId: filled.graphId, runId: filled.runId }, ledgers);
    expect(filledView?.logs.map(log => log.text)).toEqual(expect.arrayContaining([
      expect.stringContaining('사전 검사 · appSlug'), expect.stringContaining('채움 · appSlug · host'),
    ]));
    const filledResponse = handleGraphInstanceViewGet(new Request('https://nexus.test/v1/graph-instance-view?source=graph&graphId=precondition-view&runId=filled'),
      { operator: true }, ledgers);
    expect(filledResponse.status).toBe(200);
    const filledBody = await filledResponse.json();
    expect(JSON.stringify(filledBody)).not.toContain('secret-app-value');
    const response = handleGraphInstanceViewGet(new Request('https://nexus.test/v1/graph-instance-view?source=graph&graphId=precondition-view&runId=blocked'),
      { operator: true }, ledgers);
    expect(response.status).toBe(200);
    const body = await response.json() as { logs: Array<{ text: string; nodeId: string }> };
    expect(body.logs.some(log => log.nodeId === 'task' && log.text.includes('차단 · appSlug'))).toBe(true);
    expect(JSON.stringify(body)).not.toContain('secret-app-value');
    expect(JSON.stringify(body)).not.toContain('credential');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
