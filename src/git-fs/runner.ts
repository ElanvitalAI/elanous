import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { hostname } from 'node:os';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { runGitWithRetry, type GitRunResult, type GitRunner } from './retry.js';

export type GitCommandOptions = SpawnSyncOptions;
export type GitCommandRunner = (cwd: string, args: string[], options: GitCommandOptions) => GitRunResult;

let testRunner: GitCommandRunner | undefined;

type GitIoGroup = { calls: number; totalDurationMs: number };
type GitIoEvent = {
  caller: string;
  subcommand: string;
  durationMs: number;
  host: string;
  status: number | null;
};
type GitIoHourState = { groups: Map<string, GitIoGroup>; revision: number; clockSkew: boolean; historyTruncated: boolean };
const MAX_HOURLY_HISTORY_BUCKETS = 24;
let activeHour: string | undefined;
let activeHourClockSkew = false;
let activeHourHistoryTruncated = false;
let evictedThroughHour: string | undefined;
let hourlyGroups = new Map<string, GitIoGroup>();
const hourlyHistory = new Map<string, GitIoHourState>();
let gitIoObserver: ((event: 'run' | 'hourly-summary', data: Record<string, unknown>) => void) | undefined;
let gitIoNow = () => new Date();
let gitIoCallsite = callsite;
let gitIoMonotonicNow = () => performance.now();
type GitIoTimer = ReturnType<typeof setTimeout>;
type GitIoTimerApi = {
  schedule(callback: () => void, delayMs: number): GitIoTimer;
  cancel(timer: GitIoTimer): void;
};
let gitIoTimerApi: GitIoTimerApi = { schedule: setTimeout, cancel: clearTimeout };
let summaryTimer: GitIoTimer | undefined;
let timerGeneration = 0;
let summaryRevision = 0;
const processInstanceId = randomUUID();
const hourlyStateDir = join(tmpdir(), `elanous-git-fs-io-${processInstanceId}`);
process.once('exit', () => { try { rmSync(hourlyStateDir, { recursive: true, force: true }); } catch { /* Temporary telemetry state is best-effort. */ } });

function callerFromStack(stack: string | undefined): string {
  // This function is called only from runGitCommand. Skip its two stable
  // frames by stack position so transpiled and bundled filenames do not matter.
  const caller = stack?.split('\n').slice(1)[2];
  return caller?.trim().replace(/^at\s+/, '') ?? 'unknown';
}

function callsite(): string {
  return callerFromStack(new Error().stack);
}

function gitSubcommand(args: string[]): string {
  const optionsWithValues = new Set([
    '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--shallow-file', '--config-env',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg && optionsWithValues.has(arg)) {
      index += 1;
      continue;
    }
    if (arg && !arg.startsWith('-')) return arg;
  }
  return args[0] ?? '(empty)';
}

function emitGitIo(event: 'run' | 'hourly-summary', data: Record<string, unknown>): void {
  try {
    if (gitIoObserver) gitIoObserver(event, data);
    else debug.log('git-fs.io', event, data);
  } catch { /* Git observability must not change command behavior. */ }
}

function emitHourlySummary(complete: boolean, observedAt: string): void {
  if (activeHour && hourlyGroups.size > 0) {
    summaryRevision += 1;
    emitGitIo('hourly-summary', {
      hour: activeHour,
      host: hostname(),
      processId: process.pid,
      processInstanceId,
      revision: summaryRevision,
      observedAt,
      complete,
      clockSkew: activeHourClockSkew,
      historyTruncated: activeHourHistoryTruncated,
      totalCalls: [...hourlyGroups.values()].reduce((sum, group) => sum + group.calls, 0),
      groups: Object.fromEntries([...hourlyGroups].map(([key, value]) => [key, { ...value }])),
    });
  }
}

function flushHourlySummary(observedAt: string): void {
  emitHourlySummary(true, observedAt);
  if (activeHour) {
    const state: GitIoHourState = {
      groups: new Map([...hourlyGroups].map(([key, group]) => [key, { ...group }])),
      revision: summaryRevision,
      clockSkew: activeHourClockSkew,
      historyTruncated: activeHourHistoryTruncated,
    };
    hourlyHistory.set(activeHour, state);
    try {
      mkdirSync(hourlyStateDir, { recursive: true });
      writeFileSync(hourlyStatePath(activeHour), JSON.stringify({
        groups: Object.fromEntries(state.groups), revision: state.revision,
        clockSkew: state.clockSkew, historyTruncated: state.historyTruncated,
      }));
    } catch { /* Persistent rollup state is best-effort; Git behavior stays primary. */ }
    while (hourlyHistory.size > MAX_HOURLY_HISTORY_BUCKETS) {
      const oldestHour = [...hourlyHistory.keys()].sort()[0];
      if (!oldestHour) break;
      hourlyHistory.delete(oldestHour);
      if (!evictedThroughHour || oldestHour > evictedThroughHour) evictedThroughHour = oldestHour;
    }
  }
}

function hourlyStatePath(hour: string): string {
  return join(hourlyStateDir, `${hour.replace(/[^0-9A-Za-z-]/gu, '_')}.json`);
}

function activateHour(hour: string, clockSkew: boolean): void {
  let previous = hourlyHistory.get(hour);
  if (!previous) {
    try {
      const persisted = JSON.parse(readFileSync(hourlyStatePath(hour), 'utf8')) as {
        groups?: Record<string, GitIoGroup>; revision?: number; clockSkew?: boolean; historyTruncated?: boolean;
      };
      if (persisted.groups && Number.isSafeInteger(persisted.revision)) {
        previous = {
          groups: new Map(Object.entries(persisted.groups)), revision: persisted.revision!,
          clockSkew: Boolean(persisted.clockSkew), historyTruncated: Boolean(persisted.historyTruncated),
        };
        hourlyHistory.set(hour, previous);
      }
    } catch { /* A missing/invalid old bucket starts a marked partial segment below. */ }
  }
  activeHour = hour;
  activeHourClockSkew = clockSkew || Boolean(previous?.clockSkew);
  activeHourHistoryTruncated = previous?.historyTruncated ?? Boolean(evictedThroughHour && hour <= evictedThroughHour);
  hourlyGroups = previous?.groups ?? new Map();
  summaryRevision = previous?.revision ?? 0;
}

function cancelSummaryTimer(): void {
  timerGeneration += 1;
  if (summaryTimer) gitIoTimerApi.cancel(summaryTimer);
  summaryTimer = undefined;
}

function scheduleHourlySummary(): void {
  if (summaryTimer || !activeHour) return;
  const now = gitIoNow();
  const nextHour = new Date(`${activeHour}:00:00.000Z`);
  nextHour.setUTCHours(nextHour.getUTCHours() + 1);
  const scheduledHour = activeHour;
  const generation = ++timerGeneration;
  summaryTimer = gitIoTimerApi.schedule(() => {
    if (generation !== timerGeneration) return;
    summaryTimer = undefined;
    try {
      if (activeHour === scheduledHour) {
        const observedAt = gitIoNow();
        if (observedAt.getTime() < nextHour.getTime()) {
          scheduleHourlySummary();
          return;
        }
        flushHourlySummary(observedAt.toISOString());
        activeHour = undefined;
      }
    } catch { /* A failed summary must not crash the host process. */ }
  }, Math.max(1, nextHour.getTime() - now.getTime()));
  summaryTimer.unref?.();
}

function recordGitIo(data: GitIoEvent): void {
  const observedAt = gitIoNow().toISOString();
  const observedHour = observedAt.slice(0, 13);
  let clockSkew = false;
  if (!activeHour) {
    activateHour(observedHour, false);
  } else if (observedHour !== activeHour) {
    const previousHour = activeHour;
    cancelSummaryTimer();
    flushHourlySummary(observedAt);
    clockSkew = observedHour < previousHour;
    activateHour(observedHour, clockSkew);
  }
  const hour = activeHour;
  const key = `${data.caller} :: ${data.subcommand}`;
  const group = hourlyGroups.get(key) ?? { calls: 0, totalDurationMs: 0 };
  group.calls += 1;
  group.totalDurationMs += data.durationMs;
  hourlyGroups.set(key, group);
  emitGitIo('run', { ...data, hour, observedHour, clockSkew, historyTruncated: activeHourHistoryTruncated });
  emitHourlySummary(false, observedAt);
  scheduleHourlySummary();
}

/** Test seam for deterministic per-command and hourly rollup assertions. */
export function _setGitIoObserverForTesting(
  observer: ((event: 'run' | 'hourly-summary', data: Record<string, unknown>) => void) | undefined,
  now?: (() => Date) | undefined,
  timerApi?: GitIoTimerApi,
  diagnostics?: { caller?: () => string; monotonicNow?: () => number },
): void {
  cancelSummaryTimer();
  gitIoObserver = observer;
  gitIoNow = now ?? (() => new Date());
  gitIoCallsite = diagnostics?.caller ?? callsite;
  gitIoMonotonicNow = diagnostics?.monotonicNow ?? (() => performance.now());
  gitIoTimerApi = timerApi ?? { schedule: setTimeout, cancel: clearTimeout };
  activeHour = undefined;
  activeHourClockSkew = false;
  activeHourHistoryTruncated = false;
  evictedThroughHour = undefined;
  hourlyGroups = new Map();
  hourlyHistory.clear();
  try { rmSync(hourlyStateDir, { recursive: true, force: true }); } catch { /* Test reset is best-effort. */ }
  summaryRevision = 0;
}

/** Exercises the stack-frame caller extraction with transpiled/bundled paths. */
export function _callerFromStackForTesting(stack: string | undefined): string {
  return callerFromStack(stack);
}

/** Installs a process-free runner for behavioral tests of callers such as undo-turn. */
export function setGitCommandRunnerForTesting(runner: GitCommandRunner | undefined): void {
  testRunner = runner;
}

function outputText(output: string | Buffer | undefined | null): string {
  return output == null ? '' : output.toString();
}

/** Runs one Git command in cwd through the shared lock-contention retry seam.
 * The complete structured result is retained so callers can distinguish
 * command failure from an empty command output. */
export function runGitCommand(
  cwd: string,
  args: string[],
  options: GitCommandOptions = {},
  runner?: GitRunner,
): GitRunResult {
  let caller = 'unknown';
  try { caller = gitIoCallsite(); } catch { /* Caller metadata is optional. */ }
  const execute = runner ?? ((gitArgs: string[]): GitRunResult => {
    if (testRunner) return testRunner(cwd, gitArgs, options);
    const result = spawnSync('git', gitArgs, { ...options, cwd });
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    return {
      status: result.status,
      ...(result.signal ? { signal: result.signal } : {}),
      ...(errorCode ? { errorCode } : {}),
      stdout: outputText(result.stdout),
      stderr: outputText(result.stderr),
    };
  });
  const run: GitRunner = gitArgs => {
    let startedAt: number | undefined;
    try { startedAt = gitIoMonotonicNow(); } catch { /* Timing metadata is optional. */ }
    let result: GitRunResult | undefined;
    try {
      result = execute(gitArgs);
      return result;
    } finally {
      try {
        let endedAt: number | undefined;
        try { endedAt = gitIoMonotonicNow(); } catch { /* Timing metadata is optional. */ }
        recordGitIo({
          caller,
          subcommand: gitSubcommand(gitArgs),
          durationMs: startedAt === undefined || endedAt === undefined ? 0 : Math.max(0, endedAt - startedAt),
          host: hostname(),
          status: result?.status ?? null,
        });
      } catch { /* Instrumentation must not replace a Git result or error. */ }
    }
  };
  return runGitWithRetry(args, run);
}
