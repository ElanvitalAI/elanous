import { describe, expect, test } from 'bun:test';
import {
  decideAutoStop,
  NO_STALL,
  type AutoStopInput,
  type BrainSuggestionAction,
} from './auto-intervene.js';
import type { applyReworkBudgetDecision } from './rework-policy.js';
import {
  assist,
  mapBrainAction,
  mapControlStance,
  mapReworkVerdict,
  validateSupervisionCadence,
} from './supervision-vocabulary.js';

type ExistingReworkVerdict = NonNullable<
  Parameters<typeof applyReworkBudgetDecision>[1]
>['verdict'];

describe('supervision vocabulary brain mappings', () => {
  test('maps every existing brain action', () => {
    const wait: BrainSuggestionAction = 'wait';
    const input: BrainSuggestionAction = 'input';

    expect(mapBrainAction(wait, false)).toEqual({ verdict: 'continue' });
    expect(mapBrainAction(input, false)).toEqual({ verdict: 'assist', kind: 'context' });
    expect(mapBrainAction('handoff', false)).toEqual({ verdict: 'continue' });
    expect(mapBrainAction('ask-human', false)).toEqual({ verdict: 'escalate' });
  });

  test('splits done completion from the exact stall-confirmed auto-stop condition', () => {
    const done: BrainSuggestionAction = 'done';
    const withoutStall: AutoStopInput = {
      action: done,
      state: 'working',
      stallRung: NO_STALL,
      childAlive: true,
      enabled: true,
      minRung: 2,
    };
    const withStall: AutoStopInput = { ...withoutStall, stallRung: 2 };
    const withoutStallConfirmation = decideAutoStop(withoutStall).stop;
    const withStallConfirmation = decideAutoStop(withStall).stop;

    expect(withoutStallConfirmation).toBe(false);
    expect(withStallConfirmation).toBe(true);
    expect(mapBrainAction(done, withoutStallConfirmation)).toEqual({ verdict: 'complete' });
    expect(mapBrainAction(done, withStallConfirmation)).toEqual({ verdict: 'abandon' });
  });

  test('preserves an assistance capability kind outside the judgment axis', () => {
    expect(assist('capability')).toEqual({ verdict: 'assist', kind: 'capability' });
    expect(assist('info')).toEqual({ verdict: 'assist', kind: 'info' });
  });
});

describe('supervision vocabulary rework mappings', () => {
  test('maps every existing rework verdict without changing its disposition', () => {
    const extend: ExistingReworkVerdict = 'EXTEND';
    const sufficient: ExistingReworkVerdict = 'SUFFICIENT';
    const unconvergeable: ExistingReworkVerdict = 'UNCONVERGEABLE';
    const contractConflict: ExistingReworkVerdict = 'CONTRACT-CONFLICT';

    expect(mapReworkVerdict(extend, 'gate')).toEqual({ verdict: 'continue' });
    expect(mapReworkVerdict(sufficient, 'gate')).toEqual({ verdict: 'continue' });
    expect(mapReworkVerdict(sufficient, 'review')).toEqual({ verdict: 'complete' });
    expect(mapReworkVerdict(unconvergeable, 'review')).toEqual({ verdict: 'abandon' });
    expect(mapReworkVerdict(contractConflict, 'review')).toEqual({ verdict: 'assist', kind: 'contract-conflict' });
  });
});

describe('supervision vocabulary control-stance mappings', () => {
  test.each([
    ['owned', 'halt', 'continue'],
    ['owned', 'skip', 'continue'],
    ['lost', 'halt', 'abandon'],
    ['lost', 'skip', 'continue'],
    ['unknown', 'halt', 'abandon'],
    ['unknown', 'skip', 'continue'],
  ] as const)('maps stance=%s with policy=%s to %s', (stance, policy, verdict) => {
    expect(mapControlStance(stance, policy)).toEqual({ verdict });
  });

  test('skip policy keeps a blocking stance running rather than abandoning it', () => {
    expect(mapControlStance('lost', 'skip')).toEqual({ verdict: 'continue' });
    expect(mapControlStance('unknown', 'skip')).not.toEqual({ verdict: 'abandon' });
  });
});

describe('supervision cadence validation', () => {
  test('accepts the currently wired cadences', () => {
    expect(validateSupervisionCadence('once')).toEqual({ valid: true, cadence: 'once' });
    expect(validateSupervisionCadence('always')).toEqual({ valid: true, cadence: 'always' });
  });

  test('rejects each unwired cadence with its missing substrate', () => {
    expect(validateSupervisionCadence('on-signal'))
      .toEqual({ valid: false, reason: 'on-signal requires the signal substrate' });
    expect(validateSupervisionCadence('scheduled'))
      .toEqual({ valid: false, reason: 'scheduled requires deferred-resume wiring' });
  });
});
