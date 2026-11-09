import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { addItem, checklistHistory, devVersion, listChecklist } from '../release-loop/checklist.js';
import { resolveTimeZone } from '../time/time-zone.js';
import {
  EDGE_CREATOR_INCIDENT_SEEDS,
  generateEdgeCreatorPlan,
  runEdgeCreatorE5Simulation,
  runEdgeCreatorM2Simulation,
  type EdgeCreatorE5Result,
  type EdgeCreatorM2Result,
  type EdgeCreatorPlan,
  type EdgeCreatorSeed,
} from './edge-creator.js';

const DEFAULT_NIGHTLY_AT = '02:00';
// 출처: src/domains/watch-default-scheduler.ts polls daemon-owned daily work once per minute.
const DEFAULT_TICK_INTERVAL_MS = 60_000;

export interface EdgeCreatorFailure {
  key: string;
  incidentId: string;
  invariant: string;
  summary: string;
  detail: string;
}

export interface EdgeCreatorNightlyResult {
  status: 'green' | 'red';
  version: string;
  plan: EdgeCreatorPlan | null;
  m2: EdgeCreatorM2Result | null;
  e5: EdgeCreatorE5Result | null;
  failures: EdgeCreatorFailure[];
  unrecordedFailures: EdgeCreatorFailure[];
  checklistCellIds: string[];
  cellRecordingComplete: boolean;
}

export interface EdgeCreatorNightlyDeps {
  version?: () => string;
  seeds?: readonly EdgeCreatorSeed[];
  generatePlan?: (seeds: readonly EdgeCreatorSeed[]) => EdgeCreatorPlan;
  runM2?: (seeds: readonly EdgeCreatorSeed[]) => Promise<EdgeCreatorM2Result>;
  runE5?: () => Promise<EdgeCreatorE5Result>;
  ensureCell?: (input: { version: string; id: string; title: string; owner: string; failure: EdgeCreatorFailure }) => boolean;
  pendingFailures?: readonly EdgeCreatorFailure[];
  now?: () => Date;
}

export async function runEdgeCreatorNightly(deps: EdgeCreatorNightlyDeps = {}): Promise<EdgeCreatorNightlyResult> {
  const version = (deps.version ?? devVersion)();
  const seeds = deps.seeds ?? EDGE_CREATOR_INCIDENT_SEEDS;
  const failures: EdgeCreatorFailure[] = [...(deps.pendingFailures ?? [])];
  const addFailure = (failure: EdgeCreatorFailure) => {
    if (!failures.some((item) => item.key === failure.key)) failures.push(failure);
  };
  let plan: EdgeCreatorPlan | null = null;
  let m2: EdgeCreatorM2Result | null = null;
  let e5: EdgeCreatorE5Result | null = null;

  try {
    plan = (deps.generatePlan ?? generateEdgeCreatorPlan)(seeds);
    if (plan.coveredIncidentIds.length !== seeds.length || plan.coveredPairCount !== plan.requiredPairCount) {
      addFailure({ key: 'plan:coverage', incidentId: 'E0', invariant: 'pairwise-plan-coverage',
        summary: 'nightly edge plan omitted a recorded incident or required pair',
        detail: `incidents=${plan.coveredIncidentIds.length}/${seeds.length}, pairs=${plan.coveredPairCount}/${plan.requiredPairCount}` });
    }
  } catch (error) {
    addFailure({ key: 'plan:error', incidentId: 'E0', invariant: 'plan-generation',
      summary: 'nightly edge plan generation threw', detail: errorMessage(error) });
  }

  try { m2 = await (deps.runM2 ?? runEdgeCreatorM2Simulation)(seeds); }
  catch (error) {
    addFailure({ key: 'm2:error', incidentId: 'E0', invariant: 'production-graph-simulation',
      summary: 'nightly production graph simulation threw', detail: errorMessage(error) });
  }
  if (m2) {
    const failureCountBeforeM2 = failures.length;
    for (const [incidentId, evidence] of Object.entries(m2.invariantEvidence)) {
      if (evidence.passed === true) continue;
      const seed = seeds.find((candidate) => candidate.incidentId === incidentId);
      addFailure({ key: `${incidentId}:${String(evidence.seedInvariant ?? 'unknown')}`, incidentId,
        invariant: String(evidence.seedInvariant ?? 'unknown'),
        summary: seed?.summary ?? String(evidence.seedSummary ?? `edge incident ${incidentId}`),
        detail: `production graph result=${m2.status}; evidence=${JSON.stringify(evidence)}` });
    }
    if (m2.status !== 'done' && failures.length === failureCountBeforeM2) addFailure({ key: 'm2:status', incidentId: 'E0',
      invariant: 'production-graph-terminal', summary: 'nightly production graph did not finish', detail: `status=${m2.status}` });
  }

  try { e5 = await (deps.runE5 ?? runEdgeCreatorE5Simulation)(); }
  catch (error) {
    addFailure({ key: 'e5:error', incidentId: 'E5', invariant: 'same-run-resume-simulation',
      summary: 'nightly E5 resume simulation threw', detail: errorMessage(error) });
  }
  if (e5?.verdict === 'red') for (const violation of e5.invariantViolations) {
    const seed = seeds.find((candidate) => candidate.incidentId === 'E5');
    addFailure({ key: `E5:${violation}`, incidentId: 'E5', invariant: violation,
      summary: seed?.summary ?? 'dynamic append same-run resume invariant failed', detail: formatE5Evidence(e5, violation) });
  }
  if (e5?.verdict === 'red' && e5.invariantViolations.length === 0) addFailure({ key: 'E5:verdict', incidentId: 'E5',
    invariant: 'same-run-resume-verdict', summary: 'E5 reported red without naming an invariant violation', detail: formatE5Evidence(e5) });

  const checklistCellIds: string[] = [];
  const unrecordedFailures: EdgeCreatorFailure[] = [];
  for (const failure of failures) {
    const id = edgeCreatorFailureCellId(failure.key);
    const title = `대상 경로: src/ux-sim/edge-creator.ts\n야간 SIM-EDGE-CREATOR 실패 — ${failure.incidentId} / ${failure.invariant}\n${failure.summary}\n근거: ${failure.detail}`;
    try {
      const ensured = (deps.ensureCell ?? ensureChecklistCell)({ version, id, title, owner: 'OPC', failure });
      if (ensured) checklistCellIds.push(id);
      else unrecordedFailures.push(failure);
    } catch (error) {
      unrecordedFailures.push(failure);
      debug.log('ux-sim.edge-creator', 'failure-cell-write-failed', { id, incidentId: failure.incidentId, reason: errorMessage(error) });
    }
  }
  const status = failures.length === 0 ? 'green' : 'red';
  const cellRecordingComplete = unrecordedFailures.length === 0;
  const result = { status, version, plan, m2, e5, failures, unrecordedFailures, checklistCellIds, cellRecordingComplete } satisfies EdgeCreatorNightlyResult;
  debug.log('ux-sim.edge-creator', 'nightly-run-finished', {
    status, version, failureCount: failures.length, checklistCellIds, cellRecordingComplete,
  });
  return result;
}

export function edgeCreatorFailureCellId(key: string): string {
  return `SIM-EDGE-NIGHTLY-${createHash('sha256').update(key).digest('hex').toUpperCase()}`;
}

function ensureChecklistCell(input: Parameters<NonNullable<EdgeCreatorNightlyDeps['ensureCell']>>[0]): boolean {
  if (checklistHistory(input.id).length || listChecklist(input.version).items.some((item) => item.id === input.id)) return true;
  try {
    addItem(input.version, { id: input.id, title: input.title, refs: ['src/ux-sim/edge-creator.ts', 'src/ux-sim/edge-creator-nightly.ts'],
      owner: input.owner, priority: 'P1', dispatchKind: 'code' });
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
  run?: (pendingFailures: readonly EdgeCreatorFailure[]) => Promise<EdgeCreatorNightlyResult>;
  runOnStart?: boolean;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  onError?: (error: unknown) => void;
}

/** Opt-in on the designated idle VM with ELANOUS_EDGE_CREATOR_NIGHTLY=1; one run per local day after 02:00. */
export function startEdgeCreatorNightlyScheduler(deps: EdgeCreatorNightlySchedulerDeps = {}): EdgeCreatorNightlySchedulerHandle {
  const enabled = deps.enabled ?? process.env.ELANOUS_EDGE_CREATOR_NIGHTLY === '1';
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
  const savedState = readNightlyState(statePath, onError);
  let lastRunDay = savedState.lastRunDay;
  let pendingFailures = savedState.pendingFailures;

  const tickNow = async (): Promise<void> => {
    if (!enabled || stopped || running) return;
    const parts = dateFormatter.formatToParts(now());
    const part = (kind: string) => parts.find((entry) => entry.type === kind)?.value ?? '';
    const day = `${part('year')}-${part('month')}-${part('day')}`;
    const clock = `${part('hour')}:${part('minute')}`;
    if (!day.includes('-') || clock < nightlyAt || lastRunDay === day) return;
    running = true;
    try {
      const result = await (deps.run ?? ((pending) => runEdgeCreatorNightly({ pendingFailures: pending })))(pendingFailures);
      if (!result.cellRecordingComplete) {
        pendingFailures = result.unrecordedFailures;
        writeNightlyState(statePath, { schema: 1, lastRunDay, pendingFailures });
        onError(new Error(`nightly failures remain unrecorded: ${pendingFailures.map(({ key }) => key).join(',')}`));
        return;
      }
      writeNightlyState(statePath, { schema: 1, lastRunDay: day, pendingFailures: [] });
      lastRunDay = day;
      pendingFailures = [];
    } catch (error) {
      onError(error);
      debug.log('ux-sim.edge-creator', 'nightly-run-failed', { day, reason: errorMessage(error) });
    } finally { running = false; }
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
  pendingFailures: EdgeCreatorFailure[];
}

function readNightlyState(path: string, onError: (error: unknown) => void): EdgeCreatorNightlyState {
  if (!existsSync(path)) return { schema: 1, lastRunDay: null, pendingFailures: [] };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { schema?: unknown; lastRunDay?: unknown; pendingFailures?: unknown; day?: unknown };
    // M1 state persisted `day`; a deploy on the same day must not rerun completed nightly work.
    if (value.schema === 1 && value.lastRunDay === undefined && typeof value.day === 'string'
        && /^\d{4}-\d{2}-\d{2}$/.test(value.day)) {
      return { schema: 1, lastRunDay: value.day, pendingFailures: [] };
    }
    if (value.schema !== 1 || (value.lastRunDay !== null && typeof value.lastRunDay !== 'string')
        || (typeof value.lastRunDay === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(value.lastRunDay))
        || !Array.isArray(value.pendingFailures) || value.pendingFailures.some((failure) => !isEdgeCreatorFailure(failure)))
      throw new Error('invalid edge-creator nightly state record');
    return { schema: 1, lastRunDay: value.lastRunDay as string | null, pendingFailures: value.pendingFailures as EdgeCreatorFailure[] };
  } catch (error) { onError(error); return { schema: 1, lastRunDay: null, pendingFailures: [] }; }
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
