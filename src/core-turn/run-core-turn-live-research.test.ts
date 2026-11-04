import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as llmModule from '../llm.js';
import { registerResearchRun } from '../nexus/api/research-run-observer.js';
import { buildRunTraversal } from '../nexus/api/harness-traversal.js';
import { appendRunLedgerEntry, loadRunLedger } from '../self-implement/run-ledger.js';
import { runCoreTurn } from './run-core-turn.js';

let mockedResearchOK = true;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  mock.restore();
});

const researchQuestionLadderRunner = async (_request: string, options: import('../auto-research/research-turn.js').ResearchQuestionLadderRunOptions) => {
  options.onGraphEvent?.({ type: 'enter', node: 'question-plan' });
  options.onGraphEvent?.({ type: 'exit', node: 'question-plan', outcome: 'ok' });
  options.onGraphEvent?.({ type: 'enter', node: 'axes' });
  options.onGraphEvent?.({ type: 'exit', node: 'axes', outcome: 'ok' });
  options.onGraphEvent?.({ type: 'enter', node: 'evidence-check' });
  options.onGraphEvent?.({ type: 'exit', node: 'evidence-check', outcome: 'complete' });
  return { ok: mockedResearchOK, output: mockedResearchOK ? 'grounded evidence' : '', sourceUrls: [] };
};

test('default research registers a live run through final synthesis and exposes its traversal', async () => {
  mockedResearchOK = true;
  const stateRoot = mkdtempSync(join(tmpdir(), 'core-turn-research-run-'));
  roots.push(stateRoot);
  const runId = 'run-00000000-0000-4000-8000-000000000026';
  let modelCalls = 0;
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers) => {
    modelCalls += 1;
    const text = modelCalls === 1 ? 'provisional answer' : 'synthesized answer';
    handlers.onTurnComplete?.([{ role: 'assistant', content: text, phase: 'final_answer' }]);
    return text;
  });
  await runCoreTurn({
    sessionId: 'live-research-session', runId,
    messages: [{ role: 'user', content: 'deep research: why are bond yields rising?' }],
    tools: [], dispatchTool: async () => null, signal: new AbortController().signal,
    userText: 'deep research: why are bond yields rising?',
  }, {
    researchQuestionLadderRunner,
    researchRunObserverFactory: (id) => registerResearchRun(id, {
      append: (entry) => appendRunLedgerEntry(entry, join(stateRoot, 'run-ledger')),
    }),
  });
  const entries = loadRunLedger(runId, join(stateRoot, 'run-ledger')) ?? [];
  const traversal = buildRunTraversal(runId, entries);
  expect(traversal).toMatchObject({ runId, graphId: 'natural-language-research', status: 'completed' });
  expect(traversal.steps.map(({ node }) => node).at(-1)).toBe('synthesis');
  expect(entries.at(-1)?.event).toBe('run-status');
  expect(entries.at(-1)?.data.runStatus).toBe('completed');
  expect(modelCalls).toBe(2);
});

test('failed research with a provisional fallback finishes the run as failed', async () => {
  mockedResearchOK = false;
  const stateRoot = mkdtempSync(join(tmpdir(), 'core-turn-research-failed-'));
  roots.push(stateRoot);
  const runId = 'run-00000000-0000-4000-8000-000000000027';
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers) => {
    handlers.onTurnComplete?.([{ role: 'assistant', content: 'provisional answer', phase: 'final_answer' }]);
    return 'provisional answer';
  });
  await runCoreTurn({
    sessionId: 'live-research-failed-session', runId,
    messages: [{ role: 'user', content: 'deep research: why are bond yields rising?' }],
    tools: [], dispatchTool: async () => null, signal: new AbortController().signal,
    userText: 'deep research: why are bond yields rising?',
  }, {
    researchQuestionLadderRunner,
    researchRunObserverFactory: (id) => registerResearchRun(id, {
      append: (entry) => appendRunLedgerEntry(entry, join(stateRoot, 'run-ledger')),
    }),
  });
  const entries = loadRunLedger(runId, join(stateRoot, 'run-ledger')) ?? [];
  expect(entries.at(-1)?.event).toBe('run-status');
  expect(entries.at(-1)?.data.runStatus).toBe('failed');
});
