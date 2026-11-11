import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { resolveCurrentInstance } from '../instance/current.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { addItem, checklistDevVersion, checklistHistory, devVersion, listChecklist } from '../release-loop/checklist.js';
import { assignedVersions as assignedChecklistVersions } from '../release-loop/feature-store.js';
import { resolveTimeZone } from '../time/time-zone.js';
import { adaptIOSChatEdgeInputs, hasChangedIOSChatEdgeTouch, isIOSChatEdgeSeed } from './ios-chat-edge-adapter.js';
import {
  EDGE_CREATOR_INCIDENT_SEEDS,
  edgeCreatorTupleKey,
  evaluateEdgeCreatorPromotion,
  generateEdgeCreatorPlan,
  runEdgeCreatorE5Simulation,
  runEdgeCreatorM2Simulation,
  type EdgeCreatorE5Result,
  type EdgeCreatorM2Result,
  type EdgeCreatorPlan,
  type EdgeCreatorPlanOptions,
  type EdgeCreatorPromotionEvidence,
  type EdgeCreatorSeed,
  type EdgeCreatorScenarioTrace,
} from './edge-creator.js';

const DEFAULT_NIGHTLY_AT = '02:00';
// 출처: src/domains/watch-default-scheduler.ts polls daemon-owned daily work once per minute.
const DEFAULT_TICK_INTERVAL_MS = 60_000;
const activeTestUniverseSimLeases = new Set<string>();

export interface EdgeCreatorFailure {
  key: string;
  incidentId: string;
  invariant: string;
  summary: string;
  detail: string;
  codePath?: string;
  severity?: 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'unknown';
}

export interface EdgeCreatorFailureCluster {
  clusterId: string;
  invariant: string;
  codePath?: string;
  failures: readonly EdgeCreatorFailure[];
}

/** Same invariant at the same code location becomes one repair cell; unknown locations stay separate. */
export function clusterEdgeCreatorFailures(failures: readonly EdgeCreatorFailure[]): EdgeCreatorFailureCluster[] {
  const groups = new Map<string, EdgeCreatorFailure[]>();
  for (const failure of failures) {
    const key = failure.codePath ? `${failure.invariant}\0${failure.codePath}` : `unlocated\0${failure.key}`;
    const group = groups.get(key) ?? [];
    group.push(failure);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => ({
    clusterId: createHash('sha256').update(key).digest('hex'), invariant: group[0]!.invariant,
    ...(group[0]!.codePath ? { codePath: group[0]!.codePath } : {}), failures: group,
  }));
}

export interface EdgeCreatorNightlyResult {
  status: 'green' | 'red';
  version: string;
  plan: EdgeCreatorPlan | null;
  m2: EdgeCreatorM2Result | null;
  e5: EdgeCreatorE5Result | null;
  failures: EdgeCreatorFailure[];
  unrecordedFailures: EdgeCreatorFailure[];
  deferredFailures?: EdgeCreatorFailure[];
  promotion?: ReturnType<typeof evaluateEdgeCreatorPromotion> | null;
  completedScenarioReceipts?: Array<{ head: string; scenarioHash: string; status: 'green' }>;
  unmeasuredScenarioHashes?: string[];
  failedScenarioHashes?: string[];
  scenarioTraces?: Record<string, EdgeCreatorScenarioTrace>;
  checklistCellIds: string[];
  cellRecordingComplete: boolean;
  checklistVersionStatus?: 'confirmed' | 'unconfirmed-observation-only';
}

export interface EdgeCreatorNightlyDeps {
  version?: () => string;
  /** Test seam for a deterministic snapshot of checklist versions known to the release ledger. */
  availableChecklistVersions?: () => string[];
  seeds?: readonly EdgeCreatorSeed[];
  generatePlan?: (seeds: readonly EdgeCreatorSeed[], options?: EdgeCreatorPlanOptions) => EdgeCreatorPlan;
  runM2?: (seeds: readonly EdgeCreatorSeed[], scenario?: { axes: EdgeCreatorSeed['axes']; scenarioHash: string }) => Promise<EdgeCreatorM2Result>;
  runE5?: (scenario?: { axes: EdgeCreatorSeed['axes']; scenarioHash: string }) => Promise<EdgeCreatorE5Result>;
  runScenarioM2?: (seeds: readonly EdgeCreatorSeed[], scenario: { axes: EdgeCreatorSeed['axes']; scenarioHash: string }) => Promise<EdgeCreatorM2Result>;
  runScenarioE5?: (scenario: { axes: EdgeCreatorSeed['axes']; scenarioHash: string }) => Promise<EdgeCreatorE5Result>;
  ensureCell?: (input: { version: string; id: string; title: string; owner: string; failure: EdgeCreatorFailure }) => boolean;
  classifySeverity?: (failure: EdgeCreatorFailure) => EdgeCreatorFailure['severity'];
  /** Sourced by the idle sim-slot lease/policy; absent means the daily cap remains unmeasured. */
  maxNewCellsPerRun?: number;
  planOptions?: EdgeCreatorPlanOptions;
  scenarioTraces?: Readonly<Record<string, EdgeCreatorScenarioTrace>>;
  promotionEvidence?: EdgeCreatorPromotionEvidence;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  pendingFailures?: readonly EdgeCreatorFailure[];
  now?: () => Date;
}

export async function runEdgeCreatorNightly(deps: EdgeCreatorNightlyDeps = {}): Promise<EdgeCreatorNightlyResult> {
  const cpuStartedAt = process.cpuUsage();
  const observe = deps.log ?? ((category: string, event: string, data: Record<string, unknown>) => debug.log(category, event, data));
  const version = (deps.version ?? devVersion)();
  const checklistVersion = checklistDevVersion(version);
  let availableChecklistVersions = new Set<string>();
  let checklistVersionLookupError: string | undefined;
  try { availableChecklistVersions = new Set((deps.availableChecklistVersions ?? assignedChecklistVersions)()); }
  catch (error) { checklistVersionLookupError = errorMessage(error); }
  const checklistVersionStatus = availableChecklistVersions.has(checklistVersion) ? 'confirmed' : 'unconfirmed-observation-only';
  if (checklistVersionStatus === 'unconfirmed-observation-only') observe('ux-sim.edge-creator', 'nightly-version-unconfirmed', {
    version, checklistVersion, mode: 'observation-only',
    reason: checklistVersionLookupError ? 'checklist-version-lookup-failed' : 'checklist-version-not-assigned',
    ...(checklistVersionLookupError ? { error: checklistVersionLookupError } : {}),
  });
  const changedTouches = deps.planOptions?.changedTouches ?? [];
  const seeds = deps.seeds ?? (hasChangedIOSChatEdgeTouch(changedTouches)
    ? [...EDGE_CREATOR_INCIDENT_SEEDS, ...adaptIOSChatEdgeInputs()]
    : EDGE_CREATOR_INCIDENT_SEEDS);
  const failures: EdgeCreatorFailure[] = [...(deps.pendingFailures ?? [])];
  const addFailure = (failure: EdgeCreatorFailure) => {
    if (!failures.some((item) => item.key === failure.key)) failures.push(failure);
  };
  let plan: EdgeCreatorPlan | null = null;
  let m2: EdgeCreatorM2Result | null = null;
  let e5: EdgeCreatorE5Result | null = null;
  const scenarioVerdicts: Array<{ scenarioHash: string; axes: EdgeCreatorSeed['axes']; verdict: 'green' | 'red' }> = [];
  const scenarioTraces: Record<string, EdgeCreatorScenarioTrace> = {};
  const unmeasuredScenarioHashes: string[] = [];

  try {
    plan = (deps.generatePlan ?? generateEdgeCreatorPlan)(seeds, deps.planOptions);
    if (plan.requiredIncidentIds.some((id) => !plan!.coveredIncidentIds.includes(id)) || plan.coveredPairCount !== plan.requiredPairCount) {
      addFailure({ key: 'plan:coverage', incidentId: 'E0', invariant: 'pairwise-plan-coverage',
        summary: 'nightly edge plan omitted a recorded incident or required pair',
        detail: `incidents=${plan.coveredIncidentIds.length}/${plan.requiredIncidentIds.length}, pairs=${plan.coveredPairCount}/${plan.requiredPairCount}` });
    }
  } catch (error) {
    addFailure({ key: 'plan:error', incidentId: 'E0', invariant: 'plan-generation',
      summary: 'nightly edge plan generation threw', detail: errorMessage(error) });
  }
  if (plan) {
    const axisCounts = Object.fromEntries(Object.keys(EDGE_CREATOR_INCIDENT_SEEDS[0]!.axes).map((axis) => [axis,
      Object.fromEntries([...new Set(plan.scenarios.map((scenario) => String(scenario.axes[axis as keyof EdgeCreatorSeed['axes']])))]
        .sort().map((value) => [value, plan!.scenarios.filter((scenario) => String(scenario.axes[axis as keyof EdgeCreatorSeed['axes']]) === value).length]))]));
    observe('sim.edge.generate', 'plan', { version, scenarios: plan.scenarios.length, incidents: plan.incidentCount, axisCounts,
      requiredPairs: plan.requiredPairCount, coveredPairs: plan.coveredPairCount, suppressedPairs: plan.suppressedPairCount });
    observe('sim.edge.generate', 'node-resume-cases', { count: plan.nodeResumeCases.length,
      cases: plan.nodeResumeCases.map(({ id, nodeKind, interruption, resumeRunId, regression }) =>
        ({ id, nodeKind, interruption, resumeRunId, regression })) });
    observe('sim.edge.dedupe', 'plan', { deduplicatedScenarioCount: plan.deduplicatedScenarioCount,
      skippedReceiptCount: plan.skippedReceiptCount, dormantScenarioCount: plan.dormantScenarioCount });
    for (const scenario of plan.scenarios) if (scenario.disposition === 'receipt-reuse')
      observe('sim.edge.run', 'receipt-reused', { head: deps.planOptions?.head ?? null, scenarioHash: scenario.scenarioHash });
    if (plan.coveredPairCount < plan.requiredPairCount)
      observe('sim.edge.budget', 'exhausted', { reason: 'plan-budget-or-radius', coveredPairs: plan.coveredPairCount,
        requiredPairs: plan.requiredPairCount, maxScenarios: deps.planOptions?.maxScenarios ?? null });
  }

  if (plan && !deps.runM2 && !deps.runE5) {
    for (const scenario of plan.scenarios) {
      if (scenario.disposition !== 'run') continue;
      const input = { axes: scenario.axes, scenarioHash: scenario.scenarioHash };
      const scenarioIOSSeeds = seeds.filter((seed) => isIOSChatEdgeSeed(seed) && scenario.incidentIds.includes(seed.incidentId));
      if (scenarioIOSSeeds.length) {
        unmeasuredScenarioHashes.push(scenario.scenarioHash);
        observe('sim.edge.run', 'input-prepared', { scenarioHash: scenario.scenarioHash,
          incidentIds: scenarioIOSSeeds.map((seed) => seed.incidentId), reason: 'ios-chat-simulator-driver-not-connected' });
      }
      const scenarioSeeds = seeds.filter((seed) => !isIOSChatEdgeSeed(seed)).map((seed) => ({ ...seed, axes: scenario.axes }));
      let resultM2: EdgeCreatorM2Result | null = null;
      let resultE5: EdgeCreatorE5Result | null = null;
      try { resultM2 = await (deps.runScenarioM2 ?? runEdgeCreatorM2Simulation)(scenarioSeeds, input); }
      catch (error) { addFailure({ key: `${scenario.scenarioHash}:m2:error`, incidentId: 'E0', invariant: 'production-graph-simulation',
        summary: 'nightly axis scenario simulation threw', detail: `${scenario.id} ${errorMessage(error)}` }); }
      const requiresE5 = scenario.incidentIds.includes('E5');
      try { resultE5 = requiresE5 ? await (deps.runScenarioE5 ?? runEdgeCreatorE5Simulation)(input) : null; }
      catch (error) { addFailure({ key: `${scenario.scenarioHash}:e5:error`, incidentId: 'E5', invariant: 'same-run-resume-simulation',
        summary: 'nightly axis scenario E5 simulation threw', detail: `${scenario.id} ${errorMessage(error)}` }); }
      m2 = resultM2 ?? m2;
      e5 = resultE5 ?? e5;
      const expectedM2 = scenarioSeeds.filter((seed) => ['completed-receipts-survive-interruption', 'invalidate-only-source-affected-receipts',
        'node-scope-does-not-expand-run-scope', 'passing-shard-receipts-survive-peer-failure', 'missing-cut-pin-refuses-standalone-gate'].includes(seed.invariant));
      const executed = new Set(resultM2?.executedIncidentIds ?? []);
      const matched = resultM2?.scenarioHash === scenario.scenarioHash
        && JSON.stringify(resultM2.scenarioAxes) === JSON.stringify(scenario.axes)
        && (!requiresE5 || JSON.stringify(resultE5?.scenarioAxes) === JSON.stringify(scenario.axes))
        && expectedM2.every((seed) => executed.has(seed.incidentId));
      if (!matched) addFailure({ key: `${scenario.scenarioHash}:receipt-mismatch`, incidentId: 'E0', invariant: 'scenario-execution-receipt-match',
        summary: 'scenario plan axes do not match executed graph receipts', detail: `scenario=${scenario.id} axes=${JSON.stringify(scenario.axes)} m2=${JSON.stringify(resultM2?.scenarioAxes)} e5=${JSON.stringify(resultE5?.scenarioAxes)} executed=${JSON.stringify([...executed])}` });
      for (const [incidentId, evidence] of Object.entries(resultM2?.invariantEvidence ?? {})) if (evidence.passed !== true) {
        const seed = seeds.find((candidate) => candidate.incidentId === incidentId);
        addFailure({ key: `${scenario.scenarioHash}:${incidentId}:${String(evidence.seedInvariant ?? 'unknown')}`, incidentId,
          invariant: String(evidence.seedInvariant ?? 'unknown'), summary: seed?.summary ?? String(evidence.seedSummary ?? `edge incident ${incidentId}`),
          detail: `scenario=${scenario.id} axes=${JSON.stringify(scenario.axes)} evidence=${JSON.stringify(evidence)}`,
          ...(typeof evidence.codePath === 'string' ? { codePath: evidence.codePath } : {}) });
      }
      if (resultM2 && resultM2.status !== 'done'
        && !Object.values(resultM2.invariantEvidence).some((evidence) => evidence.passed === false)) addFailure({ key: `${scenario.scenarioHash}:m2:status`, incidentId: 'E0',
        invariant: 'production-graph-status', summary: 'nightly M2 graph did not finish successfully and named no failed invariant',
        detail: `scenario=${scenario.id} status=${resultM2.status} executed=${JSON.stringify(resultM2.executedIncidentIds)}` });
      for (const violation of resultE5?.invariantViolations ?? []) addFailure({ key: `${scenario.scenarioHash}:E5:${violation}`,
        incidentId: 'E5', invariant: violation, summary: seeds.find((seed) => seed.incidentId === 'E5')?.summary ?? 'dynamic append resume invariant failed',
        detail: `scenario=${scenario.id} axes=${JSON.stringify(scenario.axes)} ${formatE5Evidence(resultE5!, violation)}` });
      if (requiresE5 && resultE5?.verdict === 'red' && resultE5.invariantViolations.length === 0)
        addFailure({ key: `${scenario.scenarioHash}:E5:verdict`, incidentId: 'E5', invariant: 'same-run-resume-verdict',
          summary: 'E5 reported red without naming an invariant violation', detail: `scenario=${scenario.id} ${formatE5Evidence(resultE5)}` });
      const invariantObservations = Object.fromEntries(Object.entries(resultM2?.invariantEvidence ?? {}).map(([id, evidence]) => [id, evidence.passed]));
      scenarioTraces[edgeCreatorTupleKey(scenario.axes)] = { nodeExitSequence: resultM2?.executedIncidentIds ?? [],
        stateWrites: Object.keys(resultM2?.invariantEvidence ?? {}).sort(), environment: scenario.axes.environment,
        invariantObservations, externalEffects: Object.keys(resultE5?.effectsByIdempotencyKey ?? {}).sort() };
      const generalGreen = matched && resultM2?.status === 'done'
        && expectedM2.every((seed) => resultM2?.invariantEvidence[seed.incidentId]?.passed === true)
        && (!requiresE5 || resultE5?.verdict === 'green');
      if (scenarioIOSSeeds.length === 0 || !generalGreen)
        scenarioVerdicts.push({ scenarioHash: scenario.scenarioHash, axes: scenario.axes, verdict: generalGreen ? 'green' : 'red' });
    }
  } else {
    const runnableIncidentIds = new Set(plan?.scenarios.filter((scenario) => scenario.disposition === 'run').flatMap((scenario) => scenario.incidentIds)
      ?? seeds.map((seed) => seed.incidentId));
    const runnableSeeds = seeds.filter((seed) => runnableIncidentIds.has(seed.incidentId));
    try { m2 = runnableSeeds.length ? await (deps.runM2 ?? runEdgeCreatorM2Simulation)(runnableSeeds)
      : { runId: `edge-creator-receipt-reuse-${deps.planOptions?.head ?? 'unknown'}`, status: 'done', executedIncidentIds: [], invariantEvidence: {} }; }
    catch (error) { addFailure({ key: 'm2:error', incidentId: 'E0', invariant: 'production-graph-simulation',
      summary: 'nightly production graph simulation threw', detail: errorMessage(error) }); }
    if (m2) for (const [incidentId, evidence] of Object.entries(m2.invariantEvidence)) if (evidence.passed !== true) {
      const seed = seeds.find((candidate) => candidate.incidentId === incidentId);
      addFailure({ key: `${incidentId}:${String(evidence.seedInvariant ?? 'unknown')}`, incidentId,
        invariant: String(evidence.seedInvariant ?? 'unknown'), summary: seed?.summary ?? String(evidence.seedSummary ?? `edge incident ${incidentId}`),
        detail: `production graph result=${m2.status}; evidence=${JSON.stringify(evidence)}`,
        ...(typeof evidence.codePath === 'string' ? { codePath: evidence.codePath } : {}) });
    }
    try { e5 = runnableIncidentIds.has('E5') ? await (deps.runE5 ?? runEdgeCreatorE5Simulation)() : null; }
    catch (error) { addFailure({ key: 'e5:error', incidentId: 'E5', invariant: 'same-run-resume-simulation', summary: 'nightly E5 resume simulation threw', detail: errorMessage(error) }); }
    if (e5?.verdict === 'red') for (const violation of e5.invariantViolations) addFailure({ key: `E5:${violation}`, incidentId: 'E5',
      invariant: violation, summary: seeds.find((seed) => seed.incidentId === 'E5')?.summary ?? 'dynamic append same-run resume invariant failed', detail: formatE5Evidence(e5, violation) });
    if (e5?.verdict === 'red' && e5.invariantViolations.length === 0) addFailure({ key: 'E5:verdict', incidentId: 'E5',
      invariant: 'same-run-resume-verdict', summary: 'E5 reported red without naming an invariant violation', detail: formatE5Evidence(e5) });
  }

  const checklistCellIds: string[] = [];
  const unrecordedFailures: EdgeCreatorFailure[] = [];
  const seedSeverity = new Map<string, EdgeCreatorSeed['severity']>(seeds.map((seed) => [seed.incidentId, seed.severity]));
  const immediateFailures = failures.map((failure) => ({ ...failure,
    severity: deps.classifySeverity?.(failure) ?? failure.severity ?? seedSeverity.get(failure.incidentId) ?? 'unknown' }))
    .filter((failure) => failure.severity === 'S0' || failure.severity === 'S1' || failure.severity === 'S2');
  const deferredFailures = failures.filter((failure) => !immediateFailures.some((candidate) => candidate.key === failure.key));
  if (deps.maxNewCellsPerRun !== undefined && (!Number.isSafeInteger(deps.maxNewCellsPerRun) || deps.maxNewCellsPerRun < 0))
    throw new Error('maxNewCellsPerRun must be a non-negative safe integer');
  const clusters = clusterEdgeCreatorFailures(immediateFailures);
  observe('sim.edge.cluster', 'failures-clustered', { failureCount: failures.length, clusterCount: clusters.length,
    deferredCount: deferredFailures.length, cap: deps.maxNewCellsPerRun ?? null });
  for (const [index, cluster] of clusters.entries()) {
    const first = cluster.failures[0]!;
    if (deps.maxNewCellsPerRun !== undefined && index >= deps.maxNewCellsPerRun) {
      unrecordedFailures.push(...cluster.failures);
      observe('sim.edge.budget', 'exhausted', { reason: 'max-new-cells-per-run', cap: deps.maxNewCellsPerRun, deferredClusters: clusters.length - index });
      continue;
    }
    const id = edgeCreatorFailureCellId(cluster.failures.length === 1 ? first.key : `cluster:${cluster.clusterId}`);
    const details = cluster.failures.map((failure) => `${failure.incidentId}: ${failure.summary}; ${failure.detail}`).join('\n');
    const title = `대상 경로: src/ux-sim/edge-creator.ts\n야간 SIM-EDGE-CREATOR 실패 군집 — ${cluster.invariant}${cluster.codePath ? ` @ ${cluster.codePath}` : ''}\n${details}\n근거: cluster=${cluster.clusterId}`;
    if (checklistVersionStatus === 'unconfirmed-observation-only') {
      unrecordedFailures.push(...cluster.failures);
      observe('sim.edge.cluster', 'failure-cell-observation-only', { version, checklistVersion, clusterId: cluster.clusterId,
        keys: cluster.failures.map(({ key }) => key) });
      continue;
    }
    try {
      const ensured = (deps.ensureCell ?? ensureChecklistCell)({ version: checklistVersion, id, title, owner: 'OPC', failure: first });
      if (ensured) checklistCellIds.push(id);
      else unrecordedFailures.push(...cluster.failures);
    } catch (error) {
      unrecordedFailures.push(...cluster.failures);
      observe('sim.edge.cluster', 'failure-cell-write-failed', { id, clusterId: cluster.clusterId, reason: errorMessage(error) });
    }
  }
  const status = failures.length === 0 ? 'green' : 'red';
  const cellRecordingComplete = unrecordedFailures.length === 0;
  const promotion = deps.promotionEvidence ? evaluateEdgeCreatorPromotion(deps.promotionEvidence) : null;
  const head = deps.planOptions?.head;
  const failedScenarioHashes = scenarioVerdicts.filter(({ verdict }) => verdict === 'red').map(({ scenarioHash }) => scenarioHash);
  const completedScenarioReceipts = head && /^[a-f0-9]{40}$/i.test(head) ? scenarioVerdicts
    .filter(({ verdict }) => verdict === 'green').map(({ scenarioHash }) => ({ head, scenarioHash, status: 'green' as const })) : [];
  const result = { status, version, plan, m2, e5, failures, unrecordedFailures, deferredFailures, unmeasuredScenarioHashes, failedScenarioHashes,
    promotion, completedScenarioReceipts, scenarioTraces, checklistCellIds, cellRecordingComplete, checklistVersionStatus } satisfies EdgeCreatorNightlyResult;
  debug.log('ux-sim.edge-creator', 'nightly-run-finished', {
    status, version, checklistVersion, checklistVersionStatus, failureCount: failures.length, checklistCellIds, cellRecordingComplete,
  });
  const cpuUsage = process.cpuUsage(cpuStartedAt);
  const m2GreenCount = Object.values(m2?.invariantEvidence ?? {}).filter((item) => item.passed === true).length;
  const m2RedCount = Object.values(m2?.invariantEvidence ?? {}).filter((item) => item.passed === false).length;
  observe('sim.edge.run', 'finished', { status, cpuMs: Math.max(0, Math.round((cpuUsage.user + cpuUsage.system) / 1000)),
    scenarioCount: plan?.scenarios.length ?? 0, redCount: m2RedCount + (e5?.verdict === 'red' ? 1 : 0),
    greenCount: m2GreenCount + (e5?.verdict === 'green' ? 1 : 0), failureCount: failures.length });
  observe('sim.edge.promote', 'summary', { state: promotion ? (promotion.promotable ? 'eligible' : 'refused') : 'not-invoked', redScenarioCount: failures.length,
    compressedClusterCount: clusters.length, promotedChanges: 'unmeasured', compressionRatio: null,
    evidencePromotable: promotion?.promotable ?? null, reasons: promotion?.reasons ?? [] });
  observe('sim.edge.canary', 'not-requested', { reason: promotion?.promotable ? 'awaiting-explicit-candidate' : 'promotion-not-eligible', hostCount: 0 });
  if (deferredFailures.length) observe('sim.edge.cluster', 'deferred-outside-s0-s2', { count: deferredFailures.length, keys: deferredFailures.map(({ key }) => key) });
  return result;
}

export function edgeCreatorFailureCellId(key: string): string {
  return `SIM-EDGE-NIGHTLY-${createHash('sha256').update(key).digest('hex').toUpperCase()}`;
}

function ensureChecklistCell(input: Parameters<NonNullable<EdgeCreatorNightlyDeps['ensureCell']>>[0]): boolean {
  if (checklistHistory(input.id).length || listChecklist(input.version).items.some((item) => item.id === input.id)) return true;
  try {
    addItem(input.version, { id: input.id, title: input.title, refs: ['src/ux-sim/edge-creator.ts', 'src/ux-sim/edge-creator-nightly.ts'],
      owner: input.owner, priority: input.failure.severity === 'S0' ? 'P0' : 'P1', dispatchKind: 'code' });
    return true;
  } catch (error) {
    if (checklistHistory(input.id).length || listChecklist(input.version).items.some((item) => item.id === input.id)) return true;
    throw error;
  }
}

export interface EdgeCreatorNightlySchedulerHandle {
  tickNow(): Promise<void>;
  stop(): void;
  diagnostics(): { enabled: boolean; running: boolean; lastRunDay: string | null; nightlyAt: string };
}

export interface EdgeCreatorNightlySchedulerDeps {
  enabled?: boolean;
  nightlyAt?: string;
  timeZone?: string;
  tickIntervalMs?: number;
  statePath?: string;
  now?: () => Date;
  head?: () => string | null;
  requestIdleSimSlot?: (request: { requestId: string; runId: string; consumer: 'SIM-EDGE-CREATOR'; priority: 'lowest'; preemptible: true }) => Promise<
    | { state: 'granted'; leaseId: string; host: string; runId: string }
    | { state: 'denied'; reason: string }
  >;
  releaseIdleSimSlot?: (leaseId: string) => Promise<void>;
  readChangedPaths?: typeof readEdgeCreatorChangedPaths;
  readIncidentHistory?: typeof readIncidentHistory;
  onNightlyResult?: (result: EdgeCreatorNightlyResult) => void;
  nightlyDependencies?: Pick<EdgeCreatorNightlyDeps, 'version' | 'availableChecklistVersions' | 'seeds' | 'runScenarioM2' | 'runScenarioE5' | 'ensureCell' | 'classifySeverity' | 'maxNewCellsPerRun' | 'log'>;
  run?: (pendingFailures: readonly EdgeCreatorFailure[], previousState?: {
    lastRunHead: string | null; scenarioTraces: Readonly<Record<string, EdgeCreatorScenarioTrace>>;
  }) => Promise<EdgeCreatorNightlyResult>;
  runOnStart?: boolean;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  onError?: (error: unknown) => void;
}

/** Opt-in on the designated idle VM with ELANOUS_EDGE_CREATOR_NIGHTLY=1; one run per local day after 02:00. */
export function startEdgeCreatorNightlyScheduler(deps: EdgeCreatorNightlySchedulerDeps = {}): EdgeCreatorNightlySchedulerHandle {
  const testUniverse = resolveCurrentInstance().kind === 'test';
  const enabled = deps.enabled ?? (process.env.ELANOUS_EDGE_CREATOR_NIGHTLY === '1' || testUniverse);
  const requestIdleSimSlot = deps.requestIdleSimSlot ?? (testUniverse ? async ({ runId }: { runId: string }) => {
    if (activeTestUniverseSimLeases.size) return { state: 'denied' as const, reason: 'test-nexus-simulation-slot-in-use' };
    const leaseId = `edge-creator-test:${runId}`;
    activeTestUniverseSimLeases.add(leaseId);
    return { state: 'granted' as const, leaseId, host: `test-nexus:${hostname()}`, runId };
  } : undefined);
  const releaseIdleSimSlot = deps.releaseIdleSimSlot ?? (testUniverse ? async (leaseId: string) => {
    activeTestUniverseSimLeases.delete(leaseId);
  } : undefined);
  const nightlyAt = deps.nightlyAt ?? DEFAULT_NIGHTLY_AT;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(nightlyAt)) throw new Error(`invalid edge-creator nightly time: ${nightlyAt}`);
  const timeZone = deps.timeZone ?? resolveTimeZone().timeZone;
  const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const statePath = deps.statePath ?? join(effectiveInstanceRoot(), 'ux-sim', 'edge-creator-nightly.json');
  const now = deps.now ?? (() => new Date());
  const onError = deps.onError ?? ((error) => console.error('[edge-creator-nightly]', error));
  const setIntervalFn = deps.setIntervalImpl ?? setInterval;
  const clearIntervalFn = deps.clearIntervalImpl ?? clearInterval;
  let stopped = false;
  let running = false;
  let savedState = readNightlyState(statePath, onError);
  let lastRunDay = savedState.lastRunDay;
  let pendingFailures = savedState.pendingFailures;
  let receipts = savedState.receipts;
  let greenStreakByHash = savedState.greenStreakByHash;
  debug.log('ux-sim.edge-creator', 'nightly-scheduler-started', {
    enabled, nightlyAt, timeZone, testUniverse, idleSimSlotPortAvailable: !!requestIdleSimSlot && !!releaseIdleSimSlot,
  });

  const tickNow = async (): Promise<void> => {
    if (!enabled || stopped || running) return;
    const parts = dateFormatter.formatToParts(now());
    const part = (kind: string) => parts.find((entry) => entry.type === kind)?.value ?? '';
    const day = `${part('year')}-${part('month')}-${part('day')}`;
    const clock = `${part('hour')}:${part('minute')}`;
    if (!day.includes('-') || clock < nightlyAt || lastRunDay === day) return;
    running = true;
    let grantedLeaseId: string | null = null;
    try {
      const head = deps.head?.() ?? readCurrentHead();
      if (!requestIdleSimSlot || !releaseIdleSimSlot) {
        debug.log('sim.edge.budget', 'exhausted', { day, reason: 'idle-sim-slot-lease-port-unavailable' });
        return;
      }
      const runId = `edge-creator:${head ?? 'unknown'}:${day}`;
      const lease = await requestIdleSimSlot({ requestId: runId, runId, consumer: 'SIM-EDGE-CREATOR', priority: 'lowest', preemptible: true });
      if (lease.state !== 'granted' || !lease.leaseId.trim() || !lease.host.trim() || lease.runId !== runId) {
        debug.log('sim.edge.budget', 'exhausted', { day, runId, reason: lease.state === 'denied' ? lease.reason : 'invalid-idle-sim-slot-grant' });
        return;
      }
      grantedLeaseId = lease.leaseId;
      debug.log('sim.edge.budget', 'idle-sim-slot-granted', { day, runId, leaseId: lease.leaseId, host: lease.host,
        priority: 'lowest', preemptible: true });
      let changedPaths: string[] | null = null;
      if (!deps.run) {
        changedPaths = head ? (deps.readChangedPaths ?? readEdgeCreatorChangedPaths)(savedState.lastRunHead, head) : null;
        if (!head || !changedPaths) {
          debug.log('sim.edge.budget', 'exhausted', { day, runId, reason: 'git-diff-unavailable' });
          return;
        }
      }
      const result = deps.run ? await deps.run(pendingFailures, { lastRunHead: savedState.lastRunHead, scenarioTraces: savedState.scenarioTraces })
        : await runEdgeCreatorNightly({ ...deps.nightlyDependencies, pendingFailures,
        planOptions: { head: head!, priorReceipts: receipts, greenStreakByHash, changedTouches: changedPaths!,
          incidentHistory: (deps.readIncidentHistory ?? readIncidentHistory)(checklistDevVersion(devVersion()), EDGE_CREATOR_INCIDENT_SEEDS, pendingFailures),
          traceByTuple: savedState.scenarioTraces },
        scenarioTraces: savedState.scenarioTraces });
      deps.onNightlyResult?.(result);
      const receiptMap = new Map(receipts.map((receipt) => [`${receipt.head}\0${receipt.scenarioHash}`, receipt]));
      for (const receipt of result.completedScenarioReceipts ?? []) receiptMap.set(`${receipt.head}\0${receipt.scenarioHash}`, receipt);
      receipts = [...receiptMap.values()];
      for (const scenario of result.plan?.scenarios ?? []) if (scenario.disposition === 'run') {
        if ((result.completedScenarioReceipts ?? []).some((receipt) => receipt.scenarioHash === scenario.scenarioHash && receipt.head === head))
          greenStreakByHash = { ...greenStreakByHash, [scenario.scenarioHash]: (greenStreakByHash[scenario.scenarioHash] ?? 0) + 1 };
        else if (result.status === 'red') greenStreakByHash = { ...greenStreakByHash, [scenario.scenarioHash]: 0 };
      }
      const scenarioTraces = { ...savedState.scenarioTraces, ...(result.scenarioTraces ?? {}) };
      const observationOnly = result.checklistVersionStatus === 'unconfirmed-observation-only';
      if (!result.cellRecordingComplete && !observationOnly) {
        pendingFailures = [...result.unrecordedFailures, ...(result.deferredFailures ?? [])];
        savedState = { ...savedState, pendingFailures, receipts, greenStreakByHash, scenarioTraces };
        writeNightlyState(statePath, savedState);
        onError(new Error(`nightly failures remain unrecorded: ${pendingFailures.map(({ key }) => key).join(',')}`));
        return;
      }
      pendingFailures = result.cellRecordingComplete ? result.deferredFailures ?? []
        : [...result.unrecordedFailures, ...(result.deferredFailures ?? [])];
      if (observationOnly) debug.log('ux-sim.edge-creator', 'nightly-observation-only', { day, version: result.version,
        checklistVersion: checklistDevVersion(result.version), pendingFailureCount: pendingFailures.length });
      savedState = { schema: 1, lastRunDay: day, lastRunHead: head, pendingFailures, receipts, greenStreakByHash, scenarioTraces };
      writeNightlyState(statePath, savedState);
      lastRunDay = day;
    } catch (error) {
      onError(error);
      debug.log('ux-sim.edge-creator', 'nightly-run-failed', { day, reason: errorMessage(error) });
    } finally {
      if (grantedLeaseId && releaseIdleSimSlot) {
        try { await releaseIdleSimSlot(grantedLeaseId); }
        catch (error) { debug.log('sim.edge.budget', 'idle-sim-slot-release-failed', { leaseId: grantedLeaseId, reason: errorMessage(error) }, { level: 'warn' }); }
      }
      running = false;
    }
  };

  const timer = enabled ? setIntervalFn(() => { void tickNow(); }, deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS) : undefined;
  if (timer && typeof timer === 'object') timer.unref?.();
  if (enabled && deps.runOnStart !== false) void tickNow();
  return {
    tickNow,
    stop() { if (stopped) return; stopped = true; if (timer !== undefined) clearIntervalFn(timer); },
    diagnostics: () => ({ enabled, running, lastRunDay, nightlyAt }),
  };
}

interface EdgeCreatorNightlyState {
  schema: 1;
  lastRunDay: string | null;
  lastRunHead: string | null;
  pendingFailures: EdgeCreatorFailure[];
  receipts: Array<{ head: string; scenarioHash: string; status: 'green' }>;
  greenStreakByHash: Record<string, number>;
  scenarioTraces: Record<string, EdgeCreatorScenarioTrace>;
}

function readNightlyState(path: string, onError: (error: unknown) => void): EdgeCreatorNightlyState {
  if (!existsSync(path)) return { schema: 1, lastRunDay: null, lastRunHead: null, pendingFailures: [], receipts: [], greenStreakByHash: {}, scenarioTraces: {} };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { schema?: unknown; lastRunDay?: unknown; pendingFailures?: unknown;
      day?: unknown; lastRunHead?: unknown; receipts?: unknown; greenStreakByHash?: unknown; scenarioTraces?: unknown };
    // M1 state persisted `day`; a deploy on the same day must not rerun completed nightly work.
    if (value.schema === 1 && value.lastRunDay === undefined && typeof value.day === 'string'
        && /^\d{4}-\d{2}-\d{2}$/.test(value.day)) {
      return { schema: 1, lastRunDay: value.day, lastRunHead: null, pendingFailures: [], receipts: [], greenStreakByHash: {}, scenarioTraces: {} };
    }
    if (value.schema !== 1 || (value.lastRunDay !== null && typeof value.lastRunDay !== 'string')
        || (typeof value.lastRunDay === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(value.lastRunDay))
        || !Array.isArray(value.pendingFailures) || value.pendingFailures.some((failure) => !isEdgeCreatorFailure(failure)))
      throw new Error('invalid edge-creator nightly state record');
    const receipts = value.receipts === undefined ? [] : value.receipts;
    const greenStreakByHash = value.greenStreakByHash === undefined ? {} : value.greenStreakByHash;
    const lastRunHead = value.lastRunHead === undefined ? null : value.lastRunHead;
    const scenarioTraces = value.scenarioTraces === undefined ? {} : value.scenarioTraces;
    if (!Array.isArray(receipts) || receipts.some((receipt) => !receipt || typeof receipt !== 'object'
      || !/^[a-f0-9]{40}$/i.test(String((receipt as { head?: unknown }).head))
      || !/^[a-f0-9]{64}$/i.test(String((receipt as { scenarioHash?: unknown }).scenarioHash))
      || (receipt as { status?: unknown }).status !== 'green')) throw new Error('invalid edge-creator scenario receipt state');
    if (!greenStreakByHash || typeof greenStreakByHash !== 'object' || Array.isArray(greenStreakByHash)
      || Object.values(greenStreakByHash as Record<string, unknown>).some((count) => !Number.isSafeInteger(count) || Number(count) < 0))
      throw new Error('invalid edge-creator GREEN streak state');
    if (lastRunHead !== null && (typeof lastRunHead !== 'string' || !/^[a-f0-9]{40}$/i.test(lastRunHead))) throw new Error('invalid edge-creator last-run head');
    if (!scenarioTraces || typeof scenarioTraces !== 'object' || Array.isArray(scenarioTraces)
      || Object.values(scenarioTraces as Record<string, unknown>).some((trace) => !isScenarioTrace(trace))) throw new Error('invalid edge-creator scenario trace state');
    return { schema: 1, lastRunDay: value.lastRunDay as string | null, lastRunHead: lastRunHead as string | null,
      pendingFailures: value.pendingFailures as EdgeCreatorFailure[], receipts: receipts as EdgeCreatorNightlyState['receipts'],
      greenStreakByHash: greenStreakByHash as Record<string, number>, scenarioTraces: scenarioTraces as Record<string, EdgeCreatorScenarioTrace> };
  } catch (error) { onError(error); return { schema: 1, lastRunDay: null, lastRunHead: null, pendingFailures: [], receipts: [], greenStreakByHash: {}, scenarioTraces: {} }; }
}

function readCurrentHead(): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5_000 });
  const head = result.status === 0 ? result.stdout.trim() : '';
  return /^[a-f0-9]{40}$/i.test(head) ? head : null;
}

export function readEdgeCreatorChangedPaths(previousHead: string | null, head: string, cwd = process.cwd()): string[] | null {
  const args = previousHead
    ? ['diff', '--name-only', '--diff-filter=ACMRD', `${previousHead}...${head}`]
    : ['diff-tree', '--no-commit-id', '--name-only', '-r', head];
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) return null;
  return [...new Set(result.stdout.split(/\r?\n/).map((path) => path.trim()).filter(Boolean))].sort();
}

function pairKeys(axes: EdgeCreatorSeed['axes']): string[] {
  const keys = Object.keys(axes) as (keyof EdgeCreatorSeed['axes'])[];
  return keys.flatMap((left, index) => keys.slice(index + 1).map((right) => `${left}:${axes[left]}|${right}:${axes[right]}`));
}

function readIncidentHistory(version: string, seeds: readonly EdgeCreatorSeed[], pending: readonly EdgeCreatorFailure[]): Record<string, number> {
  const counts: Record<string, number> = {};
  const seedById = new Map<string, EdgeCreatorSeed>(seeds.map((seed) => [seed.incidentId, seed]));
  const countIncident = (id: string) => {
    const seed = seedById.get(id);
    if (!seed) return;
    for (const pair of pairKeys(seed.axes)) counts[pair] = (counts[pair] ?? 0) + 1;
  };
  for (const failure of pending) countIncident(failure.incidentId);
  // Read only versions that the ledger actually knows. A valid-but-unassigned current release is observation-only.
  let assignedVersions: string[];
  try { assignedVersions = assignedChecklistVersions(); }
  catch (error) {
    debug.log('ux-sim.edge-creator', 'nightly-version-unconfirmed', { version, checklistVersion: checklistDevVersion(version),
      mode: 'observation-only', reason: 'checklist-version-lookup-failed', error: errorMessage(error) });
    return counts;
  }
  const versions = new Set(assignedVersions);
  for (const assignedVersion of versions) for (const item of listChecklist(assignedVersion).items) {
    if (!item.id.startsWith('SIM-EDGE-NIGHTLY-') || item.status === 'done') continue;
    for (const match of item.title.matchAll(/\b(E\d+)\s*:/g)) countIncident(match[1]!);
  }
  return counts;
}

function isScenarioTrace(value: unknown): value is EdgeCreatorScenarioTrace {
  if (!value || typeof value !== 'object') return false;
  const trace = value as Partial<EdgeCreatorScenarioTrace>;
  return Array.isArray(trace.nodeExitSequence) && trace.nodeExitSequence.every((item) => typeof item === 'string')
    && Array.isArray(trace.stateWrites) && trace.stateWrites.every((item) => typeof item === 'string')
    && typeof trace.environment === 'string' && !!trace.invariantObservations && typeof trace.invariantObservations === 'object'
    && !Array.isArray(trace.invariantObservations) && Array.isArray(trace.externalEffects) && trace.externalEffects.every((item) => typeof item === 'string');
}

function isEdgeCreatorFailure(value: unknown): value is EdgeCreatorFailure {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<EdgeCreatorFailure>;
  return typeof row.key === 'string' && typeof row.incidentId === 'string' && typeof row.invariant === 'string'
    && typeof row.summary === 'string' && typeof row.detail === 'string';
}

function formatE5Evidence(e5: EdgeCreatorE5Result, violation?: string): string {
  return [
    'E5 observed evidence:',
    `runId=${e5.runId}`,
    `verdict=${e5.verdict}`,
    `violation=${violation ?? 'none-reported'}`,
    `invariantViolations=${JSON.stringify(e5.invariantViolations)}`,
    `interruptedStatus=${e5.interruptedStatus}`,
    `resumedStatus=${e5.resumedStatus}`,
    `baselineTerminal=${e5.baselineTerminal}`,
    `resumedTerminal=${e5.resumedTerminal}`,
    `baselineAppendCount=${e5.baselineAppendCount}`,
    `appendCount=${e5.appendCount}`,
    `baselineRepairCalls=${e5.baselineRepairCalls}`,
    `runNodeExecutionCount=${e5.runNodeExecutionCount}`,
    `declaredRunNodeExecutionLimit=${e5.declaredRunNodeExecutionLimit}`,
  ].join('; ');
}

function writeNightlyState(path: string, state: EdgeCreatorNightlyState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
