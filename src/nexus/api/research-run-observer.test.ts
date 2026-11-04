import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRunLedgerEntry, loadRunLedger } from '../../self-implement/run-ledger.js';
import { defaultGraphsDir, GRAPH_SPECS, loadGraphTemplatesFrom } from '../../self-implement/graph-templates.js';
import { buildRunTraversal } from './harness-traversal.js';
import { registerResearchRun, RESEARCH_GRAPH_ID } from './research-run-observer.js';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

test('research registration publishes one runId with ordered live traversal and adaptive graph events', () => {
  const template = loadGraphTemplatesFrom(defaultGraphsDir()).templates[RESEARCH_GRAPH_ID];
  expect(template?.nodes.map(({ nodeId }) => nodeId)).toEqual(['question-plan', 'axes', 'evidence-check', 'followup', 'synthesis']);
  expect(GRAPH_SPECS[RESEARCH_GRAPH_ID]?.edges).toContainEqual({ from: 'evidence-check', on: 'outcome', map: { complete: 'synthesis', gap: 'synthesis' } });

  const root = mkdtempSync(join(tmpdir(), 'research-run-observer-'));
  roots.push(root);
  const runId = 'run-00000000-0000-4000-8000-000000000024';
  const streamed: Array<Record<string, unknown>> = [];
  const observer = registerResearchRun(runId, {
    append: (entry) => appendRunLedgerEntry(entry, root),
    publish: (event) => { streamed.push(event as unknown as Record<string, unknown>); },
  });

  observer.event({ type: 'enter', node: 'question-plan' });
  observer.event({ type: 'exit', node: 'question-plan', outcome: 'ok' });
  observer.event({ type: 'node-added', node: 'followup-q5', kind: 'research', reason: 'contract gap' });
  observer.event({ type: 'edge-rerouted', from: 'evidence-check', outcome: 'gap', to: 'followup-q5', was: 'synthesis', reason: 'missing evidence' });
  observer.event({ type: 'priority-changed', node: 'followup-q5', from: 2, to: 1, reason: 'section priority' });
  observer.event({ type: 'enter', node: 'followup-q5' });
  observer.event({ type: 'exit', node: 'followup-q5', outcome: 'ok' });
  observer.finish('completed');

  const entries = loadRunLedger(runId, root) ?? [];
  const traversal = buildRunTraversal(runId, entries);
  expect(traversal).toMatchObject({ runId, graphId: 'natural-language-research', title: '자연어 리서치', status: 'completed' });
  expect(traversal.steps.map(({ node }) => node)).toEqual(['question-plan', 'followup-q5']);
  expect(traversal.graphEvents?.map(({ type }) => type)).toEqual(['node-added', 'edge-rerouted', 'priority-changed']);
  expect(traversal.graphEvents?.at(-1)).toMatchObject({ node: 'followup-q5', from: 2, to: 1 });
  expect(streamed.map(({ event, runId: streamedRunId }) => [event, streamedRunId]).every(([, streamedRunId]) => streamedRunId === runId)).toBe(true);
  expect(streamed.some(({ event }) => event === 'priority-changed')).toBe(true);
});

test('a ledger append fault does not suppress the live research event stream', () => {
  const streamed: Array<Record<string, unknown>> = [];
  const observer = registerResearchRun('run-00000000-0000-4000-8000-000000000025', {
    append: () => { throw new Error('ledger unavailable'); },
    publish: (event) => { streamed.push(event as unknown as Record<string, unknown>); },
  });
  observer.event({ type: 'edge-rerouted', from: 'evidence-check', outcome: 'gap', to: 'followup-q5', was: 'synthesis', reason: 'missing evidence' });
  expect(streamed.some(({ event }) => event === 'edge-rerouted')).toBe(true);
});
