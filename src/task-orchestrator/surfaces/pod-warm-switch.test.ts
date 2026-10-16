import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import {
  decideWarmReuse,
  DEFAULT_WARM_MIN_MATCH_SAMPLES,
  resolveWarmMinMatchSamples,
  WARM_REUSE_CONSUMER_ORDER,
  type WarmReuseEvidence,
  type WarmReuseEvidenceByConsumer,
  type WarmReuseSwitchConfig,
} from './pod-warm-switch.js';

const identity = { head: 'aaaa111122223333', main: 'bbbb444455556666', lock: 'sha256:lock' };
const fullEvidence = (over: Partial<WarmReuseEvidence> = {}): WarmReuseEvidence => ({
  consecutiveMatchSamples: 3,
  recentMismatchCount: 0,
  leaseValid: true,
  canaryPassed: true,
  expected: { ...identity },
  worker: { ...identity },
  ...over,
});
const allOn: WarmReuseSwitchConfig = { gateRecheck: true, land: true, ta: true };
/** 세 소비자 모두 같은 증거 — 개별 칸은 덮어쓴다. */
const every = (evidence: WarmReuseEvidence | undefined, over: WarmReuseEvidenceByConsumer = {}): WarmReuseEvidenceByConsumer => ({
  'gate-recheck': evidence, land: evidence, ta: evidence, ...over,
});

let spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
});

describe('decideWarmReuse — default off', () => {
  test('missing config is off for every consumer even with full evidence', () => {
    for (const consumer of WARM_REUSE_CONSUMER_ORDER) {
      expect(decideWarmReuse(consumer, undefined, every(fullEvidence()))).toEqual({ consumer, live: false, reason: 'flag-off' });
      expect(decideWarmReuse(consumer, {}, every(fullEvidence())).reason).toBe('flag-off');
    }
  });

  test('only literal true counts as a flag', () => {
    const loose = { gateRecheck: 'true', land: 1 } as unknown as WarmReuseSwitchConfig;
    expect(decideWarmReuse('gate-recheck', loose, every(fullEvidence())).reason).toBe('flag-off');
    expect(decideWarmReuse('land', loose, every(fullEvidence())).reason).toBe('flag-off');
  });
});

describe('decideWarmReuse — flag on but evidence short stays off', () => {
  const cases: Array<[string, WarmReuseEvidence | undefined, string]> = [
    ['no evidence', undefined, 'evidence-unmeasured'],
    ['lease unmeasured', fullEvidence({ leaseValid: undefined }), 'lease-unmeasured'],
    ['lease invalid', fullEvidence({ leaseValid: false }), 'lease-invalid'],
    ['canary unmeasured', fullEvidence({ canaryPassed: undefined }), 'canary-unmeasured'],
    ['canary failed', fullEvidence({ canaryPassed: false }), 'canary-failed'],
    ['head unmeasured', fullEvidence({ worker: { ...identity, head: undefined } }), 'identity-unmeasured:head'],
    ['main empty', fullEvidence({ expected: { ...identity, main: '' } }), 'identity-unmeasured:main'],
    ['main blank', fullEvidence({ expected: { ...identity, main: '  ' } }), 'identity-malformed:main'],
    ['padded head is not read as equal', fullEvidence({ expected: { ...identity, head: ` ${identity.head} ` } }), 'identity-malformed:head'],
    ['padded worker lock is not read as equal', fullEvidence({ worker: { ...identity, lock: `${identity.lock}\n` } }), 'identity-malformed:lock'],
    ['lock mismatch', fullEvidence({ worker: { ...identity, lock: 'sha256:other' } }), 'identity-mismatch:lock'],
    ['head mismatch', fullEvidence({ worker: { ...identity, head: 'cccc' } }), 'identity-mismatch:head'],
    ['mismatch count unmeasured', fullEvidence({ recentMismatchCount: undefined }), 'mismatch-unmeasured'],
    ['recent mismatch', fullEvidence({ recentMismatchCount: 1 }), 'recent-mismatch'],
    ['samples unmeasured', fullEvidence({ consecutiveMatchSamples: undefined }), 'samples-unmeasured'],
    ['samples negative', fullEvidence({ consecutiveMatchSamples: -1 }), 'samples-unmeasured'],
    ['samples short', fullEvidence({ consecutiveMatchSamples: 2 }), 'samples-short'],
  ];
  for (const [name, evidence, reason] of cases) {
    test(name, () => {
      expect(decideWarmReuse('gate-recheck', { gateRecheck: true }, every(evidence))).toEqual({ consumer: 'gate-recheck', live: false, reason });
    });
  }

  test('minMatchSamples raises the bar; invalid values fall back to the conservative default', () => {
    expect(decideWarmReuse('gate-recheck', { gateRecheck: true, minMatchSamples: 5 }, every(fullEvidence({ consecutiveMatchSamples: 4 }))).reason).toBe('samples-short');
    expect(decideWarmReuse('gate-recheck', { gateRecheck: true, minMatchSamples: 5 }, every(fullEvidence({ consecutiveMatchSamples: 5 }))).live).toBe(true);
    for (const invalid of [0, -1, 1.5, '1']) {
      expect(resolveWarmMinMatchSamples({ minMatchSamples: invalid })).toBe(DEFAULT_WARM_MIN_MATCH_SAMPLES);
    }
    expect(DEFAULT_WARM_MIN_MATCH_SAMPLES).toBe(3);
  });
});

describe('decideWarmReuse — all satisfied is live', () => {
  test('gate-recheck alone with full evidence is live', () => {
    expect(decideWarmReuse('gate-recheck', { gateRecheck: true }, every(fullEvidence()))).toEqual({ consumer: 'gate-recheck', live: true, reason: 'live' });
  });

  test('every consumer is live when all flags and evidence are present', () => {
    for (const consumer of WARM_REUSE_CONSUMER_ORDER) {
      expect(decideWarmReuse(consumer, allOn, every(fullEvidence())).live).toBe(true);
    }
  });
});

describe('decideWarmReuse — order gate-recheck → land → ta', () => {
  test('land is off while gate-recheck is off', () => {
    expect(decideWarmReuse('land', { land: true }, every(fullEvidence()))).toEqual({ consumer: 'land', live: false, reason: 'predecessor-off:gate-recheck' });
  });

  test('ta is off while land is off, even with gate-recheck live', () => {
    expect(decideWarmReuse('ta', { gateRecheck: true, ta: true }, every(fullEvidence())).reason).toBe('predecessor-off:land');
    expect(decideWarmReuse('ta', { ta: true }, every(fullEvidence())).reason).toBe('predecessor-off:land');
  });

  test('a predecessor that is off for evidence reasons also holds back its successors', () => {
    expect(decideWarmReuse('land', allOn, every(fullEvidence({ canaryPassed: false }))).reason).toBe('predecessor-off:gate-recheck');
    expect(decideWarmReuse('ta', allOn, every(fullEvidence({ consecutiveMatchSamples: 0 }))).reason).toBe('predecessor-off:land');
  });

  test('a predecessor is judged by its own evidence, never by the successor evidence', () => {
    const good = fullEvidence();
    expect(decideWarmReuse('land', allOn, { 'gate-recheck': fullEvidence({ canaryPassed: false }), land: good }).reason).toBe('predecessor-off:gate-recheck');
    expect(decideWarmReuse('land', allOn, { land: good }).reason).toBe('predecessor-off:gate-recheck');
    expect(decideWarmReuse('ta', allOn, { 'gate-recheck': good, land: fullEvidence({ recentMismatchCount: 1 }), ta: good }).reason).toBe('predecessor-off:land');
    expect(decideWarmReuse('ta', allOn, { 'gate-recheck': good, ta: good }).reason).toBe('predecessor-off:land');
    expect(decideWarmReuse('ta', allOn, { 'gate-recheck': good, land: good }).reason).toBe('evidence-unmeasured');
    expect(decideWarmReuse('ta', allOn, { 'gate-recheck': good, land: good, ta: good }).live).toBe(true);
  });

  test('order is gate-recheck, land, ta', () => {
    expect([...WARM_REUSE_CONSUMER_ORDER]).toEqual(['gate-recheck', 'land', 'ta']);
  });
});

describe('decideWarmReuse — observation', () => {
  test('each decision writes one pod.warm switch-decision line', () => {
    const lines: Array<[string, string, unknown]> = [];
    spies.push(spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
      lines.push([category, event, data]);
    }) as typeof debug.log));
    decideWarmReuse('ta', allOn, every(fullEvidence({ recentMismatchCount: 2 })));
    expect(lines).toHaveLength(1);
    expect(lines[0]![0]).toBe('pod.warm');
    expect(lines[0]![1]).toBe('switch-decision');
    expect(lines[0]![2]).toMatchObject({ consumer: 'ta', live: false, reason: 'predecessor-off:land', flag: true, minMatchSamples: 3, samples: 3, recentMismatchCount: 2 });
  });
});
