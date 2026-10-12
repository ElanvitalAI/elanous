import { describe, expect, it, spyOn } from 'bun:test';
import { debug } from '../debug/log.js';
import { estimateLlmCost } from './llm-cost.js';
import { planShadowArms } from './shadow-arms.js';

const FIRST = 'gpt-5.6-terra';
const SECOND = 'claude-sonnet-4-6';
const UNKNOWN = 'absent-model-for-shadow-arms';

function costOf(model: string, inputTokens: number, outputTokens: number): number {
  const got = estimateLlmCost({ model, inputTokens, outputTokens });
  expect(got.kind).toBe('known');
  if (got.kind !== 'known') throw new Error(`expected known price for ${model}`);
  return got.usd;
}

function baseInput(overrides: Partial<Parameters<typeof planShadowArms>[0]> = {}) {
  return {
    stage: 'implement' as const,
    difficulty: 'small' as const,
    inputTokens: 1_000,
    expectedOutputTokens: 500,
    candidates: [FIRST, SECOND],
    spentTodayUsd: 0,
    dailyCapUsd: 1_000,
    ...overrides,
  };
}

describe('planShadowArms', () => {
  it('상한 넉넉 → 전부 fire', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const input = baseInput();
      const first = costOf(FIRST, input.inputTokens, input.expectedOutputTokens);
      const second = costOf(SECOND, input.inputTokens, input.expectedOutputTokens);
      const got = planShadowArms(input);
      expect(got.fire).toEqual([
        { model: FIRST, estUsd: first },
        { model: SECOND, estUsd: second },
      ]);
      expect(got.skipped).toEqual([]);
      expect(got.remainingUsd).toBe(input.dailyCapUsd - first - second);
      expect(log.mock.calls.some(([category, event, data]) =>
        category === 'budget.shadow-arms'
        && event === 'planned'
        && (data as { fire: number; skipped: number }).fire === 2
        && (data as { fire: number; skipped: number }).skipped === 0,
      )).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('하루 그림자 예산을 넘는 팔은 over-daily-cap 으로 뺀다 — 상한이 둘째에서 넘침 → 둘째부터 over-daily-cap', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const inputTokens = 1_000;
      const expectedOutputTokens = 500;
      const first = costOf(FIRST, inputTokens, expectedOutputTokens);
      const second = costOf(SECOND, inputTokens, expectedOutputTokens);
      expect(second).toBeGreaterThan(0);
      const got = planShadowArms(baseInput({
        inputTokens,
        expectedOutputTokens,
        dailyCapUsd: first + second / 2,
        candidates: [FIRST, SECOND, 'grok-4.6'],
      }));
      expect(got.fire).toEqual([{ model: FIRST, estUsd: first }]);
      expect(got.skipped).toEqual([
        { model: SECOND, reason: 'over-daily-cap' },
        { model: 'grok-4.6', reason: 'over-daily-cap' },
      ]);
      expect(got.remainingUsd).toBe(first + second / 2 - first);
      expect(log.mock.calls.some(([category, event, data]) =>
        category === 'budget.shadow-arms'
        && event === 'planned'
        && (data as { fire: number; skipped: number }).fire === 1
        && (data as { fire: number; skipped: number }).skipped === 2,
      )).toBe(true);
      expect(log).toHaveBeenCalledWith('budget.shadow-arms', 'planned', {
        stage: 'implement',
        difficulty: 'small',
        fire: 1,
        skipped: 2,
        remainingUsd: got.remainingUsd,
      });
    } finally {
      log.mockRestore();
    }
  });

  it('가격 모르는 모델 → unknown-price (0원으로 치지 않는다)', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const input = baseInput({
        candidates: [UNKNOWN, FIRST],
        dailyCapUsd: 1_000,
      });
      const first = costOf(FIRST, input.inputTokens, input.expectedOutputTokens);
      const unknownEstimate = estimateLlmCost({
        model: UNKNOWN,
        inputTokens: input.inputTokens,
        outputTokens: input.expectedOutputTokens,
      });
      expect(unknownEstimate.kind).toBe('unknown');
      expect('usd' in unknownEstimate).toBe(false);
      const got = planShadowArms(input);
      expect(got.skipped).toEqual([{ model: UNKNOWN, reason: 'unknown-price' }]);
      expect(got.fire).toEqual([{ model: FIRST, estUsd: first }]);
      expect(got.remainingUsd).toBe(input.dailyCapUsd - first);
    } finally {
      log.mockRestore();
    }
  });

  it('예산을 넘은 뒤의 가격 모르는 팔도 over-daily-cap 으로 뺀다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const inputTokens = 1_000;
      const expectedOutputTokens = 500;
      const first = costOf(FIRST, inputTokens, expectedOutputTokens);
      const second = costOf(SECOND, inputTokens, expectedOutputTokens);
      const got = planShadowArms(baseInput({
        inputTokens,
        expectedOutputTokens,
        dailyCapUsd: first + second / 2,
        candidates: [FIRST, SECOND, UNKNOWN],
      }));
      expect(got.fire).toEqual([{ model: FIRST, estUsd: first }]);
      expect(got.skipped).toEqual([
        { model: SECOND, reason: 'over-daily-cap' },
        { model: UNKNOWN, reason: 'over-daily-cap' },
      ]);
    } finally {
      log.mockRestore();
    }
  });
});
