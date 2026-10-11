import { describe, expect, test } from 'bun:test';
import { computeFlexSignals } from './flex-signals.js';

describe('computeFlexSignals', () => {
  test('same failure ids across two rounds → fail_signature_repeat 1', () => {
    const signals = computeFlexSignals({
      gateFailedIdsByRound: [['a@x.ts (introduced)', 'b@y.ts (introduced)'], ['b@y.ts (introduced)', 'a@x.ts (introduced)']],
      round: 2,
    });
    expect(signals.fail_signature_repeat).toBe(1);
  });

  test('different failure ids → fail_signature_repeat 0', () => {
    const signals = computeFlexSignals({ gateFailedIdsByRound: [['a'], ['b']], round: 2 });
    expect(signals.fail_signature_repeat).toBe(0);
  });

  test('unknown latest failure ids omit fail_signature_repeat', () => {
    expect('fail_signature_repeat' in computeFlexSignals({ gateFailedIdsByRound: [['a'], undefined], round: 2 })).toBe(false);
    expect('fail_signature_repeat' in computeFlexSignals({ gateFailedIdsByRound: [], round: 1 })).toBe(false);
  });

  test('unknown base attribution omits base_reproduce', () => {
    const signals = computeFlexSignals({ gateFailedIdsByRound: [['a']], failureAttributions: ['preexisting', 'unknown'], round: 1 });
    expect('base_reproduce' in signals).toBe(false);
    expect('base_reproduce' in computeFlexSignals({ gateFailedIdsByRound: [['a']], round: 1 })).toBe(false);
  });

  test('known attribution counts failures reproduced at base', () => {
    const signals = computeFlexSignals({ gateFailedIdsByRound: [['a', 'b']], failureAttributions: ['preexisting', 'introduced'], round: 1 });
    expect(signals.base_reproduce).toBe(1);
  });

  test('review_repeat passes through and is omitted when unknown', () => {
    expect(computeFlexSignals({ gateFailedIdsByRound: [], reviewRepeat: 0, round: 1 }).review_repeat).toBe(0);
    expect('review_repeat' in computeFlexSignals({ gateFailedIdsByRound: [], round: 1 })).toBe(false);
  });

  test('budget_burn is rounds over planned size and omitted without a plan', () => {
    expect(computeFlexSignals({ gateFailedIdsByRound: [], round: 1, plannedRounds: 4 }).budget_burn).toBe(0.25);
    expect('budget_burn' in computeFlexSignals({ gateFailedIdsByRound: [], round: 1 })).toBe(false);
  });
});
