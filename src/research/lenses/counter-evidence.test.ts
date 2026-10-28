import { expect, test } from 'bun:test';
import { judgeCounterEvidence, type CounterEvidenceAssessment } from './counter-evidence.js';

const outsideView = { description: 'Prior 10-year yield rises in tightening cycles', outcomeRate: 0.62, claimOutcomeRate: 0.62, sampleSize: 13, source: 'central-bank-study' };

test('T3 emits one counterevidence cell per axis and stops only with complete sourced outside views', () => {
  const assessment: CounterEvidenceAssessment = { axes: [
    { id: 'policy', conclusion: 'policy path drives yields', supportingEvidence: [{ claim: 'futures price cuts', source: 'futures', grade: 'high' }], counterEvidence: [{ claim: 'sticky services inflation', source: 'CPI series', grade: 'medium' }], referenceClass: outsideView },
    { id: 'term-premium', conclusion: 'issuance lifts term premium', supportingEvidence: [{ claim: 'auction tails widened', source: 'auction data', grade: 'medium' }], counterEvidence: [{ claim: 'foreign demand rose', source: 'custody data', grade: 'low' }], referenceClass: outsideView },
  ] };

  const result = judgeCounterEvidence(assessment);
  expect(result.action).toBe('stop');
  expect(result.cells).toHaveLength(2);
  expect(result.cells.map((cell) => cell.axisId)).toEqual(['policy', 'term-premium']);
  expect(result.evidence).toContain('policy: counterevidence [medium] sticky services inflation (CPI series); outside-view=aligned');
  expect(result.cells[0]?.outsideView).toEqual(outsideView);
  expect(result.counterEvidenceRefs).toEqual(['CPI series', 'custody data']);
  expect(result.outsideViewRefs).toEqual(['central-bank-study']);
});

test('stronger axis-level counterevidence prunes despite other axes supporting the claim', () => {
  const result = judgeCounterEvidence({ axes: [
    { id: 'policy', conclusion: 'policy path', supportingEvidence: [{ claim: 'survey', source: 'survey', grade: 'low' }], counterEvidence: [{ claim: 'no cut priced', source: 'futures', grade: 'high' }], referenceClass: outsideView },
    { id: 'global', conclusion: 'global demand', supportingEvidence: [{ claim: 'flows', source: 'flows', grade: 'high' }], counterEvidence: [{ claim: 'weak PMI', source: 'PMI', grade: 'low' }], referenceClass: outsideView },
  ] });
  expect(result.action).toBe('prune');
  expect(result.cells.map((cell) => cell.finding)).toEqual(['counterevidence-dominates', 'support-dominates']);
});

test('missing counterevidence or base-rate provenance deepens instead of guessing', () => {
  const result = judgeCounterEvidence({ axes: [
    { id: 'energy', conclusion: 'energy shock', supportingEvidence: [{ claim: 'oil rose', source: 'market data', grade: 'high' }], counterEvidence: [], referenceClass: outsideView },
    { id: 'global', conclusion: 'growth', supportingEvidence: [{ claim: 'PMI', source: 'survey', grade: 'medium' }], counterEvidence: [{ claim: 'exports slowed', source: 'customs', grade: 'low' }] },
  ] });
  expect(result.action).toBe('deepen');
  expect(result.cells.every((cell) => cell.finding === 'incomplete')).toBe(true);
  expect(result.evidence).toEqual(['energy: counterevidence missing', 'global: counterevidence [low] exports slowed (customs); outside-view=missing']);
});

test('a claim that departs from its reference class needs sourced adjustment evidence', () => {
  const result = judgeCounterEvidence({ axes: [{
    id: 'policy', conclusion: 'policy path',
    supportingEvidence: [{ claim: 'current futures', source: 'futures', grade: 'high' }],
    counterEvidence: [{ claim: 'inflation persistence', source: 'CPI', grade: 'medium' }],
    referenceClass: { ...outsideView, outcomeRate: 0.62, claimOutcomeRate: 0.8 },
  }] });
  expect(result.action).toBe('deepen');
  expect(result.cells[0]?.outsideViewRelation).toBe('unexplained-divergence');

  const adjusted = judgeCounterEvidence({ axes: [{
    id: 'policy', conclusion: 'policy path',
    supportingEvidence: [{ claim: 'current futures', source: 'futures', grade: 'high' }],
    counterEvidence: [{ claim: 'inflation persistence', source: 'CPI', grade: 'medium' }],
    referenceClass: { ...outsideView, outcomeRate: 0.62, claimOutcomeRate: 0.8, adjustmentEvidence: 'newly announced policy regime (central-bank minutes)' },
  }] });
  expect(adjusted.cells[0]?.outsideViewRelation).toBe('adjusted');
});

test('empty assessment deepens without inventing evidence', () => {
  expect(judgeCounterEvidence({ axes: [] })).toMatchObject({ action: 'deepen', evidence: [], cells: [] });
});
