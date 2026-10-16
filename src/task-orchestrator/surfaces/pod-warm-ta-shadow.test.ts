import { describe, expect, test } from 'bun:test';
import {
  compareWarmTaShadow,
  TA_SHADOW_UNRESOLVED_NOTE,
  type LeaseFencedWarmCandidate,
  type SiTaskJobOutcome,
} from './pod-warm-ta-shadow.js';

const outcome = (over: Partial<SiTaskJobOutcome> = {}): SiTaskJobOutcome => ({
  sourceSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  childModel: 'gpt-6-sol',
  ...over,
});
const candidate = (over: Partial<LeaseFencedWarmCandidate> = {}): LeaseFencedWarmCandidate => ({
  sourceSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  childModel: 'gpt-6-sol',
  leaseValid: true,
  ...over,
});

describe('compareWarmTaShadow — confirmed keys (source SHA / child model)', () => {
  test('same source SHA and child model on a valid lease match', () => {
    expect(compareWarmTaShadow(outcome(), candidate())).toEqual({ match: true, reason: 'match' });
  });

  test('source SHA mismatch rejects', () => {
    expect(compareWarmTaShadow(outcome(), candidate({ sourceSha: 'ffffffffffffffffffffffffffffffffffffffff' })))
      .toEqual({ match: false, reason: 'source-sha-mismatch' });
  });

  test('child model mismatch rejects', () => {
    expect(compareWarmTaShadow(outcome(), candidate({ childModel: 'claude-haiku-5-5' })))
      .toEqual({ match: false, reason: 'child-model-mismatch' });
  });
});

describe('compareWarmTaShadow — lease-fence rejection passthrough', () => {
  test('invalid lease rejects even when both keys match', () => {
    expect(compareWarmTaShadow(outcome(), candidate({ leaseValid: false })))
      .toEqual({ match: false, reason: 'lease-invalid' });
  });

  test('unmeasured lease is off, not a pass (undefined)', () => {
    expect(compareWarmTaShadow(outcome(), candidate({ leaseValid: undefined })))
      .toEqual({ match: false, reason: 'lease-unmeasured' });
  });
});

describe('compareWarmTaShadow — exact-value discipline inherited from pod-warm-switch', () => {
  test('empty source SHA on the candidate is unmeasured, not equal', () => {
    expect(compareWarmTaShadow(outcome(), candidate({ sourceSha: '' })).reason).toBe('source-sha-unmeasured');
  });

  test('padded source SHA is malformed, not read as equal', () => {
    expect(compareWarmTaShadow(outcome(), candidate({ sourceSha: ` ${outcome().sourceSha} ` })).reason)
      .toBe('source-sha-malformed');
  });

  test('padded child model is malformed, not read as equal', () => {
    expect(compareWarmTaShadow(outcome(), candidate({ childModel: ` ${outcome().childModel}` })).reason)
      .toBe('child-model-malformed');
  });

  test('blank child model on the outcome is unmeasured', () => {
    expect(compareWarmTaShadow(outcome({ childModel: '' }), candidate()).reason).toBe('child-model-unmeasured');
  });

  test('lease fence is checked before the keys', () => {
    const result = compareWarmTaShadow(outcome(), candidate({ leaseValid: false, sourceSha: 'other' }));
    expect(result.reason).toBe('lease-invalid');
  });
});

describe('compareWarmTaShadow — UNRESOLVED truncation marker', () => {
  test('exports an explicit note that the ask was truncated after child model', () => {
    expect(TA_SHADOW_UNRESOLVED_NOTE).toContain('UNRESOLVED');
    expect(TA_SHADOW_UNRESOLVED_NOTE).toContain('child model');
    expect(TA_SHADOW_UNRESOLVED_NOTE).toContain('unspecified');
  });
});
