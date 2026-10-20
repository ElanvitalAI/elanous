import { describe, expect, test } from 'bun:test';
import { observeTaJourneyUnit } from './ta-journey-observe.js';

describe('TA journey observation wrappers', () => {
  test('missing evidence fails closed and reports exactly the missing nodes', () => {
    expect(observeTaJourneyUnit('entry', {})).toMatchObject({
      outcome: 'needs-human',
      result: { unit: 'entry', observed: false, reason: 'missing-observation:intake,queue,launch-gate' },
    });
  });

  test('direct entry omits queue while requiring intake and launch-gate evidence', () => {
    expect(observeTaJourneyUnit('entry', { observations: {
      intake: { outcome: 'direct' },
      'launch-gate': { outcome: 'pass' },
    } })).toMatchObject({
      outcome: 'done',
      result: { unit: 'entry', observed: true, observations: { intake: 'direct', 'launch-gate': 'pass' } },
    });
  });

  test('queued entry waiting for a launch remains needs-human', () => {
    expect(observeTaJourneyUnit('entry', { observations: {
      intake: { outcome: 'queued' },
      queue: { outcome: 'waiting' },
      'launch-gate': { outcome: 'pass' },
    } }).outcome).toBe('needs-human');
  });

  test('known failures dominate missing downstream evidence', () => {
    expect(observeTaJourneyUnit('dispatch-pod', { substrate: 'pod', observations: {
      dispatch: { outcome: 'fresh' },
      'pool-admit': { outcome: 'error' },
    } })).toMatchObject({ outcome: 'failed', result: { reason: 'existing-step-failed' } });
  });

  test('local dispatch succeeds from its existing dispatch observation alone', () => {
    expect(observeTaJourneyUnit('dispatch-pod', { substrate: 'local', observations: {
      dispatch: { outcome: 'fresh' },
    } })).toMatchObject({ outcome: 'done', result: { observations: { dispatch: 'fresh' } } });
  });

  test('Pod path requires all existing Pod-side observations and fails closed when incomplete', () => {
    expect(observeTaJourneyUnit('dispatch-pod', { substrate: 'pod', observations: {
      dispatch: { outcome: 'pr-source' },
      'pool-admit': { outcome: 'admitted' },
      'credential-refresh': { outcome: 'usable' },
    } })).toMatchObject({ outcome: 'needs-human', result: { reason: 'missing-observation:image-sync' } });
  });

  test('author and PR map to their existing graph observation node IDs', () => {
    expect(observeTaJourneyUnit('author', { observations: { author: { outcome: 'authored' } } }).outcome).toBe('done');
    expect(observeTaJourneyUnit('pr', { observations: { 'open-pr': { outcome: 'pr-opened' } } })).toMatchObject({
      outcome: 'done',
      result: { unit: 'pr', observations: { 'open-pr': 'pr-opened' } },
    });
  });
});
