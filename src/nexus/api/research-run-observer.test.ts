import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRunLedgerEntry, loadRunLedger } from '../../self-implement/run-ledger.js';
import { defaultGraphsDir, GRAPH_SPECS, loadGraphTemplatesFrom } from '../../self-implement/graph-templates.js';
import { buildRunTraversal } from './harness-traversal.js';
import { registerResearchRun, RESEARCH_GRAPH_ID } from './research-run-observer.js';
import { runResearchQuestionLadder } from '../../auto-research/research-turn.js';
import { planGapFollowup as planResearchGapFollowup } from '../../research/gap-followup.js';
import { debug } from '../../debug/log.js';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

test('research registration publishes one runId with ordered live traversal and adaptive graph events', () => {
  const template = loadGraphTemplatesFrom(defaultGraphsDir()).templates[RESEARCH_GRAPH_ID];
  expect(template?.nodes.map(({ nodeId }) => nodeId)).toEqual(['question-plan', 'axes', 'evidence-check', 'followup', 'synthesis']);
  expect(GRAPH_SPECS[RESEARCH_GRAPH_ID]?.edges).toContainEqual({ from: 'evidence-check', on: 'outcome', map: { complete: 'synthesis', gap: 'followup' } });
  expect(template?.nodes.every(({ contract }) => contract !== undefined)).toBe(true);

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
  expect(entries.find(({ event, data }) => event === 'pipeline-node-entry' && data.node === 'question-plan')?.data).toMatchObject({
    graphId: RESEARCH_GRAPH_ID,
    graphVersion: '1',
    nodeDeclarationStatus: 'declared',
    nodeContract: { inputs: ['ask_text'], tools: 'research-llm', outputs: ['research-contract', 'questions'] },
  });
  const dynamicEntry = entries.find(({ event, data }) => event === 'pipeline-node-entry' && data.node === 'followup-q5');
  expect(dynamicEntry?.data).toMatchObject({ graphId: RESEARCH_GRAPH_ID, nodeDeclarationStatus: 'undeclared' });
  expect(dynamicEntry?.data).not.toHaveProperty('nodeContract');
  const traversal = buildRunTraversal(runId, entries);
  expect(traversal).toMatchObject({ runId, graphId: 'natural-language-research', title: '자연어 리서치', status: 'completed' });
  expect(traversal.steps.map(({ node }) => node)).toEqual(['question-plan', 'followup-q5']);
  expect(traversal.graphEvents?.map(({ type }) => type)).toEqual(['node-added', 'edge-rerouted', 'priority-changed']);
  expect(traversal.graphEvents?.at(-1)).toMatchObject({ node: 'followup-q5', from: 2, to: 1 });
  expect(streamed.map(({ event, runId: streamedRunId }) => [event, streamedRunId]).every(([, streamedRunId]) => streamedRunId === runId)).toBe(true);
  expect(streamed.some(({ event }) => event === 'priority-changed')).toBe(true);
});

test('a real research gap run dispatches follow-up before returning its synthesized result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'research-run-gap-observer-'));
  roots.push(root);
  const runId = 'run-00000000-0000-4000-8000-000000000026';
  // saveRetroRecord retains only an in-process topic Map entry; keep this key unique so other research tests cannot inherit it.
  const request = `PREEXIST graph contract gap ${crypto.randomUUID()}`;
  const observer = registerResearchRun(runId, { append: (entry) => appendRunLedgerEntry(entry, root), publish: () => {} });
  const outputContract = {
    deliverable: 'A sourced research memo', format: 'Short memo with two sections',
    sections: [
      { id: 'causes', title: 'Causes', purpose: 'Explain supported causes.' },
      { id: 'uncertainty', title: 'Uncertainty', purpose: 'State what remains unsupported.' },
    ],
    completionCriteria: ['Each section has evidence or is explicitly marked uncertain.'],
  };
  const questions = Array.from({ length: 6 }, (_, index) => ({
    id: `q${index + 1}`, level: (index + 1) as 1 | 2 | 3 | 4 | 5 | 6,
    prompt: index === 4 ? 'omni-crawl additional evidence' : `Question ${index + 1}`,
    searchTerms: [`term-${index + 1}`], sectionId: index % 2 ? 'uncertainty' : 'causes',
  }));
  let axisPass = 0;
  const priorFileLogs = debug.isFileEnabled();
  const priorMirror = debug.isMirrorEnabled();
  debug.setFileEnabled(false);
  debug.setMirror(false);
  const debugBytesBeforeRun = debug.bytesWritten();
  let result: Awaited<ReturnType<typeof runResearchQuestionLadder>>;
  try {
    result = await runResearchQuestionLadder(request, {
    generateContract: async () => JSON.stringify(outputContract),
    generate: async () => JSON.stringify({ questions }),
    allowOutputSkill: false,
    enableResearchFanout: false,
    onGraphEvent: (event) => observer.event(event),
    invokeAxes: async (axes) => {
      axisPass += 1;
      const followup = axisPass > 1;
      return { plan: [], axes: axes.map((axis) => ({ questionId: axis.id, evidence: followup || !['q5', 'q6'].includes(axis.id)
        ? ['example.org', 'example.net'].map((host) => ({ questionId: axis.id, sourceKind: 'web-search:test', source: `https://${host}/${axis.id}`, content: `Evidence ${axis.id}`, outcome: 'complete' as const, truncated: false }))
        : [{ questionId: axis.id, sourceKind: 'web-search:test', source: `https://example.org/${axis.id}`, content: `Partial ${axis.id}`, outcome: 'partial' as const, truncated: false }],
      })) };
    },
    planGapFollowup: (input) => planResearchGapFollowup({ ...input, skills: [{
      name: 'omni-crawl', description: 'Public web search', triggers: ['omni-crawl'], extractedTriggers: [],
      triggerSource: 'explicit', autoTrigger: true, sideEffects: 'none', cost: 'light', composes: [],
      skillDir: '/simulated/skills/omni-crawl', rootDir: '/simulated/skills',
    }] }),
    });
    expect(debug.bytesWritten()).toBe(debugBytesBeforeRun);
  } finally {
    debug.setFileEnabled(priorFileLogs);
    debug.setMirror(priorMirror);
  }
  observer.finish(result.ok ? 'completed' : 'failed');

  expect(result.output).toContain('Bounded research gap follow-up');
  const entries = loadRunLedger(runId, root) ?? [];
  const gap = entries.findIndex(({ event, data }) => event === 'edge-rerouted' && data.from === 'evidence-check' && data.to === 'followup');
  const followupEntry = entries.find(({ event, data }) => event === 'pipeline-node-entry' && data.node === 'followup-q5');
  const followup = followupEntry ? entries.indexOf(followupEntry) : -1;
  const followupStage = entries.find(({ event, data }) => event === 'pipeline-node-entry' && data.node === 'followup');
  const followupStageIndex = followupStage ? entries.indexOf(followupStage) : -1;
  const synthesis = entries.findIndex(({ event, data }) => event === 'pipeline-node-entry' && data.node === 'synthesis');
  const synthesisExit = entries.findIndex(({ event, data }) => event === 'pipeline-node-exit' && data.node === 'synthesis');
  expect(gap).toBeGreaterThan(-1);
  expect(followupStageIndex).toBeGreaterThan(gap);
  expect(followup).toBeGreaterThan(followupStageIndex);
  expect(followup).toBeGreaterThan(gap);
  expect(followupStage?.data).toMatchObject({
    nodeDeclarationStatus: 'declared',
    nodeContract: { inputs: ['gaps'], tools: 'research-search', outputs: ['evidence'] },
  });
  expect(synthesis).toBeGreaterThan(followup);
  expect(synthesisExit).toBeGreaterThan(synthesis);
  expect(followupEntry?.data).toMatchObject({ graphId: RESEARCH_GRAPH_ID, nodeDeclarationStatus: 'undeclared' });
  expect(followupEntry?.data).not.toHaveProperty('nodeContract');
}, 15_000);

test('a ledger append fault does not suppress the live research event stream', () => {
  const streamed: Array<Record<string, unknown>> = [];
  const observer = registerResearchRun('run-00000000-0000-4000-8000-000000000025', {
    append: () => { throw new Error('ledger unavailable'); },
    publish: (event) => { streamed.push(event as unknown as Record<string, unknown>); },
  });
  observer.event({ type: 'edge-rerouted', from: 'evidence-check', outcome: 'gap', to: 'followup-q5', was: 'synthesis', reason: 'missing evidence' });
  expect(streamed.some(({ event }) => event === 'edge-rerouted')).toBe(true);
});
