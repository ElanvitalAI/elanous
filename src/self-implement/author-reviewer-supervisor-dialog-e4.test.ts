import { afterEach, expect, test } from 'bun:test';
import { isAbsolute, relative } from 'node:path';
import { debug } from '../debug/log.js';
import { LogStore, StoreSink, logsDbPath } from '../mss/logging/log-store.js';
import { appendRunLedgerEntry, runLedgerDir } from './run-ledger.js';
import {
  executeGoalAuthorReviewerDialog,
  runGoalAuthorReviewerPrecheck,
} from './goal-author.js';
import type { LLMMessage } from '../llm.js';
import {
  superviseRun,
  type SupervisorJobResult,
} from '../self-dev/run-supervisor.js';

const firstFix = 'The result has a measurable criterion and an observable source.';
const secondFix = 'The result has a named owner and a time bound.';

const goalDocument = (): string => [
  'Reviewable goal',
  '- GoalId: 1234567890abcdef',
  '- RootIntent: preserve measurable authoring',
  '- GoalType: implement',
  '',
  '## PROBLEM', '- The current goal needs clearer acceptance.',
  '',
  '## WHAT TO BUILD', '- Make the goal measurable.',
  'Original ask (verbatim, unmodified):', '```text',
  '대상 경로: src/self-implement/goal-author.ts', `${firstFix} ${secondFix}`, '```',
  '',
  '## ACCEPTANCE CRITERIA', '- The result has a measurable criterion.',
  '',
  '## REQUIRED EVIDENCE', '- [requested] focused test output',
  '',
  '## TRACED PATHS', '- src/self-implement/goal-author.ts — author entrypoint',
  '',
  '## SCOPE BOUNDARY', '- 대상 경로: src/self-implement/goal-author.ts',
  '',
  '## 답하지 못하는 것', '- No unresolved questions.',
  '',
  '## 불변식', '- The original ask remains verbatim.',
  '',
  '## 판정 신호', '- Condition: the authoring result is reviewed',
  '- Observation: revised acceptance is present', '- Expected result: the criterion is measurable.',
].join('\n');

let logStore: LogStore | undefined;
let storeSink: StoreSink | undefined;
let unregisterStoreSink: (() => void) | undefined;
const fileSinkWasEnabled = debug.isFileEnabled();

afterEach(() => {
  unregisterStoreSink?.();
  unregisterStoreSink = undefined;
  storeSink?.close();
  storeSink = undefined;
  logStore?.close();
  logStore = undefined;
  // Keep this fixture from leaking a process-global logger toggle into later tests.
  debug.setFileEnabled(fileSinkWasEnabled);
});

test('AUTHOR-REVIEWER-SUPERVISOR-DIALOG E4: durable log joins author.reviewer.round and supervisor.reauthor-request on the same authorRunId/runId', async () => {
  const isolatedStateDir = process.env.ELANOUS_STATE_DIR;
  expect(isolatedStateDir).toBeTruthy();
  expect(logsDbPath()).toContain(isolatedStateDir!);
  const ledgerPath = relative(isolatedStateDir!, runLedgerDir());
  expect(ledgerPath.startsWith('..')).toBe(false);
  expect(isAbsolute(ledgerPath)).toBe(false);
  // Bun's preload points ELANOUS_STATE_DIR at its per-process test universe.
  logStore = new LogStore(logsDbPath(), { instance: 'test:author-reviewer-e4' });
  storeSink = new StoreSink(logStore, 'test', { installExitHandlers: false, flushBatchSize: 1000 });
  unregisterStoreSink = debug.registerSink(storeSink);
  const conversationId = 'run-e4-durable-author-reviewer';
  let activeDocument = goalDocument();
  let providerCalls = 0;
  const stream: typeof import('../llm.js').streamLLM = async (_messages: LLMMessage[], _onChunk, options = {}) => {
    providerCalls += 1;
    const fix = providerCalls === 1 ? firstFix : secondFix;
    const originalText = providerCalls === 1
      ? '- The result has a measurable criterion.'
      : `- ${firstFix}`;
    const revisedText = `${originalText}\n- ${fix}`;
    const revisedDocument = activeDocument.replace(originalText, revisedText);
    options.onResolvedProvider?.(options.provider!.name, options.model!);
    return JSON.stringify({
      suggestions: [],
      fixes: [fix],
      fixEvidence: [{ fix, originalText, revisedText }],
      remainingNeedsHuman: [],
      revisedDocument,
    });
  };

  // Durable test-universe logger: the production observer seam writes every
  // dialog event into the shared durable JSONL log instead of a memory array.
  const durableObserver = (event: string, data: Record<string, unknown>): void => {
    debug.log('author.dialog', event, data);
  };

  const dialog = await executeGoalAuthorReviewerDialog(
    true,
    activeDocument,
    conversationId,
    async (document, context) => {
      activeDocument = document;
      return runGoalAuthorReviewerPrecheck(document, { stream, reviewContext: context });
    },
    durableObserver,
  );
  expect(providerCalls).toBe(2);
  expect(dialog).toMatchObject({ outcome: 'cap-hit', rounds: 2, hitl: true, status: 'completed' });

  // The production supervisor consumes realistic review findings and emits
  // its own reauthor event. The tiny lineage ledger is written in Bun's
  // isolated test state, never the operational state directory.
  const parentRunId = 'run-e4-supervisor-parent';
  appendRunLedgerEntry({
    runId: parentRunId,
    event: 'goal-authored',
    data: { authorRunId: conversationId },
  }, runLedgerDir());
  const reviewResults = [
    {
      taskId: 'task-1', feature: 'reviewed authorship one', status: 'done', stage: 'pr-opened', runId: 'review-run-1',
      rework: { trend: 'stable', signature: 'future-ops-assumption', rounds: 7 },
      reviewMustFix: ['future assumption: requires a nonexistent runtime path.'],
      changedFiles: ['src/self-implement/goal-author.ts'], targetPaths: ['src/self-implement/goal-author.ts'],
    },
    {
      taskId: 'task-2', feature: 'reviewed authorship two', status: 'done', stage: 'pr-opened', runId: 'review-run-2',
      rework: { trend: 'worsening', signature: 'unnecessary-goal', rounds: 7 },
      reviewMustFix: ['out-of-scope: requires an additional result.'],
      changedFiles: ['src/self-implement/goal-author.ts'], targetPaths: ['src/self-implement/goal-author.ts'],
    },
    {
      taskId: 'task-3', feature: 'reviewed authorship three', status: 'done', stage: 'pr-opened', runId: 'review-run-3',
      rework: { trend: 'oscillating', signature: 'missing-piece', rounds: 7 },
      reviewMustFix: ['아직 없는 운영 배선을 요구한다.', 'Fix null handling.'],
      changedFiles: ['src/self-implement/goal-author.ts'], targetPaths: ['src/self-implement/goal-author.ts'],
    },
  ] as unknown as SupervisorJobResult[];
  await superviseRun({
    initial: reviewResults,
    runStore: { runId: parentRunId },
    limits: { maxRounds: 1 },
    rerun: async (previous) => previous,
    sweepPendingMerges: async () => ({ pending: 0, merged: 0 }),
    taskAgentShadow: false,
    observe: (event, data) => debug.log('self-dev.supervisor', event, data),
  });

  // Flush the registered StoreSink and query the same SQLite logs.db schema
  // used by `eln logs`; no file-sink JSONL shortcut or hand-written DB rows.
  storeSink.flush();
  const rows = logStore.query({ events: ['author.reviewer.round', 'supervisor.reauthor-request'], grep: conversationId, limit: 100 });
  console.log(`E4 SQLite evidence: db=${logStore.path}; rows=${JSON.stringify(rows.map((row) => ({ category: row.category, event: row.event, data: JSON.parse(row.data) })))}; query=eln logs --event author.reviewer.round,supervisor.reauthor-request --grep ${conversationId} --limit 100 --json-data`);
  const payload = (row: (typeof rows)[number]): Record<string, unknown> => JSON.parse(row.data) as Record<string, unknown>;

  const reviewerRounds = rows.filter((row) => row.event === 'author.reviewer.round'
    && payload(row)?.runId === conversationId)
    .sort((left, right) => Number(payload(left).round) - Number(payload(right).round));
  expect(reviewerRounds).toHaveLength(2);
  expect(reviewerRounds.map((row) => payload(row))).toEqual([
    expect.objectContaining({ conversationId, runId: conversationId, round: 1, proposalCount: 1, appliedCount: 1, rejectedCount: 0, rejectionReasonCodes: [] }),
    expect.objectContaining({ conversationId, runId: conversationId, round: 2, proposalCount: 1, appliedCount: 1, rejectedCount: 0, rejectionReasonCodes: [] }),
  ]);

  const supervisorRows = rows.filter((row) => row.event === 'supervisor.reauthor-request'
    && payload(row)?.runId === conversationId)
    .sort((left, right) => String(payload(left).sourceReviewRunId).localeCompare(String(payload(right).sourceReviewRunId)));
  expect(supervisorRows).toHaveLength(3);
  expect(supervisorRows.map((row) => payload(row))).toEqual([
    expect.objectContaining({ conversationId, runId: conversationId, parentRunId, sourceReviewRunId: 'review-run-1', attempt: 7, classification: 'authorship-defect' }),
    expect.objectContaining({ conversationId, runId: conversationId, parentRunId, sourceReviewRunId: 'review-run-2', attempt: 7, classification: 'authorship-defect' }),
    expect.objectContaining({ conversationId, runId: conversationId, parentRunId, sourceReviewRunId: 'review-run-3', attempt: 7, classification: 'authorship-defect' }),
  ]);
  // The durable log enriches rows with host/substrate attribution; the
  // supervisor payload must still carry every join field verbatim.
  expect(payload(supervisorRows[0]!)).toEqual(expect.objectContaining({
    conversationId,
    runId: conversationId,
    parentRunId,
    sourceReviewRunId: 'review-run-1',
    attempt: 7,
    classification: 'authorship-defect',
  }));

  // The E4 join: the durable log itself carries both event kinds under one
  // identical authorRunId/runId string, byte-for-byte.
  expect(supervisorRows.every((row) => payload(row)!.conversationId === payload(reviewerRounds[0]!)!.conversationId)).toBe(true);
  expect(supervisorRows.every((row) => payload(row)!.runId === payload(reviewerRounds[0]!)!.runId)).toBe(true);
  expect(reviewerRounds.every((row) => payload(row)!.runId === conversationId)).toBe(true);
});
