// Preservation + wiring: pending-question writes/removals go through assertNotTestWritingOps
// at the production entry points. Isolated-root behaviour stays in test/ask-user-question/.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestOpsWriteRefusedError, setOpsRootsForTesting } from '../instance/test-write-guard.js';
import {
  createPendingQuestion,
  readPendingQuestions,
  removePendingQuestion,
  removePendingQuestionAnswer,
  writePendingQuestion,
  writePendingQuestionAnswer,
} from './pending-questions.js';

let root = '';
let opsLike = '';
let isolated = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pending-questions-guard-'));
  opsLike = join(root, 'ops');
  isolated = join(root, 'isolated');
  mkdirSync(opsLike, { recursive: true });
  mkdirSync(isolated, { recursive: true });
  setOpsRootsForTesting([opsLike]);
});

afterEach(() => {
  setOpsRootsForTesting(null);
  rmSync(root, { recursive: true, force: true });
});

test('writeAtomicRecord / removePendingQuestion / removePendingQuestionAnswer refuse ops writes before mutation', () => {
  const question = createPendingQuestion('guard', { questions: [{ id: 'choice', header: 'Choice', question: 'Choose?', options: [{ label: 'A', description: 'A' }] }] });
  const answer = { id: 'guard', result: { answers: { choice: 'A' } } };
  const ops = { root: () => opsLike };
  const own = { root: () => isolated };
  expect(() => writePendingQuestion(question, ops)).toThrow(TestOpsWriteRefusedError);
  expect(() => writePendingQuestionAnswer(answer, ops)).toThrow(TestOpsWriteRefusedError);
  expect(() => removePendingQuestion('guard', ops)).toThrow(TestOpsWriteRefusedError);
  expect(() => removePendingQuestionAnswer('guard', ops)).toThrow(TestOpsWriteRefusedError);
  expect(existsSync(join(opsLike, 'ask-user-question'))).toBe(false);
  writePendingQuestion(question, own);
  writePendingQuestionAnswer(answer, own);
  expect(readPendingQuestions(own)).toEqual({ ok: true, questions: [question] });
  removePendingQuestionAnswer('guard', own);
  removePendingQuestion('guard', own);
  expect(readPendingQuestions(own)).toEqual({ ok: true, questions: [] });
});
