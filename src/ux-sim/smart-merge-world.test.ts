import { expect, test } from 'bun:test';
import { ROLE_TAG_READINESS_SCENARIOS, SMART_MERGE_SCENARIOS, TRAIN_GUARDIAN_SCENARIOS, planSimulationSignal, runSmartMergeWorld, type SmartMergeScenario } from './smart-merge-world.js';
import { simulateChainLand } from './chain-land.js';
import { simulateFakeLandQueue } from './fake-land-queue.js';
import { simulatePrLandDriftGate } from './pr-land-drift-gate-device.js';

test('smart merge incidents reuse production drift, chain-land, and queue simulation devices', async () => {
  const hotspot = SMART_MERGE_SCENARIOS[0]!;
  if (hotspot.signal.type !== 'hotspot-main-drift') throw new Error('hotspot fixture has wrong signal');
  const seedChain = await simulateChainLand({ prNumbers: [hotspot.signal.pr], gateOutcomes: ['pass'] });
  const retestedHead = seedChain.head;
  const integratedScenarios = SMART_MERGE_SCENARIOS.map((scenario) => {
    if (scenario.id !== hotspot.id || scenario.signal.type !== 'hotspot-main-drift') return scenario;
    return {
      ...scenario,
      signal: { ...scenario.signal, integratedHead: retestedHead },
      followupSignals: scenario.followupSignals?.map((signal) => {
        if (signal.type === 'hotspot-retest-result') return { ...signal, head: retestedHead,
          receiptId: `receipt:${signal.pr}:${signal.retestId}:${retestedHead}` };
        if (signal.type === 'hotspot-retest-complete') return { ...signal, integratedHead: retestedHead, verifiedHead: retestedHead };
        return signal;
      }),
    };
  });
  const worlds = await runSmartMergeWorld(integratedScenarios);
  expect(worlds).toHaveLength(10);
  const worldById = new Map(worlds.map((world) => [world.id, world]));
  const queueCandidates: { pr: number; head: string; files: string[] }[] = [];
  const sharedQueue = new Map<number, string>();
  for (const [index, scenario] of integratedScenarios.entries()) {
    const world = worldById.get(scenario.id)!;
    expect(world.world).toMatchObject({ revisionBefore: index, completedBefore: SMART_MERGE_SCENARIOS.slice(0, index).map(({ id }) => id),
      queueBefore: [...sharedQueue].map(([pr, head]) => ({ pr, head })) });
    expect(world).toMatchObject({ observed: scenario.expectedActions, missing: [], unexpected: [], finalState: { resolved: true },
      humanInterventions: 0, zeroInterventionAssertion: true });
    switch (scenario.signal.type) {
      case 'hotspot-main-drift':
        expect(world.finalState).toMatchObject({ mergedMainHead: scenario.signal.mainHead, transplantedHead: scenario.signal.integratedHead,
          retestedHead: scenario.signal.integratedHead, retestId: scenario.signal.retestId, verdictInherited: true, requeued: true });
        expect(world.finalState.queueCandidates).toEqual([{ pr: scenario.signal.pr, head: scenario.signal.integratedHead, files: scenario.signal.conflictDelta }]);
        break;
      case 'merge-only-head':
        expect(world.finalState.waiverHead).toBe(scenario.signal.newHead);
        expect(world.finalState.queueCandidates).toEqual([{ pr: scenario.signal.pr, head: scenario.signal.newHead, files: [] }]);
        break;
      case 'review-repeat':
        expect(world.finalState.retainedFindings).toEqual(['R1:slot race']);
        expect(world.finalState.routedFindings).toEqual(['R2:missing guard']);
        expect(world.finalState.queueCandidates).toEqual([]);
        break;
      case 'reported-sha':
        expect(world.finalState.correctedSha).toBe(scenario.signal.actualHead);
        expect(world.finalState.queueCandidates).toEqual([{ pr: scenario.signal.pr, head: scenario.signal.actualHead, files: [] }]);
        break;
      case 'stacked-base':
        expect(world.finalState.base).toBe(scenario.signal.main);
        expect(world.finalState.queueCandidates).toEqual([{ pr: scenario.signal.pr, head: scenario.signal.pr.toString(16).padStart(40, '0'), files: [] }]);
        break;
      case 'duplicate-cell-pr':
        expect(world.finalState).toMatchObject({ keptPr: scenario.signal.prs[0], closedPrs: scenario.signal.prs.slice(1) });
        expect(world.finalState.queueCandidates).toEqual([{ pr: scenario.signal.prs[0], head: scenario.signal.prs[0]!.toString(16).padStart(40, '0'), files: [] }]);
        break;
      case 'post-land-conflict': {
        const signal = scenario.signal;
        const overlap = signal.queuedFiles.filter((file) => signal.landedFiles.includes(file));
        expect(world.finalState).toMatchObject({ landedFiles: signal.landedFiles, predictedConflicts: overlap, notifiedOwner: signal.owner });
        expect(world.finalState.queueCandidates).toEqual([{ pr: signal.queuedPr, head: signal.queuedPr.toString(16).padStart(40, '0'), files: signal.queuedFiles }]);
        break;
      }
      case 'generated-file-overlap': {
        const signal = scenario.signal;
        expect(world.finalState.writerCollision).toBe(false);
        expect(Object.values(world.finalState.writerOwners)).toEqual(signal.prs.map((pr) => [pr]));
        expect(world.finalState.queueCandidates).toEqual(signal.prs.map((pr) => ({ pr, head: pr.toString(16).padStart(40, '0'), files: [`${signal.path}.writer-${pr}`] })));
        break;
      }
      case 'assignment-collision':
        expect(world.finalState).toMatchObject({ assignment: 'refused', activeAssignmentRefused: true });
        expect(world.finalState.queueCandidates).toEqual([]);
        break;
      case 'idle-seat':
        expect(world.finalState.idleSeatAssigned).toBe(true);
        expect(world.finalState.queueCandidates).toEqual([]);
        break;
    }
    if (scenario.signal.type === 'duplicate-cell-pr') for (const pr of world.finalState.closedPrs) sharedQueue.delete(pr);
    for (const candidate of world.finalState.queueCandidates) sharedQueue.set(candidate.pr, candidate.head);
    expect(world.world).toMatchObject({ revisionAfter: index + 1,
      completedAfter: SMART_MERGE_SCENARIOS.slice(0, index + 1).map(({ id }) => id),
      queueAfter: [...sharedQueue].map(([pr, head]) => ({ pr, head })) });
    queueCandidates.push(...world.finalState.queueCandidates);
  }

  const hotspotSignal = hotspot.signal;
  const hotspotWorld = worldById.get(hotspot.id)!;
  const drift = simulatePrLandDriftGate({
    main: hotspotWorld.finalState.mergedMainHead!,
    output: hotspotWorld.finalState.typecheckOutput!,
    refusal: `✗ heavy-remote: 원격 게이트 gate-rc-1 · remote: ${hotspotWorld.finalState.typecheckOutput!.split('\n').at(-1)}`,
  });
  expect(drift).toEqual({ typecheckDrift: 'drift', refusal: 'typecheck-drift' });

  const driftCandidate = queueCandidates.find(({ pr }) => pr === hotspotSignal.pr);
  if (drift.typecheckDrift !== 'drift' || drift.refusal !== 'typecheck-drift' || !driftCandidate || !hotspotWorld.finalState.requeued)
    throw new Error('world repair did not carry a measured drift finding into the landing queue');
  const verifiedPr = driftCandidate.pr;
  expect(hotspotWorld.observed.indexOf('pr.requeue-front')).toBeGreaterThan(hotspotWorld.observed.indexOf('verdict.inherit'));
  const waitingPr = 36199;
  const queueInput = [
    { number: waitingPr, head: '9'.repeat(40), files: ['src/waiting/pr.ts'] },
    ...queueCandidates.map(({ pr, head, files }) => ({ number: pr, head, files })),
  ];
  const landedFiles = worlds.flatMap(({ finalState }) => finalState.landedFiles);
  const frontQueue = await simulateFakeLandQueue({
    queue: queueInput,
    load: 80,
    expedite: verifiedPr,
    landedFiles,
  });
  const expectedQueueOrder = [verifiedPr, waitingPr, 36002, 36004, 36005, 36006, 36008, 36009, 36010];
  const expectedPassOrder = [verifiedPr, waitingPr, 36002, 36004, 36005, 36006, 36009, 36010];
  expect(frontQueue.departed).toEqual([[verifiedPr, waitingPr], [36002, 36004], [36005, 36006], [36008, 36009], [36010]]);
  const postLandConflict = SMART_MERGE_SCENARIOS.find(({ id }) => id === '07-predict-queued-pr-conflict-after-land')!;
  if (postLandConflict.signal.type !== 'post-land-conflict') throw new Error('post-land fixture has wrong signal');
  const postLandSignal = postLandConflict.signal;
  const postLandWorld = worldById.get(postLandConflict.id)!;
  expect({ conflictReceipt: frontQueue.conflicts, ownerNotice: postLandWorld.finalState.notifiedOwner }).toEqual({
    conflictReceipt: [{ number: postLandSignal.queuedPr, files: postLandWorld.finalState.predictedConflicts }],
    ownerNotice: postLandSignal.owner,
  });
  const hotspotQueueReceipt = frontQueue.receipts.find(({ number }) => number === verifiedPr);
  const worldRetestedHead = hotspotWorld.finalState.retestedHead;
  if (!worldRetestedHead) throw new Error('world did not retain the verified retest head');
  expect(hotspotQueueReceipt?.number).toBe(verifiedPr);
  expect(hotspotQueueReceipt?.head).toBe(worldRetestedHead);
  expect(hotspotQueueReceipt?.verdict).toBe('pass');
  const expectedReceipts: Array<(typeof frontQueue.receipts)[number]> = [
    { number: verifiedPr, head: retestedHead, verdict: 'pass' },
    { number: waitingPr, head: '9'.repeat(40), verdict: 'pass' },
    { number: 36002, head: 'd'.repeat(40), verdict: 'pass' },
    { number: 36004, head: '0'.repeat(40), verdict: 'pass' },
    { number: 36005, head: (36005).toString(16).padStart(40, '0'), verdict: 'pass' },
    { number: 36006, head: (36006).toString(16).padStart(40, '0'), verdict: 'pass' },
    { number: 36008, head: (36008).toString(16).padStart(40, '0'), verdict: 'conflict' },
    { number: 36009, head: (36009).toString(16).padStart(40, '0'), verdict: 'pass' },
    { number: 36010, head: (36010).toString(16).padStart(40, '0'), verdict: 'pass' },
  ];
  expect(frontQueue.receipts).toEqual(expectedReceipts);
  const frontOrder = expectedPassOrder;
  expect(frontQueue.receipts.map(({ number }) => number)).toEqual(expectedQueueOrder);

  const chain = await simulateChainLand({ prNumbers: frontOrder, gateOutcomes: frontOrder.map(() => 'pass'), drainQueue: true,
    expectedHead: worldRetestedHead });
  expect(chain.enqueued).toEqual(frontOrder);
  expect(chain.pending).toEqual([]);
  expect(chain.verdicts.map(({ number, verdict }) => ({ number, verdict }))).toEqual(frontOrder.map((number) => ({ number, verdict: 'pass' })));
  expect(chain.verdicts[0]?.number).toBe(verifiedPr);
  expect(chain.head).toBe(worldRetestedHead);
  expect(chain.headReceipts.find(({ number }) => number === verifiedPr)?.head).toBe(worldRetestedHead);
  const disposition = chain.disposition;
  if (!disposition) throw new Error('chain did not return a production disposition');
  expect(chain.verdicts.some(({ number, verdict }) => number === disposition.number && verdict === disposition.verdict)).toBe(true);
  expect(chain.ghCalls.length).toBeGreaterThan(0);

  expect(frontQueue.verdicts.find(({ number }) => number === postLandSignal.queuedPr)?.verdict).toBe('conflict');
  expect(frontOrder).not.toContain(postLandSignal.queuedPr);
}, { timeout: 90_000 });

test('smart merge world contains the ten operator-resolved incidents', () => {
  expect(SMART_MERGE_SCENARIOS).toHaveLength(10);
});

test('shared smart merge world refuses a PR already queued by an earlier incident', async () => {
  const head = 'f'.repeat(40);
  const repeated = (id: string): SmartMergeScenario => ({ id,
    signal: { type: 'reported-sha', pr: 36999, reportedSha: '0'.repeat(40), actualHead: head },
    expectedActions: ['report.correct-sha'] });
  const [first, second] = await runSmartMergeWorld([repeated('shared-world-first-pr'), repeated('shared-world-repeat-pr')]);
  expect(first?.finalState).toMatchObject({ resolved: true, correctedSha: head, queueCandidates: [{ pr: 36999, head, files: [] }] });
  expect(second?.world).toMatchObject({ revisionBefore: 1, completedBefore: ['shared-world-first-pr'], queueBefore: [{ pr: 36999, head }] });
  expect(second?.finalState).toMatchObject({ resolved: true, correctedSha: head, queueCandidates: [] });
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
