import { AsyncLocalStorage } from 'node:async_hooks';

/** Evidence contract for migrated CLI tests: one observed real child per file/run. */
export interface CliChildEvent {
  readonly eventId: string;
  readonly runId: string;
  readonly sourceFile: string;
  readonly type: 'child-started' | 'child-closed';
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly timedOut?: boolean;
}

export interface CliChildAdoptionTarget {
  readonly sourceFile: string;
  readonly runId: string;
}

export interface CliChildAdoptionResult {
  readonly ok: boolean;
  readonly targetFiles: number;
  readonly realChildren: number;
  readonly findings: readonly string[];
}

export interface CliChildRun {
  readonly runId: string;
  readonly sourceFile: string;
  readonly events: CliChildEvent[];
}

const childRunScope = new AsyncLocalStorage<CliChildRun>();

/** Scope every spawned CLI in a migrated test, including calls without per-call annotations. */
export function withCliChildRun<T>(run: CliChildRun, action: () => Promise<T>): Promise<T> {
  if (!run.runId.trim() || !run.sourceFile.trim()) throw new Error('child run requires a runId and sourceFile');
  return childRunScope.run(run, action);
}

/** Called at the actual child-process boundary; no event is invented for in-process turns. */
export function recordCliChildEvent(
  type: CliChildEvent['type'],
  pid: number | undefined,
  detail: Pick<CliChildEvent, 'exitCode' | 'signal' | 'timedOut'> = {},
): void {
  const run = childRunScope.getStore();
  if (!run) return;
  run.events.push({
    eventId: `${run.runId}:cli-child:${run.events.length + 1}`,
    runId: run.runId,
    sourceFile: run.sourceFile,
    type,
    ...(pid === undefined ? {} : { pid }),
    ...detail,
  });
}

/** Current migrated cohort; later cohorts extend this list in separate small PRs. */
export const CLI_CHILD_ONCE_ADOPTION_FILES = ['test/ad-intake.test.ts'] as const;

/**
 * Check injected lifecycle evidence rather than trusting a helper call count.
 * Each adopted test file/run must show exactly one started process and its close.
 */
export function evaluateCliChildAdoption(
  targets: readonly CliChildAdoptionTarget[],
  events: readonly CliChildEvent[],
): CliChildAdoptionResult {
  const findings: string[] = [];
  const targetKeys = new Set<string>();
  const eventIds = new Set<string>();
  const childrenByTarget = new Map<string, { started: number; closed: number; startedPids: number[]; closedPids: number[] }>();
  const keyFor = (sourceFile: string, runId: string) => `${sourceFile}\0${runId}`;

  for (const target of targets) {
    const key = keyFor(target.sourceFile, target.runId);
    if (!target.sourceFile.trim() || !target.runId.trim()) findings.push('target requires sourceFile and runId');
    if (targetKeys.has(key)) findings.push(`duplicate target ${target.sourceFile} run=${target.runId}`);
    targetKeys.add(key);
    childrenByTarget.set(key, { started: 0, closed: 0, startedPids: [], closedPids: [] });
  }

  for (const event of events) {
    const key = keyFor(event.sourceFile, event.runId);
    if (!event.eventId.trim() || !event.sourceFile.trim() || !event.runId.trim()) findings.push('event requires eventId, sourceFile, and runId');
    if (eventIds.has(event.eventId)) findings.push(`duplicate event ${event.eventId}`);
    eventIds.add(event.eventId);
    const counts = childrenByTarget.get(key);
    if (!counts) {
      findings.push(`event outside target cohort ${event.sourceFile} run=${event.runId}`);
      continue;
    }
    if (event.type === 'child-started') {
      if (counts.started === 0 && counts.closed > 0) findings.push(`${event.sourceFile} run=${event.runId}: child close preceded start`);
      counts.started += 1;
      if (typeof event.pid !== 'number' || !Number.isSafeInteger(event.pid) || event.pid <= 0) findings.push(`invalid real child pid ${event.sourceFile} run=${event.runId}`);
      else counts.startedPids.push(event.pid);
    } else if (event.type === 'child-closed') {
      if (counts.started === 0) findings.push(`${event.sourceFile} run=${event.runId}: child close preceded start`);
      counts.closed += 1;
      if (typeof event.pid === 'number' && Number.isSafeInteger(event.pid) && event.pid > 0) counts.closedPids.push(event.pid);
      else findings.push(`invalid closed child pid ${event.sourceFile} run=${event.runId}`);
    } else {
      findings.push(`unknown child event type ${String(event.type)} ${event.sourceFile} run=${event.runId}`);
    }
  }

  for (const target of targets) {
    const counts = childrenByTarget.get(keyFor(target.sourceFile, target.runId))!;
    if (counts.started !== 1) findings.push(`${target.sourceFile} run=${target.runId}: expected 1 child start, got ${counts.started}`);
    if (counts.closed !== 1) findings.push(`${target.sourceFile} run=${target.runId}: expected 1 child close, got ${counts.closed}`);
    if (counts.started === 1 && counts.closed === 1 && counts.startedPids[0] !== counts.closedPids[0]) {
      findings.push(`${target.sourceFile} run=${target.runId}: child pid changed across lifecycle`);
    }
  }

  return {
    ok: findings.length === 0,
    targetFiles: targetKeys.size,
    realChildren: events.filter((event) => event.type === 'child-started').length,
    findings,
  };
}
