import { expect, test } from 'bun:test';
import { createResearchEdgeDecisionRegistry, type BloomEdgeAssessment } from './edge-decision.js';

const assessment: BloomEdgeAssessment = {
  gaps: ['missing real-rate series'],
  contradictions: ['headline data conflicts with survey'],
  verdicts: ['evidence is mixed'],
};

test('the default provider stops without changing the graph', async () => {
  const registry = createResearchEdgeDecisionRegistry();
  await expect(registry.decide(assessment)).resolves.toEqual({
    action: 'stop',
    reason: 'no edge decision provider registered',
    evidence: [],
    provider: 'default-noop',
  });
});

test('a registered provider receives Bloom assessment and returns its decision with evidence', async () => {
  const registry = createResearchEdgeDecisionRegistry();
  const seen: BloomEdgeAssessment[] = [];
  const unregister = registry.register(async (value) => {
    seen.push(value);
    return { action: 'deepen', reason: 'compare the missing real-rate series', evidence: ['source-1'] };
  });

  await expect(registry.decide(assessment)).resolves.toEqual({
    action: 'deepen',
    reason: 'compare the missing real-rate series',
    evidence: ['source-1'],
    provider: 'registered',
  });
  expect(seen).toEqual([assessment]);
  unregister();
  await expect(registry.decide(assessment)).resolves.toMatchObject({ action: 'stop' });
});
