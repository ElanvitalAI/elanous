import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { resolveLogTargets } from '../cli/logs-cli.js';
import { debug } from '../debug/log.js';
import { federatedPtyRefs, type FederatedPtyListing, type FederatedPtyRef } from '../cli/pty-takeover-cli.js';
import { ptyManifestTargets } from '../domains/fleet.js';
import { isPidAlive } from '../git-fs/worktree.js';
import { LogStore } from '../mss/logging/log-store.js';
import { loadSelfDevRun, selfDevRunsDir, type SelfDevRunState } from '../self-dev/run-store.js';
import { listPtyManifestRowsAt } from '../pty-shell/pty-manifest.js';
import { isTerminatedUnfinishedLifecycle, queryFederatedUnfinishedRunLedgers, resolveFederatedRunLedgerDirectories, type FederatedUnfinishedRunLedgerEntry, type FederatedUnfinishedRunLedgerQuery, type UnfinishedRunLifecycle } from './run-ledger.js';
import { SELF_IMPLEMENT_PROGRESS_STAGES } from './orchestrator.js';

export type RunningRunStatus = 'running' | 'probable-running' | 'ended-unclosed' | 'unknown';
export type RunningRunPresence = 'ledger-live-and-pty-observed' | 'ledger-live-pty-not-observed' | 'pty-observation-unreadable' | 'ledger-and-pty-observed' | 'ledger-without-pty-observed' | 'pty-without-ledger-observed';
export type RunningRunPhaseObservation = 'observed' | 'not-observed' | 'partially-unreadable' | 'unreadable';

export interface RunningRunPhaseEvent {
  readonly runId: string;
  readonly phase: string;
  readonly observedAt: string;
}

export interface ObservedRunPhases {
  readonly events: readonly RunningRunPhaseEvent[];
  readonly targetCount: number;
  readonly unreadableTargets: readonly string[];
  /** Self-implement events excluded because they are not declared progress stages. */
  readonly discardedNonStageEventCount?: number;
}

export interface RunningRunsPhaseStoreObservation {
  readonly targetCount: number;
  readonly readableTargetCount: number;
  readonly unreadableTargetCount: number;
  readonly unreadableTargets: readonly string[];
  /** Self-implement events excluded because they are not declared progress stages. */
  readonly discardedNonStageEventCount: number;
}

type RunPhaseLogStore = Pick<LogStore, 'queryByDataKeys' | 'close'>;

export interface RunningRunAssessment {
  readonly runId: string;
  readonly status: RunningRunStatus;
  readonly presence: RunningRunPresence;
  readonly reason: string;
  readonly lifecycle: UnfinishedRunLifecycle | null;
  readonly lastActivityTimestamp: string | null;
  /** Additive phase observation fields; queryRunningRuns always supplies all three. */
  readonly phaseObservation?: RunningRunPhaseObservation;
  readonly lastPhase?: string | null;
  readonly lastPhaseObservedAt?: string | null;
  readonly ptyUpdatedAt: number | null;
  readonly ledgerDirectories: readonly string[];
  readonly ptyRefs: readonly Pick<FederatedPtyRef, 'instance' | 'id' | 'kind'>[];
}

export interface RunningRunsObservation {
  readonly runsNotYetInLedgerDuringAuthoringAreNotCounted: true;
  readonly includesTest: boolean | null;
}

export interface RunningRunsQuantity<T> {
  readonly value: T;
  readonly population: 'all assessed runs' | 'assessed runs whose status is in countedStatuses';
  readonly observation: RunningRunsObservation;
}

export type LingeringLaunchParentAssessment =
  | {
    readonly observation: 'observed';
    readonly count: number;
    readonly withoutPidCount: number;
    readonly uncountedCount: number;
    readonly reusedPidCount: number;
  }
  | { readonly observation: 'indeterminate' };

export interface RunningRunsResult {
  readonly entries: readonly RunningRunAssessment[];
  readonly counts: Record<RunningRunStatus, number>;
  readonly total: number;
  readonly countedStatuses: readonly RunningRunStatus[];
  /** Supported quantity lookup: each value is paired with its assessed population and observation limits. */
  readonly quantities: {
    readonly counts: RunningRunsQuantity<Record<RunningRunStatus, number>>;
    readonly total: RunningRunsQuantity<number>;
    readonly entries: RunningRunsQuantity<number>;
    readonly running: RunningRunsQuantity<number>;
  };
  readonly observation: RunningRunsObservation;
  /** Terminated-ledger runs whose persisted launch parent is still alive, distinct from running-run status. Query results always provide it. */
  readonly lingeringLaunchParents?: LingeringLaunchParentAssessment;
  readonly ledger: Pick<FederatedUnfinishedRunLedgerQuery, 'ledgerDirectories' | 'unreadableLedgerCount' | 'unreadableLedgerDirectoryCount' | 'missingLedgerDirectoryCount' | 'unreadableLedgerDirectoryAccessCount' | 'indeterminateLedgerDirectoryCount'> & { readonly cacheHits?: number; readonly cacheMisses?: number };
  readonly pty: Pick<FederatedPtyListing, 'unreadable'> & {
    readonly observedRefCount: number;
    readonly withoutRunIdCount: number;
    readonly notCountedRefCount: number;
  };
  /** Additive phase-store observability; queryRunningRuns always supplies this value. */
  readonly phases?: RunningRunsPhaseStoreObservation;
}

function quantityScope<T>(value: T, population: RunningRunsQuantity<T>['population'], observation: RunningRunsObservation): RunningRunsQuantity<T> {
  return { value, population, observation };
}

function quantitySummary(result: Pick<RunningRunsResult, 'entries' | 'counts' | 'total' | 'countedStatuses' | 'observation'>): RunningRunsResult['quantities'] {
  const running = result.countedStatuses.reduce((count, status) => count + result.counts[status], 0);
  return {
    counts: quantityScope(result.counts, 'all assessed runs', result.observation),
    total: quantityScope(result.total, 'all assessed runs', result.observation),
    entries: quantityScope(result.entries.length, 'all assessed runs', result.observation),
    running: quantityScope(running, 'assessed runs whose status is in countedStatuses', result.observation),
  };
}

function observationScopeText(observation: RunningRunsObservation): string {
  return `isolated test universes ${observation.includesTest === null ? 'unknown' : observation.includesTest ? 'included' : 'excluded'}`;
}

const statuses: readonly RunningRunStatus[] = ['running', 'probable-running', 'ended-unclosed', 'unknown'];

function latestLedgerActivityTimestamp(entries: readonly FederatedUnfinishedRunLedgerEntry[]): string | null {
  let latest: { timestamp: string; time: number } | null = null;
  for (const entry of entries) {
    if (entry.lastActivityTimestamp === null) continue;
    const time = Date.parse(entry.lastActivityTimestamp);
    if (!Number.isFinite(time)) continue;
    if (latest === null || time > latest.time || (time === latest.time && entry.lastActivityTimestamp > latest.timestamp)) {
      latest = { timestamp: entry.lastActivityTimestamp, time };
    }
  }
  return latest?.timestamp ?? null;
}

function latestPtyUpdatedAt(refs: readonly FederatedPtyRef[]): number | null {
  let latest: number | null = null;
  for (const ref of refs) {
    if (ref.updatedAt === undefined) continue;
    if (latest === null || ref.updatedAt > latest) latest = ref.updatedAt;
  }
  return latest;
}

function latestPhaseByRun(events: readonly RunningRunPhaseEvent[]): Map<string, RunningRunPhaseEvent> {
  const latest = new Map<string, RunningRunPhaseEvent>();
  for (const event of events) {
    const observedAt = Date.parse(event.observedAt);
    if (!Number.isFinite(observedAt)) continue;
    const existing = latest.get(event.runId);
    const existingAt = existing ? Date.parse(existing.observedAt) : Number.NEGATIVE_INFINITY;
    if (!existing || observedAt > existingAt || (observedAt === existingAt && event.observedAt > existing.observedAt)) latest.set(event.runId, event);
  }
  return latest;
}

export function collectObservedRunPhases(
  targets: readonly { name: string; dbPath: string }[],
  runIds: readonly string[],
  openStore: (dbPath: string) => RunPhaseLogStore = LogStore.openReadOnly,
): ObservedRunPhases {
  const events: RunningRunPhaseEvent[] = [];
  const unreadableTargets: string[] = [];
  const selfImplementProgressStages = new Set<string>(SELF_IMPLEMENT_PROGRESS_STAGES);
  let discardedNonStageEventCount = 0;
  for (const target of targets) {
    let store: RunPhaseLogStore | null = null;
    try {
      store = openStore(target.dbPath);
      for (const row of store.queryByDataKeys({ exactCategories: ['self-implement'], runIds })) {
        try {
          const data = row.data ? JSON.parse(row.data) as { runId?: unknown } : null;
          if (typeof data?.runId === 'string' && runIds.includes(data.runId)) {
            if (selfImplementProgressStages.has(row.event)) events.push({ runId: data.runId, phase: row.event, observedAt: row.ts });
            else discardedNonStageEventCount += 1;
          }
        } catch { /* malformed payload cannot identify a phase */ }
      }
    } catch {
      unreadableTargets.push(target.name);
    } finally {
      store?.close();
    }
  }
  return { events, targetCount: targets.length, unreadableTargets, discardedNonStageEventCount };
}

function readObservedRunPhases(options: { includeTest?: boolean }, runIds: readonly string[]): ObservedRunPhases {
  if (runIds.length === 0) return { events: [], targetCount: 0, unreadableTargets: [] };
  const { targets, error } = resolveLogTargets({ all: true, includeTest: options.includeTest });
  if (error) throw new Error(error);
  return collectObservedRunPhases(targets, runIds);
}

function phaseObservationFor(phases: ObservedRunPhases): RunningRunPhaseObservation {
  if (phases.targetCount > 0 && phases.unreadableTargets.length === phases.targetCount) return 'unreadable';
  if (phases.unreadableTargets.length > 0) return 'partially-unreadable';
  return 'not-observed';
}

function phaseStoreObservation(phases: ObservedRunPhases): RunningRunsPhaseStoreObservation {
  return {
    targetCount: phases.targetCount,
    readableTargetCount: phases.targetCount - phases.unreadableTargets.length,
    unreadableTargetCount: phases.unreadableTargets.length,
    unreadableTargets: phases.unreadableTargets,
    discardedNonStageEventCount: phases.discardedNonStageEventCount ?? 0,
  };
}

export interface RunningRunsLedgerObservation {
  readonly entries: readonly FederatedUnfinishedRunLedgerEntry[];
  readonly cacheHits?: number;
  readonly cacheMisses?: number;
  readonly ledgerDirectories: readonly string[];
  readonly unreadableLedgerCount: number;
  readonly unreadableLedgerDirectoryCount: number;
  readonly missingLedgerDirectoryCount: number;
  readonly unreadableLedgerDirectoryAccessCount: number;
  readonly indeterminateLedgerDirectoryCount: number;
}

export interface RunningRunsQueryObservation {
  readonly caller?: string | null;
  readonly cacheHits?: number;
  readonly cacheMisses?: number;
  readonly elapsedMs: number;
  readonly ledgerDirectoryCollectionElapsedMs: number;
  readonly ledgerReadElapsedMs: number;
  readonly screenProcessReadElapsedMs: number;
  readonly stageStoreReadElapsedMs: number;
  readonly launchParentClassificationElapsedMs: number;
  readonly ledgerDirectoryCount: number;
  readonly ledgerEntryCount: number;
  readonly stageStoreCount: number;
  readonly discardedNonStageEventCount: number;
}

export interface RunningRunsQueryDeps {
  readonly queryLedgers?: (options: { includeTest?: boolean; ledgerDirectories?: readonly string[]; runIds?: readonly string[]; noCache?: boolean }) => FederatedUnfinishedRunLedgerQuery;
  readonly ledgerDirectories?: (options: { includeTest?: boolean }) => readonly string[];
  readonly ptyTargets?: (options: { includeTest?: boolean }) => readonly { name: string; dbPath: string }[];
  readonly readPtyRows?: typeof listPtyManifestRowsAt;
  readonly listPtyRefs?: typeof federatedPtyRefs;
  readonly readRunPhases?: (options: { includeTest?: boolean }, runIds: readonly string[]) => ObservedRunPhases;
  readonly loadRun?: (runId: string, ledgerDirectory: string) => SelfDevRunState | null;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly processStartedAt?: (pid: number) => number | null;
  readonly observeQuery?: (observation: RunningRunsQueryObservation) => void;
}

function hasUnreadableLedgerObservation(ledger: Pick<RunningRunsLedgerObservation, 'unreadableLedgerCount' | 'unreadableLedgerDirectoryAccessCount' | 'indeterminateLedgerDirectoryCount'>): boolean {
  return ledger.unreadableLedgerCount > 0
    || ledger.unreadableLedgerDirectoryAccessCount > 0
    || ledger.indeterminateLedgerDirectoryCount > 0;
}

const PROCESS_START_OBSERVATION_RESOLUTION_MS = 1_000;

function processStartedAt(pid: number): number | null {
  try {
    const output = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();
    const startedAt = Date.parse(output);
    return Number.isFinite(startedAt) ? startedAt : null;
  } catch {
    return null;
  }
}

function definitelyStartedBeforeRun(startedAt: number, runCreatedAt: number): boolean {
  return startedAt + PROCESS_START_OBSERVATION_RESOLUTION_MS <= runCreatedAt;
}

export function assessLingeringLaunchParents(
  ledgers: readonly FederatedUnfinishedRunLedgerEntry[],
  loadRun: (runId: string, ledgerDirectory: string) => SelfDevRunState | null,
  isProcessAlive: (pid: number) => boolean,
  processStartTime: (pid: number) => number | null,
  ledgerObservation?: Pick<RunningRunsLedgerObservation, 'unreadableLedgerCount' | 'unreadableLedgerDirectoryCount' | 'unreadableLedgerDirectoryAccessCount' | 'indeterminateLedgerDirectoryCount'>,
): LingeringLaunchParentAssessment {
  if (!ledgerObservation || hasUnreadableLedgerObservation(ledgerObservation)) return { observation: 'indeterminate' };

  const terminatedRunDirectories = new Map<string, string>();
  for (const ledger of ledgers) {
    if (isTerminatedUnfinishedLifecycle(ledger.lifecycle)) terminatedRunDirectories.set(ledger.runId, ledger.ledgerDirectory);
  }
  let count = 0;
  let withoutPidCount = 0;
  let uncountedCount = 0;
  let reusedPidCount = 0;
  try {
    for (const [runId, ledgerDirectory] of terminatedRunDirectories) {
      const run = loadRun(runId, ledgerDirectory);
      const pid = run?.pid;
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        withoutPidCount += 1;
        continue;
      }
      if (!isProcessAlive(pid)) continue;
      const startedAt = processStartTime(pid);
      if (startedAt === null || !Number.isFinite(startedAt) || typeof run?.createdAt !== 'number' || !Number.isFinite(run.createdAt)) {
        uncountedCount += 1;
        continue;
      }
      if (startedAt > run.createdAt) {
        reusedPidCount += 1;
        continue;
      }
      if (!definitelyStartedBeforeRun(startedAt, run.createdAt)) {
        uncountedCount += 1;
        continue;
      }
      count += 1;
    }
  } catch {
    return { observation: 'indeterminate' };
  }
  return { observation: 'observed', count, withoutPidCount, uncountedCount, reusedPidCount };
}

function loadRunFromLedgerDirectory(runId: string, ledgerDirectory: string): SelfDevRunState | null {
  return loadSelfDevRun(runId, selfDevRunsDir(dirname(ledgerDirectory)));
}

export function assessRunningRuns(
  ledgers: readonly FederatedUnfinishedRunLedgerEntry[],
  pty: FederatedPtyListing,
  ledgerObservation: Pick<RunningRunsLedgerObservation, 'unreadableLedgerCount' | 'unreadableLedgerDirectoryCount' | 'missingLedgerDirectoryCount' | 'unreadableLedgerDirectoryAccessCount' | 'indeterminateLedgerDirectoryCount'> = { unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0, missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0 },
  phases: readonly RunningRunPhaseEvent[] = [],
  phaseObservation: RunningRunPhaseObservation = 'not-observed',
): RunningRunsResult {
  const ledgerByRun = new Map<string, FederatedUnfinishedRunLedgerEntry[]>();
  for (const ledger of ledgers) {
    const entries = ledgerByRun.get(ledger.runId) ?? [];
    entries.push(ledger);
    ledgerByRun.set(ledger.runId, entries);
  }
  const ptyByRun = new Map<string, FederatedPtyRef[]>();
  for (const ref of pty.refs) {
    if (!ref.runId) continue;
    const refs = ptyByRun.get(ref.runId) ?? [];
    refs.push(ref);
    ptyByRun.set(ref.runId, refs);
  }
  const latestPhases = latestPhaseByRun(phases);
  const entries = [...new Set([...ledgerByRun.keys(), ...ptyByRun.keys()])].sort((a, b) => a.localeCompare(b)).map((runId) => {
    const matchingLedgers = ledgerByRun.get(runId) ?? [];
    const refs = ptyByRun.get(runId) ?? [];
    const lifecycle = matchingLedgers.some((entry) => entry.lifecycle === 'live') ? 'live'
      : matchingLedgers.find((entry) => entry.lifecycle !== 'live')?.lifecycle ?? null;
    const lastActivityTimestamp = latestLedgerActivityTimestamp(matchingLedgers);
    const latestPhase = latestPhases.get(runId);
    const ptyUpdatedAt = latestPtyUpdatedAt(refs);
    const ledgerDirectories = [...new Set(matchingLedgers.map((entry) => entry.ledgerDirectory))].sort();
    const phase = { phaseObservation: phaseObservation === 'not-observed' && latestPhase ? 'observed' as const : phaseObservation, lastPhase: latestPhase?.phase ?? null, lastPhaseObservedAt: latestPhase?.observedAt ?? null };
    const ptyRefs = refs.map(({ instance, id, kind }) => ({ instance, id, kind }));
    if (matchingLedgers.some((entry) => isTerminatedUnfinishedLifecycle(entry.lifecycle))) {
      return { runId, status: 'ended-unclosed' as const, presence: refs.length > 0 ? 'ledger-and-pty-observed' as const : 'ledger-without-pty-observed' as const, reason: 'ledger-positive-termination-evidence', lifecycle, lastActivityTimestamp, ...phase, ptyUpdatedAt, ledgerDirectories, ptyRefs };
    }
    if (refs.length > 0 && lifecycle === 'live') {
      return { runId, status: 'running' as const, presence: 'ledger-live-and-pty-observed' as const, reason: 'ledger-live-and-pty-alive', lifecycle, lastActivityTimestamp, ...phase, ptyUpdatedAt, ledgerDirectories, ptyRefs };
    }
    if (matchingLedgers.length > 0 && lifecycle === 'live' && pty.unreadable.length === 0 && refs.length === 0) {
      return { runId, status: 'probable-running' as const, presence: 'ledger-live-pty-not-observed' as const, reason: 'ledger-without-live-pty', lifecycle, lastActivityTimestamp, ...phase, ptyUpdatedAt, ledgerDirectories, ptyRefs };
    }
    const ledgerUnreadable = ledgerObservation.unreadableLedgerCount > 0;
    const reason = matchingLedgers.length === 0
      ? ledgerUnreadable ? 'ledger-query-unreadable-pty-observed' : 'pty-without-unfinished-ledger'
      : pty.unreadable.length > 0 ? 'pty-query-unreadable'
      : refs.length === 0 ? 'ledger-without-live-pty' : 'ledger-not-live';
    const presence: RunningRunPresence = pty.unreadable.length > 0
      ? 'pty-observation-unreadable'
      : matchingLedgers.length === 0 ? 'pty-without-ledger-observed'
      : refs.length === 0 ? 'ledger-without-pty-observed'
      : 'ledger-and-pty-observed';
    return { runId, status: 'unknown' as const, presence, reason, lifecycle, lastActivityTimestamp, ...phase, ptyUpdatedAt, ledgerDirectories, ptyRefs };
  });
  const counts: Record<RunningRunStatus, number> = { running: 0, 'probable-running': 0, 'ended-unclosed': 0, unknown: 0 };
  for (const entry of entries) counts[entry.status] += 1;
  const observation = { runsNotYetInLedgerDuringAuthoringAreNotCounted: true, includesTest: null } as const;
  const countedStatuses: readonly RunningRunStatus[] = ['running', 'probable-running'];
  const total = entries.length;
  const withoutRunIdCount = pty.refs.filter((ref) => !ref.runId).length;
  const notCountedRefCount = pty.refs.filter((ref) => {
    if (!ref.runId) return false;
    return !countedStatuses.includes(entries.find((entry) => entry.runId === ref.runId)?.status ?? 'unknown');
  }).length;
  return { entries, counts, total, countedStatuses, quantities: quantitySummary({ entries, counts, total, countedStatuses, observation }), observation, lingeringLaunchParents: { observation: 'indeterminate' }, ledger: { ledgerDirectories: [], unreadableLedgerCount: ledgerObservation.unreadableLedgerCount, unreadableLedgerDirectoryCount: ledgerObservation.unreadableLedgerDirectoryCount, missingLedgerDirectoryCount: ledgerObservation.missingLedgerDirectoryCount, unreadableLedgerDirectoryAccessCount: ledgerObservation.unreadableLedgerDirectoryAccessCount, indeterminateLedgerDirectoryCount: ledgerObservation.indeterminateLedgerDirectoryCount }, pty: { unreadable: [...pty.unreadable], observedRefCount: pty.refs.length, withoutRunIdCount, notCountedRefCount }, phases: { targetCount: 0, readableTargetCount: 0, unreadableTargetCount: 0, unreadableTargets: [], discardedNonStageEventCount: 0 } };
}

export function queryRunningRuns(options: { includeTest?: boolean; runIds?: readonly string[]; caller?: string; noCache?: boolean } = {}, deps: RunningRunsQueryDeps = {}): RunningRunsResult {
  const queryLedgers = deps.queryLedgers ?? queryFederatedUnfinishedRunLedgers;
  const ledgerDirectories = deps.ledgerDirectories ?? resolveFederatedRunLedgerDirectories;
  const collectLedgerDirectories = deps.ledgerDirectories !== undefined || deps.queryLedgers === undefined;
  const targets = deps.ptyTargets ?? ptyManifestTargets;
  const readPtyRows = deps.readPtyRows ?? listPtyManifestRowsAt;
  const listPtyRefs = deps.listPtyRefs ?? federatedPtyRefs;
  const readRunPhases = deps.readRunPhases ?? readObservedRunPhases;
  const loadRun = deps.loadRun ?? loadRunFromLedgerDirectory;
  const isProcessAlive = deps.isProcessAlive ?? isPidAlive;
  const processStartTime = deps.processStartedAt ?? processStartedAt;
  const observeQuery = deps.observeQuery ?? ((observation: RunningRunsQueryObservation) => debug.log('self-implement.running-runs', 'query', observation));
  const startedAt = Date.now();
  let ledgerDirectoryCollectionElapsedMs = 0;
  let ledgerReadElapsedMs = 0;
  let screenProcessReadElapsedMs = 0;
  let stageStoreReadElapsedMs = 0;
  let launchParentClassificationElapsedMs = 0;
  let collectedLedgerDirectories: readonly string[] = [];
  let ledgerDirectoryCount = 0;
  let ledgerEntryCount = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let stageStoreCount = 0;
  let discardedNonStageEventCount = 0;
  try {
    if (collectLedgerDirectories) {
      const ledgerDirectoryCollectionStartedAt = Date.now();
      try {
        collectedLedgerDirectories = ledgerDirectories({ includeTest: options.includeTest });
      } finally {
        ledgerDirectoryCollectionElapsedMs = Date.now() - ledgerDirectoryCollectionStartedAt;
      }
    }
    const ledgerReadStartedAt = Date.now();
    let ledger: FederatedUnfinishedRunLedgerQuery;
    try {
      const requestedRunIds = options.runIds === undefined ? {} : { runIds: options.runIds };
      const cacheOption = options.noCache === undefined ? {} : { noCache: options.noCache };
      ledger = collectLedgerDirectories
        ? queryLedgers({ includeTest: options.includeTest, ledgerDirectories: collectedLedgerDirectories, ...requestedRunIds, ...cacheOption })
        : queryLedgers({ includeTest: options.includeTest, ...requestedRunIds, ...cacheOption });
      ledgerDirectoryCount = ledger.ledgerDirectories.length;
      ledgerEntryCount = ledger.entries.length;
      cacheHits = ledger.cacheHits ?? 0;
      cacheMisses = ledger.cacheMisses ?? 0;
    } finally {
      ledgerReadElapsedMs = Date.now() - ledgerReadStartedAt;
    }
    const screenProcessReadStartedAt = Date.now();
    let pty: FederatedPtyListing;
    try {
      pty = listPtyRefs(targets({ includeTest: options.includeTest }), readPtyRows);
    } finally {
      screenProcessReadElapsedMs = Date.now() - screenProcessReadStartedAt;
    }
    const runIds = [...new Set([...ledger.entries.map((entry) => entry.runId), ...pty.refs.flatMap((ref) => ref.runId ? [ref.runId] : [])])];
    let observedPhases: ObservedRunPhases = { events: [], targetCount: 0, unreadableTargets: [] };
    const stageStoreReadStartedAt = Date.now();
    try {
      observedPhases = readRunPhases({ includeTest: options.includeTest }, runIds);
    } catch {
      observedPhases = { events: [], targetCount: 1, unreadableTargets: ['phase-query'] };
    } finally {
      stageStoreReadElapsedMs = Date.now() - stageStoreReadStartedAt;
      stageStoreCount = observedPhases.targetCount;
      discardedNonStageEventCount = observedPhases.discardedNonStageEventCount ?? 0;
    }
    const phaseObservation = phaseObservationFor(observedPhases);
    const result = assessRunningRuns(ledger.entries, pty, ledger, observedPhases.events, phaseObservation);
    const observation = { ...result.observation, includesTest: options.includeTest ?? false };
    const launchParentClassificationStartedAt = Date.now();
    let lingeringLaunchParents: LingeringLaunchParentAssessment;
    try {
      lingeringLaunchParents = assessLingeringLaunchParents(
        ledger.entries, loadRun, isProcessAlive, processStartTime, ledger,
      );
    } finally {
      launchParentClassificationElapsedMs = Date.now() - launchParentClassificationStartedAt;
    }
    return { ...result, observation, quantities: quantitySummary({ ...result, observation }), lingeringLaunchParents: lingeringLaunchParents!, ledger: { ledgerDirectories: ledger.ledgerDirectories, unreadableLedgerCount: ledger.unreadableLedgerCount, unreadableLedgerDirectoryCount: ledger.unreadableLedgerDirectoryCount, missingLedgerDirectoryCount: ledger.missingLedgerDirectoryCount, unreadableLedgerDirectoryAccessCount: ledger.unreadableLedgerDirectoryAccessCount, indeterminateLedgerDirectoryCount: ledger.indeterminateLedgerDirectoryCount, cacheHits, cacheMisses }, phases: phaseStoreObservation(observedPhases) };
  } finally {
    try {
      observeQuery({
        caller: options.caller ?? null,
        cacheHits,
        cacheMisses,
        elapsedMs: Date.now() - startedAt,
        ledgerDirectoryCollectionElapsedMs,
        ledgerReadElapsedMs,
        screenProcessReadElapsedMs,
        stageStoreReadElapsedMs,
        launchParentClassificationElapsedMs,
        ledgerDirectoryCount,
        ledgerEntryCount,
        stageStoreCount,
        discardedNonStageEventCount,
      });
    } catch {}
  }
}

export function renderRunningRuns(result: RunningRunsResult): string {
  const lingeringLaunchParents = result.lingeringLaunchParents ?? { observation: 'indeterminate' } as const;
  return [
    `running runs: ${result.counts.running + result.counts['probable-running']} confirmed: ${result.counts.running} probable: ${result.counts['probable-running']} countedStatuses=${result.countedStatuses.join(',')}`,
    `total assessments: ${result.total} ended-unclosed: ${result.counts['ended-unclosed']} unknown: ${result.counts.unknown}`,
    'observation limit: runs still in the post-launch authoring window and not yet recorded in the run ledger are not counted',
    `lingering launch parents: ${lingeringLaunchParents.observation === 'observed' ? `${lingeringLaunchParents.count} without pid: ${lingeringLaunchParents.withoutPidCount} uncounted: ${lingeringLaunchParents.uncountedCount} reused pid: ${lingeringLaunchParents.reusedPidCount}` : 'indeterminate'}`,
    `observation scope: ${observationScopeText(result.observation)}`,
    `ledger directories: ${result.ledger.ledgerDirectories.length} unreadable ledgers: ${result.ledger.unreadableLedgerCount} unreadable ledger directories: ${result.ledger.unreadableLedgerDirectoryCount} missing ledger directories: ${result.ledger.missingLedgerDirectoryCount} unreadable ledger directory accesses: ${result.ledger.unreadableLedgerDirectoryAccessCount} indeterminate ledger directories: ${result.ledger.indeterminateLedgerDirectoryCount}`,
    `observed live ptys: ${result.pty.observedRefCount} without runId: ${result.pty.withoutRunIdCount} not counted as running: ${result.pty.notCountedRefCount}`,
    `unreadable pty roots: ${result.pty.unreadable.join(',') || 'none'}`,
    `phase stores: ${result.phases?.targetCount ?? 0} readable: ${result.phases?.readableTargetCount ?? 0} unreadable: ${result.phases?.unreadableTargetCount ?? 0} unreadable targets: ${result.phases?.unreadableTargets.join(',') || 'none'} non-stage events discarded: ${result.phases?.discardedNonStageEventCount ?? 0}`,
    ...result.entries.map((entry) => `runId=${entry.runId} status=${entry.status} presence=${entry.presence} reason=${entry.reason} lifecycle=${entry.lifecycle ?? 'none'} lastActivity=${entry.lastActivityTimestamp ?? 'null'} phaseObservation=${entry.phaseObservation ?? 'not-observed'} lastPhase=${entry.lastPhase ?? 'none'} lastPhaseObservedAt=${entry.lastPhaseObservedAt ?? 'none'} ledgerDirectories=${entry.ledgerDirectories.join(',') || 'none'} ptyRefs=${entry.ptyRefs.map((ref) => `${ref.instance}:${ref.id}`).join(',') || 'none'}`),
    `quantity scope: running=${result.quantities.running.value} population=${result.quantities.running.population}; total=${result.quantities.total.value} entries=${result.quantities.entries.value} population=${result.quantities.total.population}; ${observationScopeText(result.observation)}`,
    'quantity limit: runs still in the post-launch authoring window and not yet recorded in the run ledger are not counted',
  ].join('\n');
}
