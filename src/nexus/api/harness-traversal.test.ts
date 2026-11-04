import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildRunTraversal, handleHarnessRunTraversalGet } from './harness-traversal.js';
import type { RunLedgerEntry } from '../../self-implement/run-ledger.js';
import type { HarnessGraphEventWire } from '../../../apps/pwa/src/nexus/client.js';

const runId = 'run-demo-replay';
const at = '2026-10-29T00:00:00.000Z';
const row = (event: string, seq: number, data: Record<string, unknown>): RunLedgerEntry => ({
  timestamp: at, runId, event, seq, data,
});
const demo1104RunId = '9770d6f8-39e6-412a-9e83-9447b7a2cd36';
const demo1104FixedLedger = readFileSync(new URL('../../../test/fixtures/run-ledgers/demo1104-arg-9770d6f8.jsonl', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).map((line) => JSON.parse(line) as RunLedgerEntry);

describe('buildRunTraversal graph replay sequence', () => {
  test('DEMO1104 fixed S2 ledger returns A/B/C structure and mock provenance in the traversal wire', async () => {
    const response = handleHarnessRunTraversalGet(new Request(`http://localhost/v1/harness/run-traversal?runId=${demo1104RunId}`), {
      loadLedger: () => demo1104FixedLedger,
    });
    const wire = await response.json();
    const fixedTraversal = JSON.parse(readFileSync(new URL('../../../test/fixtures/run-ledgers/demo1104-arg-9770d6f8.traversal.json', import.meta.url), 'utf8'));
    expect(wire).toEqual(fixedTraversal);
    expect(response.status).toBe(200);
    expect(wire.graphEvents.filter((event: { type: string }) => event.type === 'node-added')).toEqual([
      expect.objectContaining({ seq: 1, node: 'fx-scenario-quantification', decider: 'runtime-overlay' }),
      expect.objectContaining({ seq: 12, node: 'subscription-repair', decider: 'scenario-injection', kind: 'judge', scene: 'B', demo1104Scene: 'B', reason: 'paid-wall recovery mock' }),
      expect.objectContaining({ seq: 17, node: 'headline-refresh', decider: 'scenario-injection', kind: 'researcher', scene: 'C', demo1104Scene: 'C', reason: 'new headline reordering mock' }),
    ]);
    expect(wire.graphEvents).toHaveLength(9);
    expect(wire.journeyEdges.filter((edge: { injected?: boolean }) => edge.injected)).toHaveLength(4);
    expect(wire.journeyEdges.filter((edge: { injected?: boolean }) => edge.injected)).toMatchObject([
      { seq: 15, source: 'graph', taken: 'subscription-repair', injected: true, mockOutcome: 'paywall', scene: 'B', demo1104Scene: 'B' },
      { seq: 16, source: 'graph', taken: 'summarize', injected: true, mockOutcome: 'paywall', scene: 'B', demo1104Scene: 'B' },
      { seq: 20, source: 'graph', taken: 'headline-refresh', injected: true, mockOutcome: 'new_headline', scene: 'C', demo1104Scene: 'C' },
      { seq: 21, source: 'graph', taken: 'prioritize', injected: true, mockOutcome: 'new_headline', scene: 'C', demo1104Scene: 'C' },
    ]);
  });

  test('projects host, Pod and model from the real self-implement origin and Pod launch events', () => {
    const traversal = buildRunTraversal(runId, [
      row('run-origin', 0, { hostname: 'host-origin', hostId: 'host-2', podName: 'worker-pod-7', childProvider: 'openai-codex', childModel: 'gpt-6.1-terra' }),
      row('pipeline-node-entry', 1, { node: 'implement', round: 1 }),
      row('pod-launch-started', 2, { job: 'si-task-worker-7', run: 'child-run-7', provenance: { 'launch-host': 'gcp2' } }),
      row('pod-launch-finished', 3, { job: 'si-task-worker-7', run: 'child-run-7', phase: 'complete' }),
      row('pipeline-node-entry', 4, { node: 'review', round: 1 }),
    ]);

    expect(traversal.steps[0]?.resources).toEqual({ host: 'gcp2', pod: 'worker-pod-7', models: ['gpt-6.1-terra'] });
    expect(traversal.steps[0]?.resources).not.toHaveProperty('plugins');
    expect(traversal.steps[1]?.resources).toEqual({ host: 'host-origin', pod: 'worker-pod-7', models: ['gpt-6.1-terra'] });
  });

  test('projects only actual model and plugin tool calls from the visited node window', () => {
    const traversal = buildRunTraversal(runId, [
      row('run-origin', 0, { hostname: 'host-origin', childProvider: 'openai-codex', childModel: 'requested-model' }),
      row('pipeline-node-entry', 1, { node: 'implement', round: 1 }),
      row('llm-consume-start', 2, { provider: 'grok', model: 'grok-4.6', childProvider: 'grok', childModel: 'grok-4.6', llmConsumeStart: { provider: 'grok', model: 'grok-4.6' } }),
      row('plugin-tool-call', 3, { plugin: 'linear', tool: 'elanous_linear_issue' }),
      row('pipeline-node-entry', 4, { node: 'review', round: 1 }),
      row('pipeline-node-entry', 5, { node: 'merge', round: 1 }),
      row('plugin-tool-call', 6, { plugin: 'outside-window', tool: 'later-call' }),
    ]);

    expect(traversal.steps[0]?.resources).toEqual({
      host: 'host-origin',
      models: ['grok-4.6'],
      plugins: ['linear/elanous_linear_issue'],
    });
    expect(traversal.steps[1]?.resources).toEqual({ host: 'host-origin', models: ['requested-model'] });
    expect(traversal.steps[2]?.resources).toMatchObject({ plugins: ['outside-window/later-call'] });
  });

  test('does not present a Kubernetes Job name as a Pod when run-origin has no Pod name', () => {
    const traversal = buildRunTraversal(runId, [
      row('run-origin', 0, { hostname: 'host-origin', childProvider: 'openai-codex', childModel: 'gpt-6.1-terra' }),
      row('pipeline-node-entry', 1, { node: 'implement', round: 1 }),
      row('pod-launch-started', 2, { job: 'si-task-worker-7', run: 'child-run-7', provenance: { 'launch-host': 'gcp2' } }),
      row('pipeline-node-entry', 3, { node: 'review', round: 1 }),
    ]);

    expect(traversal.steps[0]?.resources).toEqual({ host: 'gcp2', models: ['gpt-6.1-terra'] });
  });

  test('exposes source sequence and structural graph events from the same fixed ledger', () => {
    const traversal = buildRunTraversal(runId, [
      row('start', 0, { feature: 'Research demo' }),
      row('pipeline-node-entry', 1, { node: 'investigate', round: 0, graphId: 'research-loop' }),
      row('node-added', 2, { node: 'source-check', kind: 'agent', decider: 'supervisor', reason: 'verify citation' }),
      row('pipeline-node-entry', 3, { node: 'source-check', round: 0, graphId: 'research-loop' }),
      row('edge-rerouted', 4, { from: 'source-check', outcome: 'pass', to: 'summarize', was: 'gate', decider: 'orchestrator', reason: 'evidence found' }),
    ]);

    expect(traversal.steps.map(({ node, sourceSeq }) => [node, sourceSeq])).toEqual([
      ['investigate', 1], ['source-check', 3],
    ]);
    expect(traversal.graphEvents?.map(({ seq, type }) => [seq, type])).toEqual([
      [2, 'node-added'], [4, 'edge-rerouted'],
    ]);
    const pwaContract: HarnessGraphEventWire[] = traversal.graphEvents ?? [];
    expect(pwaContract).toHaveLength(2);
  });

  test('preserves graph events and traversal sequence through the HTTP handler', async () => {
    const response = handleHarnessRunTraversalGet(new Request(`http://localhost/v1/harness/run-traversal?runId=${runId}`), {
      loadLedger: () => [
        row('pipeline-node-entry', 1, { node: 'investigate', round: 0, graphId: 'research-loop' }),
        row('node-added', 2, { node: 'source-check', kind: 'agent', decider: 'supervisor', reason: 'verify citation' }),
      ],
    });
    const wire = await response.json();
    expect(response.status).toBe(200);
    expect(wire.steps[0].sourceSeq).toBe(1);
    expect(wire.graphEvents).toEqual([expect.objectContaining({ seq: 2, type: 'node-added', node: 'source-check' })]);
  });

  test('exposes selected graph.path edges and injected outcome provenance through the HTTP handler', async () => {
    const response = handleHarnessRunTraversalGet(new Request(`http://localhost/v1/harness/run-traversal?runId=${runId}`), {
      loadLedger: () => [
        row('graph.path', 10, { event: 'edge-taken', from: 'review', label: 'source_missing', taken: 'fx-scenario-quantification', source: 'graph', injected: true, mockOutcome: 'source_missing' }),
        row('graph.path', 11, { event: 'edge-taken', from: 'fx-scenario-quantification', label: 'complete', taken: 'merge', source: 'graph', injected: true, mockOutcome: 'source_missing' }),
      ],
    });
    const wire = await response.json();
    expect(wire.journeyEdges).toEqual([
      { seq: 10, from: 'review', label: 'source_missing', taken: 'fx-scenario-quantification', source: 'graph', injected: true, mockOutcome: 'source_missing' },
      { seq: 11, from: 'fx-scenario-quantification', label: 'complete', taken: 'merge', source: 'graph', injected: true, mockOutcome: 'source_missing' },
    ]);
  });
});
