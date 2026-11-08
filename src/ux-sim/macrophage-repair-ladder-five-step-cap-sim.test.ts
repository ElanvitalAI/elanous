import { expect, test } from 'bun:test';
import { runMacrophageRepairLadderFiveStepCapSim } from './release-sim-rig.js';
import { planAdaptiveGateHeal } from '../../scripts/release-loop/adaptive-gate-heal.js';
import { chooseGatePrescription } from '../../scripts/release-loop/gate-triage-node.js';
import { planMacrophageRepairLadder, type MacrophageRepairLadderInput } from '../release-loop/macrophage-repair-ladder.js';

test('macrophage-repair-ladder-five-step-cap-sim exercises R0-R4 and every safety boundary', () => {
  const result = runMacrophageRepairLadderFiveStepCapSim();
  expect(result.injector).toBe('macrophage-repair-ladder-five-step-cap-sim');
  expect(result.pass).toBe(true);
  expect(result.decisions).toHaveLength(16);
  expect(result.decisions.every((item) => item.pass)).toBe(true);
  expect(result.checks).toEqual({
    allFiveSteps: true,
    repairPlansTargetCutAppendOnly: true,
    r2ParallelismBounded: true,
    exactFourChildrenAllowed: true,
    r3IsDraftOnly: true,
    r4ProducesDecisionCard: true,
    childLimitAndNoPartialSplit: true,
    ninetyMinuteBudget: true,
    cutoffBoundary: true,
    unknownCountdownFailsClosed: true,
    r3ProposalOnePerRun: true,
  });
  expect(result.inputMutationCount).toBe(0);
});

test('macrophage ladder controls prescriptions and fails closed before unconstrained repair execution', () => {
  const failureIds = ['src/a.test.ts > introduced failure'];
  const gate = { outcome: 'regression', commit: 'a'.repeat(40), introduced: failureIds,
    preexisting: 0, fixed: null, knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 1 };
  const triageShadow = { classification: 'regression', reason: 'measured regression', commit: gate.commit,
    introduced: failureIds, stalledFiles: [], failureIds, outcome: 'ok' } as never;
  const plan = (ladder: MacrophageRepairLadderInput) => planAdaptiveGateHeal({ version: '0.3.7', runId: 'sim-ladder-adapter',
    gate: gate as never, triage: triageShadow, visitState: { gate: 1, gateTriage: 1 }, macrophageRepairLadder: ladder });
  const base: Omit<MacrophageRepairLadderInput, 'evidence' | 'failureIds'> = { runId: 'sim-ladder-adapter',
    signature: 'introduced-failure', repairChildrenUsed: 0, elapsedMs: 0, minutesToCut: 180, estimatedStepMs: 60_000 };
  const r1 = plan({ ...base, evidence: 'introduced', failureIds, sourceFiles: ['src/a.ts'], changeKind: 'fixture' });
  expect(r1.macrophageRepairLadder?.step).toBe('R1-single-file');
  expect(r1.disposition.action).toBe('decision-required');
  const r2 = plan({ ...base, evidence: 'introduced', failureIds, sourceFiles: ['src/a.ts', 'src/b.ts'], independentFiles: true });
  expect(r2.macrophageRepairLadder?.step).toBe('R2-split-files');
  expect(r2.disposition.action).toBe('decision-required');
  expect(r2.events.at(-1)?.data.reason).toContain('cut-append constrained repair executor');

  const activeContext = (macrophageRepairLadder: MacrophageRepairLadderInput) => ({ runId: 'sim-ladder-adapter',
    input: { macrophageRepairLadder }, outputs: { gate } }) as never;
  const mismatched = chooseGatePrescription(activeContext({ ...base, runId: 'other-run', evidence: 'introduced',
    failureIds, sourceFiles: ['src/a.ts'], changeKind: 'fixture' }), triageShadow);
  expect(mismatched.action).toBe('decision-card');
  expect(mismatched.reason).toContain('run id does not match');
  const r4 = chooseGatePrescription(activeContext({ ...base, evidence: 'unmeasured', failureIds }), triageShadow);
  expect(r4.action).toBe('decision-card');
  expect(r4.reason).toContain('contradicts the observed gate or triage');
  const r1Prescription = chooseGatePrescription(activeContext({ ...base, evidence: 'introduced', failureIds,
    sourceFiles: ['src/a.ts'], changeKind: 'fixture' }), triageShadow);
  expect(r1Prescription.action).toBe('decision-card');
  expect(r1Prescription.reason).toContain('cut-append constrained executor');

  const contradictory = { ...base, evidence: 'preexisting' as const, failureIds };
  expect(chooseGatePrescription(activeContext(contradictory), triageShadow)).toMatchObject({
    action: 'decision-card', reason: expect.stringContaining('contradicts the observed gate or triage'),
  });
  expect(plan(contradictory).disposition).toMatchObject({
    action: 'decision-required', reason: expect.stringContaining('failed run, failure-ID, or observed-gate verification'),
  });
  expect(plan(contradictory).macrophageRepairLadder).toBeUndefined();
  expect(plan(contradictory).events.some((event) => event.name === 'heal.macrophage-ladder.decided')).toBe(false);

  const loadGate = { ...gate, outcome: 'error', introduced: [], loadFlaky: failureIds };
  const loadTriage = { classification: 'load', reason: 'isolated remeasurement needed', commit: gate.commit,
    introduced: [], stalledFiles: failureIds, failureIds, outcome: 'ok' } as never;
  const loadInput = { ...base, evidence: 'load-flaky' as const, failureIds, r0Attempts: 0 };
  const r0 = planMacrophageRepairLadder(loadInput);
  expect(r0.step).toBe('R0-remeasure');
  expect(chooseGatePrescription({ runId: 'sim-ladder-adapter', input: { macrophageRepairLadder: loadInput },
    outputs: { gate: loadGate } } as never, loadTriage)).toMatchObject({
    action: 'decision-card', reason: 'same-slice isolated remeasurement executor is not connected',
  });
  const r0Adaptive = planAdaptiveGateHeal({ version: '0.3.7', runId: 'sim-ladder-adapter', gate: loadGate as never,
    triage: loadTriage, visitState: { gate: 1, gateTriage: 1 }, macrophageRepairLadder: loadInput });
  expect(r0Adaptive.disposition).toMatchObject({ action: 'decision-required', reason: 'same-slice isolated remeasurement executor is not connected' });

  expect(planMacrophageRepairLadder({ ...loadInput, r0Attempts: undefined }).step).toBe('R4-hitl');
  expect(planMacrophageRepairLadder({ ...loadInput, attemptedSteps: ['R0-remeasure'] }).step).toBe('R4-hitl');

  const passedStepWithActiveRegression = planMacrophageRepairLadder({ ...base, evidence: 'introduced', failureIds,
    sourceFiles: ['src/a.ts'], changeKind: 'fixture', previousStep: 'R1-single-file', previousStepOutcome: 'passed' });
  expect(passedStepWithActiveRegression.step).toBe('R4-hitl');
  expect(passedStepWithActiveRegression.reason).toContain('active failure evidence remains');
  const repeatedR3 = planMacrophageRepairLadder({ ...base, evidence: 'introduced', failureIds,
    sourceFiles: ['src/a.ts'], changeKind: 'fixture', previousStep: 'R1-single-file', previousStepOutcome: 'failed',
    revertSafe: true, attributionConfidence: 'high', causePr: 12345, causePrFailureIds: failureIds,
    attemptedSteps: ['R1-single-file', 'R3-revert-proposal'], attemptedStepsRunId: base.runId, attemptedFiles: ['src/a.ts'] });
  expect(repeatedR3.step).toBe('R4-hitl');
  expect(repeatedR3.reason).toContain('without a safe, high-confidence revert candidate');
  const unmeasuredR3 = planMacrophageRepairLadder({ ...base, evidence: 'introduced', failureIds,
    sourceFiles: ['src/a.ts'], changeKind: 'fixture', previousStep: 'R1-single-file', previousStepOutcome: 'failed',
    revertSafe: true, attributionConfidence: 'high', causePr: 12345, causePrFailureIds: failureIds, attemptedFiles: ['src/a.ts'] });
  expect(unmeasuredR3.step).toBe('R4-hitl');
  expect(unmeasuredR3.reason).toContain('R3 execution history is unmeasured');

  const unrelatedCause = planMacrophageRepairLadder({ ...base, evidence: 'introduced', failureIds,
    sourceFiles: ['src/a.ts'], previousStep: 'R1-single-file', previousStepOutcome: 'failed', revertSafe: true,
    attributionConfidence: 'high', causePr: 12345, causePrFailureIds: ['different regression'],
    attemptedSteps: ['R1-single-file'], attemptedStepsRunId: base.runId, attemptedFiles: ['src/a.ts'] });
  expect(unrelatedCause.step).toBe('R4-hitl');
  expect(unrelatedCause.reason).toContain('without a safe, high-confidence revert candidate');
  const nonIntroducedCause = planMacrophageRepairLadder({ ...base, evidence: 'known-env', failureIds,
    sourceFiles: ['src/a.ts'], previousStep: 'R1-single-file', previousStepOutcome: 'failed', revertSafe: true,
    attributionConfidence: 'high', causePr: 12345, causePrFailureIds: failureIds, attemptedSteps: ['R1-single-file'],
    attemptedStepsRunId: base.runId, attemptedFiles: ['src/a.ts'], r0Attempts: 1, minutesToCut: 30 });
  expect(nonIntroducedCause.step).toBe('R4-hitl');
  expect(nonIntroducedCause.reason).toContain('only R3/R4 are allowed');
  const unmeasuredFileHistory = planMacrophageRepairLadder({ ...base, evidence: 'introduced', failureIds,
    sourceFiles: ['src/a.ts'], changeKind: 'fixture', attemptedSteps: ['R1-single-file'], attemptedStepsRunId: base.runId });
  expect(unmeasuredFileHistory.step).toBe('R4-hitl');
  expect(unmeasuredFileHistory.reason).toContain('attempted-file history is unmeasured');
  const failedOtherStepWithUnmeasuredFileHistory = planMacrophageRepairLadder({ ...base, evidence: 'introduced', failureIds,
    sourceFiles: ['src/a.ts'], changeKind: 'fixture', previousStep: 'R0-remeasure', previousStepOutcome: 'failed',
    attemptedSteps: ['R1-single-file'], attemptedStepsRunId: base.runId });
  expect(failedOtherStepWithUnmeasuredFileHistory.step).toBe('R4-hitl');
  expect(failedOtherStepWithUnmeasuredFileHistory.reason).toContain('attempted-file history is unmeasured');
  const projectedCutoff = planMacrophageRepairLadder({ ...base, evidence: 'introduced', failureIds,
    sourceFiles: ['src/a.ts'], changeKind: 'fixture', minutesToCut: 31, estimatedStepMs: 5 * 60_000 });
  expect(projectedCutoff.reason).toContain('estimated step completion crosses');
  expect(projectedCutoff.reason).not.toContain('observed countdown is within');
});
