import { afterAll, expect, mock, test } from 'bun:test';
import { createResearchEdgeDecisionRegistry, type BloomEdgeAssessment } from './edge-decision.js';
import { judgeCounterEvidence, type CounterEvidenceAxis } from './lenses/counter-evidence.js';
import type { GraphTemplateSpec } from '../self-implement/graph-yaml.js';
import * as debugLog from '../debug/log.js';

// R-TST23: mock.module()은 process-wide 레지스트리를 바꾸며 mock.restore()로는 되돌릴 수 없다.
// 원본을 펼친 스냅샷으로 잡아 두고 파일 스코프 afterAll에서 재등록해 복구한다.
const originalDebugLog = { ...debugLog };
afterAll(() => {
  mock.module('../debug/log.js', () => originalDebugLog);
});

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

test('THINK-LENS-T3-COUNTER-EVIDENCE: 첫 동작같은 런: src/research/edge-decisio', async () => {
  const registry = createResearchEdgeDecisionRegistry();
  registry.register(() => ({
    action: 'stop', reason: 'axis counterevidence dominates', evidence: ['rates:source-a'],
    counterEvidenceRefs: ['CPI series'], outsideViewRefs: ['central-bank-study'],
  }), 'red-team');
  registry.register(() => ({
    action: 'stop', reason: 'compare the reference class', evidence: ['rates:source-b'],
    counterEvidenceRefs: ['custody data'], outsideViewRefs: ['central-bank-study'],
  }), 'outside-view');

  const decision = await registry.decide(assessment);
  expect(decision).toMatchObject({
    action: 'stop',
    provider: 'composition[red-team, outside-view]',
    evidence: ['rates:source-a', 'rates:source-b'],
    counterEvidenceRefs: ['CPI series', 'custody data'],
    outsideViewRefs: ['central-bank-study'],
    mode: 'record-only',
    votes: [{ provider: 'red-team' }, { provider: 'outside-view' }],
  });

  const logCalls: unknown[][] = [];
  mock.module('../debug/log.js', () => ({
    ...debugLog,
    debug: Object.assign(Object.create(Object.getPrototypeOf(debugLog.debug)), debugLog.debug, {
      log: (...args: unknown[]) => { logCalls.push(args); },
    }),
  }));
  const { proposeGrowth } = await import('../graph-runner/graph-grow.js');
  const result = await proposeGrowth({
    graph: { graphId: 'g' } as unknown as GraphTemplateSpec,
    nodeId: 'n', outcome: 'o', runId: 'r', output: assessment,
  }, () => undefined, undefined, undefined, registry);
  expect(result.ok).toBe(false);
  const decisionLog = logCalls.find(([category, event]) => category === 'research.edge' && event === 'decision');
  expect(decisionLog?.[2]).toMatchObject({
    provider: 'composition[red-team, outside-view]',
    decision: 'stop',
    reason: expect.stringContaining('composed red-team, outside-view'),
  });
}, { timeout: 30_000 });

test('THINK-LENS-T3-COUNTER-EVIDENCE: 첫 동작같은 런: src/research/edge-decisio — 채권 금리 4축 벤치 반대근거 5점', () => {
  const refClass = {
    description: 'Prior 10-year yield rises in tightening cycles',
    outcomeRate: 0.62, claimOutcomeRate: 0.62, sampleSize: 13, source: 'central-bank-study',
  };
  const bondRateAxes: CounterEvidenceAxis[] = [
    { id: 'policy', conclusion: 'policy path drives yields',
      supportingEvidence: [{ claim: 'futures price cuts', source: 'futures', grade: 'high' }],
      counterEvidence: [{ claim: 'sticky services inflation', source: 'CPI series', grade: 'medium' }],
      referenceClass: refClass },
    { id: 'term-premium', conclusion: 'issuance lifts term premium',
      supportingEvidence: [{ claim: 'auction tails widened', source: 'auction data', grade: 'medium' }],
      counterEvidence: [{ claim: 'foreign demand rose', source: 'custody data', grade: 'low' }],
      referenceClass: refClass },
    { id: '10-year-yield', conclusion: 'growth momentum lifts the 10-year yield',
      supportingEvidence: [{ claim: 'PMI above 50', source: 'PMI survey', grade: 'medium' }],
      counterEvidence: [{ claim: 'no cuts priced', source: 'futures', grade: 'high' }],
      referenceClass: refClass },
    { id: 'futures-cpi', conclusion: 'disinflation continues',
      supportingEvidence: [{ claim: 'core CPI cooling', source: 'CPI report', grade: 'medium' }],
      counterEvidence: [
        { claim: 'housing inflation sticky', source: 'shelter index', grade: 'low' },
        { claim: 'wage growth reaccelerated', source: 'payroll report', grade: 'low' },
      ],
      referenceClass: refClass },
  ];

  const result = judgeCounterEvidence({ axes: bondRateAxes });
  expect(result.action).toBe('prune');
  expect(result.cells.map((cell) => cell.axisId)).toEqual(['policy', 'term-premium', '10-year-yield', 'futures-cpi']);
  expect(result.cells.map((cell) => [cell.supportGrade, cell.counterGrade, cell.finding])).toEqual([
    ['high', 'medium', 'support-dominates'],
    ['medium', 'low', 'support-dominates'],
    ['medium', 'high', 'counterevidence-dominates'],
    ['medium', 'low', 'support-dominates'],
  ]);
  expect(result.counterEvidenceRefs).toEqual(['CPI series', 'custody data', 'futures', 'shelter index']);
  expect(result.outsideViewRefs).toEqual(['central-bank-study']);
  expect(result.evidence).toContain('10-year-yield: counterevidence [high] no cuts priced (futures); outside-view=aligned');
  expect(bondRateAxes.reduce((count, axis) => count + axis.counterEvidence.length, 0)).toBe(5);
});
