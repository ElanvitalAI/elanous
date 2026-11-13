import { expect, test } from 'bun:test';
import { createMeasuredTurnUsage } from './turn-usage.js';

test('provider reports aggregate within a turn while absent fields stay unavailable', () => {
  const first = createMeasuredTurnUsage();
  expect(first.snapshot()).toBeUndefined();
  first.accept({ stopReason: 'stop' });
  expect(first.snapshot()).toBeUndefined();
  first.accept({ inputTokens: 12 });
  first.accept({ outputTokens: 4 });
  first.accept({ inputTokens: 3, outputTokens: 2 });
  expect(first.snapshot()).toEqual({ inputTokens: 15, outputTokens: 6 });

  const second = createMeasuredTurnUsage();
  second.accept({ outputTokens: 0 });
  expect(second.snapshot()).toEqual({ outputTokens: 0 });
  second.accept({ inputTokens: Number.NaN, outputTokens: -1 });
  expect(second.snapshot()).toEqual({ outputTokens: 0 });
  expect(first.snapshot()).toEqual({ inputTokens: 15, outputTokens: 6 });
});
