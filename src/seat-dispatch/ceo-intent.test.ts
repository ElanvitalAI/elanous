import { expect, test } from 'bun:test';
import { CEO_QUESTION_ENDINGS, classifyCeoIntent } from './ceo-intent.js';

const examples = [
  ['오늘 행사 준비 어디까지야?', 'question'],
  ['오늘 행사 준비 어디까지야', 'question'],
  ['이거 맞니', 'question'],
  ['준비 끝났나요', 'question'],
  ['언제 시작할까요', 'question'],
  ['담당자가 누구인가요', 'question'],
  ['이건 어때', 'question'],
  ['현황 알려 줘', 'question'],
  ['목록 보여줘', 'question'],
  ['지금 상황', 'question'],
  ['준비 어디까지', 'question'],
  ['오타 고쳐 줘', 'task'],
  ['블로그 초안 만들어', 'task'],
  ['내일 일정 정리해 줘', 'task'],
  ['행사 준비 진행해', 'task'],
  ['결제 화면 수정', 'task'],
  ['PR 검토 부탁해', 'task'],
  ['회의록 작성해', 'task'],
  ['공지 올려', 'task'],
] as const;

test('each ending in the deterministic question table has an example; non-questions remain tasks', () => {
  expect(CEO_QUESTION_ENDINGS).toHaveLength(11);
  for (const [text, intent] of examples) expect(classifyCeoIntent(`  ${text}  `)).toBe(intent);
  expect(classifyCeoIntent('맞니？')).toBe('question');
  expect(classifyCeoIntent('현황 알려줘')).toBe('question');
});

test('question-ending table has a one-to-one example for every row', () => {
  const questionExamples = examples.filter(([, intent]) => intent === 'question');
  expect(questionExamples).toHaveLength(CEO_QUESTION_ENDINGS.length);
  for (const [index, ending] of CEO_QUESTION_ENDINGS.entries()) {
    expect(ending.test(questionExamples[index]![0])).toBe(true);
  }
});
