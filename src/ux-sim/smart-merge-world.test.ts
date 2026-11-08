import { expect, test } from 'bun:test';
import { ROLE_TAG_READINESS_SCENARIOS, SMART_MERGE_SCENARIOS, TRAIN_GUARDIAN_SCENARIOS, planSimulationSignal, runSmartMergeWorld, type SmartMergeScenario } from './smart-merge-world.js';

test('smart merge world contains the ten operator-resolved incidents', () => {
  expect(SMART_MERGE_SCENARIOS).toHaveLength(10);
});

for (const scenario of SMART_MERGE_SCENARIOS) {
  test(`smart merge has zero human intervention: ${scenario.id}`, async () => {
    const [result] = await runSmartMergeWorld([scenario]);
    expect(result).toMatchObject({
      id: scenario.id,
      observed: scenario.expectedActions,
      missing: [],
      unexpected: [],
      humanInterventions: 0,
      zeroInterventionAssertion: true,
    });
  });
}

for (const scenario of TRAIN_GUARDIAN_SCENARIOS) {
  test(`train guardian lifecycle has zero human intervention: ${scenario.id}`, async () => {
    const [result] = await runSmartMergeWorld([scenario]);
    expect(result).toMatchObject({
      id: scenario.id,
      observed: scenario.expectedActions,
      missing: [],
      unexpected: [],
      humanInterventions: 0,
      zeroInterventionAssertion: true,
    });
  });
}

test('role-tag readiness world covers all twelve automatic assignment edges', () => {
  expect(ROLE_TAG_READINESS_SCENARIOS).toHaveLength(12);
});

for (const scenario of ROLE_TAG_READINESS_SCENARIOS) {
  test(`role-tag readiness resolves without human intervention: ${scenario.id}`, async () => {
    const [result] = await runSmartMergeWorld([scenario]);
    expect(result).toMatchObject({ id: scenario.id, observed: scenario.expectedActions, missing: [], unexpected: [], humanInterventions: 0,
      zeroInterventionAssertion: true });
  });
}

test('the release cut-to-verify lap reserves gate hosts then restores slots and scales down', async () => {
  const scenario = TRAIN_GUARDIAN_SCENARIOS.find((item) => item.id === 'cut-gate-publish-verify-reserve-and-return')!;
  const [result] = await runSmartMergeWorld([scenario]);
  expect(result.observed).toEqual([
    'release.stage-observed', 'guardian.reserve-gate-hosts', 'train.reclaim-gate-slots',
    'release.stage-observed', 'release.stage-observed', 'release.stage-observed',
    'train.restore-slots', 'vm.scale-down', 'guardian.release-gate-hosts',
  ]);
  expect(result.humanInterventions).toBe(0);
});

test('main-drift repair remains unresolved until the integrated head retest completes', async () => {
  const scenario: SmartMergeScenario = { id: 'main-drift-retest-pending', signal: { type: 'hotspot-main-drift', pr: 36099,
    currentHead: 'a'.repeat(40), mainHead: 'b'.repeat(40), integratedHead: 'c'.repeat(40), retestId: 'retest-36099-c',
    conflictDelta: ['src/release-loop/gate-node.ts'], priorVerdict: 'WARN:mustFix0' },
  expectedActions: ['main.merge', 'conflict.delta-transplant', 'gate.retest'] };
  const [result] = await runSmartMergeWorld([scenario]);
  expect(result.observed).toEqual(scenario.expectedActions);
  expect(result.observed).not.toContain('verdict.inherit');
  expect(result.observed).not.toContain('pr.requeue-front');
  expect(result.finalState.resolved).toBe(false);
  expect(result.finalState.retestId).toBe('retest-36099-c');
  expect(result.finalState.verdictInherited).toBe(false);
  expect(result.finalState.requeued).toBe(false);
  expect(result.humanInterventions).toBe(0);
  expect(result.zeroInterventionAssertion).toBe(true);
});

test('main-drift is resolved only after its prior-run receipt is inherited and requeued', async () => {
  const [result] = await runSmartMergeWorld([SMART_MERGE_SCENARIOS[0]!]);
  expect(result.finalState).toMatchObject({ resolved: true, retestedHead: 'c'.repeat(40), retestId: 'retest-36001-c',
    retestReceiptId: 'receipt:36001:retest-36001-c:' + 'c'.repeat(40), verdictInherited: true, requeued: true });
  expect(result.finalState.retestPriorVerdict).toBe('WARN:mustFix0');
  expect(result.finalState.retestEvidenceRunId).toContain('sim-01-hotspot-main-drift-repair-and-front-requeue-');
  expect(result.humanInterventions).toBe(0);
  expect(result.zeroInterventionAssertion).toBe(true);
});

test('generated-file split creates one independent writer path per PR', async () => {
  const scenario = SMART_MERGE_SCENARIOS.find((item) => item.id === '08-split-generated-file-writer-contention')!;
  const [result] = await runSmartMergeWorld([scenario]);
  const owners = Object.values(result.finalState.writerOwners);
  expect(result.finalState.writerCollision).toBe(false);
  expect(owners).toEqual([[36009], [36010]]);
  expect(result.finalState.resolved).toBe(true);
  expect(result.humanInterventions).toBe(0);
});

test('hotspot retest refuses to inherit or requeue when the validated head differs', async () => {
  const scenario: SmartMergeScenario = { id: 'main-drift-retest-wrong-head', signal: { type: 'hotspot-retest-complete', pr: 36100, retestId: 'retest-36100-c',
    integratedHead: 'c'.repeat(40), verifiedHead: 'd'.repeat(40), result: 'passed', priorVerdict: 'WARN:mustFix0' },
  expectedActions: ['gate.retest-rejected'] };
  const [result] = await runSmartMergeWorld([scenario]);
  expect(result.observed).toEqual(scenario.expectedActions);
  expect(result.observed).not.toContain('verdict.inherit');
  expect(result.observed).not.toContain('pr.requeue-front');
  expect(result.humanInterventions).toBe(0);
});

test('hotspot main-drift refuses to retest until the integrated head and evidence ID are pinned', () => {
  expect(planSimulationSignal({ type: 'hotspot-main-drift', pr: 36101, currentHead: 'a'.repeat(40), mainHead: 'b'.repeat(40),
    integratedHead: '', retestId: '', conflictDelta: ['src/release-loop/gate-node.ts'], priorVerdict: 'WARN:mustFix0' })).toEqual([]);
});

test('a passing retest signal without its matching recorded result receipt is rejected before inheritance', async () => {
  const scenario: SmartMergeScenario = { id: 'orphan-passing-retest', signal: { type: 'hotspot-retest-complete', pr: 36102,
    retestId: 'retest-36102-c', integratedHead: 'c'.repeat(40), verifiedHead: 'c'.repeat(40), result: 'passed', priorVerdict: 'WARN:mustFix0' },
  expectedActions: ['gate.retest-rejected'] };
  const [result] = await runSmartMergeWorld([scenario]);
  expect(result.observed).toEqual(['gate.retest-rejected']);
  expect(result.finalState.resolved).toBe(true);
  expect(result.humanInterventions).toBe(0);
  expect(result.zeroInterventionAssertion).toBe(true);
});

test('a passing completion after a repair request is rejected when no retest result receipt was recorded', async () => {
  const source = SMART_MERGE_SCENARIOS[0]!;
  const request = source.signal;
  if (request.type !== 'hotspot-main-drift') throw new Error('main drift fixture has wrong signal');
  const scenario: SmartMergeScenario = { ...source, id: 'main-drift-complete-without-result-receipt',
    followupSignals: [{ type: 'hotspot-retest-complete', pr: request.pr, retestId: request.retestId,
      integratedHead: request.integratedHead, verifiedHead: request.integratedHead, result: 'passed', priorVerdict: request.priorVerdict }],
    expectedActions: ['main.merge', 'conflict.delta-transplant', 'gate.retest', 'gate.retest-rejected'] };
  const [result] = await runSmartMergeWorld([scenario]);
  expect(result.observed).toEqual(scenario.expectedActions);
  expect(result.observed).not.toContain('verdict.inherit');
  expect(result.observed).not.toContain('pr.requeue-front');
  expect(result.finalState).toMatchObject({ resolved: true, retestedHead: request.integratedHead,
    retestReceiptId: null, verdictInherited: false, requeued: false });
  expect(result.humanInterventions).toBe(0);
  expect(result.zeroInterventionAssertion).toBe(true);
});

test('a retest cannot inherit a verdict different from the one bound to the repair request', async () => {
  const source = SMART_MERGE_SCENARIOS[0]!;
  const signal = source.signal;
  if (signal.type !== 'hotspot-main-drift') throw new Error('main drift fixture has wrong signal');
  const scenario: SmartMergeScenario = { ...source, id: 'main-drift-followup-verdict-mismatch',
    followupSignals: [
      { type: 'hotspot-retest-result', pr: signal.pr, retestId: signal.retestId, head: signal.integratedHead,
        result: 'passed', receiptId: 'receipt:verdict-mismatch' },
      { type: 'hotspot-retest-complete', pr: signal.pr, retestId: signal.retestId, integratedHead: signal.integratedHead,
        verifiedHead: signal.integratedHead, result: 'passed', priorVerdict: 'PASS:mustFix0' },
    ],
    expectedActions: ['main.merge', 'conflict.delta-transplant', 'gate.retest', 'gate.retest-rejected'] };
  const [result] = await runSmartMergeWorld([scenario]);
  expect(result.observed).toEqual(scenario.expectedActions);
  expect(result.finalState).toMatchObject({ resolved: true, verdictInherited: false, requeued: false });
  expect(result.humanInterventions).toBe(0);
  expect(result.zeroInterventionAssertion).toBe(true);
});

test('an observed human intervention increments the counter and fails the zero-intervention assertion', async () => {
  const [result] = await runSmartMergeWorld([{ id: 'injected-human-intervention',
    signal: { type: 'human-intervention-observed', incident: 'operator repaired missing lease evidence' }, expectedActions: [] }]);
  expect(result.humanInterventions).toBe(1);
  expect(result.zeroInterventionAssertion).toBe(false);
});

test('readiness includes asynchronous registry completion plus recipe lead time', async () => {
  const source = ROLE_TAG_READINESS_SCENARIOS.find((scenario) => scenario.id === 'readiness-registry-lag')!;
  if (source.signal.type !== 'role-tag-readiness') throw new Error('registry-lag scenario has wrong signal');
  const signal = { ...source.signal, hosts: source.signal.hosts.map((host) => host.host === 'primary' ? { ...host,
    registryReadyAtMs: 9_000, leadMsByRole: { ...host.leadMsByRole, 'gate-warm': 2_000 } } : host) };
  const [result] = await runSmartMergeWorld([{ ...source, signal }]);
  expect(result.finalState).toMatchObject({ assignment: 'assigned', selectedHost: 'fallback' });
  expect(result.humanInterventions).toBe(0);
});
