import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot, prodInstanceRoot, releaseLedgerRoot } from '../instance/resolve.js';
import { listChecklist, type ChecklistItem } from '../release-loop/checklist.js';
import { listSchedules } from '../release-loop/release-schedule.js';
import { withFileLockSync } from '../storage/file-lock.js';
import { trafficTick, TRAFFIC_SEATS, type TrafficCell } from '../loops/orchestrator/traffic.js';
import { decideSpawn, seatCapDetails, seatCapReason } from '../loops/budget.js';
import { listSelfDevRuns, processBirthId, selfDevRunsDir } from '../self-dev/run-store.js';
import { getUserConfig, userConfigPath, type OrchestratorLoopConfig } from '../user-config.js';
import { hostLeaseCounts, leaseHasPendingPod } from '../pod-lease/host-lease.js';
import { leaseKubectl, measurePoolLease } from '../task-orchestrator/surfaces/pod-lease.js';
import { parsePodPool, podPoolHostLease, resolvePodPoolSpec } from '../task-orchestrator/surfaces/pod-pool.js';
import { writeHarnessQueueReceipt } from './harness-queue-child.js';
import { finishAdvice, measureFinish, type FinishMetrics } from '../loops/orchestrator/finish-rate.js';

export type QueueSeat = 'OP' | 'TC' | 'MK' | 'UX';
export type QueueItem = {
  id: string; seat: QueueSeat; kind: 'say' | 'ask'; input: string; hold: boolean; heavy: boolean;
  at: string; status: 'queued' | 'launching' | 'launched' | 'finished'; pid?: number; launchId?: string; idempotencyKey?: string; waitingReason?: string;
};
export type QueuePool = { running: number; pending: number; reserved: number; limit: number };
export type QueueTick = { outcome: 'launched' | 'waiting' | 'skipped'; item?: QueueItem; reason: string };
export type QueueProcess = { pid: number; seat?: QueueSeat; launchId?: string; runId?: string; rootPid?: number };
type ProcessProbe = {
  run?: typeof spawnSync; platform?: NodeJS.Platform;
  cwd?: (pid: number) => string;
  seatTrees?: Partial<Record<QueueSeat, string[]>>;
  runsDir?: string;
  environ?: (pid: number) => string;
  birthId?: (pid: number) => string | undefined;
};
const queueSeatNames = ['OP', 'TC', 'MK', 'UX'] as const;

export function queueSeatForCwd(cwd: string, trees: Partial<Record<QueueSeat, string[]>> = {}): QueueSeat | undefined {
  if (!cwd.startsWith('/')) return undefined;
  const current = resolve(cwd);
  const matches = queueSeatNames.filter((s) => trees[s]?.some((tree) => {
    if (!tree.startsWith('/')) return false;
    const prefix = resolve(tree);
    return current === prefix || current.startsWith(`${prefix}/`);
  }));
  return matches.length === 1 ? matches[0] : undefined;
}

export interface HarnessQueueDeps {
  root?: string;
  configPath?: string;
  cap?: (seat: QueueSeat) => number;
  pool?: () => QueuePool;
  launch?: (item: QueueItem, args: string[], root: string) => Promise<number>;
  alive?: (pid: number) => boolean;
  processes?: () => readonly QueueProcess[];
  receipt?: (root: string, launchId: string) => 'started' | 'finished' | 'not-started' | null;
  now?: () => Date;
  authorShadow?: (root: string, now: Date) => void | Promise<void>;
  idleRequest?: (root: string, now: Date, items: readonly QueueItem[], deps: HarnessQueueDeps) => void | Promise<void>;
  idleCells?: (now: Date) => { current: readonly Pick<ChecklistItem, 'id' | 'title' | 'owner' | 'status' | 'evidence'>[];
    next: readonly Pick<ChecklistItem, 'id' | 'title' | 'owner' | 'status' | 'evidence'>[] };
  idleLog?: (category: string, event: string, data: Record<string, unknown>) => void;
  log?: (event: 'enqueued' | 'launched' | 'waiting' | 'skipped', data: Record<string, unknown>) => void;
  /** FINISH-RATE metrics source; a test process without it skips the real measurement. */
  finishMetrics?: (now: Date) => FinishMetrics | Promise<FinishMetrics>;
}

const FINISH_CACHE_MS = 10 * 60 * 1_000;
const FINISH_KEYS = ['launched', 'landed', 'landingRate', 'staleDrafts', 'conflictRatio', 'unknownMergeable'] as const;

/** A cache row missing any metric or its reasons map is re-measured, never fed to finishAdvice. */
function validFinishMetrics(value: unknown): value is FinishMetrics {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return FINISH_KEYS.every((key) => row[key] === null || (typeof row[key] === 'number' && Number.isFinite(row[key])))
    && !!row.reasons && typeof row.reasons === 'object' && !Array.isArray(row.reasons);
}

/** Reads finish metrics at most once per 10 minutes per root; unreadable or missing → null (never a hold). */
async function cachedFinishMetrics(root: string, now: Date, deps: HarnessQueueDeps): Promise<FinishMetrics | null> {
  // Checked before the cache: a cached real measurement must not reach an uninjected test tick either.
  if (!deps.finishMetrics && (process.env.NODE_ENV === 'test' || process.env.ELANOUS_TEST_HOME)) {
    debug.log('loop.orchestrator', 'finish-skipped-test', {});
    return null;
  }
  const path = join(root, 'harness', 'finish-metrics.json');
  try {
    if (existsSync(path)) {
      const cached = JSON.parse(readFileSync(path, 'utf8')) as { at?: unknown; metrics?: unknown };
      const at = typeof cached.at === 'string' ? Date.parse(cached.at) : NaN;
      if (Number.isFinite(at) && now.getTime() - at >= 0 && now.getTime() - at < FINISH_CACHE_MS
        && validFinishMetrics(cached.metrics)) return cached.metrics;
    }
  } catch { /* A broken cache is re-measured. */ }
  const measure = deps.finishMetrics ?? (() => measureFinish());
  const metrics = await measure(now);
  try {
    mkdirSync(join(root, 'harness'), { recursive: true });
    writeFileSync(path, JSON.stringify({ at: now.toISOString(), metrics }));
  } catch (error) { debug.log('loop.orchestrator', 'finish-cache-write-failed', { reason: String(error) }); }
  return metrics;
}

/** FINISH-RATE: a backlogged board holds this launch when the pool already fills the launch share. */
async function finishGateReason(root: string, now: Date, mode: 'off' | 'shadow' | 'on', running: number, totalSlots: number,
  deps: HarnessQueueDeps): Promise<string | null> {
  if (mode === 'off') return null;
  let metrics: FinishMetrics | null;
  try { metrics = await cachedFinishMetrics(root, now, deps); }
  catch (error) {
    debug.log('loop.orchestrator', 'finish-measure-failed', { reason: String(error) });
    return null;
  }
  if (!metrics) return null;
  const advice = finishAdvice(metrics, totalSlots);
  if (advice.state !== 'backlogged' || running < advice.launchSlots) return null;
  debug.log('loop.orchestrator', 'finish-rebalanced', {
    finishSlots: advice.finishSlots, launchSlots: advice.launchSlots, running, reasons: advice.reasons, mode,
  });
  if (mode === 'shadow') return null;
  return `마무리 우선 — finish=${advice.finishSlots}/${totalSlots} · 사유 ${advice.reasons.join(', ')}`;
}

export function harnessQueuePath(root = effectiveInstanceRoot()): string {
  return join(root, 'harness', 'queue.json');
}

function observe(event: 'enqueued' | 'launched' | 'waiting' | 'skipped', data: Record<string, unknown>, deps: HarnessQueueDeps): void {
  try { (deps.log ?? ((name, payload) => debug.log('harness.queue', name, payload)))(event, data); }
  catch { /* Logging cannot affect dispatch. */ }
}

function read(path: string): QueueItem[] {
  if (!existsSync(path)) return [];
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(value) || !value.every((row) => row && typeof row === 'object'
    && typeof row.id === 'string' && /^(OP|TC|MK|UX)$/.test(row.seat)
    && (row.kind === 'say' || row.kind === 'ask') && typeof row.input === 'string'
    && typeof row.at === 'string' && typeof row.hold === 'boolean' && typeof row.heavy === 'boolean'
    && ['queued', 'launching', 'launched', 'finished'].includes(row.status)
    && (row.pid === undefined || Number.isSafeInteger(row.pid))
    && (row.launchId === undefined || typeof row.launchId === 'string')
    && (row.idempotencyKey === undefined || typeof row.idempotencyKey === 'string')
    && (row.waitingReason === undefined || typeof row.waitingReason === 'string'))) {
    throw new Error('harness queue: invalid queue file (no launch)');
  }
  return value as QueueItem[];
}

function save(path: string, items: QueueItem[]): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(items, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* write did not finish */ }
    throw error;
  }
}

function lastLaunchedSeat(path: string): QueueSeat | undefined {
  const marker = `${path}.round-robin.json`;
  if (!existsSync(marker)) return undefined;
  const value: unknown = JSON.parse(readFileSync(marker, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !queueSeatNames.some((name) => name === (value as { lastSeat?: unknown }).lastSeat)) {
    throw new Error('harness queue: invalid round-robin state (no launch)');
  }
  return (value as { lastSeat: QueueSeat }).lastSeat;
}

function saveLastLaunchedSeat(path: string, lastSeat: QueueSeat): void {
  const marker = `${path}.round-robin.json`;
  const temporary = `${marker}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ lastSeat }), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, marker);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* write did not finish */ }
    throw error;
  }
}

// SQLite OS locks release on process death, including death while awaiting a launch.
async function locked<T>(root: string, action: (path: string) => Promise<T>): Promise<T> {
  const path = harnessQueuePath(root);
  mkdirSync(join(root, 'harness'), { recursive: true, mode: 0o700 });
  const db = new Database(`${path}.mutex.sqlite`, { create: true, strict: true });
  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { db.exec('BEGIN IMMEDIATE'); break; }
      catch (error) {
        if ((error as { code?: string }).code !== 'SQLITE_BUSY' || Date.now() >= deadline) throw error;
        await Bun.sleep(25);
      }
    }
    try { return await action(path); }
    finally { db.exec('ROLLBACK'); }
  } finally { db.close(); }
}

function seat(value: string): QueueSeat {
  if (!/^(OP|TC|MK|UX)$/.test(value)) throw new Error(`harness queue: unknown seat ${value}`);
  return value as QueueSeat;
}

export async function addHarnessQueue(input: { seat: string; say?: string; ask?: string; hold?: boolean; heavy?: boolean; idempotencyKey?: string }, deps: HarnessQueueDeps = {}): Promise<QueueItem> {
  const assigned = seat(input.seat);
  if ((input.say === undefined) === (input.ask === undefined)) throw new Error('harness queue add: --say 또는 --ask 중 하나만 필요');
  const kind = input.ask === undefined ? 'say' : 'ask';
  const text = kind === 'say' ? input.say! : input.ask!;
  if (!text.trim()) throw new Error('harness queue add: 빈 입력');
  const value = kind === 'ask' ? resolve(text) : text;
  if (kind === 'ask' && !existsSync(value)) throw new Error(`harness queue add: goal file not found: ${value}`);
  const root = deps.root ?? effectiveInstanceRoot();
  return locked(root, async (path) => {
    const rows = read(path);
    if (input.idempotencyKey !== undefined) {
      if (!input.idempotencyKey.trim()) throw new Error('harness queue add: empty idempotency key');
      const existing = rows.find((row) => row.idempotencyKey === input.idempotencyKey
        && (row.status === 'queued' || row.status === 'launching' || row.status === 'launched')
        && queueRowOutcome(row, root) !== 'retryable');
      if (existing) {
        if (existing.seat !== assigned || existing.kind !== kind || existing.input !== value) throw new Error('harness queue: idempotency key collision');
        return existing;
      }
    }
    const item: QueueItem = { id: `hq-${randomUUID()}`, seat: assigned, kind, input: value,
      hold: input.hold === true, heavy: input.heavy === true, at: new Date().toISOString(), status: 'queued',
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }) };
    save(path, [...rows, item]);
    observe('enqueued', { id: item.id, seat: item.seat, kind }, deps);
    return item;
  });
}

export function listHarnessQueue(deps: HarnessQueueDeps = {}): QueueItem[] {
  return read(harnessQueuePath(deps.root ?? effectiveInstanceRoot()));
}

/** A missing row is not proof of failure unless the queue left a cancellation marker. */
export function harnessQueueOutcome(id: string, deps: HarnessQueueDeps = {}): 'pending' | 'succeeded' | 'retryable' | 'unknown' {
  const root = deps.root ?? effectiveInstanceRoot();
  const row = listHarnessQueue(deps).find((item) => item.id === id);
  if (!row) {
    const marker = join(root, 'harness', `${id}.outcome`);
    if (!existsSync(marker)) return 'unknown';
    const value = readFileSync(marker, 'utf8');
    return value === 'succeeded' || value === 'retryable' ? value : 'unknown';
  }
  return queueRowOutcome(row, root);
}

const keyMarkerPath = (root: string, key: string) => join(root, 'harness', 'by-key', `${createHash('sha256').update(key).digest('hex')}.id`);

function recordQueueOutcome(root: string, id: string, outcome: 'succeeded' | 'retryable', key?: string): void {
  const path = join(root, 'harness', `${id}.outcome`);
  if (!existsSync(path)) writeFileSync(path, outcome, { flag: 'wx', mode: 0o600 });
  // The row is about to leave the queue; keep «which id last held this key» so a caller that crashed before
  // recording the id can still find the outcome (LOOP-LIVE1 · seat loop recovery).
  if (key) {
    mkdirSync(join(root, 'harness', 'by-key'), { recursive: true });
    writeFileSync(keyMarkerPath(root, key), id, { mode: 0o600 });
  }
}

/** Last queue id that settled under this idempotency key, or undefined when none was recorded. */
export function harnessQueueIdForKey(key: string, deps: HarnessQueueDeps = {}): string | undefined {
  try {
    const id = readFileSync(keyMarkerPath(deps.root ?? effectiveInstanceRoot(), key), 'utf8').trim();
    return /^hq-[0-9a-f-]{36}$/i.test(id) ? id : undefined;
  } catch { return undefined; }
}

function queueRowOutcome(row: QueueItem, root: string): 'pending' | 'succeeded' | 'retryable' | 'unknown' {
  if (row.status === 'queued') return 'pending';
  if (row.status === 'finished') {
    const marker = join(root, 'harness', `${row.id}.outcome`);
    if (existsSync(marker)) {
      const value = readFileSync(marker, 'utf8');
      if (value === 'succeeded' || value === 'retryable') return value;
    }
  }
  if (!row.launchId) return 'unknown';
  const receiptPath = harnessQueueReceiptPath(root, row.launchId);
  if (!existsSync(receiptPath)) return 'pending';
  const record: unknown = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (!record || typeof record !== 'object') return 'unknown';
  const { state, exitCode } = record as { state?: unknown; exitCode?: unknown };
  if (state === 'not-started') return 'retryable';
  if (state === 'finished') return exitCode === 0 ? 'succeeded' : typeof exitCode === 'number' ? 'retryable' : 'unknown';
  return state === 'started' ? 'pending' : 'unknown';
}

export async function removeHarnessQueue(id: string, deps: HarnessQueueDeps = {}): Promise<boolean> {
  const root = deps.root ?? effectiveInstanceRoot();
  return locked(root, async (path) => {
    const rows = read(path);
    const item = rows.find((row) => row.id === id);
    if (!item) return false;
    if (item.status !== 'queued' && item.status !== 'finished') {
      if ((item.status !== 'launched' && item.status !== 'launching') || !item.launchId) return false;
      const state = (deps.receipt ?? receipt)(root, item.launchId);
      if (state !== 'finished' && state !== 'not-started'
        || (deps.processes ?? readHarnessQueueProcesses)().some((row) => row.launchId === item.launchId)) return false;
    }
    const outcome = item.status === 'queued' ? 'retryable' : queueRowOutcome(item, root);
    if (item.idempotencyKey && (outcome === 'retryable' || outcome === 'succeeded')) {
      recordQueueOutcome(root, id, outcome, item.idempotencyKey);
    }
    save(path, rows.filter((row) => row.id !== id));
    observe('skipped', { id, seat: item.seat, reason: 'removed' }, deps);
    return true;
  });
}

export function queueLaunchArgs(item: QueueItem): string[] {
  return ['harness', item.kind, item.input, '--substrate', 'pod',
    ...(item.hold ? ['--no-auto-merge'] : []), ...(item.heavy ? ['--pod-memory', 'high'] : [])];
}

export function readHarnessQueuePool(): QueuePool {
  const config = getUserConfig();
  const spec = resolvePodPoolSpec(undefined, process.env, () => config.harness?.podPool ?? config.pod?.pool);
  const current = spec ? null : leaseKubectl(['config', 'current-context']);
  const context = spec ?? (current?.status === 0 ? current.stdout.trim() : '');
  if (!context) throw new Error('pod lease status: no pool/context');
  const members = parsePodPool(context);
  const observed = measurePoolLease(members);
  if (observed.members.some((member) => member.running === null || member.pending === null)) throw new Error('pod lease status: incomplete running/pending measurement');
  const pendingJobs = observed.members.flatMap((member) => member.pendingJobs ?? []);
  const records = podPoolHostLease(members).live();
  return {
    running: observed.members.reduce((sum, member) => sum + member.running!, 0),
    pending: observed.members.reduce((sum, member) => sum + member.pending!, 0),
    reserved: hostLeaseCounts(records).reserved + records.filter((row) => row.stage === 'job' && !leaseHasPendingPod(row, pendingJobs)).length,
    limit: members.reduce((sum, member) => sum + member.capacity, 0),
  };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Host inventory includes harness authoring before it has a run ledger. Unattributed processes count for every seat. */
export function readHarnessQueueProcesses(probe: ProcessProbe = {}): readonly QueueProcess[] {
  const run = probe.run ?? spawnSync;
  const platform = probe.platform ?? process.platform;
  const result = run('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') throw new Error('harness process inventory unavailable');
  const candidates: { pid: number; ppid: number; command: string }[] = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) {
      if (/(?:elanous\.mjs|harness-queue-child\.ts)/.test(line)) throw new Error('invalid harness process inventory row');
      continue;
    }
    const command = match[3]!;
    if (!/^(?:\S*\/)?(?:bun|node)(?:\s|$)/.test(command)
      || !/(?:elanous\.mjs|harness-queue-child\.ts)/.test(command)
      || !/(?:\bharness\s+(?:say|ask)\b|\bdev\s+.*(?:--say|--ask|--file|--implement)\b|\bself\s+(?:implement|orchestrate)\b|harness-queue-child\.ts)/.test(command)) continue;
    const pid = Number(match[1]), ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) throw new Error('invalid harness pid');
    candidates.push({ pid, ppid, command });
  }
  const byPid = new Map(candidates.map((row) => [row.pid, row]));
  const children = new Map<number, typeof candidates>();
  for (const candidate of candidates) {
    const siblings = children.get(candidate.ppid) ?? [];
    siblings.push(candidate);
    children.set(candidate.ppid, siblings);
  }
  const trees = probe.seatTrees ?? getUserConfig().loops?.orchestrator?.seatTrees;
  const ledgerSeats = new Map<number, QueueSeat>();
  const ambiguousPids = new Set<number>();
  const candidatePids = new Set(candidates.map(({ pid }) => pid));
  const births = new Map<number, string | undefined>();
  for (const record of listSelfDevRuns(probe.runsDir ?? selfDevRunsDir())) {
    const pid = record.pid;
    if (!pid || !candidatePids.has(pid) || !record.pidStart || !queueSeatNames.some((name) => name === record.seat)) continue;
    if (!births.has(pid)) {
      try { births.set(pid, (probe.birthId ?? ((id: number) => processBirthId(id, platform)))(pid)); }
      catch { births.set(pid, undefined); }
    }
    if (births.get(pid) !== record.pidStart || ambiguousPids.has(pid)) continue;
    const prior = ledgerSeats.get(pid);
    if (prior && prior !== record.seat) { ledgerSeats.delete(pid); ambiguousPids.add(pid); }
    else ledgerSeats.set(pid, record.seat!);
  }
  const rows: QueueProcess[] = [];
  // Attribute a run after grouping: the orchestrator may switch working trees while its launcher stays in HQ.
  for (const root of candidates.filter((row) => !byPid.has(row.ppid))) {
    const members: { process: typeof root; depth: number }[] = [];
    const visit = (process: typeof root, depth: number): void => {
      members.push({ process, depth });
      for (const child of children.get(process.pid) ?? []) visit(child, depth + 1);
    };
    visit(root, 0);
    const attributed: { seat: QueueSeat; depth: number; source: 'env' | 'flag' | 'ledger' | 'cwd'; priority: number }[] = [];
    const worktrees: { seat: QueueSeat; depth: number }[] = [];
    let launchId: string | undefined;
    let runId: string | undefined;
    for (const { process: { pid, command }, depth } of members) {
      let envSeat: string | undefined;
      if (platform === 'linux') {
        try {
          const env = (probe.environ ?? ((id: number) => readFileSync(`/proc/${id}/environ`, 'utf8')))(pid).split('\0');
          envSeat = env.find((entry) => entry.startsWith('ELANOUS_HARNESS_SEAT='))?.slice('ELANOUS_HARNESS_SEAT='.length);
          launchId ??= env.find((entry) => entry.startsWith('ELANOUS_HARNESS_QUEUE_LAUNCH='))?.slice('ELANOUS_HARNESS_QUEUE_LAUNCH='.length);
          runId ??= env.find((entry) => entry.startsWith('ELANOUS_RUN_ID='))?.slice('ELANOUS_RUN_ID='.length);
        } catch { /* Unknown attribution is charged to all seats. */ }
      }
      const flag = /--seat[=\s]+(OP|TC|MK|UX)(?:\s|$)/.exec(command)?.[1] as QueueSeat | undefined;
      const envAssigned = envSeat && /^(OP|TC|MK|UX)$/.test(envSeat) ? envSeat as QueueSeat : undefined;
      if (envAssigned) attributed.push({ seat: envAssigned, depth, source: 'env', priority: 0 });
      if (flag) attributed.push({ seat: flag, depth, source: 'flag', priority: 1 });
      const fromLedger = ledgerSeats.get(pid);
      if (fromLedger) attributed.push({ seat: fromLedger, depth, source: 'ledger', priority: 2 });
      if (!trees || !queueSeatNames.some((s) => trees[s]?.length)) continue;
      try {
        let cwd: string;
        if (probe.cwd) cwd = probe.cwd(pid);
        else if (platform === 'linux') cwd = readlinkSync(`/proc/${pid}/cwd`);
        else {
          const lsof = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 5_000 });
          if (lsof.error || lsof.status !== 0 || typeof lsof.stdout !== 'string') throw new Error('cwd unavailable');
          cwd = lsof.stdout.split('\n').find((line) => line.startsWith('n/'))?.slice(1) ?? '';
        }
        if (!cwd.startsWith('/')) continue;
        const found = queueSeatForCwd(cwd, trees);
        if (found) worktrees.push({ seat: found, depth });
      } catch { /* Unknown attribution is charged to all seats. */ }
    }
    const deepest = Math.max(...members.map((entry) => entry.depth));
    const inferred = new Set(worktrees.filter((entry) => entry.depth === deepest).map((entry) => entry.seat));
    const complete = worktrees.filter((entry) => entry.depth === deepest).length
      === members.filter((entry) => entry.depth === deepest).length;
    if (complete && inferred.size === 1) attributed.push({ seat: [...inferred][0]!, depth: deepest, source: 'cwd', priority: 3 });
    const priority = Math.min(...attributed.map((entry) => entry.priority));
    const eligible = attributed.filter((entry) => entry.priority === priority);
    const depth = Math.max(...eligible.map((entry) => entry.depth));
    const top = eligible.filter((entry) => entry.depth === depth);
    const seats = new Set(top.map((entry) => entry.seat));
    const assigned = seats.size === 1 ? top[0] : undefined;
    try { debug.log('harness.queue', 'attributed', { pid: root.pid, seat: assigned?.seat ?? null, source: assigned?.source ?? 'all' }); }
    catch { /* Observation does not block inventory. */ }
    rows.push({ pid: root.pid, ...(assigned ? { seat: assigned.seat } : {}), ...(launchId ? { launchId } : {}),
      ...(runId ? { runId } : {}) });
  }
  return rows;
}

export function harnessQueueReceiptPath(root: string, launchId: string): string {
  if (!/^hq-[0-9a-f-]{36}$/.test(launchId)) throw new Error('invalid queue launch id');
  return join(root, 'harness', `${launchId}.receipt.json`);
}

function receipt(root: string, launchId: string): 'started' | 'finished' | 'not-started' | null {
  try {
    const record = JSON.parse(readFileSync(harnessQueueReceiptPath(root, launchId), 'utf8')) as { state?: string };
    return record.state === 'started' || record.state === 'finished' || record.state === 'not-started' ? record.state : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function launch(item: QueueItem, args: string[], root: string): Promise<number> {
  const repo = resolve(import.meta.dir, '../..');
  const logPath = join(root, 'harness', `${item.id}.log`);
  const fd = openSync(logPath, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [join(repo, 'src', 'harness', 'harness-queue-child.ts'),
      harnessQueueReceiptPath(root, item.launchId!), join(repo, 'bin', 'elanous.mjs'),
      ...(resolve(root) === prodInstanceRoot() ? [] : [`--test=${root}`]), ...args], {
      cwd: repo, detached: true, stdio: ['ignore', fd, fd],
      env: { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_HARNESS_SEAT: item.seat,
        ELANOUS_HARNESS_QUEUE_LAUNCH: item.launchId! },
    });
    const pid = await new Promise<number>((done, reject) => {
      child.once('spawn', () => done(child.pid!));
      child.once('error', (error) => {
        try { writeHarnessQueueReceipt(harnessQueueReceiptPath(root, item.launchId!), 'not-started'); }
        catch { /* A failed receipt write leaves the reservation safely indeterminate. */ }
        reject(error);
      });
    });
    child.unref();
    return pid;
  } finally { closeSync(fd); }
}

/** Only a wrapper receipt proving no active child can clear an uncertain reservation. */
export async function reconcileHarnessQueue(id: string, deps: HarnessQueueDeps = {}): Promise<'released' | 'running' | 'unknown'> {
  const root = deps.root ?? effectiveInstanceRoot();
  return locked(root, async (path) => {
    const rows = read(path);
    const item = rows.find((row) => row.id === id);
    if (!item || !['launching', 'launched'].includes(item.status) || !item.launchId) return 'unknown';
    const state = (deps.receipt ?? receipt)(root, item.launchId);
    const processes = (deps.processes ?? readHarnessQueueProcesses)();
    if (processes.some((row) => row.launchId === item.launchId)
      || (item.pid !== undefined && (deps.alive ?? alive)(item.pid) && state !== 'finished' && state !== 'not-started')) return 'running';
    if (state !== 'finished' && state !== 'not-started') return 'unknown';
    // A finished receipt proves the child exited; a reused wrapper PID alone is not its identity.
    // Keep completed launches in the ledger, but never charge their seat again.
    const outcome = state === 'not-started' ? 'retryable' : queueRowOutcome(item, root);
    if (item.idempotencyKey && (outcome === 'succeeded' || outcome === 'retryable')) recordQueueOutcome(root, id, outcome, item.idempotencyKey);
    save(path, state === 'finished' && item.status === 'launched'
      ? rows.map((row) => row.id === id ? { ...row, status: 'finished' } : row)
      : rows.filter((row) => row.id !== id));
    observe('skipped', { id, seat: item.seat, reason: `reconciled ${state}`, launchId: item.launchId }, deps);
    return 'released';
  });
}

const warnedLegacySeatCapPaths = new Set<string>();

function warnLegacySeatCap(path: string): void {
  if (warnedLegacySeatCapPaths.has(path)) return;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const harness = (raw as Record<string, unknown>).harness;
    if (!harness || typeof harness !== 'object' || Array.isArray(harness)) return;
    const queue = (harness as Record<string, unknown>).queue;
    if (!queue || typeof queue !== 'object' || Array.isArray(queue)
      || !Object.hasOwn(queue, 'seatCap')) return;
    warnedLegacySeatCapPaths.add(path);
    debug.log('harness.queue', 'legacy-seat-cap-ignored', {
      key: 'harness.queue.seatCap', replacement: 'loops.orchestrator.seatCaps', path,
    }, { level: 'warn' });
  } catch { /* An unreadable config cannot affect dispatch or observation. */ }
}

function groupQueueRuns(processes: readonly QueueProcess[]): { seat?: QueueSeat; launchIds: Set<string> }[] {
  const groups: { seats: Set<QueueSeat>; unknown: boolean; launchIds: Set<string>; keys: Set<string> }[] = [];
  for (const row of processes) {
    const keys = [row.runId && `run:${row.runId}`, `root:${row.rootPid ?? row.pid}`,
      row.launchId && `launch:${row.launchId}`, `pid:${row.pid}`].filter((key): key is string => Boolean(key));
    const matching = groups.filter((group) => keys.some((key) => group.keys.has(key)));
    const group = matching[0] ?? { seats: new Set<QueueSeat>(), unknown: false,
      launchIds: new Set<string>(), keys: new Set<string>() };
    for (const other of matching.slice(1)) {
      for (const key of other.keys) group.keys.add(key);
      for (const seat of other.seats) group.seats.add(seat);
      for (const id of other.launchIds) group.launchIds.add(id);
      group.unknown ||= other.unknown;
      groups.splice(groups.indexOf(other), 1);
    }
    for (const key of keys) group.keys.add(key);
    if (row.seat) group.seats.add(row.seat);
    else group.unknown = true;
    if (row.launchId) group.launchIds.add(row.launchId);
    if (!matching.length) groups.push(group);
  }
  return groups.map((group) => ({
    ...(group.unknown || group.seats.size !== 1 ? {} : { seat: [...group.seats][0] }),
    launchIds: group.launchIds,
  }));
}

const IDLE_REQUEST_INTERVAL_MS = 15 * 60_000;
const IDLE_REQUEST_MINUTES = 30;
type IdleRequestState = { checkedAt: string; idleSince: Partial<Record<QueueSeat, string>>; notified?: string[] };

function idleRequestCells(now: Date, root: string): ReturnType<NonNullable<HarnessQueueDeps['idleCells']>> {
  const ledger = root === effectiveInstanceRoot() ? releaseLedgerRoot() : root;
  if (!existsSync(join(ledger, 'release', 'features.sqlite'))) throw new Error('release checklist ledger unavailable');
  const upcoming = listSchedules(ledger).filter(row => Date.parse(row.cutAt) > now.getTime())
    .sort((a, b) => Date.parse(a.cutAt) - Date.parse(b.cutAt));
  if (!upcoming[0]) throw new Error('current release schedule unavailable');
  return { current: listChecklist(upcoming[0].version, ledger).items,
    next: upcoming[1] ? listChecklist(upcoming[1].version, ledger).items : [] };
}

function hasRunEvidence(cell: Pick<ChecklistItem, 'evidence'>): boolean {
  return /(?:\brun[-_][a-z0-9-]+\b|\b(?:런|run)(?:\s*(?:근거|id|ID))?\s*[:：#]\s*\S+)/i.test(cell.evidence ?? '');
}

/** The queue lock serializes the observation marker; request journal lock also covers external traffic writers. */
export function requestIdleSeats(root: string, now: Date, items: readonly QueueItem[], deps: HarnessQueueDeps = {}): void {
  const config: OrchestratorLoopConfig | undefined = (deps.configPath ? getUserConfig(deps.configPath) : getUserConfig()).loops?.orchestrator;
  const mode = config?.idleRequest ?? 'shadow';
  if (mode === 'off') return;
  if (!Number.isFinite(now.getTime())) throw new Error('invalid idle request clock');
  const marker = join(root, 'orchestrator', 'idle-request.json');
  const previous: IdleRequestState = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) as IdleRequestState
    : { checkedAt: new Date(now.getTime() - IDLE_REQUEST_INTERVAL_MS).toISOString(), idleSince: {} };
  if (!previous || typeof previous !== 'object' || !previous.idleSince || typeof previous.idleSince !== 'object'
    || !Number.isFinite(Date.parse(previous.checkedAt)) || (previous.notified !== undefined
      && (!Array.isArray(previous.notified) || previous.notified.some(key => typeof key !== 'string')))
    || Object.entries(previous.idleSince).some(([seat, value]) =>
      !TRAFFIC_SEATS.some(name => name === seat) || typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) {
    throw new Error('invalid idle request marker');
  }
  const processes = (deps.processes ?? readHarnessQueueProcesses)();
  const groups = groupQueueRuns(processes);
  const reservations = items.filter(item => item.status === 'launching' || item.status === 'launched').filter(item => {
    if (item.launchId && groups.some(group => group.launchIds.has(item.launchId!))) return false;
    const state = item.launchId ? (deps.receipt ?? receipt)(root, item.launchId) : null;
    return state !== 'finished' && state !== 'not-started';
  });
  const counts = Object.fromEntries(TRAFFIC_SEATS.map(seat => [seat,
    groups.filter(group => !group.seat || group.seat === seat).length
      + reservations.filter(item => item.seat === seat).length])) as Record<QueueSeat, number>;
  const idleSince = { ...previous.idleSince };
  for (const seat of TRAFFIC_SEATS) {
    if (counts[seat] > 0) delete idleSince[seat];
    else if (!idleSince[seat]) idleSince[seat] = now.toISOString();
  }
  const due = now.getTime() - Date.parse(previous.checkedAt) >= IDLE_REQUEST_INTERVAL_MS;
  if (!due && Object.keys(idleSince).length === Object.keys(previous.idleSince).length) return;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const state: IdleRequestState = { checkedAt: due ? now.toISOString() : previous.checkedAt, idleSince,
    notified: (previous.notified ?? []).filter(key => key.startsWith('orch-idle:') && key.split(':')[2] === day) };
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  const temporary = `${marker}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, marker);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* no temporary file */ }
    throw error;
  }
  if (!due) return;
  const cells = (deps.idleCells ?? ((clock: Date) => idleRequestCells(clock, root)))(now);
  const eligible = (rows: typeof cells.current, seat: QueueSeat) => rows.filter(cell =>
    cell.owner?.split('/')[0] === seat && cell.status === 'yellow' && !hasRunEvidence(cell));
  const candidates: TrafficCell[] = TRAFFIC_SEATS.flatMap(seat => {
    const current = eligible(cells.current, seat);
    return (current.length ? current : eligible(cells.next, seat)).slice(0, 1);
  });
  const measured = trafficTick({ now, processes: TRAFFIC_SEATS.flatMap(seat => Array.from({ length: counts[seat] }, () =>
    ({ seat, command: 'bun bin/elanous.mjs harness say observed', elapsedSeconds: 0 }))),
    caps: config?.seatCaps ?? { OP: 4, TC: 8, MK: 6, UX: 6 }, idleSince: Object.fromEntries(TRAFFIC_SEATS.map(seat =>
      [seat, idleSince[seat] ? new Date(idleSince[seat]) : null])), openCells: candidates, idleMinutes: IDLE_REQUEST_MINUTES });
  const log = deps.idleLog ?? ((category: string, event: string, data: Record<string, unknown>) => debug.log(category, event, data));
  for (const row of measured.seats) {
    if (!row.idle || row.running !== 0) continue;
    const cell = row.nextCell ? `${row.nextCell.id} ${row.nextCell.title.replace(/\s+/g, ' ').trim()}` : '칸 없음';
    let outcome: 'shadow' | 'queued' | 'duplicate' | 'no-cell' = mode === 'live' ? 'no-cell' : 'shadow';
    const key = `orch-idle:${row.seat}:${day}:${row.nextCell?.id ?? 'no-cell'}`;
    if (state.notified!.includes(key)) continue;
    if (mode === 'live' && row.nextCell) {
      const path = join(root, 'seat-requests', 'requests.jsonl');
      mkdirSync(join(root, 'seat-requests'), { recursive: true });
      outcome = withFileLockSync(`${path}.lock`, () => {
        if (existsSync(path) && readFileSync(path, 'utf8').split('\n').some(line => {
          if (!line) return false;
          try { return (JSON.parse(line) as { key?: string }).key === key; }
          catch { throw new Error('invalid seat request journal'); }
        })) return 'duplicate';
        appendFileSync(path, JSON.stringify({ key, receiptId: key, seat: row.seat,
          text: `다음 칸: ${cell} — 30분 놀았다`, status: 'queued', queuedAt: now.toISOString(), source: 'orchestrator-idle' }) + '\n');
        return 'queued';
      });
    }
    if (outcome !== 'duplicate') {
      state.notified!.push(key);
      try { log('loop.orchestrator', 'idle-requested', {
        seat: row.seat, idleMinutes: IDLE_REQUEST_MINUTES, cell, mode, outcome }); }
      catch { /* Observation cannot change the request or queue decision. */ }
    }
  }
  try {
    writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, marker);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* no temporary file */ }
    throw error;
  }
}

export async function tickHarnessQueue(deps: HarnessQueueDeps = {}): Promise<QueueTick> {
  const root = deps.root ?? effectiveInstanceRoot();
  return locked(root, async (path) => {
    try {
      const now = (deps.now ?? (() => new Date()))();
      // A test process must not run the real author shadow — it reads operational ledgers and blew the 5s test budget (10-05 P0).
      if (!deps.authorShadow && process.env.ELANOUS_AUTHOR_SHADOW_LIVE !== '1' && (process.env.NODE_ENV === 'test' || process.env.ELANOUS_TEST_HOME)) {
        debug.log('loops.author-depth', 'shadow-skipped-test', {});
      } else {
        const shadow = deps.authorShadow ?? (await import('../loops/orchestrator/author-depth.js')).runAuthorDepthShadow;
        await shadow(root, now);
      }
    } catch (error) {
      try { debug.log('loops.author-depth', 'shadow-failed', { reason: String(error) }); }
      catch { /* Shadow observation cannot affect queue dispatch. */ }
    }
    const items = read(path);
    try { await (deps.idleRequest ?? requestIdleSeats)(root, (deps.now ?? (() => new Date()))(), items, deps); }
    catch (error) {
      try { debug.log('loop.orchestrator', 'idle-request-failed', { reason: String(error) }); }
      catch { /* Idle observation cannot affect queue dispatch. */ }
    }
    const heads = new Map<QueueSeat, QueueItem>();
    for (const row of items) if (row.status === 'queued' && !heads.has(row.seat)) heads.set(row.seat, row);
    if (!heads.size) { observe('skipped', { reason: 'empty' }, deps); return { outcome: 'skipped', reason: 'empty' }; }
    const lastSeat = lastLaunchedSeat(path);
    const first = lastSeat ? (queueSeatNames.indexOf(lastSeat) + 1) % queueSeatNames.length
      : queueSeatNames.indexOf(items.find((row) => row.status === 'queued')!.seat);
    const candidates = [...queueSeatNames.slice(first), ...queueSeatNames.slice(0, first)]
      .flatMap((name) => heads.get(name) ? [heads.get(name)!] : []);
    const config = deps.configPath === undefined ? getUserConfig() : getUserConfig(deps.configPath);
    warnLegacySeatCap(deps.configPath ?? userConfigPath());
    const caps = config.loops?.orchestrator?.seatCaps;
    const gate = config.loops?.orchestrator?.releaseGate;
    const attributed: Record<QueueSeat, number> = { OP: 0, TC: 0, MK: 0, UX: 0 };
    let unattributed = 0;
    const blocked = new Map<QueueSeat, { reason: string; active: number }>();
    const waiting = (): QueueTick => {
      const reason = candidates.map((item) => blocked.get(item.seat)!.reason).join('\n');
      const updated = current.map((row) => {
        const block = blocked.get(row.seat);
        return heads.get(row.seat)?.id === row.id && block && row.waitingReason !== block.reason
          ? { ...row, waitingReason: block.reason } : row;
      });
      if (updated.some((row, index) => row !== current[index])) save(path, updated);
      for (const item of candidates) {
        const { reason: seatReason, active } = blocked.get(item.seat)!;
        const injectedCap = deps.cap?.(item.seat);
        const details = seatCapDetails({ seat: item.seat, caps, gate, injectedCap });
        observe('waiting', { id: item.id, seat: item.seat, reason: seatReason, active, cap: details.cap,
          seatCaps: details.seatCaps, releaseGate: details.releaseGate,
          ...(details.injectedCap === undefined ? {} : { injectedCap: details.injectedCap }), capKeys: details.winners,
          attributed, unattributed }, deps);
      }
      return { outcome: 'waiting', item: { ...candidates[0]!, waitingReason: blocked.get(candidates[0]!.seat)!.reason }, reason };
    };
    for (const item of candidates) {
      const injectedCap = deps.cap?.(item.seat);
      if (injectedCap !== undefined && (!Number.isSafeInteger(injectedCap) || injectedCap < 0)) throw new Error(`harness queue: invalid seat cap for ${item.seat}`);
    }
    let current = items;
    let processes: readonly QueueProcess[];
    try { processes = (deps.processes ?? readHarnessQueueProcesses)(); }
    catch (error) {
      for (const item of candidates) {
        const injectedCap = deps.cap?.(item.seat);
        const budget = decideSpawn({ seat: item.seat, running: null, caps, gate, injectedCap });
        blocked.set(item.seat, { reason: `${budget.reason}: harness process inventory unavailable: ${String(error)}`, active: 0 });
      }
      return waiting();
    }
    const runs = groupQueueRuns(processes);
    for (const run of runs) {
      if (run.seat) attributed[run.seat]++;
      else unattributed++;
    }
    current = items.flatMap((row) => {
      if ((row.status !== 'launched' && row.status !== 'launching') || !row.launchId) return [row];
      const state = (deps.receipt ?? receipt)(root, row.launchId);
      if (state !== 'finished' && state !== 'not-started'
        || processes.some((process) => process.launchId === row.launchId)) return [row];
      if (state === 'finished' && row.status === 'launched') return [{ ...row, status: 'finished' as const }];
      const outcome = state === 'not-started' ? 'retryable' : queueRowOutcome(row, root);
      if (row.idempotencyKey && (outcome === 'succeeded' || outcome === 'retryable')) recordQueueOutcome(root, row.id, outcome, row.idempotencyKey);
      return [];
    });
    if (current.length !== items.length || current.some((row, index) => row !== items[index])) save(path, current);
    let pool: QueuePool | undefined;
    let poolReason: string | undefined;
    let finishHeld: string | null | undefined;
    for (const item of candidates) {
      const injectedCap = deps.cap?.(item.seat);
      const details = seatCapDetails({ seat: item.seat, caps, gate, injectedCap });
      const charged = runs.filter((run) => !run.seat || run.seat === item.seat);
      const launchIds = new Set(charged.flatMap((run) => [...run.launchIds]));
      const active = charged.length + current.filter((row) => row.seat === item.seat &&
        (row.status === 'launching' || row.status === 'launched')
        && (!row.launchId || !launchIds.has(row.launchId))).length;
      if (active >= details.cap) { blocked.set(item.seat, { reason: seatCapReason(item.seat, active, details), active }); continue; }
      if (!pool && !poolReason) {
        try { pool = (deps.pool ?? readHarnessQueuePool)(); }
        catch (error) { poolReason = `pod lease status unavailable: ${String(error)}`; }
        if (pool && (![pool.running, pool.pending, pool.reserved, pool.limit].every((n) => Number.isSafeInteger(n) && n >= 0) || pool.limit < 1)) {
          poolReason = 'pod lease status incomplete';
        }
        if (pool && !poolReason) {
          const queueLaunching = current.filter((row) => row.status === 'launching' || row.status === 'launched').length;
          if (pool.running + pool.pending + pool.reserved + queueLaunching >= pool.limit) {
            poolReason = `pool: ${pool.running}+${pool.pending}+${pool.reserved}+${queueLaunching}/${pool.limit}`;
          }
        }
      }
      if (poolReason) { blocked.set(item.seat, { reason: poolReason, active }); continue; }
      const budget = decideSpawn({ seat: item.seat, running: active, caps, gate, injectedCap });
      if (!budget.allow) {
        blocked.set(item.seat, { reason: `${budget.reason}: ${seatCapReason(item.seat, active, details)}`, active });
        continue;
      }
      if (finishHeld === undefined) {
        finishHeld = await finishGateReason(root, (deps.now ?? (() => new Date()))(), config.loops?.orchestrator?.finishGate ?? 'shadow',
          pool!.running + pool!.pending + pool!.reserved
          + current.filter((row) => row.status === 'launching' || row.status === 'launched').length, pool!.limit, deps);
      }
      if (finishHeld) { blocked.set(item.seat, { reason: finishHeld, active }); continue; }
      const launching: QueueItem = { ...item, status: 'launching', launchId: `hq-${randomUUID()}` };
      delete launching.waitingReason;
      save(path, current.map((row) => row.id === item.id ? launching : row));
      try {
        const pid = await (deps.launch ?? launch)(launching, queueLaunchArgs(launching), root);
        if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('launcher returned no pid');
        const launched: QueueItem = { ...launching, pid, status: 'launched' };
        save(path, current.map((row) => row.id === item.id ? launched : row));
        try { saveLastLaunchedSeat(path, item.seat); }
        catch (error) {
          try { debug.log('harness.queue', 'round-robin-save-failed', { id: item.id, seat: item.seat, reason: String(error) }, { level: 'warn' }); }
          catch { /* Observation cannot change an already persisted launch. */ }
        }
        observe('launched', { id: item.id, seat: item.seat, pid, kind: item.kind, launchId: launched.launchId }, deps);
        return { outcome: 'launched', item: launched, reason: 'spawned' };
      } catch (error) {
        observe('skipped', { id: item.id, seat: item.seat, reason: `launch uncertain: ${String(error)}`, launchId: launching.launchId }, deps);
        throw error;
      }
    }
    return waiting();
  });
}
