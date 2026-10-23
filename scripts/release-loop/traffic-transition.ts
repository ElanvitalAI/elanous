import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { debug } from '../../src/debug/log.js';
import type { GraphContext } from './node-verdict.js';
import type { ReleaseLoopConfig } from './unattended-release.js';

export type ReleaseTrafficEvent = 'gate-passed' | 'verify-complete';

export interface TrafficFile {
  global?: string;
  seats: Record<string, Record<string, unknown>>;
  releaseLifecycle?: { runId: string; version: string; stage: 1 | 2; event: ReleaseTrafficEvent; startedAt?: string; updatedAt: string };
  [key: string]: unknown;
}

type ReleaseTrafficConfig = ReleaseLoopConfig & {
  trafficFile?: string;
};

const SEATS = ['OP', 'TC', 'MK', 'UX'] as const;
const STAGE: Record<ReleaseTrafficEvent, 1 | 2> = { 'gate-passed': 1, 'verify-complete': 2 };
const TRAFFIC_PER_CYCLE = { half: 3, full: 6 } as const;

export interface TrafficTransitionOptions {
  trafficFile?: string;
  lockTimeoutMs?: number;
  now?: () => Date;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

function waitSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireTrafficLock(path: string, timeoutMs = 10_000): () => void {
  const lock = `${path}.lock.d`;
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt += 1) {
    try {
      mkdirSync(lock);
      try { writeFileSync(`${lock}/pid`, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); }
      catch (error) { rmSync(lock, { recursive: true, force: true }); throw error; }
      return () => rmSync(lock, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        // A directory cannot be conditionally renamed by identity. Reclaiming after
        // checking its PID can therefore move a replacement owner's live lock.
        // Fail closed; OP can inspect and remove a stale lock after the warning mail.
        readFileSync(`${lock}/pid`, 'utf8');
        statSync(lock);
      } catch { /* Unknown or concurrently changing locks are left intact. */ }
      if (Date.now() >= deadline) throw new Error(`traffic lock timeout: ${lock}`);
      waitSync(100);
    }
  }
}

function readTrafficFile(path: string): TrafficFile {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('traffic file must contain a JSON object');
  const file = parsed as TrafficFile;
  if (!file.seats || typeof file.seats !== 'object' || Array.isArray(file.seats)
    || !SEATS.every((seat) => file.seats[seat] && typeof file.seats[seat] === 'object' && !Array.isArray(file.seats[seat]))) {
    throw new Error('traffic seats object missing');
  }
  return file;
}

function atomicWriteTrafficFile(path: string, file: TrafficFile): void {
  const temp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const mode = statSync(path).mode & 0o777;
  try {
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { flag: 'wx', mode });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function compareReleaseVersions(left: string, right: string): number {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/.exec(value);
  const a = parse(left), b = parse(right);
  if (!a || !b) return left.localeCompare(right);
  for (const index of [1, 2, 3]) {
    const delta = Number(a[index]) - Number(b[index]);
    if (delta) return Math.sign(delta);
  }
  if (!a[4] || !b[4]) return a[4] ? -1 : b[4] ? 1 : 0;
  const rank = { alpha: 0, beta: 1, rc: 2 } as const;
  const kind = rank[a[4] as keyof typeof rank] - rank[b[4] as keyof typeof rank];
  return kind || Math.sign(Number(a[5]) - Number(b[5]));
}

function isLaterRun(current: string | undefined, previous: string | undefined): boolean {
  return Boolean(current && previous && current > previous);
}

/** Apply one monotonic release graph event while preserving unrelated traffic policy fields. */
export async function applyReleaseTrafficEvent(
  context: GraphContext,
  event: ReleaseTrafficEvent,
  options: TrafficTransitionOptions,
): Promise<{ applied: boolean; stage: number; reason?: string }> {
  if (!context.runId) throw new Error('release traffic event requires graph runId');
  if (!options.trafficFile) throw new Error('traffic file path is not configured');
  const runId = context.runId;
  const version = context.input.version;
  const path = resolve(options.trafficFile);
  if (!existsSync(path)) throw new Error(`traffic file does not exist: ${path}`);
  const log = options.log ?? ((name, fields) => debug.log('release-loop.traffic', name, fields));
  const stage = STAGE[event];
  const stamp = (options.now ?? (() => new Date()))().toISOString();
  const rate = event === 'gate-passed' ? TRAFFIC_PER_CYCLE.half : TRAFFIC_PER_CYCLE.full;
  const releaseLifecycle = { runId, version, stage, event, ...(context.startedAt ? { startedAt: context.startedAt } : {}), updatedAt: stamp };
  const release = () => {
    const unlock = acquireTrafficLock(path, options.lockTimeoutMs);
    try {
      const before = readTrafficFile(path);
      const prior = before.releaseLifecycle;
      const sameRun = prior?.runId === runId;
      const newerVersion = !prior?.runId || compareReleaseVersions(version, prior.version) > 0;
      const sameVersionLaterRun = prior?.version === version && isLaterRun(context.startedAt, prior.startedAt);
      if (sameRun && prior.stage >= stage) return { file: before, applied: true, idempotent: true };
      const permitted = sameRun
        ? prior.stage === stage - 1
        : newerVersion || (event === 'gate-passed' && prior?.version === version && (prior.stage ?? 0) < 2 && sameVersionLaterRun)
          || (event === 'verify-complete' && prior?.version === version && sameVersionLaterRun);
      if (!permitted) {
        return { file: before, applied: false, idempotent: false, reason: prior?.runId && prior.runId !== runId ? 'different-run-is-current' : 'event-out-of-order' };
      }
      const after: TrafficFile = {
        ...before,
        ...(event === 'verify-complete' ? { global: 'green' } : {}),
        seats: Object.fromEntries(Object.entries(before.seats).map(([seat, value]) => [
          seat, SEATS.includes(seat as typeof SEATS[number]) ? { ...value, perCycle: rate } : value,
        ])),
        releaseLifecycle,
      };
      atomicWriteTrafficFile(path, after);
      return { file: after, applied: true, idempotent: false };
    } finally { unlock(); }
  };
  const result = release();
  const reason = result.applied && result.idempotent ? 'already-applied' : result.reason;
  log(result.idempotent ? 'already-applied' : result.applied ? 'applied' : 'ignored', {
    runId, version, event, stage, reason, perCycle: rate, ...(event === 'verify-complete' ? { global: 'green' } : {}),
  });
  return { applied: result.applied, stage: result.file.releaseLifecycle?.stage ?? 0, ...(reason ? { reason } : {}) };
}

export function trafficOptionsFromConfig(env: NodeJS.ProcessEnv = process.env, rawConfig: ReleaseLoopConfig = {}): TrafficTransitionOptions {
  const config = rawConfig as ReleaseTrafficConfig;
  const envTrafficFile = env.ELANOUS_RELEASE_TRAFFIC_FILE?.trim();
  const configTrafficFile = typeof config.trafficFile === 'string' ? config.trafficFile.trim() : undefined;
  const trafficFile = envTrafficFile || configTrafficFile;
  return trafficFile ? { trafficFile } : {};
}
