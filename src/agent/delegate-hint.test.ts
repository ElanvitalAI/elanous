import { describe, expect, test } from 'bun:test';
import { DELEGATE_HINT, shouldHintDelegate } from './delegate-hint.js';

describe('SUBAGENT-AUTO-DELEGATE', () => {
  test('일이 남은 2반복째에는 힌트를 준다', () => {
    expect(shouldHintDelegate({ iteration: 2, maxIterations: 4, toolCallsThisIteration: 0, toolBudget: 10, alreadyHinted: false })).toBe(true);
  });

  test('첫 반복에서 도구 예산의 정확히 80%를 쓰면 힌트를 준다', () => {
    expect(shouldHintDelegate({ iteration: 1, maxIterations: 4, toolCallsThisIteration: 8, toolBudget: 10, alreadyHinted: false })).toBe(true);
  });

  test('이미 힌트를 줬으면 다시 주지 않는다', () => {
    expect(shouldHintDelegate({ iteration: 2, maxIterations: 4, toolCallsThisIteration: 10, toolBudget: 10, alreadyHinted: true })).toBe(false);
  });

  test('첫 반복에서 예산이 남으면 힌트를 주지 않는다', () => {
    expect(shouldHintDelegate({ iteration: 1, maxIterations: 4, toolCallsThisIteration: 7, toolBudget: 10, alreadyHinted: false })).toBe(false);
  });

  test('힌트 원문', () => {
    expect(DELEGATE_HINT).toBe('[delegate] 남은 일 중 서로 독립인 단위나 긴 조사는 Agent 도구로 서브에이전트에 넘겨라(가능하면 동시에 · 긴 일은 run_in_background) — 결과는 자동으로 회수된다. 너는 조율과 마무리를 맡는다.');
  });
});
