import { describe, expect, test } from 'bun:test';
import { classifyGateEnvDeficit } from './gate-env-retry.js';

describe('classifyGateEnvDeficit', () => {
  const none = { introduced: 0, preexisting: 0, unknown: 1, childResponsibility: 'none' };
  test('retryable unknown reasons are environment deficits', () => {
    expect(classifyGateEnvDeficit({ passed: false, reflectGateFacts: { ...none, unknownReason: 'test-result-unavailable' } })).toEqual({ envDeficit: true, kind: 'test-result-unavailable' });
    expect(classifyGateEnvDeficit({ passed: false, reflectGateFacts: { ...none, unknownReason: 'infrastructure-failure' } })).toEqual({ envDeficit: true, kind: 'infrastructure-failure' });
  });
  test('log vocabulary: index.lock · heap OOM · could not measure · network timeout', () => {
    expect(classifyGateEnvDeficit({ passed: false, log: "fatal: Unable to create '/r/.git/index.lock': File exists." })).toMatchObject({ kind: 'git-lock' });
    expect(classifyGateEnvDeficit({ passed: false, log: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory' })).toMatchObject({ kind: 'out-of-memory' });
    expect(classifyGateEnvDeficit({ passed: false, log: '[typecheck] tsc could not measure' })).toMatchObject({ kind: 'unmeasured' });
    expect(classifyGateEnvDeficit({ passed: false, log: 'GET https://registry.npmjs.org/x error: ETIMEDOUT' })).toMatchObject({ kind: 'network-timeout' });
  });
  test('introduced failures and child responsibility are never environment deficits', () => {
    expect(classifyGateEnvDeficit({ passed: false, log: 'index.lock', reflectGateFacts: { introduced: 1, unknownReason: 'test-result-unavailable' } })).toEqual({ envDeficit: false, reason: 'introduced' });
    expect(classifyGateEnvDeficit({ passed: false, log: 'index.lock', reflectGateFacts: { introduced: 0, childResponsibility: 'child' } })).toEqual({ envDeficit: false, reason: 'child-responsible' });
  });
  test('a non-retryable unknownReason wins over environment words in the log (mixed signal)', () => {
    expect(classifyGateEnvDeficit({ passed: false, log: 'index.lock · JavaScript heap out of memory', reflectGateFacts: { ...none, unknownReason: 'module-load-error' } })).toEqual({ envDeficit: false, reason: 'non-retryable-reason' });
    expect(classifyGateEnvDeficit({ passed: false, log: 'ETIMEDOUT', reflectGateFacts: { ...none, unknownReason: 'budget-exceeded' } })).toEqual({ envDeficit: false, reason: 'non-retryable-reason' });
  });
  test('non-retryable reasons and plain failures stay out', () => {
    expect(classifyGateEnvDeficit({ passed: false, log: 'x', reflectGateFacts: { ...none, unknownReason: 'budget-exceeded' } })).toEqual({ envDeficit: false, reason: 'non-retryable-reason' });
    expect(classifyGateEnvDeficit({ passed: false, log: 'x', reflectGateFacts: { ...none, unknownReason: 'module-load-error' } })).toEqual({ envDeficit: false, reason: 'non-retryable-reason' });
    expect(classifyGateEnvDeficit({ passed: false, log: '[test] 1 fail: expected 2 got 3' })).toEqual({ envDeficit: false, reason: 'no-env-signal' });
    expect(classifyGateEnvDeficit({ passed: true, log: 'index.lock' })).toEqual({ envDeficit: false, reason: 'passed' });
  });
});
