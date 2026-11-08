import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getTestStateRoot } from '../nexus/paths.js';
import { resetEffectiveInstanceRoot } from '../instance/resolve.js';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { listGraphRuns, runGraph as runGraphCore, STOPPED_NODE_ERROR, type GraphRunOptions, type GraphRunState } from '../graph-runner/runner.js';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { releaseResumeWaiver } from '../../scripts/release-loop/resume.js';
import { runKnownIssues } from '../../scripts/release-loop/known-issues-node.js';
import { createGateRunner, graphGateResult, judgeGate } from '../../scripts/release-loop/gate-api-leaf.js';
import type { GateResult, GateRunner } from '../../scripts/release-loop/gate-types.js';
import { runNpmPublish } from '../../scripts/release-loop/npm-publish-node.js';
import { runPublish } from '../../scripts/release-loop/publish-node.js';
import { resumeReleaseRun } from '../../scripts/release-loop/resume-release.js';
import { runAutoApprove } from '../../scripts/release-loop/auto-approve-node.js';
import { runVerify } from '../../scripts/release-loop/verify-node.js';
import { readGraphContext, runNodeVerdict } from '../../scripts/release-loop/node-verdict.js';
import { runGateRepairNode } from '../../scripts/release-loop/gate-repair-node.js';
import { resolveScenarioFilePath } from './scenario.js';

/** The sim world executes the same live subscribers against its isolated state root. */
function runGraph(path: string, options: GraphRunOptions): ReturnType<typeof runGraphCore> {
  return runGraphCore(path, { ...options, deps: { ...options.deps, releaseGraphEventAdapters: true } });
}
import { planGateReceiptRadius, reduceGateShardReceipts, gateShardRuntimeIdentityKey, type GateShardIdentity, type GateShardReceipt } from '../../scripts/release-loop/gate-shard-dispatch.js';
import { inspectGateShardReceipts, saveGateShardResult, type GateShardReceiptInspection } from '../../scripts/release-loop/gate-shard-receipts.js';
import { gateEnvFingerprint, gateSourcePins } from '../../scripts/release-loop/gate-baseline-receipt.js';
import { runMacrophageHeal, type MacrophageScrap } from '../release-loop/macrophage-heal.js';
import { createMacrophageRuntime } from '../release-loop/macrophage-heal-node.js';
import { checkReleaseEventTrace, type ReleaseEventExpectation, type ReleaseEventRecord } from './release-event-trace.js';
import { createReleasePublishDevices } from './release-publish-devices.js';
import { PodPoolScheduler } from '../task-orchestrator/surfaces/pod-pool.js';
import { createGraphEventBus, type GraphEvent, type GraphEventBus } from '../graph-runner/graph-events.js';
import { planMacrophageIncident, recordMacrophageGraphRecovery, simulateMacrophageRecovery, type MacrophageIncidentSignal } from '../release-loop/macrophage-incident-recovery.js';
import { classifyGateShadow } from '../../scripts/release-loop/gate-triage-node.js';
import { attributeReleaseFailures, type ReleaseFailureAttribution } from '../release-loop/release-failure-attribution.js';
import { planMacrophageRepairLadder, type MacrophageRepairLadderInput, type MacrophageRepairLadderDecision } from '../release-loop/macrophage-repair-ladder.js';

export interface MacrophageRepairLadderFiveStepCapSim {
  readonly injector: 'macrophage-repair-ladder-five-step-cap-sim';
  readonly pass: boolean;
  readonly decisions: readonly { readonly id: string; readonly expectedStep: string; readonly decision: MacrophageRepairLadderDecision; readonly pass: boolean }[];
  readonly checks: Readonly<Record<string, boolean>>;
  readonly inputMutationCount: number;
}

/** GREEN-V injection seam: run the production five-step decision policy without PR, graph, or file writes. */
export function runMacrophageRepairLadderFiveStepCapSim(): MacrophageRepairLadderFiveStepCapSim {
  const common: Omit<MacrophageRepairLadderInput, 'evidence' | 'failureIds'> = {
    runId: 'sim-macrophage-repair-ladder', signature: 'simulated-release-gate-failure',
    repairChildrenUsed: 0, elapsedMs: 0, minutesToCut: 180, estimatedStepMs: 5 * 60_000,
  };
  const cases: Array<{ id: string; input: MacrophageRepairLadderInput; expectedStep: string }> = [
    { id: 'R0-same-slice-remeasure', expectedStep: 'R0-remeasure', input: { ...common, evidence: 'load-flaky', failureIds: ['test/a.test.ts > timeout'], r0Attempts: 0 } },
    { id: 'R1-one-file-fixture', expectedStep: 'R1-single-file', input: { ...common, evidence: 'introduced', failureIds: ['test/a.test.ts > stale expectation'],
      sourceFiles: ['src/a.ts'], changeKind: 'expectation' } },
    { id: 'R2-independent-file-split', expectedStep: 'R2-split-files', input: { ...common, evidence: 'introduced', failureIds: ['test/a.test.ts > regression'],
      sourceFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'], independentFiles: true } },
    { id: 'R2-exact-four-child-cap', expectedStep: 'R2-split-files', input: { ...common, evidence: 'introduced', failureIds: ['test/a.test.ts > regression'],
      sourceFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'], independentFiles: true } },
    { id: 'R3-safe-revert-draft', expectedStep: 'R3-revert-proposal', input: { ...common, evidence: 'introduced', failureIds: ['test/a.test.ts > regression'],
      sourceFiles: ['src/a.ts'], previousStep: 'R1-single-file', previousStepOutcome: 'failed', causePr: 123,
      causePrFailureIds: ['test/a.test.ts > regression'], attributionConfidence: 'high', revertSafe: true,
      attemptedSteps: ['R1-single-file'], attemptedStepsRunId: common.runId, attemptedFiles: ['src/a.ts'] } },
    { id: 'R4-human-decision', expectedStep: 'R4-hitl', input: { ...common, evidence: 'unmeasured', failureIds: ['unattributed gate failure'] } },
    { id: 'four-children-exhausted', expectedStep: 'R4-hitl', input: { ...common, evidence: 'introduced', failureIds: ['test/a.test.ts > regression'],
      sourceFiles: ['src/a.ts'], changeKind: 'fixture', repairChildrenUsed: 4 } },
    { id: 'R2-no-partial-over-cap', expectedStep: 'R4-hitl', input: { ...common, evidence: 'introduced', failureIds: ['test/a.test.ts > regression'],
      sourceFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'], independentFiles: true, repairChildrenUsed: 2 } },
    { id: 'ninety-minute-cap', expectedStep: 'R4-hitl', input: { ...common, evidence: 'introduced', failureIds: ['test/a.test.ts > regression'],
      sourceFiles: ['src/a.ts'], changeKind: 'fixture', elapsedMs: 90 * 60_000 } },
    { id: 'step-would-overrun-cap', expectedStep: 'R4-hitl', input: { ...common, evidence: 'introduced', failureIds: ['test/a.test.ts > regression'],
      sourceFiles: ['src/a.ts'], changeKind: 'fixture', elapsedMs: 85 * 60_000, estimatedStepMs: 6 * 60_000 } },
    { id: 'cut-minus-thirty-restricts-to-R3-R4', expectedStep: 'R3-revert-proposal', input: { ...common, evidence: 'introduced', failureIds: ['test/a.test.ts > regression'],
      sourceFiles: ['src/a.ts'], previousStep: 'R2-split-files', previousStepOutcome: 'failed', causePr: 123,
      causePrFailureIds: ['test/a.test.ts > regression'], attributionConfidence: 'high', revertSafe: true,
      attemptedSteps: ['R2-split-files'], attemptedStepsRunId: common.runId, attemptedFiles: ['src/a.ts'], minutesToCut: 30 } },
    { id: 'cut-minus-thirty-one-allows-R1', expectedStep: 'R1-single-file', input: { ...common, evidence: 'introduced', failureIds: ['test/a.test.ts > stale expectation'],
      sourceFiles: ['src/a.ts'], changeKind: 'expectation', minutesToCut: 31, estimatedStepMs: 30_000 } },
    { id: 'projected-step-crosses-cutoff', expectedStep: 'R4-hitl', input: { ...common, evidence: 'introduced', failureIds: ['test/a.test.ts > stale expectation'],
      sourceFiles: ['src/a.ts'], changeKind: 'expectation', minutesToCut: 31, estimatedStepMs: 5 * 60_000 } },
    { id: 'cut-minus-thirty-blocks-R0', expectedStep: 'R4-hitl', input: { ...common, evidence: 'load-flaky', failureIds: ['test/a.test.ts > timeout'], minutesToCut: 30 } },
    { id: 'unknown-countdown-fails-closed', expectedStep: 'R4-hitl', input: { ...common, evidence: 'introduced', failureIds: ['test/a.test.ts > regression'],
      sourceFiles: ['src/a.ts'], changeKind: 'fixture', minutesToCut: null } },
    { id: 'R3-proposal-used-once', expectedStep: 'R4-hitl', input: { ...common, evidence: 'introduced', failureIds: ['test/a.test.ts > regression'],
      sourceFiles: ['src/a.ts'], previousStep: 'R2-split-files', previousStepOutcome: 'failed', causePr: 123,
      causePrFailureIds: ['test/a.test.ts > regression'], attributionConfidence: 'high', revertSafe: true,
      r3ProposalUsed: true, attemptedSteps: ['R2-split-files', 'R3-revert-proposal'], attemptedStepsRunId: common.runId,
      attemptedFiles: ['src/a.ts'] } },
  ];
  let inputMutationCount = 0;
  const decisions = cases.map(({ id, input, expectedStep }) => {
    const before = structuredClone(input);
    const result = planMacrophageRepairLadder(input);
    const unchanged = JSON.stringify(input) === JSON.stringify(before);
    if (!unchanged) inputMutationCount++;
    return { id, expectedStep, decision: result, pass: result.step === expectedStep && unchanged };
  });
  const r1 = decisions.find(({ id }) => id === 'R1-one-file-fixture')!.decision;
  const r2 = decisions.find(({ id }) => id === 'R2-independent-file-split')!.decision;
  const r3 = decisions.find(({ id }) => id === 'R3-safe-revert-draft')!.decision;
  const r4 = decisions.find(({ id }) => id === 'R4-human-decision')!.decision;
  const checks = {
    allFiveSteps: ['R0-remeasure', 'R1-single-file', 'R2-split-files', 'R3-revert-proposal', 'R4-hitl']
      .every((step) => decisions.some(({ decision }) => decision.step === step)),
    repairPlansTargetCutAppendOnly: [r1, r2].every((item) => item.repositoryWrite === 'cut-append-only'
      && item.repairUnits.every((unit) => unit.writeTarget === 'cut-append')),
    r2ParallelismBounded: r2.childrenPlanned === 3 && r2.maxParallelChildren === 2,
    exactFourChildrenAllowed: decisions.find(({ id }) => id === 'R2-exact-four-child-cap')?.decision.childrenPlanned === 4,
    r3IsDraftOnly: r3.revertDraft?.draftOnly === true && r3.action === 'propose-revert-draft',
    r4ProducesDecisionCard: r4.action === 'raise-decision' && r4.decisionCard !== undefined,
    childLimitAndNoPartialSplit: decisions.find(({ id }) => id === 'four-children-exhausted')?.decision.childrenPlanned === 0
      && decisions.find(({ id }) => id === 'R2-no-partial-over-cap')?.decision.childrenPlanned === 0,
    ninetyMinuteBudget: decisions.find(({ id }) => id === 'ninety-minute-cap')?.decision.step === 'R4-hitl'
      && decisions.find(({ id }) => id === 'step-would-overrun-cap')?.decision.step === 'R4-hitl',
    cutoffBoundary: decisions.find(({ id }) => id === 'cut-minus-thirty-restricts-to-R3-R4')?.decision.step === 'R3-revert-proposal'
      && decisions.find(({ id }) => id === 'cut-minus-thirty-one-allows-R1')?.decision.step === 'R1-single-file'
      && decisions.find(({ id }) => id === 'projected-step-crosses-cutoff')?.decision.step === 'R4-hitl'
      && decisions.find(({ id }) => id === 'cut-minus-thirty-blocks-R0')?.decision.step === 'R4-hitl',
    unknownCountdownFailsClosed: decisions.find(({ id }) => id === 'unknown-countdown-fails-closed')?.decision.step === 'R4-hitl',
    r3ProposalOnePerRun: decisions.find(({ id }) => id === 'R3-proposal-used-once')?.decision.step === 'R4-hitl',
  };
  return { injector: 'macrophage-repair-ladder-five-step-cap-sim', pass: decisions.every((item) => item.pass)
    && inputMutationCount === 0 && Object.values(checks).every(Boolean), decisions, checks, inputMutationCount };
}

export interface ReleaseMacrophageIncidentSimInput {
  readonly runId: string;
  readonly incidents: readonly MacrophageIncidentSignal[];
  readonly repairLandedIds: readonly string[];
  readonly hitlApprovedIds: readonly string[];
  readonly version?: string;
  readonly attributionContext?: { readonly repo: string; readonly previousTag: string; readonly cutCommit: string };
  readonly graphDrivenIncidentIds?: readonly string[];
}

export interface ReleaseMacrophageIncidentSimCase {
  readonly signal: MacrophageIncidentSignal;
  readonly plan: ReturnType<typeof planMacrophageIncident>;
  readonly resumed: boolean;
  readonly receipt?: ReturnType<typeof simulateMacrophageRecovery>['receipt'];
  readonly receiptJsonl: string;
  readonly eventNames: readonly string[];
  readonly pass: boolean;
}

const GRAPH_DRIVEN_MACROPHAGE_INCIDENT = 'c-three-file-regression';

const RELEASE_SIM_RIG_WORKTREE_MARKER = '.elanous-release-sim-rig';

/** Fake Git boundary used by the simulator's real PWA worktree creation and teardown path. */
export function createReleaseSimRigFakeGitScript(): string {
  return [
    '#!/bin/sh',
    'if [ "$1" = "worktree" ] && [ "$2" = "add" ]; then',
    '  if ! mkdir "$4" 2>/dev/null; then echo "[release-sim-rig] refused existing worktree path: $4" >&2; printf "add-refused-existing\\n" >> "$ELANOUS_SIM_RIG_WORKTREE_LOG"; exit 1; fi',
    '  if ! mkdir -p "$4/apps/pwa"; then echo "[release-sim-rig] failed to prepare new worktree path: $4" >&2; printf "add-prepare-failed\\n" >> "$ELANOUS_SIM_RIG_WORKTREE_LOG"; exit 1; fi',
    `  if ! (set -C; printf 'release-sim-rig-worktree-v1\\n%s\\n' "$ELANOUS_SIM_RIG_RUN_ID" > "$4/${RELEASE_SIM_RIG_WORKTREE_MARKER}"); then echo "[release-sim-rig] could not create ownership marker: $4" >&2; printf "add-marker-create-failed\\n" >> "$ELANOUS_SIM_RIG_WORKTREE_LOG"; exit 1; fi`,
    `  if printf 'release-sim-rig-worktree-v1\\n%s\\n' "$ELANOUS_SIM_RIG_RUN_ID" | cmp -s - "$4/${RELEASE_SIM_RIG_WORKTREE_MARKER}"; then if [ -n "$ELANOUS_SIM_RIG_MARKER_SNAPSHOT" ]; then cp "$4/${RELEASE_SIM_RIG_WORKTREE_MARKER}" "$ELANOUS_SIM_RIG_MARKER_SNAPSHOT" || exit 1; printf '%s\\n' "$4" > "$ELANOUS_SIM_RIG_WORKTREE_PATH_SNAPSHOT" || exit 1; fi; printf "add-marker-verified\\n" >> "$ELANOUS_SIM_RIG_WORKTREE_LOG"; else echo "[release-sim-rig] marker verification failed: $4" >&2; exit 1; fi`,
    '  exit 0',
    'fi',
    'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
    `  marker="$4/${RELEASE_SIM_RIG_WORKTREE_MARKER}"`,
    `  if [ ! -f "$marker" ] || ! printf 'release-sim-rig-worktree-v1\\n%s\\n' "$ELANOUS_SIM_RIG_RUN_ID" | cmp -s - "$marker"; then`,
    '    if [ -f "$marker" ]; then echo "[release-sim-rig] preserved worktree owned by another simulation run: $4" >&2; printf "remove-preserved-other-run\\n" >> "$ELANOUS_SIM_RIG_WORKTREE_LOG"; else echo "[release-sim-rig] preserved unmarked worktree: $4" >&2; printf "remove-preserved-unmarked\\n" >> "$ELANOUS_SIM_RIG_WORKTREE_LOG"; fi',
    '    exit 0',
    '  fi',
    '  quarantine="$4.release-sim-rig-teardown-$ELANOUS_SIM_RIG_RUN_ID-$$"',
    '  if ! mkdir "$quarantine" 2>/dev/null; then echo "[release-sim-rig] could not reserve teardown path for: $4" >&2; exit 1; fi',
    '  chmod 700 "$quarantine" || exit 1',
    '  if ! mv "$4" "$quarantine/worktree"; then rmdir "$quarantine" 2>/dev/null; echo "[release-sim-rig] worktree changed before teardown: $4" >&2; exit 1; fi',
    `  if [ -f "$quarantine/worktree/${RELEASE_SIM_RIG_WORKTREE_MARKER}" ] && printf 'release-sim-rig-worktree-v1\\n%s\\n' "$ELANOUS_SIM_RIG_RUN_ID" | cmp -s - "$quarantine/worktree/${RELEASE_SIM_RIG_WORKTREE_MARKER}"; then`,
    '    rm -rf "$quarantine/worktree"',
    '    if [ ! -e "$quarantine/worktree" ] && rmdir "$quarantine" 2>/dev/null && [ ! -e "$quarantine" ]; then printf "remove-marker-matched-path-absent\\n" >> "$ELANOUS_SIM_RIG_WORKTREE_LOG"; exit 0; fi',
    '    echo "[release-sim-rig] verified worktree remains in teardown quarantine: $4" >&2; exit 1',
    '  fi',
    '  if [ ! -e "$4" ]; then mv "$quarantine/worktree" "$4"; rmdir "$quarantine" 2>/dev/null; fi',
    '  echo "[release-sim-rig] preserved worktree after ownership changed: $4" >&2; printf "remove-preserved-changed-marker\\n" >> "$ELANOUS_SIM_RIG_WORKTREE_LOG"; exit 0',
    'fi',
    'echo "unexpected git boundary: $*" >&2',
    'exit 97',
    '',
  ].join('\n');
}

/** Extends the existing release graph rig with fake incident/PR/owner boundaries and the production recovery decision core. */
export async function runReleaseMacrophageIncidentSim(input: ReleaseMacrophageIncidentSimInput): Promise<{
  readonly pass: boolean;
  readonly runId: string;
  readonly graphState: GraphRunState;
  readonly graphDrivenIncidentId: string;
  readonly graphRepairFailureIds: readonly string[];
  readonly graphRepairInputFailureIds: readonly string[];
  readonly graphRepairInputFiles: readonly string[];
  readonly graphRepairAttributions: readonly ReleaseFailureAttribution[];
  readonly graphRepairMeasured: boolean;
  readonly graphRepairChecks: Readonly<Record<string, boolean | number>>;
  readonly statePath: string;
  readonly receiptPath: string;
  readonly recoveryReceiptPath: string;
  readonly cases: readonly ReleaseMacrophageIncidentSimCase[];
  readonly eventTrace: readonly GraphEvent[];
  readonly runtimeDecisions: readonly GraphEvent[];
  readonly jsonl: string;
}> {
  const bus = createGraphEventBus();
  const injectedType = 'release.macrophage.incident.injected';
  const outputTypes = ['release.macrophage.detected', 'release.macrophage.attributed', 'release.macrophage.classified',
    'release.macrophage.repair-pr-landed', 'release.macrophage.hitl-approved', 'release.macrophage.run-resumed',
    'release.macrophage.receipt-written'];
  bus.registerType(injectedType);
  for (const type of outputTypes) bus.registerType(type);
  const root = getTestStateRoot();
  if (!root) throw new Error('release macrophage incident simulation requires --test isolated mode');
  const eventTrace: GraphEvent[] = [];
  bus.subscribe((event) => { eventTrace.push(event); });
  const runtimeDecisions: GraphEvent[] = [];
  const macrophageRuntime = createMacrophageRuntime({ root, runId: input.runId, eventBus: bus, mode: 'simulation',
    inventory: (event) => event.source.nodeId === 'pre-gate-join' ? [{ id: 'simulated-stale-output', kind: 'stale-generated-artifact',
      evidence: { sourceFingerprint: 'cut-current', generatedFingerprint: 'stale' } }] : [] });
  bus.subscribe((event) => { if (event.type === 'release.macrophage.decision') runtimeDecisions.push(event); }, { type: 'release.macrophage.decision' });
  const jsonlRows: string[] = [];
  const cases: ReleaseMacrophageIncidentSimCase[] = [];
  const repairLanded = new Set(input.repairLandedIds);
  const hitlApproved = new Set(input.hitlApprovedIds);
  const graphDrivenIncidentIds = new Set(input.graphDrivenIncidentIds ?? [GRAPH_DRIVEN_MACROPHAGE_INCIDENT]);
  bus.subscribe(async (event) => {
    if (event.type !== injectedType) return;
    const signal = event.data?.signal as MacrophageIncidentSignal;
    const plan = planMacrophageIncident(signal);
    await bus.publish({ graphId: event.graphId, runId: event.runId, type: 'release.macrophage.detected', source: { kind: 'runner' }, data: { incidentId: signal.id } });
    await bus.publish({ graphId: event.graphId, runId: event.runId, type: 'release.macrophage.attributed', source: { kind: 'runner' },
      data: { incidentId: signal.id, sourceFiles: plan.files, causePr: plan.causePr ?? null, method: signal.evidence } });
    await bus.publish({ graphId: event.graphId, runId: event.runId, type: 'release.macrophage.classified', source: { kind: 'runner' },
      data: { incidentId: signal.id, label: plan.label, step: plan.step, reason: plan.reason } });
    const graphDriven = graphDrivenIncidentIds.has(signal.id);
    const recovery = graphDriven ? undefined : simulateMacrophageRecovery({ runId: event.runId, plan, changedShardId: `shard-${cases.length}`,
      carriedShardIds: ['shard-0', 'shard-1', 'shard-2', 'shard-3'], repairLanded: repairLanded.has(signal.id),
      hitlApproved: hitlApproved.has(signal.id) });
    if (plan.label === 'fix' && repairLanded.has(signal.id) && !graphDriven) {
      await bus.publish({ graphId: event.graphId, runId: event.runId, type: 'release.macrophage.repair-pr-landed', source: { kind: 'runner' },
        data: { incidentId: signal.id, files: plan.files } });
    }
    if (plan.label === 'hitl' && hitlApproved.has(signal.id)) {
      await bus.publish({ graphId: event.graphId, runId: event.runId, type: 'release.macrophage.hitl-approved', source: { kind: 'runner' }, data: { incidentId: signal.id } });
    }
    if (recovery?.resumed) {
      await bus.publish({ graphId: event.graphId, runId: event.runId, type: 'release.macrophage.run-resumed', source: { kind: 'runner' },
        data: { incidentId: signal.id, disposition: recovery.receipt.disposition, gateVisit: recovery.receipt.gateVisit } });
      jsonlRows.push(recovery.jsonl);
      await bus.publish({ graphId: event.graphId, runId: event.runId, type: 'release.macrophage.receipt-written', source: { kind: 'runner' },
        data: { incidentId: signal.id, schema: recovery.receipt.schema, jsonl: recovery.jsonl } });
    }
    const expectedResume = plan.label === 'noise' || (plan.label === 'fix' && repairLanded.has(signal.id))
      || (plan.label === 'hitl' && hitlApproved.has(signal.id));
    cases.push({ signal, plan, resumed: recovery?.resumed ?? false, ...(recovery ? { receipt: recovery.receipt } : {}),
      receiptJsonl: recovery?.jsonl ?? '', eventNames: [], pass: graphDriven ? false
        : recovery!.resumed === expectedResume && (!recovery!.resumed || recovery!.receipt.runId === event.runId)
          && (plan.label !== 'fix' || !recovery!.resumed || recovery!.receipt.gateVisit === 2) });
  }, { type: injectedType });
  const version = input.version ?? '0.3.6';
  let incidentsInjected = false;
  let gateVisits = 0;
  let graphRepairInputFiles: string[] = [];
  let graphRepairInputFailureIds: string[] = [];
  let graphState: GraphRunState;
  try { graphState = await runGraph(RELEASE_GRAPH, { runId: input.runId,
    input: { version, previousVersion: '0.3.5' }, eventBus: bus, pinChildUniverse: true, quiet: true,
    deps: { root, runBash: async (_command: string, options: { env?: NodeJS.ProcessEnv }) => {
      const { nodeId } = parseContext(options.env ?? process.env);
      if (!incidentsInjected && nodeId === 'gate') {
        incidentsInjected = true;
        for (const incident of input.incidents) {
          await bus.publish({ graphId: 'release-loop', runId: input.runId, type: injectedType, source: { kind: 'runner' }, data: { signal: incident } });
        }
        await bus.flush({ graphId: 'release-loop', runId: input.runId });
      }
      if (nodeId === 'gate') {
        gateVisits++;
        const graphDriven = cases.filter(({ signal }) => graphDrivenIncidentIds.has(signal.id));
        if (graphDriven.length === 0 || graphDriven.some((item) => item.plan.label !== 'fix'
          || !repairLanded.has(item.signal.id) || (item.signal.id === GRAPH_DRIVEN_MACROPHAGE_INCIDENT
            && (item.plan.step !== 'R2-split-files' || item.plan.files.length < 2)))) {
          throw new Error('graph-driven incidents must resolve to landed repair plans');
        }
        const commit = 'a'.repeat(40);
        const introduced = graphDriven.flatMap(({ signal, plan }) => signal.failureIds?.length
          ? signal.failureIds : plan.files.map((file) => `${file}.test.ts > injected R2 regression in ${file}`));
        const gate = gateVisits === 1
          ? { outcome: 'fail', commit, introduced, preexisting: 0, fixed: null,
            knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 1 }
          : { outcome: 'ok', commit, introduced: [], preexisting: 0, fixed: null,
            knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 1 };
        return { exitCode: gateVisits === 1 ? 1 : 0, stdout: `${JSON.stringify(gate)}\n`,
          stderr: gateVisits === 1 ? 'TypeScript TS2322: simulated gate regression' : '' };
      }
      if (nodeId === 'gate-triage') {
        const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
        if (!contextPath) throw new Error('gate-triage simulation requires its graph context');
        const context = JSON.parse(readFileSync(contextPath, 'utf8')) as { input: Record<string, unknown>; outputs: { gate?: Record<string, unknown> } };
        if (!context.outputs.gate) throw new Error('gate-triage simulation did not receive the current gate output');
        const triage = classifyGateShadow(context.outputs.gate as never);
        return { exitCode: 0, stdout: `${JSON.stringify({ ...triage,
          gateExecutionId: context.input.adaptiveGateExecutionId })}\n`, stderr: '' };
      }
      if (/^gate-repair-[a-f0-9]{12}$/.test(nodeId)) {
        const graphDriven = cases.filter(({ signal }) => graphDrivenIncidentIds.has(signal.id));
        if (graphDriven.length === 0 || graphDriven.some(({ signal }) => !repairLanded.has(signal.id))) throw new Error('repair PR landing was not supplied to the graph-driven incident');
        const graphContext = readGraphContext(options.env);
        const failureIds = graphContext.nodeInput?.failureIds;
        const expectedFailureIds = graphDriven.flatMap(({ signal, plan }) => signal.failureIds?.length
          ? signal.failureIds : plan.files.map((file) => `${file}.test.ts > injected R2 regression in ${file}`));
        if (!Array.isArray(failureIds) || expectedFailureIds.some((id) => !failureIds.includes(id))) {
          throw new Error('adaptive repair input does not preserve the original gate failure IDs');
        }
        const attributions = input.attributionContext
          ? attributeReleaseFailures({ ...input.attributionContext, failureIds: failureIds as string[] })
          : graphDriven.flatMap(({ signal, plan }) => (signal.failureIds?.length ? signal.failureIds : plan.files.map((file) => `${file}.test.ts > injected R2 regression in ${file}`))
            .map((failureId) => {
              const testFile = failureId.split(' > ')[0] ?? '';
              const inferredSource = testFile.endsWith('.test.ts') ? testFile.slice(0, -8) : testFile;
              const sourceFiles = plan.files.includes(inferredSource) ? [inferredSource] : plan.files.length === 1 ? [...plan.files] : [];
              return { failureId, testFile, sourceFiles,
              causePrs: signal.causePr ? [signal.causePr] : [], confidence: 'high' as const, method: 'first-parent-source-overlap' as const,
              evidence: [], unresolvedImports: [] };
            }));
        for (const item of graphDriven) {
          const itemAttributions = attributions.filter((row) => item.signal.failureIds?.includes(row.failureId)
            || (!item.signal.failureIds?.length && item.plan.files.some((file) => row.sourceFiles.includes(file))));
          const attributedFiles = new Set(itemAttributions.flatMap((row) => row.sourceFiles));
          if (itemAttributions.length === 0 || itemAttributions.some((row) => row.confidence === 'unmeasured')
            || !item.plan.files.every((file) => attributedFiles.has(file))) {
            throw new Error(`adaptive repair input could not attribute original failures for ${item.signal.id}`);
          }
        }
        const attributedRepairFailureIds = [...new Set(attributions.flatMap((row) => row.sourceFiles
          .map((file) => `${file} > ${row.failureId}`)))];
        if (!attributedRepairFailureIds.length) throw new Error('production attribution produced no repairable source files');
        const repairPrFiles = new Map<number, string>();
        let nextRepairPr = 90000;
        const repairContext = { ...graphContext, nodeInput: { ...graphContext.nodeInput, failureIds: attributedRepairFailureIds,
          independenceEvidence: attributions.map(({ failureId, sourceFiles, unresolvedImports }) => ({ failureId, sourceFiles, unresolvedImports })) } };
        graphRepairInputFailureIds = [...attributedRepairFailureIds];
        const repairResult = await runGateRepairNode(repairContext, {
          root, repo: input.attributionContext?.repo,
          attributeFailures: () => attributions,
          startRepairChild: async (featurePath) => {
            const body = readFileSync(featurePath, 'utf8');
            const file = /^Attributed source file: (.+)$/m.exec(body)?.[1];
            if (!file) throw new Error('production repair feature omitted its attributed source file');
            const prNumber = nextRepairPr++;
            repairPrFiles.set(prNumber, file);
            return { ok: true, prNumber, prUrl: `https://github.com/ElanvitalAI/elanous/pull/${prNumber}` };
          },
          inspectRepairPr: async (prNumber) => {
            const file = repairPrFiles.get(prNumber);
            if (!file) throw new Error(`unknown simulated repair PR ${prNumber}`);
            return { isDraft: false, files: [file], headRefOid: createHash('sha1').update(file).digest('hex') };
          },
          waitForLanded: async (prNumber) => {
            const file = repairPrFiles.get(prNumber);
            if (!file) throw new Error(`unknown simulated landing PR ${prNumber}`);
            return { schema: 1, prNumber, repairRunId: input.runId,
              head: createHash('sha1').update(file).digest('hex'), mergeSha: 'f'.repeat(40), base: 'main', mergedAt: '2026-11-07T00:00:00.000Z' };
          },
          isAncestor: () => true,
          refreshMainlineHead: () => 'f'.repeat(40),
        });
        if (repairResult.outcome !== 'ok') throw new Error(`production repair entrypoint did not land every attributed file: ${repairResult.summary}`);
        graphRepairInputFiles = repairResult.repairs.map(({ file }) => file).sort();
        for (const item of graphDriven) {
          const itemAttributions = attributions.filter((row) => item.signal.failureIds?.includes(row.failureId)
            || (!item.signal.failureIds?.length && item.plan.files.some((file) => row.sourceFiles.includes(file))));
          await bus.publish({ graphId: 'release-loop', runId: input.runId, type: 'release.macrophage.repair-pr-landed', source: { kind: 'runner' },
            data: { incidentId: item.signal.id, files: item.plan.files, failureIds,
              attribution: itemAttributions, adaptiveRepairInputFiles: graphRepairInputFiles, nodeId } });
        }
        return { exitCode: 0, stdout: `${JSON.stringify(repairResult)}\n`, stderr: '' };
      }
      return resultForNode(nodeId, undefined, version);
    } } });
  } finally { macrophageRuntime.dispose(); }
  if (graphState.runId !== input.runId) throw new Error(`incident simulation run ${input.runId} does not match graph run ${graphState.runId}`);
  await bus.flush({ graphId: 'release-loop', runId: input.runId });
  const statePath = graphState.statePath;
  if (!statePath) throw new Error('release graph simulation did not persist a run state path');
  const receiptPath = `${statePath}.contexts/macrophage.jsonl`;
  const recoveryReceiptPath = `${statePath}.contexts/macrophage-recovery.jsonl`;
  const graphLifecycleMeasured = graphState.status === 'done'
    && graphState.path.filter((nodeId) => nodeId === 'gate').length === 2
    && graphState.path.some((nodeId) => /^gate-repair-[a-f0-9]{12}$/.test(nodeId));
  const graphDriven = cases.filter(({ signal }) => graphDrivenIncidentIds.has(signal.id));
  const graphRepairAppend = graphState.adaptiveGateNodeAppends?.find(({ request }) => request.rerunGateAt === 'gate'
    && request.node.recipe === 'cmd:gate-repair');
  const graphRepairFailureIds = graphRepairAppend?.request.node.recipe === 'cmd:gate-repair'
    ? graphRepairAppend.request.node.input.failureIds : [];
  const graphRepairAttributions = input.attributionContext && graphRepairFailureIds.length
    ? attributeReleaseFailures({ ...input.attributionContext, failureIds: graphRepairFailureIds }) : [];
  const graphDrivenRepairMeasured = graphLifecycleMeasured && graphDriven.length > 0
    && graphDriven.every(({ plan }) => plan.files.every((file) => graphRepairInputFiles.includes(file)))
    && graphDriven.every(({ signal, plan }) => plan.files.every((file) => graphRepairInputFailureIds.some((id) =>
      signal.failureIds?.includes(id) || id.startsWith(`${file} > `))))
    && (!input.attributionContext || graphDriven.every(({ signal, plan }) => {
      const rows = graphRepairAttributions.filter((row) => signal.failureIds?.includes(row.failureId));
      return rows.length > 0 && rows.every((row) => row.confidence !== 'unmeasured')
        && plan.files.every((file) => rows.some((row) => row.sourceFiles.includes(file)));
    }));
  const graphRepairChecks = { lifecycle: graphLifecycleMeasured, graphDrivenCount: graphDriven.length,
    inputFiles: graphDriven.every(({ plan }) => plan.files.every((file) => graphRepairInputFiles.includes(file))),
    failureMapping: graphDriven.every(({ signal, plan }) => plan.files.every((file) => graphRepairInputFailureIds.some((id) =>
      signal.failureIds?.includes(id) || id.startsWith(`${file} > `)))), attribution: !input.attributionContext || graphDriven.every(({ signal, plan }) => {
      const rows = graphRepairAttributions.filter((row) => signal.failureIds?.includes(row.failureId));
      return rows.length > 0 && rows.every((row) => row.confidence !== 'unmeasured')
        && plan.files.every((file) => rows.some((row) => row.sourceFiles.includes(file)));
    }) };
  const graphDrivenRepairNodeId = graphRepairAppend?.request.node.nodeId;
  if (graphDrivenRepairMeasured) {
    for (const [index, item] of graphDriven.entries()) {
      const itemFailureIds = item.signal.failureIds?.length ? item.signal.failureIds
        : graphRepairInputFailureIds.filter((id) => item.plan.files.some((file) => id.startsWith(`${file} > `)));
      const itemAttributions = input.attributionContext
        ? graphRepairAttributions.filter((row) => itemFailureIds.includes(row.failureId))
        : itemFailureIds.map((failureId) => ({ failureId, sourceFiles: item.plan.files, confidence: 'high' as const }));
      const recovery = recordMacrophageGraphRecovery({ runId: input.runId, plan: item.plan,
        repairLanded: repairLanded.has(item.signal.id), repairNodeId: graphDrivenRepairNodeId,
        gateVisits: graphState.path.filter((nodeId) => nodeId === 'gate').length, failureIds: itemFailureIds,
        attributedFailures: itemAttributions,
        changedShardId: item.signal.id === 'd-receipt-reuse-zero-of-81' ? 'shard-d-receipt-reuse-zero-of-81' : `shard-${index}`,
        carriedShardIds: ['shard-0', 'shard-1', 'shard-2', 'shard-3'] });
      await bus.publish({ graphId: 'release-loop', runId: input.runId, type: 'release.macrophage.run-resumed', source: { kind: 'runner' },
        data: { incidentId: item.signal.id, disposition: recovery.receipt.disposition,
          gateVisit: graphState.path.filter((nodeId) => nodeId === 'gate').length } });
      jsonlRows.push(recovery.jsonl);
      await bus.publish({ graphId: 'release-loop', runId: input.runId, type: 'release.macrophage.receipt-written', source: { kind: 'runner' },
        data: { incidentId: item.signal.id, schema: recovery.receipt.schema, jsonl: recovery.jsonl } });
    }
  }
  await bus.flush({ graphId: 'release-loop', runId: input.runId });
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(recoveryReceiptPath, jsonlRows.join(''), { mode: 0o600 });
  const runtimeApplied = runtimeDecisions.some((event) => event.data?.id === 'simulated-stale-output'
    && event.data.action === 'regenerate' && event.data.applied === true);
  const runtimeFailureDetected = runtimeDecisions.some((decision) => {
    const sourceEventId = decision.data?.sourceEventId;
    const sourceEvent = typeof sourceEventId === 'string' ? eventTrace.find((event) => event.eventId === sourceEventId) : undefined;
    return decision.data?.sourceNodeId === 'gate' && decision.data.action === 'attempt-repair'
      && decision.data.failureSignature === 'type-error' && decision.data.applied === false
      && sourceEvent?.type === 'node-end' && sourceEvent.data?.ok === false
      && sourceEvent.source.kind === 'node' && sourceEvent.source.nodeId === 'gate';
  });
  const finalized = cases.map((item) => {
    if (graphDrivenIncidentIds.has(item.signal.id) && graphDrivenRepairMeasured) {
      const receipt = JSON.parse(jsonlRows.find((line) => JSON.parse(line).incidentId === item.signal.id) ?? 'null') as NonNullable<typeof item.receipt>;
      item = { ...item, resumed: true, receipt, receiptJsonl: `${JSON.stringify(receipt)}\n`, pass: true };
    }
    const eventNames = eventTrace.filter((row) => row.runId === input.runId && row.data?.incidentId === item.signal.id).map((row) => row.type);
    const expectedPrefix = ['release.macrophage.incident.injected', 'release.macrophage.detected', 'release.macrophage.attributed',
      'release.macrophage.classified'];
    const expectedTail = item.resumed ? [
      ...(item.plan.label === 'fix' ? ['release.macrophage.repair-pr-landed'] : []),
      ...(item.plan.label === 'hitl' ? ['release.macrophage.hitl-approved'] : []),
      'release.macrophage.run-resumed', 'release.macrophage.receipt-written',
    ] : [];
    const relevantNames = eventNames.filter((name) => name !== 'release.macrophage.incident.injected');
    const completeTrace = expectedPrefix.slice(1).every((name, index) => relevantNames[index] === name)
      && expectedTail.every((name, index) => relevantNames[index + 3] === name)
      && relevantNames.length === 3 + expectedTail.length;
    return { ...item, eventNames, pass: item.pass && completeTrace };
  });
  return { pass: runtimeApplied && runtimeFailureDetected && graphDrivenRepairMeasured && graphState.runId === input.runId
      && finalized.length === input.incidents.length && finalized.every((item) => item.pass)
      && jsonlRows.length === finalized.filter((item) => item.resumed).length
      && readFileSync(recoveryReceiptPath, 'utf8') === jsonlRows.join(''),
    runId: input.runId, graphState, graphDrivenIncidentId: [...graphDrivenIncidentIds][0] ?? GRAPH_DRIVEN_MACROPHAGE_INCIDENT,
    graphRepairFailureIds, graphRepairInputFailureIds, graphRepairInputFiles, graphRepairAttributions, graphRepairMeasured: graphDrivenRepairMeasured,
    graphRepairChecks,
    statePath, receiptPath, recoveryReceiptPath, cases: finalized, eventTrace, runtimeDecisions, jsonl: jsonlRows.join('') };
}

const REPOSITORY_ROOT = join(import.meta.dir, '../..');
const RELEASE_GRAPH = join(REPOSITORY_ROOT, 'graphs/release/release-loop.yaml');
const RECEIPT_SIM_NODE_IDS = ['cut', 'gate-cut', 'append-a', 'resume-a', 'gate-a', 'append-b', 'resume-b', 'gate-b', 'publish', 'done', 'failed'];

function releaseCutWorldEnv(base: NodeJS.ProcessEnv, home: string, tmp: string, emptyGitConfig: string): NodeJS.ProcessEnv {
  const gitExecutable = Bun.which('git');
  const bunExecutable = Bun.which('bun');
  if (!gitExecutable || !bunExecutable) throw new Error('release cut sim requires git and bun executables');
  const safePath = [...new Set([dirname(gitExecutable), dirname(bunExecutable), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(delimiter);
  return {
    ...Object.fromEntries(Object.entries(base).filter(([key]) => !key.startsWith('GIT_') && key !== 'HOME' && key !== 'PATH' && key !== 'SSH_AUTH_SOCK')),
    HOME: home, PATH: safePath, TMPDIR: tmp, NODE_ENV: base.NODE_ENV ?? 'test',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_CONFIG_SYSTEM: emptyGitConfig, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file',
    GIT_AUTHOR_NAME: 'Release sim', GIT_AUTHOR_EMAIL: 'release-sim@example.invalid',
    GIT_COMMITTER_NAME: 'Release sim', GIT_COMMITTER_EMAIL: 'release-sim@example.invalid',
    GIT_AUTHOR_DATE: '2026-11-05T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-05T00:00:00Z',
  };
}

let cachedCutTip: string | undefined;
function cutTip(): string {
  // The sim command is registered for root help. Resolve Git only when a
  // release simulation runs so importing its registrar works from any cwd.
  cachedCutTip ??= execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).trim();
  return cachedCutTip;
}


export interface ReleaseSimRigCase {
  id: string;
  mode?: 'baseline' | 'cut-tip-moved-after-resume' | 'approval-graph-path-mismatch' | 'pwa-costly-opt-in-required' | 'cutoff-cli-notes-empty' | 'docs-node-cli-in-sim' | 'gate-waive-introduced-regression' | 'owner-waive-unmeasured-gate' | 'owner-waive-0246-fixture' | 'append-receipt-continuity' | 'macrophage-heal' | 'old-graph-measured-waiver' | 'appended-tip-regate-before-waiver';
  unmeasuredGateShape?: 'stopped' | 'sweep-incomplete' | 'killed';
  fault?: { node: string; outcome: 'fail' | 'error' | 'timeout'; evidence?: Record<string, unknown> };
  nodeOutcomes?: Record<string, { outcome: 'ok' | 'fail' | 'error' | 'unknown'; delayMs?: number }>;
  expect: { status: 'done' | 'failed' | 'resume-refused' | 'awaiting-approval'; mustVisit: string[]; mustNotVisit: string[]; overlap?: [string, string]; refusalIncludes?: string; events?: ReleaseEventExpectation[] };
}

export interface ReleaseSimGateReceiptStage {
  name: string;
  commit: string;
  selectedFiles: string[];
  plan: { carriedShardIds: string[]; rerunShardIds: string[]; fullSweep: boolean };
  receiptIds: string[];
  aggregate: 'complete' | 'unmeasured';
  formalReceiptDecision?: { kind: 'absent'; reason: 'formal-receipt-set-absent' };
  formalGateRun?: { outcome: 'ok' | 'regression' | 'error'; formalReceiptDecision?: string; cutSweepCount: number; fullSweep: boolean; baselineVersion?: string };
  gateOutcome: 'pass' | 'fail' | 'unmeasured';
  publishDecision: 'eligible' | 'blocked';
}

/** Production receipt-radius planner seam. The optional final hook is reserved for p13's gate fault helper. */
export function runReleaseSimGateReceiptSeam(input: {
  tests: string[];
  receipts: readonly GateShardReceipt[];
  priorCommit: string;
  commit: string;
  selectedFiles: string[];
  stage: string;
  formalReceiptInspection?: GateShardReceiptInspection;
  formalGateRun?: ReleaseSimGateReceiptStage['formalGateRun'];
}, finalInjection?: (stage: ReleaseSimGateReceiptStage) => Pick<Partial<ReleaseSimGateReceiptStage>, 'gateOutcome'>): ReleaseSimGateReceiptStage {
  const radius = planGateReceiptRadius({ receipts: input.receipts, tests: input.tests,
    selectedFiles: input.selectedFiles, priorCommit: input.priorCommit });
  const fullSweep = radius === null;
  const carriedShardIds = fullSweep ? [] : radius.unchangedShardIds;
  const rerunShardIds = fullSweep ? input.tests.map((_, index) => `pod-${index}`) : radius.invalidatedShardIds;
  const shards: GateShardIdentity[] = input.tests.map((file, index) => ({ id: `pod-${index}`, files: [file] }));
  const previousById = new Map(input.receipts.map((receipt) => [receipt.id, receipt]));
  const nextReceipts = [
    ...carriedShardIds.map((id) => {
      const previous = previousById.get(id);
      return previous ? { ...previous, head40: input.commit } : null;
    }),
    ...rerunShardIds.map((id) => {
      const index = Number(id.slice(4));
      const file = input.tests[index];
      return file ? simulatedReceipt(id, file, input.commit) : null;
    }),
  ].filter((receipt): receipt is GateShardReceipt => receipt !== null);
  const reduction = reduceGateShardReceipts({ head40: input.commit, base40: SIM_BASE_COMMIT, shards, receipts: nextReceipts });
  const aggregate: ReleaseSimGateReceiptStage['aggregate'] = reduction.status;
  const measuredOutcome: ReleaseSimGateReceiptStage['gateOutcome'] = reduction.status !== 'complete' ? 'unmeasured'
    : reduction.failureIds.length || reduction.errorIds.length ? 'fail' : 'pass';
  const formalGateOutcome: ReleaseSimGateReceiptStage['gateOutcome'] = input.formalGateRun?.outcome === 'regression' ? 'fail'
    : input.formalGateRun?.outcome === 'error' ? 'unmeasured'
      : !input.formalReceiptInspection ? 'pass'
        : !input.formalGateRun ? 'unmeasured'
          : input.formalReceiptInspection.kind === 'invalid'
            || (input.formalReceiptInspection.kind === 'absent' && input.formalGateRun.formalReceiptDecision !== 'formal-receipt-set-absent')
            || (input.formalReceiptInspection.kind === 'valid' && input.formalGateRun.formalReceiptDecision === 'formal-receipt-set-absent')
            ? 'fail' : 'pass';
  const combinedGateOutcome: ReleaseSimGateReceiptStage['gateOutcome'] = measuredOutcome === 'fail' || formalGateOutcome === 'fail' ? 'fail'
    : measuredOutcome === 'unmeasured' || formalGateOutcome === 'unmeasured' ? 'unmeasured' : 'pass';
  const planned: ReleaseSimGateReceiptStage = { name: input.stage, commit: input.commit,
    selectedFiles: [...input.selectedFiles], plan: { carriedShardIds, rerunShardIds, fullSweep },
    receiptIds: reduction.status === 'complete' ? reduction.receipts.map((receipt) => receipt.id) : [],
    ...(input.formalGateRun ? { formalGateRun: input.formalGateRun } : {}),
    ...(input.formalGateRun?.formalReceiptDecision === 'formal-receipt-set-absent'
      ? { formalReceiptDecision: { kind: 'absent' as const, reason: input.formalGateRun.formalReceiptDecision } } : {}),
    aggregate, gateOutcome: combinedGateOutcome, publishDecision: combinedGateOutcome === 'pass' ? 'eligible' : 'blocked' };
  const injected = finalInjection?.(planned);
  const gateOutcome = injected?.gateOutcome ?? planned.gateOutcome;
  return { ...planned, ...injected, gateOutcome, publishDecision: gateOutcome === 'pass' ? 'eligible' : 'blocked' };
}

async function runProductionMissingReceiptGate(root: string, tests: string[], version: string, previousVersion: string): Promise<ReleaseSimGateReceiptStage['formalGateRun']> {
  const repo = join(root, 'release-gate-fixture');
  const instanceRoot = join(root, 'release-gate-instance');
  const ledgerRoot = join(root, 'release-gate-ledger');
  for (const path of [repo, instanceRoot, ledgerRoot]) rmSync(path, { recursive: true, force: true });
  mkdirSync(join(repo, 'apps/pwa'), { recursive: true });
  mkdirSync(join(repo, 'docker/harness'), { recursive: true });
  mkdirSync(join(repo, 'graphs/release'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'release-gate-sim', version }) + '\n');
  writeFileSync(join(repo, 'bun.lock'), 'lockfileVersion = 1\n');
  writeFileSync(join(repo, 'apps/pwa/package.json'), JSON.stringify({ name: 'release-gate-sim-pwa', version }) + '\n');
  writeFileSync(join(repo, 'apps/pwa/bun.lock'), 'lockfileVersion = 1\n');
  writeFileSync(join(repo, 'docker/harness/Dockerfile'), 'FROM ubuntu:24.04\n');
  writeFileSync(join(repo, 'graphs/release/release-loop.yaml'), "  - { node_id: gate, kind: gate, recipe: 'cmd:gate', max_visits: 1 }\n");
  writeFileSync(join(repo, 'graphs/release/recipes.yaml'), "gate:\n  command: 'bun scripts/release-loop/gate-node-cli.ts --json'\n  timeout_ms: 14400000\n");
  for (const file of tests) {
    const path = join(repo, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'import { expect, test } from \'bun:test\'; test(\'simulated shard\', () => expect(true).toBe(true));\n');
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Release sim'); git('config', 'user.email', 'release-sim@example.invalid');
  git('add', '.'); git('commit', '-qm', 'release simulation baseline');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'simulation-tip.txt'), 'append\n');
  git('add', '.'); git('commit', '-qm', 'release simulation cut');
  const commit = git('rev-parse', 'HEAD');
  mkdirSync(join(instanceRoot, 'release', previousVersion), { recursive: true });
  writeFileSync(join(instanceRoot, 'release', previousVersion, 'release.json'), JSON.stringify({ sourceCommit: base }));
  const graphRunId = 'release-sim-formal-receipt-absent';
  const pins = gateSourcePins(repo, commit);
  if (!pins) throw new Error('release simulation gate graph pins unavailable');
  mkdirSync(join(instanceRoot, 'graph-runs', 'release-loop'), { recursive: true });
  writeFileSync(join(instanceRoot, 'graph-runs', 'release-loop', `${graphRunId}.json`), JSON.stringify({
    graphId: 'release-loop', runId: graphRunId, graphSnapshot: { graphSha: pins.graphSha, recipeSha: pins.recipeSha },
  }));
  const cutSweeps: boolean[] = [];
  const ok = { rc: 0, output: '' };
  const runner: GateRunner = {
    async command() { return ok; }, async localCommand() { return ok; },
    async sweep(tree, _logDir, _pod, only) {
      if (tree.endsWith('/cut')) cutSweeps.push(!only);
      const count = only?.length ?? tests.length;
      return { rc: 0, output: `${count} pass\n0 fail\nRan ${count} tests across ${count} files.\n` };
    },
    async add() {}, async remove() {}, async snapshot() {}, async removeSnapshot() {},
  };
  const previousConfig = getElanousConfigDirOverride();
  if (previousConfig) resetElanousConfigDir();
  try {
    const runtime = { bunVersion: '1.4.2', platform: 'linux', architecture: 'x64', envFingerprint: gateEnvFingerprint(process.env),
      baseImageDigest: 'sha256:' + 'd'.repeat(64) };
    const result = await judgeGate({ commit, version, baselineVersion: previousVersion, baselineCommit: base, graphRunId,
      repo, instanceRoot, ledgerRoot, pod: { pool: 'pool-test', shards: 1 } }, runner, () => SIM_IMAGE_DIGEST, () => ({ ...runtime, imageDigest: SIM_IMAGE_DIGEST }));
    return { outcome: result.outcome, formalReceiptDecision: result.formalReceiptDecision, baselineVersion: previousVersion,
      cutSweepCount: cutSweeps.length, fullSweep: cutSweeps.length === 1 && cutSweeps[0] === true };
  } finally { if (previousConfig) setElanousConfigDir(previousConfig); }
}

const SIM_BASE_COMMIT = 'b'.repeat(40);
const SIM_IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`;
const SIM_ENV_FINGERPRINT = 'c'.repeat(64);
const SIM_RUNTIME_IDENTITY = { bunVersion: '1.4.2', platform: 'linux', architecture: 'x64', envFingerprint: SIM_ENV_FINGERPRINT,
  baseImageDigest: `sha256:${'d'.repeat(64)}` };
const SIM_LOCKFILE_BODY = 'lockfileVersion = 1\n';
const SIM_LOCKFILE_HASH = createHash('sha256').update(Buffer.concat([
  Buffer.from(SIM_LOCKFILE_BODY), Buffer.from('\0'), Buffer.from(SIM_LOCKFILE_BODY), Buffer.from('\0'),
])).digest('hex');
const SIM_TEST_SOURCE = "import { expect, test } from 'bun:test'; test('saved shard', () => expect(true).toBe(true));\n";
const SIM_TEST_HASH = createHash('sha256').update(SIM_TEST_SOURCE).digest('hex');

function simulatedReceipt(id: string, file: string, commit: string): GateShardReceipt {
  return { id, files: [file], version: '0.3.1', graphSha: '0'.repeat(64), recipeSha: '1'.repeat(64),
    graphEntry: 'release-sim-gate', recipeCommand: 'simulated gate receipt', recipeTimeoutMs: 1000,
    head40: commit, base40: SIM_BASE_COMMIT, host: 'sim-host', imageDigest: SIM_IMAGE_DIGEST,
    runtimeIdentity: SIM_RUNTIME_IDENTITY, envFingerprint: SIM_ENV_FINGERPRINT,
    lockfileHash: SIM_LOCKFILE_HASH, testedFileHashes: { [file]: SIM_TEST_HASH },
    envKey: gateShardRuntimeIdentityKey(SIM_RUNTIME_IDENTITY, SIM_LOCKFILE_HASH)!,
    executions: [{ branch: 'test-release', attemptId: `sim-${id}-${commit.slice(0, 8)}`, host: 'sim-host',
      imageDigest: SIM_IMAGE_DIGEST, runtimeIdentity: SIM_RUNTIME_IDENTITY }],
    status: 'complete', failureIds: [], errorIds: [], evidencePath: `sim/${id}-${commit.slice(0, 8)}.json`,
    evidenceSha256: '2'.repeat(64), measuredAt: '2026-11-04T00:00:00.000Z', attempt: 1 };
}

async function simulatePersistedSameCommitCarry(root: string, version: string) {
  const repo = join(root, 'ux-sim', 'same-commit-gate-repo');
  const receiptRoot = join(root, 'ux-sim', 'same-commit-receipts');
  const tests = Array.from({ length: 4 }, (_, index) => `test/gate-shard-${index}.test.ts`);
  const shards = tests.map((file, index) => ({ id: `pod-${index}`, files: [file] }));
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, 'apps', 'pwa'), { recursive: true });
  writeFileSync(join(repo, 'bun.lock'), SIM_LOCKFILE_BODY);
  writeFileSync(join(repo, 'apps', 'pwa', 'bun.lock'), SIM_LOCKFILE_BODY);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'same-commit-gate-sim', version }) + '\n');
  for (const file of tests) {
    const path = join(repo, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, SIM_TEST_SOURCE);
  }
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Release sim'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'release-sim@example.invalid'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'same-commit receipt source'], { cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-11-05T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-05T00:00:00Z' } });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  for (const shard of shards) {
    saveGateShardResult(receiptRoot, { receipt: { ...simulatedReceipt(shard.id, shard.files[0]!, commit), version }, runs: [{
      output: '1 pass\n0 fail\nRan 1 test across 1 file.\n', rc: 0, pass: 1, fail: 0, errors: 0, ran: 1, files: 1,
      passedIds: [`${shard.files[0]} > carries prior result`],
    }] });
  }
  const expected = { version, commit, base40: SIM_BASE_COMMIT, envFingerprint: SIM_ENV_FINGERPRINT,
    runtimeIdentity: SIM_RUNTIME_IDENTITY, lockHash: SIM_LOCKFILE_HASH,
    graphPins: { graphSha: '0'.repeat(64), recipeSha: '1'.repeat(64) }, graphEntry: 'release-sim-gate',
    recipeCommand: 'simulated gate receipt', recipeTimeoutMs: 1000, shards, tests };
  const inspection = inspectGateShardReceipts(receiptRoot, expected);
  const events: Array<Record<string, unknown>> = [{ event: 'receipt-preflight', kind: inspection.kind,
    receiptCount: inspection.kind === 'valid' ? inspection.receipts.length : 0 }];
  let podCalls = 0;
  const command: GateRunner['command'] = async (cmd, args, cwd) => {
    const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return { rc: result.status ?? 2, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
  };
  const runner = createGateRunner(repo, undefined, command, async () => {
    podCalls++;
    return { exitCode: 2, artifactsDir: '', job: 'unexpected-pod' };
  }, new PodPoolScheduler([{ context: 'sim-host', capacity: 4, k3dCluster: 'release-sim' }]));
  const progress: Array<{ executor: 'host' | 'pod'; groups: readonly { id: string; state: string; host?: string }[] }> = [];
  const result = await runner.sweep(repo, undefined, { pool: 'sim-pool', shards: 4, isolationConcurrency: 1,
    shardsFile: { path: join(root, 'ux-sim', 'same-commit-shards.json'), version, receiptRoot, base40: SIM_BASE_COMMIT,
      envFingerprint: SIM_ENV_FINGERPRINT, expectedImageDigest: SIM_IMAGE_DIGEST,
      graphPins: { ...expected.graphPins, graphEntry: expected.graphEntry, recipeCommand: expected.recipeCommand, recipeTimeoutMs: expected.recipeTimeoutMs },
      executionIdentity: { ...SIM_RUNTIME_IDENTITY, imageDigest: SIM_IMAGE_DIGEST } },
  }, undefined, (row) => { progress.push(row); });
  const doneIds = [...new Set(progress.flatMap((row) => row.groups.filter((group) => group.state === 'done').map((group) => group.id)))].sort();
  const carriedShardIds = podCalls === 0 && result.rc === 0 ? doneIds : [];
  for (const shardId of carriedShardIds) events.push({ event: 'shard-carried', shardId });
  events.push({ event: 'gate-sweep-complete', rc: result.rc, totalPods: podCalls, output: result.output.trim() });
  return { commit, expectedCarry: shards.map((shard) => shard.id), inspectionKind: inspection.kind,
    inspectedReceiptCount: inspection.kind === 'valid' ? inspection.receipts.length : 0,
    carriedShardIds, rerunShardIds: podCalls > 0 ? shards.map((shard) => shard.id) : [], totalPods: podCalls, output: result.output, events };
}

async function runAppendReceiptCase(scenario: ReleaseSimRigScenario, item: ReleaseSimRigCase, root: string): Promise<ReleaseSimRigCaseResult> {
  const tests = Array.from({ length: 81 }, (_, index) => `test/shard-${String(index).padStart(2, '0')}.test.ts`);
  const cut = 'a'.repeat(40), appendA = 'c'.repeat(40), appendB = 'd'.repeat(40);
  const graphId = `release-sim-${scenario.id}-append-continuity`;
  const nodeSequence = ['cut', 'gate-cut', 'append-a', 'resume-a', 'gate-a', 'append-b', 'resume-b', 'gate-b', 'publish', 'done'];
  const graphPath = join(root, 'ux-sim', 'simulation-graphs', `${graphId}.yaml`);
  mkdirSync(join(root, 'ux-sim', 'simulation-graphs'), { recursive: true });
  const graph = `graph_id: ${graphId}\nversion: 1\nentry_node: cut\nterminal_nodes: [done, failed]\nnodes:\n`
    + nodeSequence.map((nodeId) => `  - { node_id: ${nodeId}, kind: gate, recipe: 'cmd:simulated', max_visits: 1 }\n`).join('')
    + '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n'
    + nodeSequence.slice(0, -1).map((from, index) => `  - { from: ${from}, on: outcome, map: { ok: ${nodeSequence[index + 1]}, fail: failed, error: failed } }\n`).join('');
  writeFileSync(graphPath, graph);
  writeFileSync(join(dirname(graphPath), 'recipes.yaml'), 'simulated:\n  command: "simulated release node"\n');
  const edges = new Map<string, Record<string, unknown>>(nodeSequence.slice(0, -1).map((from, index) => [from,
    { map: { ok: nodeSequence[index + 1], fail: 'failed', error: 'failed' } }]));
  const ledgerEvents: Array<Record<string, unknown>> = [];
  const eventBus = createReleaseTraceBus(ledgerEvents);
  const formalReceiptDir = join(root, 'release', scenario.input.version, 'gate-logs', 'cut', 'receipts');
  mkdirSync(formalReceiptDir, { recursive: true });
  const formalReceiptInspection = inspectGateShardReceipts(formalReceiptDir, { version: scenario.input.version, commit: cut,
    base40: SIM_BASE_COMMIT, envFingerprint: SIM_ENV_FINGERPRINT, runtimeIdentity: SIM_RUNTIME_IDENTITY, lockHash: SIM_LOCKFILE_HASH,
    graphPins: { graphSha: '0'.repeat(64), recipeSha: '1'.repeat(64) },
    graphEntry: 'release-sim-gate', recipeCommand: 'simulated gate receipt', recipeTimeoutMs: 1000,
    shards: tests.map((file, index) => ({ id: `pod-${index}`, files: [file] })), tests });
  const formalGateRun = await runProductionMissingReceiptGate(root, tests, scenario.input.version, scenario.input.previousVersion);
  let currentCommit = cut;
  let previousCommit = cut;
  let selectedFiles: string[] = [];
  let receipts: GateShardReceipt[] = [];
  const stages: ReleaseSimGateReceiptStage[] = [];
  const runBash = async (_command: string, options: { env?: NodeJS.ProcessEnv }) => {
    const { nodeId } = parseContext(options.env ?? process.env);
    if (nodeId === 'append-a') { previousCommit = cut; currentCommit = appendA; selectedFiles = [tests[0]!]; }
    if (nodeId === 'append-b') { previousCommit = appendA; currentCommit = appendB; selectedFiles = [tests[1]!]; }
    if (nodeId === 'resume-a' || nodeId === 'resume-b') {
      ledgerEvents.push({ event: 'resume', stage: nodeId, priorCommit: previousCommit, commit: currentCommit, selectedFiles: [...selectedFiles], radiusOnly: true });
    }
    if (nodeId.startsWith('gate-')) {
      const stage = runReleaseSimGateReceiptSeam({ stage: nodeId, tests, receipts,
      priorCommit: previousCommit, commit: currentCommit, selectedFiles,
        ...(nodeId === 'gate-cut' ? { formalReceiptInspection, formalGateRun } : {}) });
      stages.push(stage);
      receipts = [...receipts.filter((receipt) => stage.plan.carriedShardIds.includes(receipt.id)).map((receipt) => ({ ...receipt, head40: currentCommit })),
        ...stage.plan.rerunShardIds.map((id) => simulatedReceipt(id, tests[Number(id.slice(4))]!, currentCommit))];
      const output = { outcome: stage.gateOutcome === 'pass' ? 'ok' : stage.gateOutcome === 'fail' ? 'fail' : 'error', stage };
      ledgerEvents.push({ event: 'gate-result', stage });
      return { exitCode: stage.gateOutcome === 'pass' ? 0 : stage.gateOutcome === 'fail' ? 1 : 2, stdout: `${JSON.stringify(output)}\n`, stderr: '' };
    }
    if (nodeId === 'publish') {
      const eligible = stages.at(-1)?.publishDecision === 'eligible';
      ledgerEvents.push({ event: 'fake-publish-decision', decision: eligible ? 'eligible' : 'blocked' });
      return { exitCode: eligible ? 0 : 1, stdout: `${JSON.stringify({ outcome: eligible ? 'ok' : 'fail', decision: eligible ? 'eligible' : 'blocked' })}\n`, stderr: '' };
    }
    if (nodeId === 'append-a' || nodeId === 'append-b') ledgerEvents.push({ event: 'append', stage: nodeId, commit: currentCommit, selectedFiles: [...selectedFiles] });
    return { exitCode: 0, stdout: `${JSON.stringify({ outcome: 'ok', nodeId, commit: currentCommit })}\n`, stderr: '' };
  };
  const capture = (event: string, data: Record<string, unknown>) => ledgerEvents.push({ event, ...data });
  const state = await runGraph(graphPath, { runId: graphId, input: { version: scenario.input.version, previousVersion: scenario.input.previousVersion },
    pinChildUniverse: true, quiet: true, eventBus, deps: { root, runBash, log: capture } });
  const path = state.path;
  const visited = new Set([...path, ...Object.values(state.fanOuts ?? {}).flatMap((fanout) => Object.keys(fanout.branches))]);
  const statusOk = state.status === item.expect.status;
  const visitOk = item.expect.mustVisit.every((id) => visited.has(id));
  const notVisitOk = item.expect.mustNotVisit.every((id) => !visited.has(id));
  const edgeIssues = unexpectedEdges(path, state, edges);
  const receiptCase = stages[0], appendStageA = stages[1], appendStageB = stages[2];
  const sameCommitResume = await simulatePersistedSameCommitCarry(root, scenario.input.version);
  const carryRegressionFixture = {
    source: 'OPT #35384 draft body + preserved AWS evidence',
    expected: { carriedShardIds: ['pod-0', 'pod-1', 'pod-2', 'pod-3'], rerunShardIds: [], totalPods: 0 },
    draftObserved: { head40: 'd79513b192c591a82c89ed80a617af4b314c9337', host: 'node-b', rerunShardIds: ['pod-0', 'pod-1', 'pod-2'], totalPods: 3 },
    optObserved: { head40: 'acb26b11af8dac1b4592d9b0f5081a5d48005212', host: 'aws1', cohort: 2,
      introduced: 1, preexisting: 3, failedIdentity: 'gate-radius-live.test.ts > GATE-RECEIPT-CARRY-ANY-RUN sim: regression + focused side pass carries across append-free resume; image drift remeasures all',
      reason: 'pinned graph or recipe SHA absent' },
  };
  const sameCommitCarryOk = sameCommitResume.inspectionKind === 'valid' && sameCommitResume.inspectedReceiptCount === 4
    && JSON.stringify(sameCommitResume.carriedShardIds) === JSON.stringify(sameCommitResume.expectedCarry)
    && sameCommitResume.rerunShardIds.length === 0 && sameCommitResume.totalPods === 0
    && sameCommitResume.output.includes('Ran 4 tests across 4 files.')
    && sameCommitResume.events[1]?.event === 'shard-carried'
    && sameCommitResume.events.filter((event) => event.event === 'shard-carried').length === 4;
  const receiptFlowOk = !!receiptCase && receiptCase.formalReceiptDecision?.reason === 'formal-receipt-set-absent'
    && receiptCase.formalGateRun?.formalReceiptDecision === 'formal-receipt-set-absent'
    && receiptCase.formalGateRun.outcome === 'ok' && receiptCase.formalGateRun.fullSweep
    && formalReceiptInspection.kind === 'absent' && receiptCase.plan.fullSweep && receiptCase.plan.rerunShardIds.length === 81
    && receiptCase.aggregate === 'complete' && receiptCase.receiptIds.length === 81
    && appendStageA?.plan.carriedShardIds.length === 80 && appendStageA.plan.rerunShardIds.join() === 'pod-0'
    && appendStageA.aggregate === 'complete' && appendStageA.receiptIds.length === 81
    && appendStageB?.plan.carriedShardIds.length === 80 && appendStageB.plan.rerunShardIds.join() === 'pod-1'
    && appendStageB.aggregate === 'complete' && appendStageB.receiptIds.length === 81;
  const publishOk = stages.at(-1)?.publishDecision === 'eligible' && path.includes('publish');
  const ledgerOk = ledgerEvents.some((row) => row.event === 'node-start') && ledgerEvents.some((row) => row.event === 'node-end')
    && ledgerEvents.some((row) => row.event === 'append') && ledgerEvents.filter((row) => row.event === 'resume').length === 2;
  const eventTrace = checkExpectedEvents(item.expect.events, ledgerEvents);
  const pass = statusOk && visitOk && notVisitOk && receiptFlowOk && sameCommitCarryOk && publishOk && ledgerOk && (eventTrace?.pass ?? true) && edgeIssues.length === 0;
  return { id: item.id, pass, status: state.status, path, dispatchedNodes: path.filter((node) => nodeSequence.includes(node)),
    unexpectedEdges: edgeIssues, checks: { status: statusOk, mustVisit: visitOk, mustNotVisit: notVisitOk, overlap: true, ledgerEvents: ledgerOk, ...(eventTrace ? { events: eventTrace.pass } : {}) },
    injectedEvidence: { universe: 'test', releaseVersion: scenario.input.version, formalReceiptInspection, receiptCase, appendA: appendStageA, appendB: appendStageB,
      sameCommitResume, sameCommitCarryOk, carryRegressionFixture, appendedOnlyChangedTestRadius: receiptFlowOk, fakePublish: stages.at(-1)?.publishDecision,
      executionStatePath: state.statePath, ...(eventTrace ? { eventTrace } : {}) }, fanOuts: state.fanOuts, ledgerEvents, statePath: state.statePath };
}

export interface ReleaseSimRigScenario {
  version: 1;
  kind: 'release-graph';
  id: string;
  isolation: 'test';
  input: { version: string; previousVersion: string; releaseGateFanout?: boolean };
  cases: ReleaseSimRigCase[];
}

export interface ReleaseSimRigCaseResult {
  id: string;
  pass: boolean;
  status: string;
  path: string[];
  dispatchedNodes: string[];
  unexpectedEdges: Array<{ from: string; to: string; outcome: string; expectedTo?: string }>;
  checks: { status: boolean; mustVisit: boolean; mustNotVisit: boolean; overlap: boolean; ledgerEvents: boolean; events?: boolean; adaptiveRepair?: boolean };
  fanOuts?: GraphRunState['fanOuts'];
  nodeTimings?: Record<string, { startedAtMs: number; endedAtMs: number }>;
  injectedEvidence: Record<string, unknown>;
  ledgerEvents: Array<Record<string, unknown>>;
  statePath: string;
  refusal?: string;
}

function unexpectedEdges(path: string[], state: GraphRunState, edges: Map<string, Record<string, unknown>>): ReleaseSimRigCaseResult['unexpectedEdges'] {
  const nodes = new Map(state.nodes.map((node) => [node.nodeId, node]));
  const issues: ReleaseSimRigCaseResult['unexpectedEdges'] = [];
  for (let index = 0; index + 1 < path.length; index++) {
    const from = path[index]!;
    const to = path[index + 1]!;
    const adaptiveAppend = state.adaptiveGateNodeAppends?.some(({ request }) =>
      (from === request.afterNodeId && to === request.node.nodeId)
      || (from === request.node.nodeId && to === request.rerunGateAt));
    if (adaptiveAppend) continue;
    const edge = edges.get(from);
    if (edge?.branches && edge.join === to) continue; // The runner records a fan-out's barrier as the parent-path successor.
    const output = nodes.get(from)?.output;
    let parsed: Record<string, unknown> = {};
    if (typeof output === 'string') {
      try { parsed = record(JSON.parse(output.trim().split('\n').at(-1) ?? ''), `${from} output`); } catch { /* use runner fallback below */ }
    } else if (output && typeof output === 'object' && !Array.isArray(output)) parsed = output as Record<string, unknown>;
    const named = typeof parsed.outcome === 'string' ? parsed.outcome : nodes.get(from)?.ok ? 'ok' : 'fail';
    const map = edge?.map && typeof edge.map === 'object' ? edge.map as Record<string, unknown> : {};
    const mappedOutcome = named === 'pass(owner-waived)' ? 'ok' : named;
    const expectedTo = typeof map[mappedOutcome] === 'string' ? map[mappedOutcome] as string : typeof map[mappedOutcome === 'ok' ? 'ok' : 'fail'] === 'string'
      ? map[mappedOutcome === 'ok' ? 'ok' : 'fail'] as string : undefined;
    if (expectedTo !== to) issues.push({ from, to, outcome: named, ...(expectedTo ? { expectedTo } : {}) });
  }
  return issues;
}

function recordObservedEdges(path: string[], events: Array<Record<string, unknown>>): void {
  for (let index = 0; index + 1 < path.length; index++) {
    events.push({ event: 'edge-observed', from: path[index], to: path[index + 1], source: 'release-run-path' });
  }
}

function checkExpectedEvents(expected: ReleaseEventExpectation[] | undefined, actual: Array<Record<string, unknown>>) {
  const graphBusTrace = actual.filter((row) => row.observedBy === 'GraphEventBus');
  return expected ? checkReleaseEventTrace(graphBusTrace as ReleaseEventRecord[], expected) : undefined;
}

function createReleaseTraceBus(events: Array<Record<string, unknown>>): GraphEventBus {
  const bus = createGraphEventBus();
  bus.subscribe((event: GraphEvent) => {
    events.push({ event: event.type, graphId: event.graphId, runId: event.runId,
      ...(event.source.nodeId === undefined ? {} : { nodeId: event.source.nodeId }),
      ...event.data, eventId: event.eventId, sequence: event.sequence, observedBy: 'GraphEventBus' });
  });
  return bus;
}

export interface ReleaseSimRigResult {
  id: string;
  pass: boolean;
  universe: string;
  cases: ReleaseSimRigCaseResult[];
  table: Array<{ scenario: string; path: string; status: string; unexpectedEdges: string }>;
  artifactPath: string;
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function outputRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return undefined;
  try { return record(JSON.parse(value.trim().split('\n').at(-1) ?? ''), 'node output'); }
  catch { return undefined; }
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`${where} has unsupported key(s): ${extra.join(', ')}`);
}

function stringList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${where} must be an array of non-empty strings`);
  }
  return value as string[];
}

function releaseGraphShape(fanout = false): { nodeIds: Set<string>; edges: Map<string, Record<string, unknown>> } {
  const graphPath = fanout ? join(dirname(RELEASE_GRAPH), 'release-loop-fanout.yaml') : RELEASE_GRAPH;
  const parsed = parseGraphTemplateYaml(readFileSync(graphPath, 'utf8'));
  if (!parsed.template || parsed.errors.length) throw new Error(`release graph is invalid: ${parsed.errors.map((issue) => issue.message).join('; ')}`);
  const nodeIds = new Set(parsed.template.nodes.map((node) => node.nodeId));
  const edges = new Map<string, Record<string, unknown>>();
  for (const edge of parsed.template.edges) {
    const mapped = !!edge.map && typeof edge.map === 'object';
    const branched = !!edge.branches && typeof edge.branches === 'object' && typeof edge.join === 'string';
    if (typeof edge.from !== 'string' || edge.on !== 'outcome' || (!mapped && !branched)) {
      throw new Error('release simulation requires outcome edges with explicit maps or fan-out joins');
    }
    if (edges.has(edge.from)) throw new Error(`release graph has multiple outcome edges from ${edge.from}`);
    edges.set(edge.from, edge as unknown as Record<string, unknown>);
  }
  return { nodeIds, edges };
}

export function parseReleaseSimRigScenario(source: string): ReleaseSimRigScenario {
  const root = record(parseYaml(source), 'release simulation scenario');
  exactKeys(root, ['version', 'kind', 'id', 'isolation', 'input', 'cases'], 'release simulation scenario');
  if (root.version !== 1 || root.kind !== 'release-graph' || root.isolation !== 'test') {
    throw new Error('release simulation scenario requires version: 1, kind: release-graph, isolation: test');
  }
  if (typeof root.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(root.id)) throw new Error('scenario.id must be lowercase letters, digits, and hyphens');
  const input = record(root.input, 'scenario.input');
  exactKeys(input, ['version', 'previousVersion', 'releaseGateFanout'], 'scenario.input');
  if (input.releaseGateFanout !== undefined && typeof input.releaseGateFanout !== 'boolean') {
    throw new Error('scenario.input.releaseGateFanout must be boolean');
  }
  if (typeof input.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(input.version)
    || typeof input.previousVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(input.previousVersion)) {
    throw new Error('scenario.input requires release version and previousVersion');
  }
  const rawCases = root.cases;
  if (!Array.isArray(rawCases) || rawCases.length === 0 || rawCases.length > 32) throw new Error('scenario.cases must contain 1–32 cases');
  const { nodeIds } = releaseGraphShape(input.releaseGateFanout === true);
  const ids = new Set<string>();
  const cases = rawCases.map((raw, index): ReleaseSimRigCase => {
    const row = record(raw, `scenario.cases[${index}]`);
    exactKeys(row, ['id', 'mode', 'fault', 'nodeOutcomes', 'unmeasuredGateShape', 'expect'], `scenario.cases[${index}]`);
    if (typeof row.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.id) || ids.has(row.id)) throw new Error(`scenario.cases[${index}].id must be unique lowercase text`);
    ids.add(row.id);
    let mode: ReleaseSimRigCase['mode'];
    if (row.mode !== undefined) {
      if (row.mode !== 'baseline' && row.mode !== 'cut-tip-moved-after-resume' && row.mode !== 'approval-graph-path-mismatch' && row.mode !== 'pwa-costly-opt-in-required' && row.mode !== 'cutoff-cli-notes-empty' && row.mode !== 'docs-node-cli-in-sim' && row.mode !== 'gate-waive-introduced-regression' && row.mode !== 'owner-waive-unmeasured-gate' && row.mode !== 'owner-waive-0246-fixture' && row.mode !== 'append-receipt-continuity' && row.mode !== 'macrophage-heal' && row.mode !== 'old-graph-measured-waiver' && row.mode !== 'appended-tip-regate-before-waiver') throw new Error(`scenario.cases[${index}].mode is unregistered`);
      mode = row.mode;
    }
    const unmeasuredGateShape = row.unmeasuredGateShape;
    if (unmeasuredGateShape !== undefined && unmeasuredGateShape !== 'stopped' && unmeasuredGateShape !== 'sweep-incomplete' && unmeasuredGateShape !== 'killed') {
      throw new Error(`scenario.cases[${index}].unmeasuredGateShape is unregistered`);
    }
    if (unmeasuredGateShape !== undefined && mode !== 'owner-waive-unmeasured-gate') throw new Error(`scenario.cases[${index}].unmeasuredGateShape requires owner-waive-unmeasured-gate mode`);
    let fault: ReleaseSimRigCase['fault'];
    if (row.fault !== undefined) {
      const parsed = record(row.fault, `scenario.cases[${index}].fault`);
      exactKeys(parsed, ['node', 'outcome', 'evidence'], `scenario.cases[${index}].fault`);
      if (typeof parsed.node !== 'string' || !nodeIds.has(parsed.node)) throw new Error(`scenario.cases[${index}].fault.node is not in the release graph`);
      if (parsed.outcome !== 'fail' && parsed.outcome !== 'error' && parsed.outcome !== 'timeout') throw new Error(`scenario.cases[${index}].fault.outcome is unregistered`);
      fault = { node: parsed.node, outcome: parsed.outcome, ...(parsed.evidence === undefined ? {} : { evidence: record(parsed.evidence, `scenario.cases[${index}].fault.evidence`) }) };
    }
    if ((mode === undefined) === (fault === undefined)) throw new Error(`scenario.cases[${index}] requires exactly one of mode or fault`);
    const nodeOutcomes: ReleaseSimRigCase['nodeOutcomes'] = {};
    if (row.nodeOutcomes !== undefined) {
      const rawOutcomes = record(row.nodeOutcomes, `scenario.cases[${index}].nodeOutcomes`);
      for (const [node, value] of Object.entries(rawOutcomes)) {
        if (!nodeIds.has(node)) throw new Error(`scenario.cases[${index}].nodeOutcomes names unknown release node ${node}`);
        const injection = record(value, `scenario.cases[${index}].nodeOutcomes.${node}`);
        exactKeys(injection, ['outcome', 'delayMs'], `scenario.cases[${index}].nodeOutcomes.${node}`);
        if (injection.outcome !== 'ok' && injection.outcome !== 'fail' && injection.outcome !== 'error' && injection.outcome !== 'unknown') throw new Error(`scenario.cases[${index}].nodeOutcomes.${node}.outcome is invalid`);
        if (injection.delayMs !== undefined && (!Number.isSafeInteger(injection.delayMs) || (injection.delayMs as number) < 0 || (injection.delayMs as number) > 60_000)) throw new Error(`scenario.cases[${index}].nodeOutcomes.${node}.delayMs must be 0–60000`);
        nodeOutcomes[node] = { outcome: injection.outcome, ...(injection.delayMs === undefined ? {} : { delayMs: injection.delayMs as number }) };
      }
    }
    const expected = record(row.expect, `scenario.cases[${index}].expect`);
    exactKeys(expected, ['status', 'mustVisit', 'mustNotVisit', 'overlap', 'refusalIncludes', 'events'], `scenario.cases[${index}].expect`);
    if (expected.status !== 'done' && expected.status !== 'failed' && expected.status !== 'resume-refused' && expected.status !== 'awaiting-approval') throw new Error(`scenario.cases[${index}].expect.status is invalid`);
    const mustVisit = stringList(expected.mustVisit, `scenario.cases[${index}].expect.mustVisit`);
    const mustNotVisit = stringList(expected.mustNotVisit, `scenario.cases[${index}].expect.mustNotVisit`);
    const refusalIncludes = expected.refusalIncludes;
    if (refusalIncludes !== undefined && (typeof refusalIncludes !== 'string' || !refusalIncludes.trim())) throw new Error(`scenario.cases[${index}].expect.refusalIncludes must be nonempty text`);
    let overlap: [string, string] | undefined;
    if (expected.overlap !== undefined) {
      const pair = stringList(expected.overlap, `scenario.cases[${index}].expect.overlap`);
      if (pair.length !== 2 || pair[0] === pair[1] || pair.some((id) => !nodeIds.has(id))) throw new Error(`scenario.cases[${index}].expect.overlap must name two different release nodes`);
      overlap = [pair[0]!, pair[1]!];
    }
    let events: ReleaseEventExpectation[] | undefined;
    if (expected.events !== undefined) {
      if (!Array.isArray(expected.events)) throw new Error(`scenario.cases[${index}].expect.events must be an array`);
      events = expected.events.map((rawEvent, eventIndex) => {
        const event = record(rawEvent, `scenario.cases[${index}].expect.events[${eventIndex}]`);
        if (Object.hasOwn(event, 'concurrent')) {
          exactKeys(event, ['concurrent'], `scenario.cases[${index}].expect.events[${eventIndex}]`);
          if (!Array.isArray(event.concurrent) || event.concurrent.length === 0) throw new Error(`scenario.cases[${index}].expect.events[${eventIndex}].concurrent must be a non-empty array`);
          return { concurrent: event.concurrent.map((rawMember, memberIndex) => {
            const member = record(rawMember, `scenario.cases[${index}].expect.events[${eventIndex}].concurrent[${memberIndex}]`);
            if (typeof member.event !== 'string' || member.event.trim() === '') throw new Error(`scenario.cases[${index}].expect.events[${eventIndex}] requires event names`);
            return member as ReleaseEventRecord;
          }) };
        }
        if (typeof event.event !== 'string' || event.event.trim() === '') throw new Error(`scenario.cases[${index}].expect.events[${eventIndex}] requires an event name`);
        return event as ReleaseEventRecord;
      });
    }
    const expectedNodeIds = mode === 'append-receipt-continuity' ? new Set([...nodeIds, ...RECEIPT_SIM_NODE_IDS]) : nodeIds;
    for (const id of [...mustVisit, ...mustNotVisit]) if (!expectedNodeIds.has(id)) throw new Error(`scenario.cases[${index}] names unknown release node ${id}`);
    if (mustVisit.some((id) => mustNotVisit.includes(id))) throw new Error(`scenario.cases[${index}] visits and excludes the same node`);
    return { id: row.id, ...(mode ? { mode } : {}), ...(fault ? { fault } : {}), ...(Object.keys(nodeOutcomes).length ? { nodeOutcomes } : {}),
      ...(unmeasuredGateShape ? { unmeasuredGateShape } : {}),
      expect: { status: expected.status, mustVisit, mustNotVisit, ...(overlap ? { overlap } : {}), ...(typeof refusalIncludes === 'string' ? { refusalIncludes } : {}), ...(events ? { events } : {}) } };
  });
  return { version: 1, kind: 'release-graph', id: root.id, isolation: 'test',
    input: { version: input.version, previousVersion: input.previousVersion, ...(input.releaseGateFanout === true ? { releaseGateFanout: true } : {}) }, cases };
}

function parseContext(env: NodeJS.ProcessEnv): { nodeId: string; executionId: string } {
  const location = env.ELANOUS_GRAPH_CONTEXT;
  if (!location) throw new Error('ELANOUS_GRAPH_CONTEXT missing in release simulation');
  const context = record(JSON.parse(readFileSync(location, 'utf8')), 'release graph context');
  if (typeof context.nodeId !== 'string') throw new Error('release graph context nodeId missing');
  if (typeof context.executionId !== 'string') throw new Error('release graph context executionId missing');
  return { nodeId: context.nodeId, executionId: context.executionId };
}

type SimulatedNodeFault = NonNullable<ReleaseSimRigCase['fault']> | { node: string; outcome: 'unknown'; evidence?: Record<string, unknown> };

function resultForNode(nodeId: string, fault: SimulatedNodeFault | undefined, version: string): { exitCode: number; stdout: string; stderr: string; evidence: Record<string, unknown> } {
  const triggeredFault = fault?.node === nodeId ? fault : undefined;
  const outcome = triggeredFault ? triggeredFault.outcome === 'timeout' ? 'error' : triggeredFault.outcome : 'ok';
  const evidence = triggeredFault?.evidence ?? {};
  const commit = nodeId === 'version-release' ? { commit: cutTip(), tag: `v${version}` } : {};
  const introduced = Array.isArray(evidence.introduced) && evidence.introduced.every((id) => typeof id === 'string')
    ? evidence.introduced as string[] : [];
  // Triage is production code, so its simulated gate input must satisfy the
  // same GateResult contract as runGate. Attribution gaps are errors with no
  // introduced IDs; measured regressions require explicit identities.
  const gateOutput = nodeId === 'gate' && triggeredFault && evidence.realGateTriage === true ? {
    commit: cutTip(), introduced, preexisting: 0, fixed: null, knownEnv: 0, knownEnvCleared: [], stalledEnv: [],
    durationMs: 1, ...(outcome === 'fail' && introduced.length > 0 ? { outcome: 'fail', autoheal: { action: 'hitl', cause: 'true-regression',
      shardKey: 'gate', reason: 'measured regression requires a human decision', shardElapsedMs: 1, overallElapsedMs: 1 } }
      : outcome === 'error' ? { outcome: 'error', error: String(evidence.error ?? 'failure attribution incomplete') } : {}),
  } : {};
  const payload = { outcome, verdict: outcome === 'ok' ? 'pass' : 'fail', summary: triggeredFault ? `simulated ${triggeredFault.outcome}` : `simulated ${nodeId} success`, ...commit, ...gateOutput,
    simulation: { injected: triggeredFault !== undefined, node: nodeId, evidence } };
  return { exitCode: !triggeredFault || triggeredFault.outcome === 'unknown' ? 0 : triggeredFault.outcome === 'fail' ? 1 : triggeredFault.outcome === 'timeout' ? 124 : 2,
    stdout: `${JSON.stringify(payload)}\n`, stderr: triggeredFault ? `SIMULATED_${triggeredFault.outcome.toUpperCase()}` : '', evidence };
}

interface SharedUnmeasuredGateFixture {
  runId: string;
  state?: GraphRunState;
  snapshotRoot?: string;
  dispatchedNodes?: string[];
  ledgerEvents?: Array<Record<string, unknown>>;
  nodeTimings?: NonNullable<ReleaseSimRigCaseResult['nodeTimings']>;
  initialRuns: number;
}

async function runGateWaiveCase(scenario: ReleaseSimRigScenario, item: ReleaseSimRigCase, root: string,
  edges: Map<string, Record<string, unknown>>, shared?: SharedUnmeasuredGateFixture): Promise<ReleaseSimRigCaseResult> {
  const runId = item.unmeasuredGateShape && shared ? shared.runId : `release-sim-${scenario.id}-${item.id}`;
  if (item.unmeasuredGateShape && shared) {
    const testRoot = root;
    root = shared.state
      ? join(testRoot, 'ux-sim', 'unmeasured-gate-cases', item.id)
      : join(testRoot, 'ux-sim', 'unmeasured-gate-base');
    mkdirSync(root, { recursive: true });
  }
  if (item.mode === 'owner-waive-0246-fixture') {
    root = join(root, runId);
    mkdirSync(root, { recursive: true });
  }
  const ownerWaived = (item.mode === 'owner-waive-unmeasured-gate' && item.unmeasuredGateShape === undefined) || item.mode === 'owner-waive-0246-fixture';
  const fixtureOwnerWaiver = item.mode === 'owner-waive-0246-fixture';
  let input: { version: string; previousVersion: string; branchCut?: boolean; [key: string]: unknown } = fixtureOwnerWaiver ? { ...scenario.input, version: '0.2.46', previousVersion: '0.2.45', branchCut: true }
    : ownerWaived ? { ...scenario.input, version: '0.2.45', previousVersion: '0.2.44' }
      : item.unmeasuredGateShape ? { ...scenario.input, branchCut: true } : { ...scenario.input };
  const gateFixture = fixtureOwnerWaiver
    ? JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'scripts/release-loop/fixtures/gate-verdict-0.2.46.json'), 'utf8')) as Record<string, unknown>
    : undefined;
  const fixtureIntroducedIds = Array.isArray(gateFixture?.introduced) ? gateFixture.introduced as string[] : [];
  if (fixtureOwnerWaiver) {
    const fixtureCommit = typeof gateFixture?.commit === 'string' ? gateFixture.commit : cutTip();
    const prior = { classification: 'regression' as const, commit: fixtureCommit, failureIds: [...fixtureIntroducedIds].sort() };
    input = { ...input, gateTriageEvidence: { priorDecisions: [prior, prior] } };
  }
  const introducedId = 'src/example.test.ts > reports the known regression';
  const acceptedRegressions = [{ id: introducedId, note: 'The example capability may fail during use.' }];
  const reason = 'Known gate failures remain in this release. Users may encounter these issues during normal use.';
  const dispatchedNodes: string[] = [];
  const firstAttemptDispatchedNodes: string[] = [];
  let resumedPhase = false;
  let npmPublishEvidence: Record<string, unknown> | undefined;
  let verifyEvidence: Record<string, unknown> | undefined;
  const ledgerEvents: Array<Record<string, unknown>> = [];
  const eventBus = createReleaseTraceBus(ledgerEvents);
  const nodeTimings: NonNullable<ReleaseSimRigCaseResult['nodeTimings']> = {};
  let knownIssuesAccepted: unknown;
  const runBash = async (command: string, options: { env?: NodeJS.ProcessEnv }) => {
    const { nodeId, executionId } = parseContext(options.env ?? process.env);
    if (!command.trim()) throw new Error(`empty command at simulated node ${nodeId}`);
    dispatchedNodes.push(nodeId);
    if (!resumedPhase) firstAttemptDispatchedNodes.push(nodeId);
    const startedAtMs = performance.now();
    if (nodeId === 'gate') {
      nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
      if (item.unmeasuredGateShape === 'killed' || (item.unmeasuredGateShape && shared && shared.initialRuns === 0)) {
        return { exitCode: null as unknown as number, stdout: `${JSON.stringify({ executionId, error: 'process terminated by SIGTERM' })}\n`, stderr: 'process terminated by SIGTERM' };
      }
      if (gateFixture) {
        const persisted = gateFixture as unknown as { outcome: 'regression'; introduced: string[]; preexisting: string[]; knownEnv: string[] };
        const normalized = graphGateResult({ ...persisted, preexisting: persisted.preexisting.length, knownEnv: persisted.knownEnv.length,
          fixed: null, knownEnvCleared: [], durationMs: 0, stalledEnv: [], stalledShards: [], unmeasuredRecheckFiles: [],
          unmeasuredErrors: [], abortedShards: 0, rcNonzeroNoFailures: [] } as unknown as GateResult, true);
        return { exitCode: 1, stdout: `${JSON.stringify(normalized)}\n`, stderr: '' };
      }
      const unmeasuredGateResult = item.unmeasuredGateShape === 'sweep-incomplete'
        ? { outcome: 'error', verdict: 'fail', commit: cutTip(), introduced: [], preexisting: 0, fixed: null, knownEnv: 0, knownEnvCleared: [],
          stalledEnv: [], stalledShards: [{ shard: 3, files: ['a.test.ts'], reason: 'no-output' }], durationMs: 1, error: 'pod sweep incomplete: stalled shards 3' }
        : { outcome: 'error', verdict: 'fail', commit: cutTip(), introduced: [], preexisting: 0, fixed: null,
          knownEnv: 0, knownEnvCleared: [], stalledEnv: [], durationMs: 1, error: 'failure attribution incomplete' };
      return { exitCode: 1, stdout: `${JSON.stringify(item.unmeasuredGateShape ? unmeasuredGateResult : item.mode === 'owner-waive-unmeasured-gate' ? unmeasuredGateResult : { outcome: 'fail', verdict: 'fail', commit: cutTip(), introduced: [introducedId],
        preexisting: 0, knownEnv: 0, durationMs: 1, stalledEnv: [], stalledShards: [], unmeasuredRecheckFiles: [], unmeasuredErrors: [], rcNonzeroNoFailures: [], abortedShards: 0 })}
`, stderr: '' };
    }
    if (nodeId === 'version-release' && item.unmeasuredGateShape) {
      const value = { outcome: 'ok', version: input.version, commit: cutTip(), branch: `release/${input.version}` };
      nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
      return { exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' };
    }
    if (nodeId === 'gate-triage') {
      const child = spawnSync('bun', ['scripts/release-loop/gate-triage-node.ts'], {
        cwd: REPOSITORY_ROOT, env: { ...process.env, ...options.env }, encoding: 'utf8', maxBuffer: 1024 * 1024,
      });
      nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
      return { exitCode: child.status ?? 2, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
    }
    if (nodeId === 'version-release' && fixtureOwnerWaiver) {
      const value = { outcome: 'ok', version: input.version, commit: cutTip(), branch: `release/${input.version}` };
      nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
      return { exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' };
    }
    if (nodeId === 'prepare' && fixtureOwnerWaiver) {
      const out = join(root, 'release', input.version, 'prepared');
      mkdirSync(join(out, 'dist'), { recursive: true });
      for (let index = 0; index < 5; index += 1) writeFileSync(join(out, 'dist', `fixture-${index}.tgz`), 'fixture');
      const value = { outcome: 'ok', commit: cutTip(), out };
      nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
      return { exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' };
    }
    if (nodeId === 'docs' && fixtureOwnerWaiver) {
      const worktree = join(root, 'owner-waive-docs');
      const notes = join(worktree, 'release/public/docs/releases', `${input.version}.md`);
      mkdirSync(join(worktree, 'release/public/docs/releases'), { recursive: true });
      writeFileSync(notes, `# ${input.version}\n\n`);
      const value = { outcome: 'ok', branch: `release-docs/${input.version}`, worktree, notes: 'fixture release notes', artifactOwner: { runId, attempt: 1 } };
      nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
      return { exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' };
    }
    const location = options.env?.ELANOUS_GRAPH_CONTEXT;
    const context = location ? record(JSON.parse(readFileSync(location, 'utf8')), 'release graph context') : {};
    if (nodeId === 'known-issues') knownIssuesAccepted = record(context.input, 'known-issues input').acceptedRegressions;
    if (nodeId === 'docs' && ownerWaived) {
      const worktree = join(root, 'owner-waive-docs');
      const notes = join(worktree, 'release/public/docs/releases', `${input.version}.md`);
      mkdirSync(join(worktree, 'release/public/docs/releases'), { recursive: true });
      writeFileSync(notes, '# Release\n');
      const result = { outcome: 'ok', branch: `release-docs/${input.version}`, worktree };
      nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
      return { exitCode: 0, stdout: JSON.stringify(result) + '\n', stderr: '' };
    }
    if (nodeId === 'docs' && item.unmeasuredGateShape) {
      const worktree = join(root, 'unmeasured-release-docs');
      const notes = join(worktree, 'release/public/docs/releases', `${input.version}.md`);
      mkdirSync(dirname(notes), { recursive: true });
      writeFileSync(notes, '# Release\n');
      const result = { outcome: 'ok', branch: `release-docs/${input.version}`, worktree };
      nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
      return { exitCode: 0, stdout: `${JSON.stringify(result)}\n`, stderr: '' };
    }
    if (nodeId === 'known-issues' && (ownerWaived || item.unmeasuredGateShape)) {
      const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
      if (!contextPath) throw new Error('known-issues context missing in owner waiver rig');
      const previous = process.env.ELANOUS_GRAPH_CONTEXT;
      const previousStateDir = process.env.ELANOUS_STATE_DIR;
      const previousConfigDir = getElanousConfigDirOverride();
      process.env.ELANOUS_GRAPH_CONTEXT = contextPath;
      process.env.ELANOUS_STATE_DIR = root;
      setElanousConfigDir(root);
      resetEffectiveInstanceRoot();
      try {
        const graphContext = record(JSON.parse(readFileSync(contextPath, 'utf8')), 'known-issues context');
        const output = runKnownIssues(graphContext as never, (program, args, cwd) => program === 'git'
          ? { status: 0, stdout: args[0] === 'rev-list' ? '0' : '', stderr: '' }
          : program === 'elanous' && args[0] === '--test' && args[1] === 'ask' ? { status: 1, stdout: '', stderr: 'simulated model unavailable' }
            : { status: 1, stdout: '', stderr: `unexpected ${program} ${args.join(' ')}` });
        knownIssuesAccepted = record(graphContext.input, 'known-issues input').acceptedRegressions;
        nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
        return { exitCode: 0, stdout: JSON.stringify(output) + '\n', stderr: '' };
      } finally { if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = previous; if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previousStateDir; if (previousConfigDir === undefined) resetElanousConfigDir(); else setElanousConfigDir(previousConfigDir); resetEffectiveInstanceRoot(); }
    }
    if (nodeId === 'auto-approve' && fixtureOwnerWaiver) {
      const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
      if (!contextPath) throw new Error('auto-approve context missing in owner waiver rig');
      const previous = process.env.ELANOUS_GRAPH_CONTEXT;
      const previousStateDir = process.env.ELANOUS_STATE_DIR;
      const previousConfigDir = getElanousConfigDirOverride();
      process.env.ELANOUS_GRAPH_CONTEXT = contextPath;
      process.env.ELANOUS_STATE_DIR = root;
      setElanousConfigDir(root);
      resetEffectiveInstanceRoot();
      try {
        const value = runAutoApprove(record(JSON.parse(readFileSync(contextPath, 'utf8')), 'auto-approve context') as never,
          { instanceRoot: root, repo: REPOSITORY_ROOT, bunVersion: readFileSync(join(REPOSITORY_ROOT, '.bun-version'), 'utf8').trim() });
        nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
        return { exitCode: value.outcome === 'ok' ? 0 : 1, stdout: `${JSON.stringify(value)}\n`, stderr: '' };
      } finally {
        if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = previous;
        if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previousStateDir;
        if (previousConfigDir === undefined) resetElanousConfigDir(); else setElanousConfigDir(previousConfigDir);
        resetEffectiveInstanceRoot();
      }
    }
    if (nodeId === 'tui' && fixtureOwnerWaiver) {
      const value = { outcome: 'ok', verdict: 'pass', regress: { pass: 7, fail: 0,
        results: Array.from({ length: 7 }, (_, index) => ({ id: `R${index + 1}`, title: `fixture R${index + 1}`, ok: true, reason: 'fixture pass' })) } };
      nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
      return { exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' };
    }
    if (nodeId === 'npm-publish' && fixtureOwnerWaiver) {
      const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
      if (!contextPath) throw new Error('npm-publish context missing in owner waiver rig');
      const graphContext = record(JSON.parse(readFileSync(contextPath, 'utf8')), 'npm-publish context');
      const tokenFile = join(root, 'npm-token');
      writeFileSync(tokenFile, 'fixture-token\n', { mode: 0o600 });
      const devices = createReleasePublishDevices('0.2.46');
      const result = await runNpmPublish({ ...graphContext, input: { ...record(graphContext.input, 'npm-publish input'), npmWaitMinutes: 0, npmTokenFile: tokenFile } } as never, {
        ...devices.npm, stateDir: root, productionRoot: root,
      });
      npmPublishEvidence = { ...(npmPublishEvidence ?? {}), result,
        publishedCommands: devices.npmCalls.filter((call) => call.startsWith('npm publish ')) };
      nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
      return { exitCode: result.outcome === 'ok' ? 0 : 1, stdout: `${JSON.stringify(result)}\n`, stderr: '' };
    }
    if (nodeId === 'publish' && fixtureOwnerWaiver) {
      const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
      if (!contextPath) throw new Error('publish context missing in owner waiver rig');
      const previous = process.env.ELANOUS_GRAPH_CONTEXT;
      const previousStateDir = process.env.ELANOUS_STATE_DIR;
      const previousConfigDir = getElanousConfigDirOverride();
      process.env.ELANOUS_GRAPH_CONTEXT = contextPath;
      process.env.ELANOUS_STATE_DIR = root;
      setElanousConfigDir(root);
      resetEffectiveInstanceRoot();
      const devices = createReleasePublishDevices(input.version);
      try {
        const result = runPublish(devices.publishRunner, undefined, { now: () => Date.now(), sleep: () => {} }, root);
        npmPublishEvidence = { ...(npmPublishEvidence ?? {}), publishNodeResult: result,
          publishNodeExternalCalls: devices.publishCalls };
        nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
        return { exitCode: result.outcome === 'ok' ? 0 : 1, stdout: `${JSON.stringify(result)}\n`, stderr: '' };
      } finally {
        if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = previous;
        if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previousStateDir;
        if (previousConfigDir === undefined) resetElanousConfigDir(); else setElanousConfigDir(previousConfigDir);
        resetEffectiveInstanceRoot();
      }
    }
    if (nodeId === 'verify' && fixtureOwnerWaiver) {
      const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
      if (!contextPath) throw new Error('verify context missing in owner waiver rig');
      const previous = process.env.ELANOUS_GRAPH_CONTEXT;
      process.env.ELANOUS_GRAPH_CONTEXT = contextPath;
      try {
        const result = runVerify(() => ({ status: 0, stdout: JSON.stringify({ ok: true, notesPage: 'ok', npmLatest: '0.2.46' }), stderr: '' }));
        verifyEvidence = { result, command: 'release verify --version 0.2.46', npmLatest: '0.2.46' };
        nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
        return { exitCode: result.outcome === 'ok' ? 0 : 1, stdout: `${JSON.stringify(result)}\n`, stderr: '' };
      } finally { if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = previous; }
    }
    const result = resultForNode(nodeId, undefined, input.version);
    nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  };
  const capture = (event: string, data: Record<string, unknown>) => ledgerEvents.push({ event, ...data });
  let first: GraphRunState;
  if (item.unmeasuredGateShape && shared?.state) {
    const statePath = join(root, 'graph-runs', 'release-loop', `${runId}.json`);
    const snapshotRoot = shared.snapshotRoot;
    if (!snapshotRoot) throw new Error('shared unmeasured gate snapshot is missing');
    mkdirSync(dirname(statePath), { recursive: true });
    const restoredState = { ...shared.state, statePath };
    writeFileSync(statePath, `${JSON.stringify(restoredState, null, 2)}\n`);
    for (const suffix of ['.graph', '.contexts']) {
      rmSync(`${statePath}${suffix}`, { recursive: true, force: true });
      cpSync(`${snapshotRoot}${suffix}`, `${statePath}${suffix}`, { recursive: true });
    }
    firstAttemptDispatchedNodes.push(...(shared.dispatchedNodes ?? []));
    ledgerEvents.push(...(shared.ledgerEvents ?? []));
    Object.assign(nodeTimings, shared.nodeTimings ?? {});
    first = JSON.parse(JSON.stringify(restoredState)) as GraphRunState;
  } else {
    first = await runGraph(RELEASE_GRAPH, { runId, input, pinChildUniverse: true, quiet: true, eventBus,
      deps: { root, runBash, log: capture } });
    if (item.unmeasuredGateShape && shared) {
      shared.initialRuns += 1;
      shared.state = JSON.parse(readFileSync(first.statePath, 'utf8')) as GraphRunState;
      shared.snapshotRoot = join(root, 'ux-sim', 'shared-unmeasured-gate-base');
      mkdirSync(dirname(shared.snapshotRoot), { recursive: true });
      rmSync(`${shared.snapshotRoot}.graph`, { recursive: true, force: true });
      rmSync(`${shared.snapshotRoot}.contexts`, { recursive: true, force: true });
      for (const suffix of ['.graph', '.contexts']) cpSync(`${first.statePath}${suffix}`, `${shared.snapshotRoot}${suffix}`, { recursive: true });
      shared.dispatchedNodes = [...firstAttemptDispatchedNodes];
      shared.ledgerEvents = [...ledgerEvents];
      shared.nodeTimings = { ...nodeTimings };
    }
  }
  if (item.unmeasuredGateShape) {
    const statePath = join(root, 'graph-runs', 'release-loop', `${runId}.json`);
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as GraphRunState;
    const gateIndex = state.nodes.findIndex((node) => node.nodeId === 'gate');
    if (gateIndex < 0) throw new Error('unmeasured gate simulation did not persist gate state');
    if (item.unmeasuredGateShape === 'stopped') {
      state.path.splice(gateIndex + 1);
      state.nodes.splice(gateIndex + 1);
      state.nodes[gateIndex] = { nodeId: 'gate', ok: false, exit: null, executed: false, error: STOPPED_NODE_ERROR, endedAt: '2026-11-07T00:00:00.000Z' };
    } else if (item.unmeasuredGateShape === 'sweep-incomplete') {
      const output = { outcome: 'error', verdict: 'fail', commit: cutTip(), introduced: [], preexisting: 0, fixed: null, knownEnv: 0,
        knownEnvCleared: [], stalledEnv: [], stalledShards: [{ shard: 3, files: ['a.test.ts'], reason: 'no-output' }], durationMs: 1,
        error: 'pod sweep incomplete: stalled shards 3' };
      state.nodes[gateIndex] = { nodeId: 'gate', ok: false, exit: 1, executed: true, error: 'bash exit 1',
        output: `${JSON.stringify(output)}\n`, endedAt: '2026-11-07T00:00:00.000Z' };
    }
    state.executed = state.nodes.filter((node) => node.executed).length;
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    first.path.splice(0, first.path.length, ...state.path);
    first.nodes.splice(0, first.nodes.length, ...state.nodes);
    first.executed = state.executed;
  }
  let missingReasonRejected = true;
  if (item.unmeasuredGateShape) {
    try { releaseResumeWaiver(first, { from: 'gate', waive: 'gate' }); missingReasonRejected = false; }
    catch (error) { missingReasonRejected = String(error).includes('supplied together'); }
  }
  const waiver = releaseResumeWaiver(first, { from: 'gate', ...(ownerWaived ? { ownerWaive: 'gate' } : { waive: 'gate' }), reason, acceptedRegressions: ownerWaived ? [] : acceptedRegressions, approvedBy: 'OP' });
  if (!waiver) throw new Error('measured gate waiver was not produced');
  resumedPhase = true;
  dispatchedNodes.length = 0;
  const git = (args: string[]) => {
    if (args[0] === 'ls-remote' && args.at(-1) === `refs/heads/release/${input.version}`) return `${cutTip()}\trefs/heads/release/${input.version}`;
    if (args[0] === 'ls-remote' || args[0] === 'show-ref' || args[0] === 'worktree') return '';
    if (args[0] === 'fetch') return '';
    if (args[0] === 'rev-parse') return cutTip();
    if (args[0] === 'ls-files') return '';
    if (args[0] === '-c' && args.includes('status.showUntrackedFiles=all')) return '';
    if (args[0] === 'merge-base') return '';
    throw new Error(`unexpected simulated release git ${args.join(' ')}`);
  };
  const trafficFile = join(root, 'traffic.json');
  writeFileSync(trafficFile, '{}\n');
  const resumed = fixtureOwnerWaiver || item.unmeasuredGateShape
    ? (await resumeReleaseRun({ runId, from: 'gate', ...(fixtureOwnerWaiver ? { ownerWaive: 'gate' as const, acceptedRegressions: [] }
      : { waive: 'gate' as const, acceptedRegressions }), reason, approvedBy: 'OP',
      partial: false, commandRoot: REPOSITORY_ROOT }, {
      root, repo: REPOSITORY_ROOT, graphPath: RELEASE_GRAPH, runBash, trafficFile, ledgerRoot: root,
      eventBus,
      git, isAncestor: () => true,
    })).state
    : await runGraph(RELEASE_GRAPH, { resumeRunId: runId, fromNodeId: 'gate', input,
      releaseWaiver: { ...waiver, requestedRegressions: ownerWaived ? [] : acceptedRegressions }, pinChildUniverse: true, quiet: true, eventBus,
      deps: { root, runBash, log: capture } });
  let secondWaiverRejected = true;
  if (item.unmeasuredGateShape) {
    try { secondWaiverRejected = releaseResumeWaiver(resumed, { from: 'gate', waive: 'gate', reason }) === undefined; }
    catch { secondWaiverRejected = true; }
  }
  const path = resumed.path;
  const visited = new Set([...path, ...Object.values(resumed.fanOuts ?? {}).flatMap((fanout) => Object.keys(fanout.branches))]);
  recordObservedEdges(path, ledgerEvents);
  const edgeIssues = unexpectedEdges(path, resumed, edges);
  const gate = resumed.nodes.find((node) => node.nodeId === 'gate');
  const issueRows = Array.isArray(knownIssuesAccepted) ? knownIssuesAccepted as Array<{ id?: unknown; note?: unknown }> : [];
  const knownIssueOk = (ownerWaived ? !issueRows.some((issue) => issue.id === introducedId) : issueRows.some((issue) => issue.id === introducedId))
    && issueRows.some((issue) => issue.id === 'waive:gate' && issue.note === reason);
  const ownerNotes = ownerWaived ? readFileSync(join(root, 'owner-waive-docs', 'release/public/docs/releases', `${input.version}.md`), 'utf8') : '';
  const docsOutput = resumed.nodes.find((node) => node.nodeId === 'docs')?.output;
  const docsWorktree = typeof docsOutput === 'string' ? record(JSON.parse(docsOutput), 'release docs output').worktree : undefined;
  const releaseNotes = item.unmeasuredGateShape && typeof docsWorktree === 'string'
    ? readFileSync(join(docsWorktree, 'release/public/docs/releases', `${input.version}.md`), 'utf8') : '';
  const releaseNotesOk = !item.unmeasuredGateShape || releaseNotes.includes(`- ${reason}`);
  const ownerRunLedger = ownerWaived ? JSON.parse(readFileSync(resumed.statePath, 'utf8')) as GraphRunState : undefined;
  const ownerLedger = ownerRunLedger?.nodes.find((node) => node.nodeId === 'gate')?.waiver;
  const unmeasuredRunLedger = item.unmeasuredGateShape ? JSON.parse(readFileSync(resumed.statePath, 'utf8')) as GraphRunState : undefined;
  const unmeasuredLedgerGate = unmeasuredRunLedger?.nodes.find((node) => node.nodeId === 'gate');
  const initialGateRecord = first.nodes.find((node) => node.nodeId === 'gate');
  const ownerLedgerHasApproval = ownerRunLedger?.path.includes('gate') === true && ownerRunLedger.runId === resumed.runId;
  const knownIssuesOutput = resumed.nodes.find((node) => node.nodeId === 'known-issues')?.output;
  const knownIssuesResult = typeof knownIssuesOutput === 'string' ? JSON.parse(knownIssuesOutput) as Record<string, unknown> : {};
  const actualGateTriage = outputRecord(first.nodes.find((node) => node.nodeId === 'gate-triage')?.output);
  const auditLine = ownerNotes.match(/<!-- (\{[^\n]*\}) -->/)?.[1];
  const audit = auditLine ? JSON.parse(auditLine) as Record<string, unknown> : undefined;
  const expectedOwnerIds = fixtureOwnerWaiver ? fixtureIntroducedIds : [];
  const ownerRecordOk = !ownerWaived || (ownerLedgerHasApproval && ownerLedger?.ownerWaived === true && ownerLedger.approvedBy === 'OP'
    && ownerLedger.reason === reason && JSON.stringify(ownerLedger.introducedIds ?? []) === JSON.stringify(expectedOwnerIds)
    && audit?.type === 'release-owner-waiver' && audit.approvedBy === 'OP' && audit.reason === reason
    && JSON.stringify(audit.introducedIds ?? []) === JSON.stringify(expectedOwnerIds)
    && Array.isArray(knownIssuesResult.bullets) && knownIssuesResult.bullets.includes(reason));
  const statusOk = resumed.status === item.expect.status && resumed.path.includes('publish');
  const visitOk = item.expect.mustVisit.every((id) => visited.has(id));
  const notVisitOk = item.expect.mustNotVisit.every((id) => !visited.has(id));
  const ledgerOk = ledgerEvents.some((row) => row.event === 'node-start') && ledgerEvents.some((row) => row.event === 'node-end')
    && ledgerEvents.filter((row) => row.event === 'edge-observed').length === Math.max(0, path.length - 1);
  const expectedUnmeasured = item.unmeasuredGateShape === 'stopped' ? `stopped: ${STOPPED_NODE_ERROR}`
    : item.unmeasuredGateShape === 'killed' ? /^no-verdict: gate process ended with exit null and no result line — .*SIGTERM/
      : item.unmeasuredGateShape === 'sweep-incomplete' ? /^sweep incomplete:/ : undefined;
  const waiverOk = gate?.ok === true && gate.executed === false && gate.waiver?.reason === reason
    && (item.unmeasuredGateShape ? (typeof expectedUnmeasured === 'string' ? gate.waiver.unmeasured === expectedUnmeasured
      : expectedUnmeasured?.test(gate.waiver.unmeasured ?? '') === true)
      : gate.waiver.approvedBy === 'OP' && (ownerWaived ? gate.waiver.ownerWaived === true
      && JSON.parse(String(gate.output)).outcome === 'ok' && JSON.parse(String(gate.output)).verdict === 'owner-waived'
      : JSON.stringify(gate.waiver.introducedIds) === JSON.stringify([introducedId])));
  const originalGateRecord = initialGateRecord ? { exit: initialGateRecord.exit,
    ...(initialGateRecord.executionId === undefined ? {} : { executionId: initialGateRecord.executionId }),
    ...(initialGateRecord.output === undefined ? {} : { output: initialGateRecord.output }),
    ...(initialGateRecord.error === undefined ? {} : { error: initialGateRecord.error }) } : undefined;
  const originalWaiverRecord = initialGateRecord ? { exit: initialGateRecord.exit,
    ...(initialGateRecord.output === undefined ? {} : { output: initialGateRecord.output }),
    ...(initialGateRecord.error === undefined ? {} : { error: initialGateRecord.error }) } : undefined;
  const unmeasuredLedgerOk = !item.unmeasuredGateShape || (!!originalGateRecord && !!gate?.waiver && !!unmeasuredLedgerGate?.waiver
    && JSON.stringify(gate.waiver.original) === JSON.stringify(originalWaiverRecord)
    && JSON.stringify(unmeasuredLedgerGate.waiver) === JSON.stringify(gate.waiver));
  const gateNotRerun = !item.unmeasuredGateShape || !dispatchedNodes.includes('gate');
  const releaseTailOk = !fixtureOwnerWaiver || (dispatchedNodes.includes('publish') && dispatchedNodes.includes('npm-publish') && dispatchedNodes.includes('verify')
    && (npmPublishEvidence?.publishNodeResult as { outcome?: string } | undefined)?.outcome === 'ok'
    && Array.isArray(npmPublishEvidence?.publishNodeExternalCalls)
    && npmPublishEvidence?.result !== undefined && (npmPublishEvidence.result as { outcome?: string; npm?: string }).outcome === 'ok'
    && (npmPublishEvidence.result as { npm?: string }).npm === 'published'
    && Array.isArray(npmPublishEvidence.publishedCommands) && npmPublishEvidence.publishedCommands.length === 1
    && verifyEvidence?.result !== undefined && (verifyEvidence.result as { outcome?: string }).outcome === 'ok');
  const eventTrace = checkExpectedEvents(item.expect.events, ledgerEvents);
  const pass = statusOk && visitOk && notVisitOk && knownIssueOk && waiverOk && unmeasuredLedgerOk && gateNotRerun && missingReasonRejected
    && secondWaiverRejected && ownerRecordOk && releaseTailOk && releaseNotesOk && ledgerOk && (eventTrace?.pass ?? true) && edgeIssues.length === 0;
  const result: ReleaseSimRigCaseResult = { id: item.id, pass, status: resumed.status, path, dispatchedNodes, unexpectedEdges: edgeIssues,
    checks: { status: statusOk, mustVisit: visitOk && knownIssueOk && waiverOk && unmeasuredLedgerOk && ownerRecordOk, mustNotVisit: notVisitOk, overlap: true, ledgerEvents: ledgerOk,
      ...(item.unmeasuredGateShape ? { waiverOriginalPersisted: unmeasuredLedgerOk, gateNotRerun, missingReasonRejected, secondWaiverRejected } : {}),
      ...(eventTrace ? { events: eventTrace.pass } : {}) },
    injectedEvidence: { introducedId, introducedIds: fixtureIntroducedIds, acceptedRegressions, reason, waived: waiverOk,
      actualGateTriage, waiverResult: waiver, knownIssuesAccepted, initialStatus: first.status, initialPath: first.path,
      ...(item.unmeasuredGateShape ? { originalGateRecord, persistedWaiver: unmeasuredLedgerGate?.waiver,
        sharedInitialGraphRuns: shared?.initialRuns, sharedRunId: shared?.runId, releaseNotes, releaseNotesOk } : {}),
      initialDispatchedNodes: firstAttemptDispatchedNodes, publishReached: path.includes('publish'), npmPublishEvidence,
      verifyEvidence, ownerNotes, ownerRecordOk, releaseTailOk, ownerLedgerPath: ownerWaived ? resumed.statePath : undefined,
      ...(eventTrace ? { eventTrace } : {}) },
    fanOuts: resumed.fanOuts, nodeTimings, ledgerEvents, statePath: resumed.statePath };
  return result;
}

async function runOldGraphMeasuredWaiverCase(scenario: ReleaseSimRigScenario, item: ReleaseSimRigCase, root: string,
  edges: Map<string, Record<string, unknown>>): Promise<ReleaseSimRigCaseResult> {
  const commandRoot = join(root, `${scenario.id}-${item.id}-command-root`);
  const graphDir = join(commandRoot, 'graphs', 'release');
  const graphPath = join(graphDir, 'release-loop.yaml');
  const sourceGraph = readFileSync(RELEASE_GRAPH, 'utf8');
  const oldGraph = sourceGraph
    .replace("  - { node_id: known-issues, kind: agent, recipe: 'cmd:known-issues', max_visits: 1 }\n", '')
    .replace('  - { from: docs, on: outcome, map: { ok: known-issues, fail: traffic-failed-restore, error: traffic-failed-restore } }\n',
      '  - { from: docs, on: outcome, map: { ok: notes-check, fail: traffic-failed-restore, error: traffic-failed-restore } }\n')
    .replace('  - { from: known-issues, on: outcome, map: { ok: notes-check, fail: traffic-failed-restore, error: traffic-failed-restore } }\n', '');
  if (oldGraph === sourceGraph || oldGraph.includes('node_id: known-issues')) throw new Error('old graph fixture did not remove the known-issues path');
  mkdirSync(graphDir, { recursive: true });
  mkdirSync(join(commandRoot, 'apps', 'pwa'), { recursive: true });
  symlinkSync(join(REPOSITORY_ROOT, 'node_modules'), join(commandRoot, 'node_modules'), 'dir');
  symlinkSync(join(REPOSITORY_ROOT, 'apps/pwa/node_modules'), join(commandRoot, 'apps', 'pwa', 'node_modules'), 'dir');
  writeFileSync(graphPath, oldGraph);
  writeFileSync(join(graphDir, 'recipes.yaml'), readFileSync(join(REPOSITORY_ROOT, 'graphs/release/recipes.yaml')));

  const runId = `release-sim-${scenario.id}-${item.id}`;
  const releaseVersion = '0.2.45';
  const introducedId = 'src/task-orchestrator/surfaces/pod-pool-cli.test.ts > harness CLI reads gatePodPool from the explicit isolated config';
  const reason = 'Known gate failures remain in this release. Users may encounter these issues during normal use.';
  const acceptedRegressions = [{ id: introducedId, note: 'The isolated-config test still fails under the published cut.' }];
  const trafficFile = join(root, `${runId}-traffic.json`);
  writeFileSync(trafficFile, '{}\n');
  const dispatchedNodes: string[] = [];
  const ledgerEvents: Array<Record<string, unknown>> = [];
  const nodeTimings: NonNullable<ReleaseSimRigCaseResult['nodeTimings']> = {};
  const eventBus = createReleaseTraceBus(ledgerEvents);
  const runBash = async (_command: string, options: { env?: NodeJS.ProcessEnv }) => {
    const { nodeId } = parseContext(options.env ?? process.env);
    dispatchedNodes.push(nodeId);
    const startedAtMs = performance.now();
    const result = nodeId === 'version-release'
      ? { exitCode: 0, stdout: `${JSON.stringify({ outcome: 'ok', version: releaseVersion, commit: cutTip(), branch: `release/${releaseVersion}` })}\n`, stderr: '' }
      : nodeId === 'gate'
        ? { exitCode: 1, stdout: `${JSON.stringify({ outcome: 'fail', verdict: 'fail', commit: cutTip(), introduced: [introducedId],
          preexisting: 0, knownEnv: 0, durationMs: 1, stalledEnv: [], stalledShards: [], unmeasuredRecheckFiles: [], unmeasuredErrors: [],
          rcNonzeroNoFailures: [], abortedShards: 0 })}\n`, stderr: '' }
        : { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\n', stderr: '' };
    nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
    return result;
  };
  const git = (args: string[]) => args[0] === 'ls-remote' ? `${cutTip()}\trefs/heads/release/${releaseVersion}`
    : args[0] === 'rev-parse' ? cutTip() : '';
  const first = await runGraph(graphPath, { runId, input: { version: releaseVersion, branchCut: true, previousVersion: '0.2.44' },
    pinChildUniverse: true, quiet: true, eventBus, deps: { root, runBash } });
  const initialState = JSON.parse(readFileSync(first.statePath, 'utf8')) as GraphRunState;
  const snapshotGraph = readFileSync(`${first.statePath}.graph/graph.yaml`, 'utf8');
  const initialOk = first.status === 'failed' && initialState.status === 'failed' && first.path.includes('gate')
    && snapshotGraph.includes('node_id: known-issues') === false;
  if (!initialOk) throw new Error(`old graph fixture did not persist the expected failed run and graph snapshot: ${first.status}`);
  const initialDispatchedNodes = [...dispatchedNodes];
  dispatchedNodes.length = 0;
  const ledgerBeforeResume = readFileSync(first.statePath, 'utf8');

  let refusal = '';
  try {
    await resumeReleaseRun({ runId, from: 'gate', waive: 'gate', reason, approvedBy: 'OP', commandRoot,
      acceptedRegressions }, { root, ledgerRoot: root, repo: commandRoot, graphPath, git, runBash, trafficFile });
  } catch (error) { refusal = error instanceof Error ? error.message : String(error); }
  const saved = JSON.parse(readFileSync(first.statePath, 'utf8')) as GraphRunState;
  const expectedRefusal = item.expect.refusalIncludes ?? 'waived node must reach known-issues before publication';
  const statusOk = first.status === 'failed' && refusal.includes(expectedRefusal);
  const visitOk = item.expect.mustVisit.every((nodeId) => first.path.includes(nodeId));
  const notVisitOk = item.expect.mustNotVisit.every((nodeId) => !first.path.includes(nodeId));
  const noDispatch = dispatchedNodes.length === 0;
  const noMutation = readFileSync(first.statePath, 'utf8') === ledgerBeforeResume
    && saved.status === 'failed' && saved.nodes.every((node) => !node.waiver);
  recordObservedEdges(first.path, ledgerEvents);
  const edgeIssues = unexpectedEdges(first.path, first, edges);
  const ledgerOk = ledgerEvents.some((row) => row.event === 'node-start') && ledgerEvents.some((row) => row.event === 'node-end')
    && ledgerEvents.filter((row) => row.event === 'edge-observed').length === Math.max(0, first.path.length - 1);
  const pass = initialOk && statusOk && visitOk && notVisitOk && noDispatch && noMutation && ledgerOk && edgeIssues.length === 0;
  return { id: item.id, pass, status: statusOk ? 'resume-refused' : saved.status, path: first.path, dispatchedNodes,
    unexpectedEdges: edgeIssues, checks: { status: statusOk, mustVisit: visitOk, mustNotVisit: notVisitOk && noDispatch && noMutation,
      overlap: true, ledgerEvents: ledgerOk }, injectedEvidence: { initialRunId: runId, initialPath: first.path,
      oldGraphMissingKnownIssues: !snapshotGraph.includes('node_id: known-issues'), refusal, resumeDispatchedNodes: dispatchedNodes,
      stateStayedFailedWithoutWaiver: noMutation, initialDispatchedNodes }, nodeTimings, ledgerEvents, statePath: first.statePath,
    ...(refusal ? { refusal } : {}) };
}

async function runAppendedTipReGateCase(scenario: ReleaseSimRigScenario, item: ReleaseSimRigCase, root: string,
  edges: Map<string, Record<string, unknown>>): Promise<ReleaseSimRigCaseResult> {
  const runId = `release-sim-${scenario.id}-${item.id}`;
  const releaseVersion = '0.2.45';
  const graphPath = RELEASE_GRAPH;
  const initialTip = cutTip();
  const appendedTip = 'b'.repeat(40);
  const introducedId = 'src/task-orchestrator/surfaces/pod-pool-cli.test.ts > harness CLI reads gatePodPool from the explicit isolated config';
  const reason = 'The gatePodPool isolated-config test remains failing. Users may encounter this failure during release use.';
  const acceptedRegressions = [{ id: introducedId, note: 'The gatePodPool isolated-config test still fails.' }];
  const docsTree = join(root, `${runId}-docs`);
  const notes = join(docsTree, 'release/public/docs/releases', `${releaseVersion}.md`);
  mkdirSync(dirname(notes), { recursive: true });
  writeFileSync(notes, '# Release\n');

  let branchTip = initialTip;
  let gateRuns = 0;
  let phase: 'initial' | 'regate' | 'waiver' = 'initial';
  const nodesByPhase: Record<'initial' | 'regate' | 'waiver', string[]> = { initial: [], regate: [], waiver: [] };
  const seenKnownIssues: Array<Array<{ id: string; note: string }>> = [];
  const ledgerEvents: Array<Record<string, unknown>> = [];
  const eventBus = createReleaseTraceBus(ledgerEvents);
  const runBash = async (_command: string, options: { env?: NodeJS.ProcessEnv }) => {
    const { nodeId } = parseContext(options.env ?? process.env);
    nodesByPhase[phase].push(nodeId);
    if (nodeId === 'version-release') {
      return { exitCode: 0, stdout: `${JSON.stringify({ outcome: 'ok', version: releaseVersion, commit: branchTip, branch: `release/${releaseVersion}` })}\n`, stderr: '' };
    }
    if (nodeId === 'gate') {
      gateRuns += 1;
      return { exitCode: 1, stdout: `${JSON.stringify({ outcome: 'fail', verdict: 'fail', commit: branchTip, introduced: [introducedId],
        preexisting: 0, knownEnv: 0, durationMs: 1, stalledEnv: [], stalledShards: [], unmeasuredRecheckFiles: [], unmeasuredErrors: [],
        rcNonzeroNoFailures: [], abortedShards: 0 })}\n`, stderr: '' };
    }
    if (nodeId === 'docs') {
      return { exitCode: 0, stdout: `${JSON.stringify({ outcome: 'ok', branch: `release-docs/${releaseVersion}`, worktree: docsTree })}\n`, stderr: '' };
    }
    if (nodeId === 'known-issues') {
      const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
      if (!contextPath) throw new Error('known-issues context missing in appended-tip simulation');
      const context = record(JSON.parse(readFileSync(contextPath, 'utf8')), 'known-issues context');
      const issues = record(context.input, 'known-issues input').acceptedRegressions as Array<{ id: string; note: string }>;
      seenKnownIssues.push(issues);
      const previous = process.env.ELANOUS_GRAPH_CONTEXT;
      const previousStateDir = process.env.ELANOUS_STATE_DIR;
      const previousConfigDir = getElanousConfigDirOverride();
      process.env.ELANOUS_GRAPH_CONTEXT = contextPath;
      process.env.ELANOUS_STATE_DIR = root;
      setElanousConfigDir(root);
      resetEffectiveInstanceRoot();
      try {
        const output = runKnownIssues(context as never, (program, args) => program === 'git'
          ? { status: 0, stdout: args[0] === 'rev-list' ? '0' : '', stderr: '' }
          : program === 'elanous' && args[0] === '--test' && args[1] === 'ask'
            ? { status: 0, stdout: JSON.stringify({ reply: JSON.stringify([{ id: introducedId,
              bullet: 'The gatePodPool setting fails to load from isolated configuration.' }]) }), stderr: '' }
            : { status: 1, stdout: '', stderr: `unexpected ${program} ${args.join(' ')}` });
        return { exitCode: 0, stdout: `${JSON.stringify(output)}\n`, stderr: '' };
      } finally {
        if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = previous;
        if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previousStateDir;
        if (previousConfigDir === undefined) resetElanousConfigDir(); else setElanousConfigDir(previousConfigDir);
        resetEffectiveInstanceRoot();
      }
    }
    const result = resultForNode(nodeId, undefined, releaseVersion);
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  };
  const git = (args: string[]) => {
    if (args[0] === 'ls-remote' && args.at(-1) === `refs/heads/release/${releaseVersion}`) return `${branchTip}\trefs/heads/release/${releaseVersion}`;
    if (args[0] === 'ls-remote') return '';
    if (args[0] === 'rev-parse') return branchTip;
    if (args[0] === 'show-ref' || args[0] === 'worktree' || args[0] === 'fetch' || args[0] === 'ls-files' || args[0] === 'merge-base') return '';
    if (args[0] === '-c' && args.includes('status.showUntrackedFiles=all')) return '';
    throw new Error(`unexpected appended-tip simulated git ${args.join(' ')}`);
  };
  const trafficFile = join(root, `${runId}-traffic.json`);
  writeFileSync(trafficFile, '{}\n');
  const deps = { root, graphPath, git, runBash, trafficFile, ledgerRoot: root, eventBus, isAncestor: () => true };
  const first = await runGraph(graphPath, { runId, input: { version: releaseVersion, branchCut: true, previousVersion: '0.2.44' },
    pinChildUniverse: true, quiet: true, eventBus, deps: { root, runBash } });
  const stateBefore = readFileSync(first.statePath, 'utf8');
  const invalidId = 'another.test.ts > not enough';
  let invalidWaiverRejected = false;
  try {
    await resumeReleaseRun({ runId, from: 'gate', waive: 'gate', reason, approvedBy: 'OP',
      acceptedRegressions: [{ id: invalidId, note: 'Another failure remains' }] }, deps);
  } catch (error) { invalidWaiverRejected = String(error).includes(introducedId); }
  const invalidAttemptUnchanged = readFileSync(first.statePath, 'utf8') === stateBefore;

  branchTip = appendedTip;
  let movedTipWaiverRefused = false;
  try {
    await resumeReleaseRun({ runId, from: 'gate', waive: 'gate', reason, approvedBy: 'OP', acceptedRegressions }, deps);
  } catch (error) { movedTipWaiverRefused = String(error).includes('release branch moved — re-gate the new tip before waiving a node'); }
  const movedTipAttemptUnchanged = readFileSync(first.statePath, 'utf8') === stateBefore;

  phase = 'regate';
  // In the current graph the gate runs before export-check, so a gate failure cannot resume from export-check.
  const regated = await resumeReleaseRun({ runId, from: 'gate' }, deps);
  const regatedState = readFileSync(first.statePath, 'utf8');
  const reGateTip = regated.tip;
  const regateFailed = regated.state.status === 'failed';
  const regatePartial = regated.partial;
  const regateGateCount = gateRuns;

  phase = 'waiver';
  const resumed = await resumeReleaseRun({ runId, from: 'gate', waive: 'gate', reason, approvedBy: 'OP', acceptedRegressions }, deps);
  const finalState = resumed.state;
  const knownIssueRows = seenKnownIssues.at(-1) ?? [];
  const notesText = readFileSync(notes, 'utf8');
  const statusOk = first.status === 'failed' && regateFailed && finalState.status === item.expect.status;
  const visitOk = item.expect.mustVisit.every((nodeId) => finalState.path.includes(nodeId));
  const notVisitOk = item.expect.mustNotVisit.every((nodeId) => !finalState.path.includes(nodeId));
  const acceptedIssuesOk = knownIssueRows.some((issue) => issue.id === introducedId && issue.note === acceptedRegressions[0]!.note)
    && knownIssueRows.some((issue) => issue.id === 'waive:gate' && issue.note === reason);
  const notesOk = notesText.includes('- The gatePodPool setting fails to load from isolated configuration.')
    && notesText.includes(`- ${reason}`);
  const gateNotRerunAfterWaiver = !nodesByPhase.waiver.includes('gate');
  const sameTipWaiver = resumed.tip?.from === appendedTip && resumed.tip.to === appendedTip && resumed.tip.changed === false;
  const reGateChangedTip = reGateTip?.from === initialTip && reGateTip.to === appendedTip && reGateTip.changed === true;
  const releaseTailOk = ['known-issues', 'publish', 'npm-publish', 'done'].every((nodeId) => finalState.path.includes(nodeId));
  recordObservedEdges(finalState.path, ledgerEvents);
  const edgeIssues = unexpectedEdges(finalState.path, finalState, edges);
  const ledgerOk = ledgerEvents.some((row) => row.event === 'node-start') && ledgerEvents.some((row) => row.event === 'node-end')
    && ledgerEvents.some((row) => row.event === 'edge-observed');
  const pass = statusOk && visitOk && notVisitOk && invalidWaiverRejected && invalidAttemptUnchanged
    && movedTipWaiverRefused && movedTipAttemptUnchanged && reGateChangedTip && regatePartial?.requested === true
    && regatePartial.applied === false && regatePartial.auto === true && regateGateCount === 2 && gateRuns === 2
    && sameTipWaiver && gateNotRerunAfterWaiver && acceptedIssuesOk && notesOk && releaseTailOk && ledgerOk && edgeIssues.length === 0;
  return { id: item.id, pass, status: finalState.status, path: finalState.path, dispatchedNodes: nodesByPhase.waiver,
    unexpectedEdges: edgeIssues,
    checks: { status: statusOk, mustVisit: visitOk && releaseTailOk, mustNotVisit: notVisitOk && gateNotRerunAfterWaiver,
      overlap: true, ledgerEvents: ledgerOk },
    injectedEvidence: { initialTip, appendedTip, invalidWaiverRejected, invalidAttemptUnchanged, movedTipWaiverRefused,
      movedTipAttemptUnchanged, reGateTip, regateFailed, regatePartial, regateDispatchedNodes: nodesByPhase.regate,
      regateState: JSON.parse(regatedState) as GraphRunState, gateRuns, sameTipWaiver, acceptedRegressions: knownIssueRows,
      acceptedIssuesOk, releaseNotes: notesText, notesOk, releaseTailOk, initialPath: first.path,
      initialDispatchedNodes: nodesByPhase.initial }, fanOuts: finalState.fanOuts, ledgerEvents, statePath: finalState.statePath };
}

async function runCase(scenario: ReleaseSimRigScenario, item: ReleaseSimRigCase, root: string,
  edges: Map<string, Record<string, unknown>>, sharedUnmeasuredGateFixture: SharedUnmeasuredGateFixture,
): Promise<ReleaseSimRigCaseResult> {
  if (item.mode === 'append-receipt-continuity') return runAppendReceiptCase(scenario, item, root);
  if (item.mode === 'old-graph-measured-waiver') return runOldGraphMeasuredWaiverCase(scenario, item, root, edges);
  if (item.mode === 'appended-tip-regate-before-waiver') return runAppendedTipReGateCase(scenario, item, root, edges);
  if (item.mode === 'macrophage-heal') {
    const inventory: MacrophageScrap[] = [
      { id: 'pr-repair', kind: 'parked-pr', owner: 'seat-a', evidence: { repairRecipe: 'retry-review' } },
      { id: 'draft-stale', kind: 'stale-draft', owner: 'seat-b', evidence: { draftAction: 'close' } },
      { id: 'test-repeated', kind: 'repeated-failing-test', owner: 'seat-c', evidence: { consecutiveFailures: 5 } },
      { id: 'test-timeout', kind: 'flaky-timeout-test', evidence: { timeoutBurned: true } },
      { id: 'artifact-stale', kind: 'stale-generated-artifact', evidence: { sourceFingerprint: 'new', generatedFingerprint: 'old' } },
      { id: 'worktree-orphan', kind: 'orphan-worktree', evidence: { ownerRunStatus: 'done', ownershipVerified: true, mergedMainline: true, worktreePath: '/sim/worktree' } },
      { id: 'pod-orphan', kind: 'orphan-pod', evidence: { ownerRunStatus: 'failed', ownershipVerified: true } },
      { id: 'job-orphan', kind: 'orphan-job', evidence: { ownerRunStatus: 'done', ownershipVerified: true } },
      { id: 'hold-expired', kind: 'expired-hold', owner: 'seat-d', evidence: { holdUntil: '2026-11-05T00:00:00Z' } },
      { id: 'hold-live-owner', kind: 'expired-hold', owner: 'seat-e', evidence: { holdUntil: '2026-11-05T00:00:00Z', ownerRunStatus: 'running' } },
      { id: 'draft-live-owner', kind: 'stale-draft', owner: 'seat-f', evidence: { draftAction: 'close', ownerRunStatus: 'running' } },
      { id: 'receipt-stale', kind: 'stale-receipt', evidence: { receiptStale: true, receiptVerified: true, ownerRunStatus: 'done' } },
      { id: 'worktree-live', kind: 'orphan-worktree', owner: 'seat-live', evidence: { ownerRunStatus: 'running', ownershipVerified: true, mergedMainline: true, worktreePath: '/sim/live-worktree' } },
      { id: 'land-row-merged', kind: 'merged-land-queue-row', evidence: { mergedMainline: true, queueRow: `123\t${'a'.repeat(40)}\t/tree\t/evidence` } },
      { id: 'receipt-unverified', kind: 'stale-receipt', evidence: { receiptStale: true, receiptVerified: false, ownerRunStatus: 'done' } },
    ];
    const now = new Date('2026-11-06T00:00:00Z');
    const active = runMacrophageHeal({ phase: 'active', mode: 'simulation', now, consecutiveFailureLimit: 3, inventory });
    const simulation = runMacrophageHeal({ phase: 'idle', mode: 'simulation', now, consecutiveFailureLimit: 3, inventory });
    const expectedApplied = ['draft-stale', 'test-timeout', 'artifact-stale', 'worktree-orphan', 'pod-orphan', 'job-orphan', 'hold-expired', 'receipt-stale', 'land-row-merged'];
    const appliedIds = simulation.events.filter((event) => event.applied).map((event) => event.id);
    const runId = `release-sim-${scenario.id}-macrophage`;
    const liveRuntime = createMacrophageRuntime({ runId, inventory: () => inventory, now: () => now });
    let state: GraphRunState;
    try {
      state = await runGraph(RELEASE_GRAPH, { runId, eventBus: liveRuntime.eventBus, input: scenario.input, pinChildUniverse: true, quiet: true, deps: {
        root, runBash: async (_command: string, options: { env?: NodeJS.ProcessEnv }) => {
          const { nodeId } = parseContext(options.env ?? process.env);
          return resultForNode(nodeId, undefined, scenario.input.version);
        },
      } });
    } finally { liveRuntime.dispose(); }
    const allLiveEvents = liveRuntime.decisions.map((event) => event.data ?? {});
    const phaseIds = ['pre-gate-join', 'pre-prepare-join', 'release-post-publish-join'];
    const liveEvents = allLiveEvents.filter((event) => event.phaseNodeId === phaseIds[0]);
    const checks = {
      activeDeferred: active.status === 'deferred' && active.events.length === 0 && active.remaining.length === inventory.length,
      actualBusTrace: state.status === 'done' && phaseIds.every((phaseId) => state.path.includes(phaseId)
        && allLiveEvents.filter((event) => event.phaseNodeId === phaseId).length === inventory.length)
        && liveEvents.length === inventory.length && liveEvents.every((event) => typeof event.sourceEventId === 'string'
          && event.result === `planned ${String(event.action)}; no cleanup applied` && event.applied === false),
      simulationBounded: expectedApplied.every((id) => appliedIds.includes(id)) && appliedIds.every((id) => expectedApplied.includes(id)),
      protectedRetained: ['worktree-live', 'receipt-unverified', 'hold-live-owner', 'draft-live-owner'].every((id) => simulation.remaining.includes(id)),
    };
    const path = state.path;
    const expectedStatusOk = state.status === item.expect.status;
    const expectedVisitOk = item.expect.mustVisit.every((node) => path.includes(node));
    const expectedNotVisitOk = item.expect.mustNotVisit.every((node) => !path.includes(node));
    const actualOverlap = false; // This planner case dispatches no graph nodes, so no node overlap occurred.
    const expectedOverlap = item.expect.overlap !== undefined;
    const overlapMatches = actualOverlap === expectedOverlap;
    const pass = Object.values(checks).every(Boolean) && overlapMatches
      && expectedStatusOk && expectedVisitOk && expectedNotVisitOk;
    const ledgerEvents = liveEvents.map((event) => ({ event: 'release.macrophage.decision', id: event.id, kind: event.kind,
      evidence: event.evidence, result: event.result, action: event.action, applied: event.applied,
      sourceEventId: event.sourceEventId, phaseNodeId: event.phaseNodeId }));
    return { id: item.id, pass, status: 'done', path, dispatchedNodes: [],
      unexpectedEdges: [], checks: { status: expectedStatusOk && Object.values(checks).every(Boolean), mustVisit: expectedVisitOk && checks.actualBusTrace,
        mustNotVisit: expectedNotVisitOk && checks.simulationBounded && checks.protectedRetained,
        overlap: overlapMatches, ledgerEvents: ledgerEvents.length === inventory.length },
      injectedEvidence: { scrapCount: inventory.length, active, live: liveEvents, simulation, expectedApplied,
        overlap: { expected: expectedOverlap, actual: actualOverlap } }, ledgerEvents,
      statePath: state.statePath };
  }
  const runId = `release-sim-${scenario.id}-${item.id}`;
  const ledgerEvents: Array<Record<string, unknown>> = [];
  const eventBus = createReleaseTraceBus(ledgerEvents);
  const dispatchedNodes: string[] = [];
  const nodeTimings: NonNullable<ReleaseSimRigCaseResult['nodeTimings']> = {};
  let versionReleaseCliStdout = '';
  let cutoffCliStdout = '';
  let docsNodeCliStdout = '';
  let docsNodeEvidence: Record<string, unknown> = {};
  let pwaNodeEvidence: Record<string, unknown> = {};
  let cutoffWorld: { world: string; repo: string; stateRoot: string; home: string; tmp: string; emptyGitConfig: string } | undefined;
  const runBash = async (command: string, options: { env?: NodeJS.ProcessEnv }) => {
    const { nodeId } = parseContext(options.env ?? process.env);
    if (!command.trim()) throw new Error(`empty command at simulated node ${nodeId}`);
    dispatchedNodes.push(nodeId);
    const startedAtMs = performance.now();
    if (item.mode === 'cutoff-cli-notes-empty' && nodeId === 'version-release') {
      if (command.trim() !== 'bun scripts/release-loop/version-node.ts release --json') throw new Error(`version-release recipe changed: ${command}`);
      const world = join(root, `${runId}-cutoff-world`);
      const seed = join(world, 'seed');
      const origin = join(world, 'origin.git');
      const repo = join(world, 'repo');
      const stateRoot = join(world, 'state');
      const home = join(world, 'home');
      const tmp = join(world, 'tmp');
      const emptyHooks = join(world, 'empty-hooks');
      const emptyTemplate = join(world, 'empty-template');
      const emptyGitConfig = join(world, 'empty.gitconfig');
      rmSync(world, { recursive: true, force: true });
      mkdirSync(join(seed, 'release/public/docs'), { recursive: true });
      mkdirSync(join(seed, 'src/cli'), { recursive: true });
      for (const directory of [stateRoot, home, tmp, emptyHooks, emptyTemplate]) mkdirSync(directory, { recursive: true });
      writeFileSync(emptyGitConfig, '');
      writeFileSync(join(seed, 'package.json'), `${JSON.stringify({ name: 'release-sim-cut', version: scenario.input.version })}\n`);
      writeFileSync(join(seed, 'release/public/docs/cli.md'), '## `elanous sim`\n');
      const gitExecutable = Bun.which('git');
      if (!gitExecutable) throw new Error('release cut sim requires git executable');
      const worldEnv = (base: NodeJS.ProcessEnv) => releaseCutWorldEnv(base, home, tmp, emptyGitConfig);
      const git = (cwd: string, ...args: string[]) => execFileSync(gitExecutable, args, { cwd, env: worldEnv(process.env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      git(world, 'init', '--bare', `--template=${emptyTemplate}`, '-q', origin);
      git(origin, 'config', 'core.hooksPath', emptyHooks);
      git(seed, 'init', `--template=${emptyTemplate}`, '-q'); git(seed, 'config', 'core.hooksPath', emptyHooks);
      git(seed, 'config', 'user.name', 'Release sim'); git(seed, 'config', 'user.email', 'release-sim@example.invalid');
      git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'release simulation baseline');
      git(seed, 'tag', `v${scenario.input.previousVersion}`);
      git(seed, 'remote', 'add', 'origin', origin); git(seed, 'push', '-q', '-u', 'origin', 'HEAD:main');
      git(seed, 'push', '-q', 'origin', `refs/tags/v${scenario.input.previousVersion}`);
      git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
      writeFileSync(join(seed, 'src/cli/simulated-cut.ts'), 'export const simulatedCut = true;\n');
      git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'feat: simulated release cut');
      git(seed, 'push', '-q', 'origin', 'HEAD:main');
      execFileSync(gitExecutable, ['clone', '-q', `--template=${emptyTemplate}`, origin, repo], {
        cwd: world, env: worldEnv(process.env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      git(repo, 'config', 'core.hooksPath', emptyHooks);
      git(repo, 'config', 'user.name', 'Release sim'); git(repo, 'config', 'user.email', 'release-sim@example.invalid');
      if (git(repo, 'remote', 'get-url', 'origin') !== origin) throw new Error('release cut sim origin is not the isolated local bare repository');
      symlinkSync(join(REPOSITORY_ROOT, 'scripts'), join(repo, 'scripts'), 'dir');
      cutoffWorld = { world, repo, stateRoot, home, tmp, emptyGitConfig };
      const contextValue = options.env?.ELANOUS_GRAPH_CONTEXT;
      if (!contextValue) throw new Error('release graph context missing for version-release CLI');
      const context = JSON.parse(contextValue.trimStart().startsWith('{') ? contextValue : readFileSync(contextValue, 'utf8')) as {
        input: Record<string, unknown> };
      context.input = { ...context.input, branchCut: true };
      const cli = spawnSync('bun', ['scripts/release-loop/version-node.ts', 'release', '--json'], {
        cwd: repo, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...worldEnv({ ...process.env, ...options.env }), ELANOUS_STATE_DIR: stateRoot, ELANOUS_STATE_DIR_SOURCE: 'explicit',
          ELANOUS_NEXUS_DIR: stateRoot, ELANOUS_GRAPH_CONTEXT: JSON.stringify(context) },
      });
      versionReleaseCliStdout = cli.stdout ?? '';
      nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
      if (cli.error) throw cli.error;
      return { exitCode: cli.status ?? 2, stdout: cli.stdout ?? '', stderr: cli.stderr ?? '' };
    }
    if (item.mode === 'cutoff-cli-notes-empty' && nodeId === 'cutoff') {
      if (command.trim() !== 'bun scripts/release-loop/node-verdict.ts cutoff') throw new Error(`cutoff recipe changed: ${command}`);
      if (!cutoffWorld) throw new Error('version-release CLI did not create an isolated cutoff world');
      const cli = spawnSync('bun', ['scripts/release-loop/node-verdict.ts', 'cutoff'], {
        cwd: cutoffWorld.repo, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...releaseCutWorldEnv({ ...process.env, ...options.env }, cutoffWorld.home, cutoffWorld.tmp, cutoffWorld.emptyGitConfig), ELANOUS_STATE_DIR: cutoffWorld.stateRoot, ELANOUS_STATE_DIR_SOURCE: 'explicit',
          ELANOUS_NEXUS_DIR: cutoffWorld.stateRoot },
      });
      cutoffCliStdout = cli.stdout ?? '';
      nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
      if (cli.error) throw cli.error;
      return { exitCode: cli.status ?? 2, stdout: cli.stdout ?? '', stderr: cli.stderr ?? '' };
    }
    if (item.mode === 'docs-node-cli-in-sim' && nodeId === 'docs') {
      if (command.trim() !== 'bun scripts/release-loop/docs-node.ts --json') throw new Error(`docs recipe changed: ${command}`);
      const world = join(root, `${runId}-docs-world`);
      const seed = join(world, 'seed');
      const origin = join(world, 'origin.git');
      const repo = join(world, 'repo');
      const stateRoot = join(world, 'state');
      const home = join(world, 'home');
      const tmp = join(world, 'tmp');
      const emptyHooks = join(world, 'empty-hooks');
      const emptyTemplate = join(world, 'empty-template');
      const emptyGitConfig = join(world, 'empty.gitconfig');
      const fakeBin = join(world, 'fake-bin');
      rmSync(world, { recursive: true, force: true });
      for (const directory of [stateRoot, home, tmp, emptyHooks, emptyTemplate, fakeBin]) mkdirSync(directory, { recursive: true });
      writeFileSync(emptyGitConfig, '');
      const gitExecutable = Bun.which('git');
      const bunExecutable = Bun.which('bun');
      if (!gitExecutable || !bunExecutable) throw new Error('docs node sim requires git and bun executables');
      const isolatedEnv = releaseCutWorldEnv(process.env, home, tmp, emptyGitConfig);
      const git = (cwd: string, ...args: string[]) => execFileSync(gitExecutable, args, { cwd, env: isolatedEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      mkdirSync(join(seed, 'release/public/docs'), { recursive: true });
      mkdirSync(join(seed, 'release/public/docs/releases'), { recursive: true });
      mkdirSync(join(seed, 'website'), { recursive: true });
      mkdirSync(join(seed, 'scripts/release-loop'), { recursive: true });
      writeFileSync(join(seed, 'package.json'), '{"name":"release-docs-sim","version":"0.0.0","private":true}\n');
      writeFileSync(join(seed, 'release/public/docs/cli.md'), '## CLI\n\n🟡 on main — next release\n');
      writeFileSync(join(seed, 'release/public/docs/releases/index.md'), '# Releases\n');
      writeFileSync(join(seed, 'website/pages.json'), '{"pages":[]}\n');
      symlinkSync(join(REPOSITORY_ROOT, 'scripts/release-loop/docs-node.ts'), join(seed, 'scripts/release-loop/docs-node.ts'));
      git(seed, 'init', '-b', 'main', `--template=${emptyTemplate}`, '-q');
      git(seed, 'config', 'core.hooksPath', emptyHooks);
      git(seed, 'config', 'user.name', 'Release sim'); git(seed, 'config', 'user.email', 'release-sim@example.invalid');
      git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'release docs simulation baseline');
      git(world, 'clone', '-q', '--bare', `--template=${emptyTemplate}`, seed, origin);
      git(origin, 'config', 'core.hooksPath', emptyHooks);
      git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
      execFileSync(gitExecutable, ['clone', '-q', `--template=${emptyTemplate}`, origin, repo], {
        cwd: world, env: isolatedEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      git(repo, 'config', 'core.hooksPath', emptyHooks);
      git(repo, 'config', 'user.name', 'Release sim'); git(repo, 'config', 'user.email', 'release-sim@example.invalid');
      if (git(repo, 'remote', 'get-url', 'origin') !== origin) throw new Error('docs sim origin is not the isolated local bare repository');
      const fakeBun = join(fakeBin, 'bun');
      writeFileSync(fakeBun, '#!/bin/sh\nif [ "$1" = install ] && [ "$2" = --frozen-lockfile ]; then\n  ln -s "$ELANOUS_SIM_NODE_MODULES" "$PWD/node_modules"\n  exit 0\nfi\necho "unexpected bun boundary: $*" >&2\nexit 97\n');
      chmodSync(fakeBun, 0o755);
      const contextValue = options.env?.ELANOUS_GRAPH_CONTEXT;
      if (!contextValue) throw new Error('release graph context missing for docs node CLI');
      const context = JSON.parse(contextValue.trimStart().startsWith('{') ? contextValue : readFileSync(contextValue, 'utf8')) as {
        input: { version: string }; outputs: Record<string, { outcome?: string; commit?: string }> };
      const version = context.input.version;
      const versionCommit = context.outputs['version-release']?.commit;
      if (!versionCommit || !/^[0-9a-f]{40}$/i.test(versionCommit)) throw new Error('docs sim release commit missing from graph context');
      mkdirSync(join(stateRoot, 'release', version), { recursive: true });
      writeFileSync(join(stateRoot, 'release', version, 'manifest.json'), `${JSON.stringify({
        version, baseline: { ref: `v${scenario.input.previousVersion}`, sha: cutTip() }, cutoff: { sha: versionCommit },
        in: [{ sha: versionCommit, title: 'feat: simulated docs node', docs: 'present', kind: 'feat', line: 'Simulation publishes release documentation.' }],
        deferred: [], escalate: [],
      }, null, 2)}\n`);
      const cli = spawnSync(bunExecutable, ['scripts/release-loop/docs-node.ts', '--json'], {
        cwd: repo, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...isolatedEnv, PATH: [fakeBin, isolatedEnv.PATH].join(delimiter),
          ELANOUS_SIM_NODE_MODULES: join(REPOSITORY_ROOT, 'node_modules'), ELANOUS_GRAPH_CONTEXT: contextValue,
          ELANOUS_STATE_DIR: stateRoot, ELANOUS_STATE_DIR_SOURCE: 'explicit', ELANOUS_NEXUS_DIR: stateRoot },
      });
      docsNodeCliStdout = cli.stdout ?? '';
      nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
      if (cli.error) throw cli.error;
      if (cli.status !== 0) {
        docsNodeEvidence = { actualCli: 'bun scripts/release-loop/docs-node.ts --json', cliStatus: cli.status,
          cliOutput: docsNodeCliStdout, cliStderr: cli.stderr ?? '', remote: 'local-bare-only' };
        return { exitCode: cli.status ?? 2, stdout: cli.stdout ?? '', stderr: cli.stderr ?? '' };
      }
      const branch = `release-docs/${version}`;
      const remoteHead = git(origin, 'rev-parse', `refs/heads/${branch}`);
      const remoteNotes = git(origin, 'show', `${branch}:release/public/docs/releases/${version}.md`);
      const remotePages = git(origin, 'show', `${branch}:website/pages.json`);
      const remoteMarker = git(origin, 'show', `${branch}:release/public/docs/cli.md`);
      const cliPayload = JSON.parse(docsNodeCliStdout.trim().split('\n').at(-1) ?? 'null') as { outcome?: unknown; branch?: unknown };
      docsNodeEvidence = { actualCli: 'bun scripts/release-loop/docs-node.ts --json', cliStatus: cli.status,
        cliOutput: docsNodeCliStdout, remote: 'local-bare-only', branch, remoteHead,
        cliOutcome: cliPayload.outcome, cliBranch: cliPayload.branch,
        notesRegistered: remoteNotes.includes('Simulation publishes release documentation.'),
        pagesRegistered: remotePages.includes(`"id": "releases/${version}"`),
        markerFlipped: remoteMarker.includes(`✅ in v${version}`) && !remoteMarker.includes('🟡 on main') };
      if (cliPayload.outcome !== 'ok' || cliPayload.branch !== branch || !docsNodeEvidence.notesRegistered
        || !docsNodeEvidence.pagesRegistered || !docsNodeEvidence.markerFlipped)
        throw new Error(`actual docs node CLI did not publish complete docs evidence: ${JSON.stringify(docsNodeEvidence)}`);
      return { exitCode: cli.status ?? 2, stdout: cli.stdout ?? '', stderr: cli.stderr ?? '' };
    }
    if (item.mode === 'pwa-costly-opt-in-required' && nodeId === 'pwa') {
      let nodeStdout = '';
      const fakeBin = join(root, `${runId}-fake-bin`);
      const fakeNexusServer = join(root, `${runId}-fake-nexus-server.cjs`);
      const worktreeLifecycleLog = join(root, `${runId}-worktree-lifecycle.log`);
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(fakeNexusServer, "const http=require('node:http'); const server=http.createServer((req,res)=>{res.statusCode=200;res.end('simulated nexus');}); server.listen(0,'127.0.0.1',()=>console.log('nexus :'+server.address().port+' pid '+process.pid));\n");
      writeFileSync(worktreeLifecycleLog, '');
      const fakeBun = join(fakeBin, 'bun');
      writeFileSync(fakeBun, '#!/bin/sh\nif [ "$1" = "-e" ]; then printf \'[{"id":"regular","costly":false},{"id":"C1","costly":true}]\\n\'; exit 0; fi\nif [ "$1" = "scripts/pwa-scenarios.ts" ]; then printf \'{"results":[{"id":"regular","pass":true}]}\\n\'; exit 0; fi\nif [ "$1" = "bin/elanous.mjs" ] && [ "$2" = "nexus" ] && [ "$3" = "build" ]; then exit 0; fi\nif [ "$1" = "bin/elanous.mjs" ] && [ "$2" = "--test" ] && [ "$3" = "nexus" ] && [ "$4" = "run" ]; then\n  if [ "$5" = "--stop" ]; then exit 0; fi\n  "$ELANOUS_SIM_NODE_EXECUTABLE" "$ELANOUS_SIM_NEXUS_SERVER" &\n  exit 0\nfi\necho "unexpected bun boundary: $*" >&2\nexit 97\n');
      const fakeGit = join(fakeBin, 'git');
      writeFileSync(fakeGit, createReleaseSimRigFakeGitScript());
      chmodSync(fakeBun, 0o755); chmodSync(fakeGit, 0o755);
      const trafficPath = join(root, `${runId}-traffic.json`);
      writeFileSync(trafficPath, `${JSON.stringify({ global: 'green', seats: { OP: {}, TC: {}, MK: {}, UX: {} } })}\n`);
      const originalLog = console.log;
      try {
        console.log = (...values: unknown[]) => { nodeStdout += `${values.map(String).join(' ')}\n`; };
        const pwaEnv: NodeJS.ProcessEnv = { ...process.env, ...options.env, ELANOUS_TRAFFIC_SIGNAL: trafficPath };
        const exitCode = await runNodeVerdict(['pwa'], pwaEnv, (program, args) => {
          if (program !== 'bun' || args[0] !== 'scripts/release-loop/pwa-scenarios-node.ts')
            return { status: 97, stdout: '', stderr: `unexpected PWA boundary ${program} ${args.join(' ')}` };
          const bunExecutable = Bun.which('bun');
          const nodeExecutable = Bun.which('node');
          if (!bunExecutable || !nodeExecutable) return { status: 97, stdout: '', stderr: 'bun/node executable unavailable for isolated PWA simulation' };
          const child = spawnSync(bunExecutable, args, { cwd: REPOSITORY_ROOT, encoding: 'utf8', timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...options.env, PATH: [fakeBin, process.env.PATH ?? ''].join(delimiter),
              ELANOUS_SIM_NODE_EXECUTABLE: nodeExecutable, ELANOUS_SIM_NEXUS_SERVER: fakeNexusServer, ELANOUS_SIM_RIG_RUN_ID: runId,
              ELANOUS_SIM_RIG_WORKTREE_LOG: worktreeLifecycleLog,
              ELANOUS_SIM_RIG_MARKER_SNAPSHOT: join(root, `${runId}-worktree-marker.snapshot`),
              ELANOUS_SIM_RIG_WORKTREE_PATH_SNAPSHOT: join(root, `${runId}-worktree-path.snapshot`) } });
          let externalResult: Record<string, unknown> | null = null;
          try { externalResult = JSON.parse((child.stdout ?? '').trim().split('\n').at(-1) ?? 'null') as Record<string, unknown> | null; } catch { /* Preserve child diagnostics below. */ }
          pwaNodeEvidence = { actualNode: 'runNodeVerdict(pwa)', actualCli: 'scripts/release-loop/pwa-scenarios-node.ts',
            externalBoundary: [program, ...args], costlyRequested: args.includes('--with-costly'), externalResult, stderr: child.stderr ?? '',
            worktreeLifecycle: readFileSync(worktreeLifecycleLog, 'utf8').trim().split('\n').filter(Boolean) };
          return { status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
        });
        pwaNodeEvidence = { ...pwaNodeEvidence, exitCode, capturedOutput: nodeStdout };
        nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
        return { exitCode, stdout: nodeStdout, stderr: '' };
      } finally { console.log = originalLog; }
    }
    const injection = item.nodeOutcomes?.[nodeId];
    if (nodeId === 'gate-triage') {
      const child = spawnSync('bun', ['scripts/release-loop/gate-triage-node.ts'], {
        cwd: REPOSITORY_ROOT, env: { ...process.env, ...options.env }, encoding: 'utf8', maxBuffer: 1024 * 1024,
      });
      nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
      return { exitCode: child.status ?? 2, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
    }
    const injectedFault = item.mode === 'approval-graph-path-mismatch' && nodeId === 'auto-approve'
      ? { node: nodeId, outcome: 'error' as const, evidence: { approvalSnapshot: 'other graph path' } } : item.fault;
    const result = injection ? resultForNode(nodeId, injection.outcome === 'ok' ? undefined : {
      node: nodeId, outcome: injection.outcome, evidence: {},
    }, scenario.input.version) : resultForNode(nodeId, injectedFault, scenario.input.version);
    if (injection?.delayMs) await new Promise((resolve) => setTimeout(resolve, injection.delayMs));
    nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  };
  const capture = (event: string, data: Record<string, unknown>) => ledgerEvents.push({ event, ...data });

  if (item.mode === 'gate-waive-introduced-regression' || item.mode === 'owner-waive-unmeasured-gate' || item.mode === 'owner-waive-0246-fixture') return runGateWaiveCase(scenario, item, root, edges,
    item.unmeasuredGateShape ? sharedUnmeasuredGateFixture : undefined);

  if (item.mode === 'approval-graph-path-mismatch') {
    const waiting = await runGraph(RELEASE_GRAPH, { runId, input: scenario.input, pinChildUniverse: true, quiet: true, eventBus,
      deps: { root, runBash, log: capture } });
    let refusal = '';
    try {
      await runGraph(RELEASE_GRAPH, { resumeRunId: runId, input: scenario.input, useCurrentGraph: true,
        graphSource: `${readFileSync(RELEASE_GRAPH, 'utf8')}\n# simulated alternate approval graph source\n`, pinChildUniverse: true, quiet: true, eventBus,
        deps: { root, runBash, log: capture } });
    } catch (error) { refusal = error instanceof Error ? error.message : String(error); }
    const saved = listGraphRuns(root).runs.find((run) => run.runId === runId);
    const path = saved?.path ?? waiting.path;
    recordObservedEdges(path, ledgerEvents);
    const edgeIssues = saved ? unexpectedEdges(path, saved, edges) : [];
    const visited = new Set([...path, ...Object.values(saved?.fanOuts ?? {}).flatMap((fanout) => Object.keys(fanout.branches))]);
    const statusOk = waiting.status === 'awaiting-approval' && refusal.includes(item.expect.refusalIncludes ?? 'approval source changed since run was paused');
    const visitOk = item.expect.mustVisit.every((id) => visited.has(id));
    const notVisitOk = item.expect.mustNotVisit.every((id) => !visited.has(id));
    const eventTrace = checkExpectedEvents(item.expect.events, ledgerEvents);
    const ledgerOk = ledgerEvents.some((row) => row.event === 'node-start') && ledgerEvents.some((row) => row.event === 'node-end')
      && ledgerEvents.filter((row) => row.event === 'edge-observed').length === Math.max(0, path.length - 1);
    return { id: item.id, pass: statusOk && visitOk && notVisitOk && ledgerOk && (eventTrace?.pass ?? true) && edgeIssues.length === 0,
      status: statusOk ? 'resume-refused' : waiting.status, path, dispatchedNodes, unexpectedEdges: edgeIssues,
      checks: { status: statusOk, mustVisit: visitOk, mustNotVisit: notVisitOk, overlap: true, ledgerEvents: ledgerOk, ...(eventTrace ? { events: eventTrace.pass } : {}) },
      injectedEvidence: { approvalDecision: 'not recorded', changedGraphSource: true, refusal, ...(eventTrace ? { eventTrace } : {}) },
      fanOuts: waiting.fanOuts, nodeTimings, ledgerEvents, statePath: waiting.statePath, ...(refusal ? { refusal } : {}) };
  }

  if (item.mode === 'cut-tip-moved-after-resume') {
    let beforeNode = 0;
    const simulatedStop = new Error('simulated runner stop after cut');
    try {
      await runGraph(RELEASE_GRAPH, { runId, input: scenario.input, pinChildUniverse: true, quiet: true, eventBus,
        deps: { root, runBash, log: capture, beforeNode: () => { if (++beforeNode === 2) throw simulatedStop; } } });
    } catch (error) {
      if (error !== simulatedStop) throw error;
    }
    let refusal = '';
    try {
      await runGraph(RELEASE_GRAPH, { resumeRunId: runId, pinChildUniverse: true, quiet: true, eventBus,
        releaseCommandSource: { root: REPOSITORY_ROOT, cutTip: 'b'.repeat(40), git: () => { throw new Error('git must not be consulted after the saved tip differs'); } },
        deps: { root, runBash, log: capture } });
    } catch (error) { refusal = error instanceof Error ? error.message : String(error); }
    const interrupted = listGraphRuns(root).runs.find((run) => run.runId === runId);
    const stateFile = interrupted?.statePath ?? '';
    const path = interrupted?.path ?? [];
    const visited = new Set([...path, ...Object.values(interrupted?.fanOuts ?? {}).flatMap((fanout) => Object.keys(fanout.branches))]);
    recordObservedEdges(path, ledgerEvents);
    const edgeIssues = interrupted ? unexpectedEdges(path, interrupted, edges) : [];
    const statusOk = item.expect.status === 'resume-refused' && refusal.includes(item.expect.refusalIncludes ?? 'release command source differs from the saved cut tip');
    const visitOk = item.expect.mustVisit.every((id) => visited.has(id));
    const notVisitOk = item.expect.mustNotVisit.every((id) => !visited.has(id));
    const overlapPair = item.expect.overlap;
    const overlapOk = !overlapPair || (!!nodeTimings[overlapPair[0]] && !!nodeTimings[overlapPair[1]] &&
      nodeTimings[overlapPair[0]]!.startedAtMs < nodeTimings[overlapPair[1]]!.endedAtMs &&
      nodeTimings[overlapPair[1]]!.startedAtMs < nodeTimings[overlapPair[0]]!.endedAtMs);
    const ledgerOk = ledgerEvents.some((row) => row.event === 'node-end')
      && ledgerEvents.filter((row) => row.event === 'edge-observed').length === Math.max(0, path.length - 1);
    const eventTrace = checkExpectedEvents(item.expect.events, ledgerEvents);
    return { id: item.id, pass: statusOk && visitOk && notVisitOk && overlapOk && ledgerOk && (eventTrace?.pass ?? true) && edgeIssues.length === 0, status: statusOk ? 'resume-refused' : interrupted?.status ?? 'missing',
      path, dispatchedNodes, unexpectedEdges: edgeIssues, checks: { status: statusOk, mustVisit: visitOk, mustNotVisit: notVisitOk, overlap: overlapOk, ledgerEvents: ledgerOk, ...(eventTrace ? { events: eventTrace.pass } : {}) }, injectedEvidence: eventTrace ? { eventTrace } : {}, ledgerEvents,
      statePath: stateFile, ...(refusal ? { refusal } : {}) };
  }

  // Initial runs have no releaseCommandSource (the runner only accepts it on resume); all node shell work is intercepted here.
  const state = await runGraph(RELEASE_GRAPH, { runId, input: scenario.input, pinChildUniverse: true, quiet: true, eventBus,
    deps: { root, runBash, log: capture } });
  const path = state.path;
  const visited = new Set([...path, ...Object.values(state.fanOuts ?? {}).flatMap((fanout) => Object.keys(fanout.branches))]);
  recordObservedEdges(path, ledgerEvents);
  const edgeIssues = unexpectedEdges(path, state, edges);
  const statusOk = state.status === item.expect.status;
  const visitOk = item.expect.mustVisit.every((id) => visited.has(id));
  const notVisitOk = item.expect.mustNotVisit.every((id) => !visited.has(id));
  const overlapPair = item.expect.overlap;
  const overlapOk = !overlapPair || (!!nodeTimings[overlapPair[0]] && !!nodeTimings[overlapPair[1]] &&
    nodeTimings[overlapPair[0]]!.startedAtMs < nodeTimings[overlapPair[1]]!.endedAtMs &&
    nodeTimings[overlapPair[1]]!.startedAtMs < nodeTimings[overlapPair[0]]!.endedAtMs);
  const ledgerOk = ledgerEvents.some((row) => row.event === 'node-start') && ledgerEvents.some((row) => row.event === 'node-end')
    && ledgerEvents.filter((row) => row.event === 'edge-observed').length === Math.max(0, path.length - 1);
  const eventTrace = checkExpectedEvents(item.expect.events, ledgerEvents);
  const actualGateOutput = state.nodes.find((node) => node.nodeId === 'gate')?.output;
  const actualTriageOutput = state.nodes.find((node) => node.nodeId === 'gate-triage')?.output;
  const adaptiveRepairRequired = item.fault?.node === 'gate' && item.fault.outcome === 'fail'
    && item.fault.evidence?.realGateTriage === true && Array.isArray(item.fault.evidence.introduced)
    && item.fault.evidence.introduced.length > 0;
  const triageOutput = outputRecord(actualTriageOutput);
  const adaptiveHeal = triageOutput?.adaptiveHeal && typeof triageOutput.adaptiveHeal === 'object'
    ? record(triageOutput.adaptiveHeal, 'gate-triage adaptiveHeal') : undefined;
  const disposition = adaptiveHeal?.disposition && typeof adaptiveHeal.disposition === 'object'
    ? record(adaptiveHeal.disposition, 'gate-triage adaptiveHeal.disposition') : undefined;
  const firstTriageIndex = path.indexOf('gate-triage');
  const repairNodeId = firstTriageIndex >= 0 ? path[firstTriageIndex + 1] : undefined;
  const adaptiveAppend = state.adaptiveGateNodeAppends?.find(({ request }) => request.node.nodeId === repairNodeId);
  const adaptiveRepairOk = !adaptiveRepairRequired || (state.status === 'failed'
    && path.filter((nodeId) => nodeId === 'gate').length === 2
    && typeof repairNodeId === 'string' && /^gate-repair-[a-f0-9]{12}$/.test(repairNodeId)
    && path[firstTriageIndex + 2] === 'gate'
    && adaptiveAppend?.request.rerunGateAt === 'gate'
    && disposition?.action === 'append-repair-and-resume'
    && path.includes('traffic-failed-restore') && !path.includes('publish'));
  const injectedEvidence = { ...(item.fault ? item.fault.evidence ?? {} : {}),
    ...(item.fault?.evidence?.realGateTriage === true ? { actualGateTriage: {
      gate: outputRecord(actualGateOutput),
      triage: outputRecord(actualTriageOutput),
    } } : {}),
    ...(Object.keys(pwaNodeEvidence).length ? { pwaNode: pwaNodeEvidence } : {}),
    ...(item.mode === 'cutoff-cli-notes-empty' ? { actualCli: 'version-node.ts release → node-verdict.ts cutoff → cutoff.ts',
      actualVersionReleaseCliOutput: versionReleaseCliStdout, actualCutoffCliOutput: cutoffCliStdout } : {}),
    ...(item.mode === 'docs-node-cli-in-sim' ? docsNodeEvidence : {}) };
  return { id: item.id, pass: statusOk && visitOk && notVisitOk && overlapOk && ledgerOk && adaptiveRepairOk && (eventTrace?.pass ?? true) && edgeIssues.length === 0, status: state.status, path, dispatchedNodes, unexpectedEdges: edgeIssues,
    checks: { status: statusOk, mustVisit: visitOk, mustNotVisit: notVisitOk, overlap: overlapOk, ledgerEvents: ledgerOk,
      ...(adaptiveRepairRequired ? { adaptiveRepair: adaptiveRepairOk } : {}), ...(eventTrace ? { events: eventTrace.pass } : {}) },
    injectedEvidence: { ...injectedEvidence, ...(adaptiveRepairRequired ? { adaptiveRepair: { disposition: disposition?.action ?? null, appendCount: state.adaptiveGateNodeAppends?.length ?? 0 } } : {}), ...(eventTrace ? { eventTrace } : {}) },
    fanOuts: state.fanOuts, nodeTimings, ledgerEvents, statePath: state.statePath };
}

export async function runReleaseSimRigScenario(source: string): Promise<ReleaseSimRigResult> {
  const scenario = parseReleaseSimRigScenario(source);
  const root = getTestStateRoot();
  if (!root) throw new Error('release simulation rig requires --test isolated mode');
  const { edges } = releaseGraphShape(scenario.input.releaseGateFanout === true);
  const cases = [];
  const sharedUnmeasuredGateFixture: SharedUnmeasuredGateFixture = {
    runId: `release-sim-${scenario.id}-unmeasured-gate-shared`, initialRuns: 0,
  };
  for (const item of scenario.cases) cases.push(await runCase(scenario, item, root, edges, sharedUnmeasuredGateFixture));
  const result: ReleaseSimRigResult = { id: scenario.id, pass: cases.every((item) => item.pass), universe: root, cases,
    table: cases.map((item) => ({ scenario: item.id, path: item.path.join(' → '), status: item.status,
      unexpectedEdges: item.unexpectedEdges.length ? JSON.stringify(item.unexpectedEdges) : 'none' })),
    artifactPath: join(root, 'ux-sim', 'evidence', `${scenario.id}.json`) };
  mkdirSync(join(root, 'ux-sim', 'evidence'), { recursive: true });
  writeFileSync(result.artifactPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return result;
}

export async function runReleaseSimRigIfFile(filePath: string): Promise<ReleaseSimRigResult | null> {
  const source = readFileSync(resolveScenarioFilePath(filePath), 'utf8');
  if (record(parseYaml(source), 'scenario').kind !== 'release-graph') return null;
  if (!getTestStateRoot()) throw new Error('release simulation rig requires --test isolated mode');
  return runReleaseSimRigScenario(source);
}
