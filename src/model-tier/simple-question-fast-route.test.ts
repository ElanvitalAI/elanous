import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isSimpleQuestionFastRoute } from './simple-question-fast-route.js';

describe('simple question fast route', () => {
  test('accepts a short, stable, single-turn factual question', () => {
    expect(isSimpleQuestionFastRoute({ text: '우리나라 가장 높은 빌딩?' })).toBe(true);
    expect(isSimpleQuestionFastRoute({ text: 'What is the capital of France?' })).toBe(true);
  });

  test('keeps dynamic, action, compound, attachment, and follow-up prompts on normal routing', () => {
    for (const text of [
      '오늘 서울 날씨?',
      '요즘 가장 높은 빌딩을 검색해서 출처도 알려 줘.',
      '우리나라 가장 높은 빌딩은 무엇이고 몇 미터야?',
      'src/llm.ts 파일 읽어 줘',
      'Why is the current price changing?',
      'Can you delete the database?',
      'Who is the president of South Korea?',
      'What is 2+2 and 3+3?',
      'Should I quit my job?',
      'This is broken?',
      'What is my name?',
      'What is in the repository?',
      'What is the name of the user?',
      'What is searchIndex in src/router.ts?',
      'What is in src/router.ts?',
      'What is 2+2? What is 3+3?',
      'What is 2+2. What is 3+3?',
    ]) expect(isSimpleQuestionFastRoute({ text })).toBe(false);
    expect(isSimpleQuestionFastRoute({ text: '우리나라 가장 높은 빌딩?', priorUserTurns: 1 })).toBe(false);
    expect(isSimpleQuestionFastRoute({ text: '우리나라 가장 높은 빌딩?', hasAttachments: true })).toBe(false);
  });

  test('does not classify any tool-routed utterance in the shared NL routing corpus as fast', () => {
    const path = resolve(import.meta.dir, '../../scripts/fixtures/nl-routing/corpus.jsonl');
    const rows = readFileSync(path, 'utf8').trim().split(/\r?\n/u).slice(1).map(line => JSON.parse(line) as { prompt: string; accept: string[] });
    const toolExpected = rows.filter(row => row.accept.length > 0);
    expect(toolExpected).toHaveLength(16);
    const fast = toolExpected.filter(row => isSimpleQuestionFastRoute({ text: row.prompt }));
    expect({ measured: toolExpected.length, falseFast: fast.map(row => row.prompt) }).toEqual({ measured: toolExpected.length, falseFast: [] });
  });
});
