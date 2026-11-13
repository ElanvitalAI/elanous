import { expect, test } from 'bun:test';
import { createTurnIdClaim, usageCompletionFrame } from './usage-completion.js';

test('completion is bound to one claimed turn ID and suppressed on abort or absent telemetry', () => {
  const claim = createTurnIdClaim();
  expect(claim('turn-a')).toBe(true);
  expect(claim('turn-a')).toBe(false);
  expect(claim('')).toBe(false);
  expect(claim(' \t\n')).toBe(false);
  expect(claim(' turn-a ')).toBe(true); // validation does not normalize the identifier
  expect(claim(' turn-a ')).toBe(false);
  expect(claim('turn-b')).toBe(true);
  expect(usageCompletionFrame('turn-a', 'session-1', { inputTokens: 7 }, false)).toEqual({
    event: 'usage-complete', turnId: 'turn-a', sessionId: 'session-1', usage: { inputTokens: 7 },
  });
  expect(usageCompletionFrame('turn-b', 'session-1', undefined, false)).toBeUndefined();
  expect(usageCompletionFrame('turn-b', 'session-1', { outputTokens: 3 }, true)).toBeUndefined();
});
