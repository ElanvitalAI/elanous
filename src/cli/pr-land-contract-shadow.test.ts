import { expect, test } from 'bun:test';
import { compareContractShadowLanding, comparePinnedLandingHead } from './pr-land-contract-shadow.js';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
// Source: synthetic complete gate observation; counts exercise the join invariant only.
const complete = { commit: head, priorCommit: base, comparison: 'complete', candidate: 'limited',
  observedFailureCount: 2, missedFailureCount: 0, selectedTests: 12, totalTests: 40 };

test('unpinned or mismatched GitHub head cannot assert identity', () => {
  expect(comparePinnedLandingHead(head)).toBeNull();
  expect(comparePinnedLandingHead(head, base)).toBe(false);
  expect(comparePinnedLandingHead(head, head.toUpperCase())).toBe(true);
});

test('landing shadow only accepts a complete observation for the exact head and base', () => {
  expect(compareContractShadowLanding({ head, base }, [complete])).toEqual({ comparison: 'complete',
    observedFailureCount: 2, missedFailureCount: 0, selectedTests: 12, totalTests: 40 });
  expect(compareContractShadowLanding({ head, base: 'c'.repeat(40) }, [complete]).comparison).toBe('unmeasured');
  expect(compareContractShadowLanding({ head: 'd'.repeat(40), base }, [complete]).comparison).toBe('unmeasured');
  expect(compareContractShadowLanding({ head, base }, [{ ...complete, comparison: 'unmeasured' }]).comparison).toBe('unmeasured');
  expect(compareContractShadowLanding({ head, base }, [complete, complete]).comparison).toBe('unmeasured');
  expect(compareContractShadowLanding({ head, base }, [{ ...complete, missedFailureCount: null }]).comparison).toBe('unmeasured');
});

test('a full-radius candidate counts zero misses only after its sweep completes', () => {
  expect(compareContractShadowLanding({ head, base }, [{ ...complete, candidate: 'full', missedFailureCount: null }]).missedFailureCount).toBe(0);
  expect(compareContractShadowLanding({ head, base }, [{ ...complete, candidate: 'full', comparison: 'unmeasured' }]).comparison).toBe('unmeasured');
});
