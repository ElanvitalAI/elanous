import { expect, test } from 'bun:test';
import { createResearchEdgeDecisionRegistry, type BloomEdgeAssessment } from './edge-decision.js';

const assessment: BloomEdgeAssessment = {
  gaps: ['missing real-rate series'],
  contradictions: ['headline data conflicts with survey'],
  verdicts: ['evidence is mixed'],
};

test('the default provider stops without changing the graph', async () => {
  const registry = createResearchEdgeDecisionRegistry();
  await expect(registry.decide(assessment)).resolves.toMatchObject({
    action: 'stop',
    reason: 'no edge decision provider registered',
    evidence: [],
    provider: 'default-noop',
    votes: [],
    dissent: [],
    counterEvidenceRefs: [],
    outsideViewRefs: [],
    mode: 'record-only',
  });
});

test('a registered provider receives Bloom assessment and returns its decision with evidence', async () => {
  const registry = createResearchEdgeDecisionRegistry();
  const seen: BloomEdgeAssessment[] = [];
  const unregister = registry.register(async (value) => {
    seen.push(value);
    return { action: 'deepen', reason: 'compare the missing real-rate series', evidence: ['source-1'], confidence: 0.7, counterEvidenceRefs: ['counter-1'], outsideViewRefs: ['class-1'] };
  });

  await expect(registry.decide(assessment)).resolves.toMatchObject({
    action: 'deepen',
    reason: 'compare the missing real-rate series',
    evidence: ['source-1'],
    provider: 'registered',
    votes: [{ provider: 'registered', action: 'deepen', counterEvidenceRefs: ['counter-1'], outsideViewRefs: ['class-1'] }],
    counterEvidenceRefs: ['counter-1'],
    outsideViewRefs: ['class-1'],
    recommendation: { action: 'deepen', provider: 'registered', confidence: 0.7 },
    agreesWithLive: true,
    mode: 'record-only',
  });
  expect(seen).toEqual([assessment]);
  unregister();
  await expect(registry.decide(assessment)).resolves.toMatchObject({ action: 'stop' });
});

test('registered providers compose evidence and keep a unanimous action without voting', async () => {
  const registry = createResearchEdgeDecisionRegistry();
  registry.register(() => ({ action: 'deepen', reason: 'find a real-rate series', evidence: ['rates:source-a'] }), 'red-team');
  registry.register(() => ({ action: 'deepen', reason: 'compare the reference class', evidence: ['rates:source-b'] }), 'outside-view');

  await expect(registry.decide(assessment)).resolves.toMatchObject({
    action: 'deepen', reason: 'composed red-team, outside-view: find a real-rate series; evidence=rates:source-a | rates:source-b',
    evidence: ['rates:source-a', 'rates:source-b'], provider: 'composition[red-team, outside-view]',
    mode: 'record-only',
    votes: [{ provider: 'red-team' }, { provider: 'outside-view' }],
  });
});

test('record-only T3 recommendation records counterevidence without changing the live main decision', async () => {
  const registry = createResearchEdgeDecisionRegistry();
  registry.register(() => ({ action: 'prune', reason: 'main live decision', evidence: ['live'], evidenceStrength: 0.9 }), 'main-live');
  registry.register(() => ({ action: 'deepen', reason: 'T3 counterevidence recommendation', evidence: ['counter'], confidence: 0.95, counterEvidenceRefs: ['cpi'], outsideViewRefs: ['base-rate'] }), 't3');

  const result = await registry.decide(assessment);
  expect(result).toMatchObject({
    action: 'prune', provider: 'main-live',
    recommendation: { action: 'deepen', provider: 't3', confidence: 0.95 },
    agreesWithLive: false, mode: 'record-only',
    counterEvidenceRefs: ['cpi'], outsideViewRefs: ['base-rate'],
  });
});

test('invalid optional record metadata cannot invalidate the live provider decision', async () => {
  const registry = createResearchEdgeDecisionRegistry();
  registry.register(() => ({
    action: 'prune', reason: 'valid live action', evidence: ['live'], confidence: 4,
    counterEvidenceRefs: ['cpi', 3] as unknown as string[],
  }), 'live');
  const result = await registry.decide(assessment);
  expect(result).toMatchObject({ action: 'prune', reason: 'valid live action', provider: 'live', mode: 'record-only' });
  expect(result.recommendation).toBeUndefined();
  expect(result.counterEvidenceRefs).toEqual(['cpi']);
});

test('conflicting providers choose strongest declared evidence, then priority, never majority', async () => {
  const registry = createResearchEdgeDecisionRegistry();
  registry.register(() => ({ action: 'stop', reason: 'three weak signals agree', evidence: ['weak-a', 'weak-b', 'weak-c'], evidenceStrength: 0.3 }), 'weak-majority', { priority: 99 });
  registry.register(() => ({ action: 'prune', reason: 'primary source disproves claim', evidence: ['primary-source'], evidenceStrength: 0.9 }), 'strong-counter', { priority: 0 });

  await expect(registry.decide(assessment)).resolves.toMatchObject({
    action: 'prune', provider: 'strong-counter', evidence: ['weak-a', 'weak-b', 'weak-c', 'primary-source'],
    reason: expect.stringContaining('conflict resolved by strong-counter (strength=0.9, priority=0); primary source disproves claim'),
  });
});

test('conflict ties fail closed and invalid evidence strength is rejected', async () => {
  const registry = createResearchEdgeDecisionRegistry();
  registry.register(() => ({ action: 'deepen', reason: 'A', evidence: ['a'], evidenceStrength: 0.7 }), 'a');
  registry.register(() => ({ action: 'prune', reason: 'B', evidence: ['b'], evidenceStrength: 0.7 }), 'b');
  await expect(registry.decide(assessment)).resolves.toMatchObject({ action: 'stop', provider: 'composition', reason: 'unresolved edge decision conflict: a, b (priority unspecified)' });

  const invalid = createResearchEdgeDecisionRegistry();
  invalid.register(() => ({ action: 'deepen', reason: 'bad strength', evidence: [], evidenceStrength: 1.1 }), 'invalid');
  await expect(invalid.decide(assessment)).resolves.toMatchObject({ action: 'stop', reason: 'all edge decision providers failed: invalid returned an invalid decision' });
});

test('provider priority breaks equal-strength conflicts deterministically', async () => {
  const registry = createResearchEdgeDecisionRegistry();
  registry.register(() => ({ action: 'deepen', reason: 'lower priority', evidence: ['a'], evidenceStrength: 0.6 }), 'low', { priority: 1 });
  registry.register(() => ({ action: 'stop', reason: 'higher priority', evidence: ['b'], evidenceStrength: 0.6 }), 'high', { priority: 2 });
  await expect(registry.decide(assessment)).resolves.toMatchObject({ action: 'stop', provider: 'high', reason: expect.stringContaining('conflict resolved by high (strength=0.6, priority=2); higher priority') });
});

test('preserves unspecified priority and fails closed on tied conflicts without explicit priorities', async () => {
  const registry = createResearchEdgeDecisionRegistry();
  registry.register(() => ({ action: 'prune', reason: 'strong counterevidence', evidence: ['source'], evidenceStrength: 0.9 }), 'strong');
  registry.register(() => ({ action: 'deepen', reason: 'weaker evidence', evidence: ['context'], evidenceStrength: 0.4 }), 'weak');
  await expect(registry.decide(assessment)).resolves.toMatchObject({
    action: 'prune', reason: expect.stringContaining('priority=unspecified'),
  });

  const tied = createResearchEdgeDecisionRegistry();
  tied.register(() => ({ action: 'prune', reason: 'A', evidence: ['a'], evidenceStrength: 0.7 }), 'a');
  tied.register(() => ({ action: 'deepen', reason: 'B', evidence: ['b'], evidenceStrength: 0.7 }), 'b');
  await expect(tied.decide(assessment)).resolves.toMatchObject({
    action: 'stop', reason: 'unresolved edge decision conflict: a, b (priority unspecified)',
  });
});

test('rejects non-finite provider priority instead of coercing it to zero', () => {
  const registry = createResearchEdgeDecisionRegistry();
  expect(() => registry.register(() => ({ action: 'stop', reason: 'unused', evidence: [] }), 'invalid', { priority: Number.NaN }))
    .toThrow('research edge provider priority must be finite when supplied');
});
