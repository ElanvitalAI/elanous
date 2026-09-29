import { describe, expect, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { decideNonGitInit } from './non-git-consent.js';

const target = '/home/example/project';
const prompt = `${target} 는 git 저장소가 아닙니다. 여기서 \`git init\` 하고 첫 커밋을 만들까요? 되돌리려면 \`.git\` 을 지우면 됩니다. [y/N] `;

describe('decideNonGitInit', () => {
  for (const { interactive, assumeYes, answer, expected, expectedCalls } of [
    { interactive: true, assumeYes: false, answer: 'y', expected: 'init', expectedCalls: 1 },
    { interactive: true, assumeYes: false, answer: 'n', expected: 'refused', expectedCalls: 1 },
    { interactive: false, assumeYes: true, answer: 'n', expected: 'init', expectedCalls: 0 },
    { interactive: false, assumeYes: false, answer: 'y', expected: 'non-interactive-refused', expectedCalls: 0 },
  ] as const) {
    test(`interactive=${interactive} assumeYes=${assumeYes} returns ${expected} and asks ${expectedCalls} time(s)`, async () => {
      const prompts: string[] = [];
      const observations: Record<string, unknown>[] = [];
      const off = debug.registerSink({
        name: `non-git-consent-${interactive}-${assumeYes}-${answer}`,
        emit: (record) => {
          if (record.category === 'harness.non-git' && record.event === 'decided') {
            observations.push(record.data as Record<string, unknown>);
          }
        },
      });
      try {
        expect(await decideNonGitInit({
          target, interactive, assumeYes,
          ask: async (question) => { prompts.push(question); return answer; },
        })).toBe(expected);
        expect(prompts).toHaveLength(expectedCalls);
        if (expectedCalls) expect(prompts).toEqual([prompt]);
        expect(observations).toHaveLength(1);
        expect(observations[0]).toMatchObject({ target, interactive, decision: expected });
      } finally {
        off();
      }
    });
  }

  test.each(['', ' Y ', 'YES', undefined])('interactive confirmation handles %s without assuming consent', async (answer) => {
    const prompts: string[] = [];
    expect(await decideNonGitInit({
      target, interactive: true, assumeYes: false,
      ask: async (question) => { prompts.push(question); return answer; },
    })).toBe(answer === ' Y ' || answer === 'YES' ? 'init' : 'refused');
    expect(prompts).toEqual([prompt]);
  });
});
