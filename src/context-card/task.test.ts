import { expect, test } from 'bun:test';
import { buildTaskCard, type TaskLedgerReader } from './task.js';
import type { RunLedgerEntry } from '../self-implement/run-ledger.js';

const taskId = 'goal-1';
const entry = (runId: string, event: string, timestamp: string, data: Record<string, unknown>): RunLedgerEntry =>
  ({ runId, goalId: taskId, event, timestamp, data });
const sha256 = 'a'.repeat(64);
const runs = [
  { runId: 'run-1', entries: [
    entry('run-1', 'start', '2026-10-05T10:00:00Z', { goalFile: 'docs/goals/GOAL-1.txt' }),
    entry('run-1', 'goal-authored', '2026-10-05T10:01:00Z', { path: 'docs/goals/GOAL-1.txt', sha256 }),
    entry('run-1', 'reviewed', '2026-10-05T10:02:00Z', { reviewed: true, verdict: 'fail', artifactPath: 'review/1.json', mustFix: 1 }),
  ] },
  { runId: 'run-2', entries: [
    entry('run-2', 'start', '2026-10-05T11:00:00Z', { goalFile: 'docs/goals/GOAL-1.txt' }),
    entry('run-2', 'reviewed', '2026-10-05T11:02:00Z', { reviewed: true, verdict: 'fail', artifactPath: 'review/2.json', mustFix: 3 }),
    entry('run-2', 'decision-card', '2026-10-05T11:03:00Z', { cardId: 'decision:7' }),
    entry('run-2', 'next-action', '2026-10-05T11:04:00Z', { nextAction: '수정 후 집중 시험' }),
  ] },
];

test('two runs, three latest must-fixes, one decision, verbatim ask, authored hash and next action come only from reader', () => {
  let reads = 0;
  const reader: TaskLedgerReader = {
    readRuns: () => { reads++; return runs; },
    readOriginalAsk: () => '원문\n그대로',
    readReviewMustFix: (path) => path === 'review/2.json' ? ['fix a', 'fix b', 'fix c'] : ['obsolete'],
  };
  const before = structuredClone(runs);
  const card = buildTaskCard(taskId, reader);
  expect(reads).toBe(1);
  expect(card).toMatchObject({
    id: 'task:goal-1', kind: 'task', originalAsk: '원문\n그대로',
    authoredGoal: { path: 'docs/goals/GOAL-1.txt', sha256 },
    runIds: ['run-1', 'run-2'], mustFix: ['fix a', 'fix b', 'fix c'],
    decisionCards: ['decision:7'], nextAction: '수정 후 집중 시험',
    conclusion: '수정 후 집중 시험', verdict: 'fail', updatedAt: '2026-10-05T11:04:00Z',
    remaining: ['fix a', 'fix b', 'fix c'],
  });
  expect(card.pointers).toEqual([
    'docs/goals/GOAL-1.txt', `docs/goals/GOAL-1.txt#sha256=${sha256}`,
    'run:run-1', 'run:run-2', 'review/2.json', 'decision:7',
  ]);
  expect(buildTaskCard(taskId, reader)).toEqual(card);
  expect(runs).toEqual(before);
  const withoutAction: TaskLedgerReader = {
    ...reader,
    readRuns: () => runs.map((run) => ({ ...run, entries: run.entries.filter((e) => e.event !== 'next-action') })),
  };
  expect(buildTaskCard(taskId, withoutAction).nextAction).toBe('fix a');
});

test('missing original ask or next action is explicit, never invented', () => {
  expect(() => buildTaskCard(taskId, { readRuns: () => runs })).toThrow('original ask unavailable');
  expect(() => buildTaskCard(taskId, { readRuns: () => runs, readOriginalAsk: () => 'ask' })).toThrow('review must-fix unavailable');
  expect(() => buildTaskCard(taskId, { readRuns: () => runs.map((run) => ({ ...run, entries: run.entries.filter((e) => e.event !== 'next-action') })), readOriginalAsk: () => 'ask', readReviewMustFix: () => [] })).toThrow('next action unavailable');
});
