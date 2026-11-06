import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { releaseReadiness } from '../../scripts/release-loop/release-readiness.js';
import { loadRunLedger, runLedgerDir, type RunLedgerEntry } from '../self-implement/run-ledger.js';
import { createFakePsDevice, type FakePsDevice } from './fake-ps.js';
import type { SimChaosFault, SimHostChaosFault, SimMonkeyFault, SimRecoveryExpectation, SimWorldProcess } from './world-schema.js';

export type WorldChaosKind = 'monkey' | 'gorilla';

export interface WorldChaosScenario {
  readonly kind: WorldChaosKind;
  readonly faultAtMs: number;
  readonly recoverAtMs: number;
  readonly target: string;
  readonly signal: 'KILL' | 'TERM';
  readonly process: SimWorldProcess;
}

export interface RecoveryExpectation {
  readonly withinMs: number;
  readonly hitlCount?: number;
  readonly lostLedgerRows?: number;
}

function durationMs(value: string): number {
  const match = /^\+(0|[1-9]\d*)(ms|s|m|h)$/.exec(value);
  if (!match) throw new Error(`invalid relative duration: ${value}`);
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
  const result = Number(match[1]) * scale[match[2] as keyof typeof scale];
  if (!Number.isSafeInteger(result)) throw new Error(`relative duration is too large: ${value}`);
  return result;
}

/** Adapt a validated monkey declaration to the production release-readiness process probe. */
export async function runWorldChaosFault(fault: SimMonkeyFault, processes: readonly SimWorldProcess[], clock?: WorldChaosClock, baseTimeMs = 0, processTable = createFakePsDevice({ processes })): Promise<WorldChaosObservation> {
  const recovery = startWorldChaosFault(fault, processTable, clock, baseTimeMs);
  if (clock) clock.tick(recovery.atMs - durationMs(fault.at));
  return recovery.complete();
}

function startWorldChaosFault(fault: SimMonkeyFault, processTable: FakePsDevice, clock?: WorldChaosClock, baseTimeMs = 0): PendingChaosRecovery {
  const target = fault.monkey.kill;
  const [id, host] = target.split(' host=');
  const process = processTable.find(id!, host!);
  if (!process) throw new Error(`world.chaos monkey target is not declared: ${target}`);
  const faultAtMs = durationMs(fault.at);
  const scenario = { kind: 'monkey' as const, faultAtMs, recoverAtMs: faultAtMs + 250, target, signal: fault.monkey.signal, process };
  return { atMs: scenario.recoverAtMs, target, complete: prepareMonkeyRecovery(scenario, processTable, clock, baseTimeMs) };
}

export function recoveryExpectationFromWorld(expectation: SimRecoveryExpectation): RecoveryExpectation {
  return { withinMs: durationMs(expectation.within), hitlCount: expectation.hitl, lostLedgerRows: expectation.lostLedger };
}

export interface WorldChaosObservation {
  readonly kind: WorldChaosKind | 'aggregate';
  readonly faultAtMs: number;
  readonly faultVerdict: string;
  readonly recoveredAtMs: number | null;
  readonly recoveryVerdict: string;
  readonly recoveryMs: number | null;
  readonly metrics: {
    readonly hitlCount: number;
    readonly lostLedgerRows: number | null;
    readonly schedulableCpuMillicores: number | null;
  };
}

export interface RecoveryEvaluation {
  readonly pass: boolean;
  readonly failures: readonly string[];
  readonly unmeasured: readonly string[];
}

export interface WorldChaosTimelineEntry {
  readonly atMs: number;
  readonly kind: 'injection' | 'world-event' | 'fault-start' | 'fault-recovery' | 'fault-restore';
  readonly target: string;
}

export interface WorldChaosInjectionReceipt {
  readonly runId: string;
  readonly injectionId: string;
  readonly ledgerPath: string;
  readonly ledgerRows: number;
}

export interface WorldChaosRun {
  readonly observations: readonly WorldChaosObservation[];
  readonly timeline: readonly WorldChaosTimelineEntry[];
  readonly injections: readonly WorldChaosInjectionReceipt[];
  readonly aggregate?: WorldChaosObservation;
  readonly evaluation?: RecoveryEvaluation;
}

export interface WorldChaosScheduledEvent {
  readonly atMs: number;
  readonly run: (now: () => Date) => { readonly injectionId: string; readonly runId: string; readonly ledgerPath: string; readonly ledgerRows: readonly RunLedgerEntry[] }
    | Promise<{ readonly injectionId: string; readonly runId: string; readonly ledgerPath: string; readonly ledgerRows: readonly RunLedgerEntry[] }>;
}

/** A deterministic world event sharing the fault and injection clock. */
export interface WorldChaosAction {
  readonly atMs: number;
  readonly target: string;
  readonly recordTimeline?: boolean;
  run(now: () => Date): void | Promise<void>;
}

export interface WorldChaosClock {
  now(): number;
  setTime(now: number | Date): void;
  tick(ms: number): void;
}

export interface PendingChaosRecovery {
  readonly atMs: number;
  readonly target: string;
  complete(): WorldChaosObservation | Promise<WorldChaosObservation>;
  readonly restoreAtMs?: number;
  restore?(): void;
}

export interface WorldHostChaosController {
  start(fault: SimHostChaosFault, atMs: number): PendingChaosRecovery;
}

/** Run all fault and injection declarations on one stable fake-time axis. */
export async function runWorldChaosSchedule(
  faults: readonly SimChaosFault[],
  processes: readonly SimWorldProcess[],
  expected?: SimRecoveryExpectation,
  ledgerMeasurement?: { readonly runId: string; readonly stateRoot: string; readonly expectedRows: readonly RunLedgerEntry[] },
  scheduledEvents: readonly WorldChaosScheduledEvent[] = [],
  clock?: WorldChaosClock,
  baseTimeMs = 0,
  hostChaos?: WorldHostChaosController,
  processTable = createFakePsDevice({ processes }),
  scheduledActions: readonly WorldChaosAction[] = [],
): Promise<WorldChaosRun> {
  const observations: WorldChaosObservation[] = [];
  const timeline: WorldChaosTimelineEntry[] = [];
  const injections: WorldChaosInjectionReceipt[] = [];
  type QueueEntry = { atMs: number; order: number; fault?: SimChaosFault; event?: WorldChaosScheduledEvent; action?: WorldChaosAction; recovery?: PendingChaosRecovery; restore?: () => void; restoreTarget?: string };
  const queue: QueueEntry[] = [
    ...faults.map((fault, order) => ({ atMs: durationMs(fault.at), order, fault })),
    ...scheduledEvents.map((event, order) => ({ atMs: event.atMs, order, event })),
    ...scheduledActions.map((action, order) => ({ atMs: action.atMs, order, action })),
  ];
  let nextOrder = queue.length;
  while (queue.length) {
    // Close fault lifecycles (including restorations) before injections scheduled for the same instant.
    const priority = (item: QueueEntry) => item.restore || item.recovery ? 0 : item.fault ? 1 : 2;
    queue.sort((a, b) => a.atMs - b.atMs || priority(a) - priority(b) || a.order - b.order);
    const item = queue.shift()!;
    if (clock) clock.setTime(Math.max(clock.now(), baseTimeMs + item.atMs));
    if (item.restore) {
      item.restore();
      timeline.push({ atMs: item.atMs, kind: 'fault-restore', target: item.restoreTarget! });
      continue;
    }
    if (item.event) {
      const result = await item.event.run(() => new Date(clock?.now() ?? baseTimeMs + item.atMs));
      injections.push({ runId: result.runId, injectionId: result.injectionId, ledgerPath: result.ledgerPath, ledgerRows: result.ledgerRows.length });
      timeline.push({ atMs: clock ? clock.now() - baseTimeMs : item.atMs, kind: 'injection', target: result.injectionId });
      continue;
    }
    if (item.action) {
      await item.action.run(() => new Date(clock?.now() ?? baseTimeMs + item.atMs));
      if (item.action.recordTimeline !== false) {
        timeline.push({ atMs: clock ? clock.now() - baseTimeMs : item.atMs, kind: 'world-event', target: item.action.target });
      }
      continue;
    }
    if (item.recovery) {
      observations.push(await item.recovery.complete());
      timeline.push({ atMs: clock ? clock.now() - baseTimeMs : item.atMs, kind: 'fault-recovery', target: item.recovery.target });
      if (item.recovery.restore && item.recovery.restoreAtMs !== undefined) {
        queue.push({ atMs: item.recovery.restoreAtMs, order: nextOrder++, restore: item.recovery.restore, restoreTarget: item.recovery.target });
      }
      continue;
    }
    const fault = item.fault!;
    const target = 'monkey' in fault ? fault.monkey.kill : fault.gorilla.host;
    timeline.push({ atMs: item.atMs, kind: 'fault-start', target });
    if ('monkey' in fault) {
      const recovery = startWorldChaosFault(fault, processTable, clock, baseTimeMs);
      queue.push({ atMs: recovery.atMs, order: nextOrder++, recovery });
    } else {
      if (!hostChaos) throw new Error('world.chaos gorilla needs assembled host devices');
      const recovery = hostChaos.start(fault, item.atMs);
      queue.push({ atMs: recovery.atMs, order: nextOrder++, recovery });
    }
  }
  if (!expected) return { observations, timeline, injections };
  const persistedLedgerRows = ledgerMeasurement
    ? (loadRunLedger(ledgerMeasurement.runId, runLedgerDir(ledgerMeasurement.stateRoot)) ?? [])
    : null;
  const expectedRowIds = ledgerMeasurement?.expectedRows.map((row) => row.data.injectionRowId).filter((id): id is string => typeof id === 'string') ?? [];
  const persistedRowIds = persistedLedgerRows?.map((row) => row.data.injectionRowId).filter((id): id is string => typeof id === 'string') ?? [];
  const persistedRowCounts = new Map<string, number>();
  for (const id of persistedRowIds) persistedRowCounts.set(id, (persistedRowCounts.get(id) ?? 0) + 1);
  const retainedRowIds = expectedRowIds.filter((id) => persistedRowCounts.get(id) === 1);
  const injectedLostLedgerRows = ledgerMeasurement
    ? expectedRowIds.length - retainedRowIds.length + Math.max(0, persistedRowIds.length - expectedRowIds.length)
    : null;
  const lostLedgerRows = injectedLostLedgerRows;
  const recoveryMs = observations.length > 0 && observations.every((row) => row.recoveryMs !== null)
    ? Math.max(...observations.map((row) => row.recoveryMs!)) : null;
  const aggregate: WorldChaosObservation = {
    kind: 'aggregate', faultAtMs: observations.length ? Math.min(...observations.map((row) => row.faultAtMs)) : 0,
    faultVerdict: observations.map((row) => `${row.kind}:${row.faultVerdict}`).join(', '),
    recoveredAtMs: observations.length && observations.every((row) => row.recoveredAtMs !== null)
      ? Math.max(...observations.map((row) => row.recoveredAtMs!)) : null,
    recoveryVerdict: observations.map((row) => `${row.kind}:${row.recoveryVerdict}`).join(', '), recoveryMs,
    metrics: {
      hitlCount: observations.reduce((sum, row) => sum + row.metrics.hitlCount, 0),
      lostLedgerRows,
      schedulableCpuMillicores: [...observations].reverse().find((row) => row.metrics.schedulableCpuMillicores !== null)?.metrics.schedulableCpuMillicores ?? null,
    },
  };
  return { observations, timeline, injections, aggregate, evaluation: evaluateExpectRecovers(aggregate, recoveryExpectationFromWorld(expected)) };
}

let active = false;

/** Evaluate recovery only from production-path observations. */
export function evaluateExpectRecovers(observation: WorldChaosObservation, expected: RecoveryExpectation): RecoveryEvaluation {
  const failures: string[] = [];
  const unmeasured: string[] = [];
  if (!Number.isFinite(expected.withinMs) || expected.withinMs < 0) failures.push('withinMs must be a nonnegative finite number');
  if (observation.recoveryMs === null) failures.push('production path did not recover');
  else if (observation.recoveryMs > expected.withinMs) failures.push(`recovery took ${observation.recoveryMs}ms, over ${expected.withinMs}ms`);
  if (expected.hitlCount !== undefined && observation.metrics.hitlCount !== expected.hitlCount) {
    failures.push(`HITL count ${observation.metrics.hitlCount} does not equal ${expected.hitlCount}`);
  }
  if (expected.lostLedgerRows !== undefined) {
    const lost = observation.metrics.lostLedgerRows;
    if (lost === null) unmeasured.push('lostLedgerRows');
    else if (lost !== expected.lostLedgerRows) failures.push(`lost ledger rows ${lost} does not equal ${expected.lostLedgerRows}`);
  }
  if (unmeasured.length) failures.push(`expectation uses unmeasured metrics: ${unmeasured.join(', ')}`);
  return { pass: failures.length === 0, failures, unmeasured };
}

/** Run the declared signal against its exact registered fake process, then ask production readiness to read its PID lock. */
export async function runWorldChaosScenario(scenario: WorldChaosScenario, clock?: WorldChaosClock, baseTimeMs = 0): Promise<WorldChaosObservation> {
  if (active) throw new Error('world chaos scenarios run serially');
  if (!Number.isSafeInteger(scenario.faultAtMs) || scenario.faultAtMs < 0 || scenario.recoverAtMs <= scenario.faultAtMs) {
    throw new Error('monkey recovery must follow its nonnegative fault time');
  }
  active = true;
  const originalLog = debug.log;
  const hitlEvents: Array<{ event: string; data: unknown }> = [];
  (debug as { log: typeof debug.log }).log = function (category, event, data, options) {
    if (category === 'hitl.execution') hitlEvents.push({ event, data });
    return originalLog.call(debug, category, event, data, options);
  };
  try {
    const processTable = createFakePsDevice({ processes: [scenario.process] });
    const complete = prepareMonkeyRecovery(scenario, processTable, clock, baseTimeMs);
    if (clock) clock.tick(scenario.recoverAtMs - scenario.faultAtMs);
    const observed = complete();
    return { ...observed, metrics: { ...observed.metrics, hitlCount: hitlEvents.length } };
  } finally {
    (debug as { log: typeof debug.log }).log = originalLog;
    active = false;
  }
}

function prepareMonkeyRecovery(scenario: WorldChaosScenario, processTable: FakePsDevice, clock?: WorldChaosClock, baseTimeMs = 0): () => WorldChaosObservation {
  const root = mkdtempSync(join(tmpdir(), 'world-chaos-monkey-'));
  try {
    const version = scenario.process.releaseVersion;
    const release = join(root, 'release', version);
    mkdirSync(release, { recursive: true });
    const running = processTable.find(scenario.process.id, scenario.process.host);
    if (!running?.alive) throw new Error(`fake ps has no live process: ${scenario.process.id} host=${scenario.process.host}`);
    const pid = running.pid;
    writeFileSync(join(release, 'run.lock'), `${JSON.stringify({ pid })}\n`, { mode: 0o600 });
    const probe = () => releaseReadiness(version, {
      ledgerRoot: root,
      isPidAlive: (candidate) => processTable.pidAlive(candidate),
      now: () => new Date(clock?.now() ?? baseTimeMs + scenario.faultAtMs),
      checklist: () => ({ ok: true, red: [], undecided: [], blocked: [] }),
    });
    const before = probe();
    const signalDelivered = `${scenario.process.id} host=${scenario.process.host}` === scenario.target && running.pid === pid
      && (scenario.signal === 'KILL' || scenario.signal === 'TERM') && processTable.kill(scenario.process.id, scenario.process.host);
    let completed = false;
    return () => {
      if (completed) throw new Error('monkey recovery was completed twice');
      completed = true;
      try {
        if (signalDelivered) unlinkSync(join(release, 'run.lock'));
        const recovered = probe();
        const restarted = before.reason === 'already-running' && signalDelivered && recovered.ready && recovered.reason === 'ready'
          && processTable.restart(scenario.process.id, scenario.process.host);
        const ok = restarted;
        return {
          kind: scenario.kind, faultAtMs: scenario.faultAtMs,
          faultVerdict: signalDelivered ? `${scenario.target} received ${scenario.signal}; ${before.reason}` : `target refused: ${scenario.target}`,
          recoveredAtMs: ok ? (clock ? clock.now() - baseTimeMs : scenario.recoverAtMs) : null,
          recoveryVerdict: recovered.reason, recoveryMs: ok ? scenario.recoverAtMs - scenario.faultAtMs : null,
          metrics: { hitlCount: 0, lostLedgerRows: null, schedulableCpuMillicores: null },
        };
      } finally { rmSync(root, { recursive: true, force: true }); }
    };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}
