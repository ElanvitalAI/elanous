import { expect, test } from 'bun:test';
import { readDashboardAskClarification } from './ask-clarification.js';
import type { GoalDocumentClarification } from '../../self-implement/goal-author-clarification.js';

const clarification: GoalDocumentClarification = {
  questionId: 'scope', header: 'Scope', question: 'Which scope?',
  options: [{ label: 'small', description: 'Small scope' }, { label: 'wide', description: 'Wide scope' }],
  includeOther: false, answer: '', answered: false, answerLine: 1,
};

test('interactive clarification preserves its unbounded question behavior', async () => {
  let received: { timeoutMs?: number } | undefined = { timeoutMs: 1 };
  await readDashboardAskClarification(clarification, {
    question: async (_request, options) => { received = options; return null; },
  }, undefined, false);
  expect(received).toBeUndefined();
});

test('unattended clarification receives the 60-second timeout', async () => {
  let received: { timeoutMs?: number } | undefined;
  await readDashboardAskClarification(clarification, {
    question: async (_request, options) => { received = options; return null; },
  }, undefined, true);
  expect(received).toEqual({ timeoutMs: 60_000 });
});
