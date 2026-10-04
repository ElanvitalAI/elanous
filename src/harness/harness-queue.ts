import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';
import { decideSpawn } from '../loops/budget.js';
import { listSelfDevRuns, processBirthId, selfDevRunsDir } from '../self-dev/run-store.js';
import { getUserConfig } from '../user-config.js';
import { hostLeaseCounts, leaseHasPendingPod } from '../pod-lease/host-lease.js';
import { leaseKubectl, measurePoolLease } from '../task-orchestrator/surfaces/pod-lease.js';
import { parsePodPool, podPoolHostLease, resolvePodPoolSpec } from '../task-orchestrator/surfaces/pod-pool.js';
import { writeHarnessQueueReceipt } from './harness-queue-child.js';

export type QueueSeat = 'OP' | 'TC' | 'MK' | 'UX';
export type QueueItem = {
  id: string; seat: QueueSeat; kind: 'say' | 'ask'; input: string; hold: boolean; heavy: boolean;
  at: string; status: 'queued' | 'launching' | 'launched' | 'finished'; pid?: number; launchId?: string; idempotencyKey?: string;
};
export type QueuePool = { running: number; pending: number; reserved: number; limit: number };
export type QueueTick = { outcome: 'launched' | 'waiting' | 'skipped'; item?: QueueItem; reason: string };
export type QueueProcess = { pid: number; seat?: QueueSeat; launchId?: string };
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
  log?: (event: 'enqueued' | 'launched' | 'waiting' | 'skipped', data: Record<string, unknown>) => void;
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
    && (row.idempotencyKey === undefined || typeof row.idempotencyKey === 'string'))) {
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
    for (const { process: { pid, command }, depth } of members) {
      let envSeat: string | undefined;
      if (platform === 'linux') {
        try {
          const env = (probe.environ ?? ((id: number) => readFileSync(`/proc/${id}/environ`, 'utf8')))(pid).split('\0');
          envSeat = env.find((entry) => entry.startsWith('ELANOUS_HARNESS_SEAT='))?.slice('ELANOUS_HARNESS_SEAT='.length);
          launchId ??= env.find((entry) => entry.startsWith('ELANOUS_HARNESS_QUEUE_LAUNCH='))?.slice('ELANOUS_HARNESS_QUEUE_LAUNCH='.length);
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
    rows.push({ pid: root.pid, ...(assigned ? { seat: assigned.seat } : {}), ...(launchId ? { launchId } : {}) });
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

export async function tickHarnessQueue(deps: HarnessQueueDeps = {}): Promise<QueueTick> {
  const root = deps.root ?? effectiveInstanceRoot();
  return locked(root, async (path) => {
    const items = read(path);
    const item = items.find((row) => row.status === 'queued');
    if (!item) { observe('skipped', { reason: 'empty' }, deps); return { outcome: 'skipped', reason: 'empty' }; }
    const config = deps.configPath === undefined ? getUserConfig() : getUserConfig(deps.configPath);
    const cap = (deps.cap ?? ((s: QueueSeat) => config.harness?.queue?.seatCap?.[s] ?? 8))(item.seat);
    if (!Number.isSafeInteger(cap) || cap < 1) throw new Error(`harness queue: invalid seat cap for ${item.seat}`);
    const caps = config.loops?.orchestrator?.seatCaps;
    const gate = config.loops?.orchestrator?.releaseGate;
    const attributed: Record<QueueSeat, number> = { OP: 0, TC: 0, MK: 0, UX: 0 };
    let unattributed = 0;
    const wait = (reason: string, active: number): QueueTick => {
      observe('waiting', { id: item.id, seat: item.seat, reason, active, cap, attributed, unattributed }, deps);
      return { outcome: 'waiting', item, reason };
    };
    let processes: readonly QueueProcess[];
    try { processes = (deps.processes ?? readHarnessQueueProcesses)(); }
    catch (error) {
      const budget = decideSpawn({ seat: item.seat, running: null, caps, gate });
      return wait(`${budget.reason}: harness process inventory unavailable: ${String(error)}`, 0);
    }
    for (const row of processes) {
      if (row.seat) attributed[row.seat]++;
      else unattributed++;
    }
    const current = items.flatMap((row) => {
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
    const charged = processes.filter((row) => !row.seat || row.seat === item.seat);
    const launchIds = new Set(charged.map((row) => row.launchId));
    const active = new Set(charged.map((row) => row.launchId ?? `pid:${row.pid}`)).size + current.filter((row) => row.seat === item.seat &&
      (row.status === 'launching' || row.status === 'launched')
      && (!row.launchId || !launchIds.has(row.launchId))).length;
    if (active >= cap) return wait(`seat ${item.seat}: ${active}/${cap}`, active);
    let pool: QueuePool;
    try { pool = (deps.pool ?? readHarnessQueuePool)(); }
    catch (error) { return wait(`pod lease status unavailable: ${String(error)}`, active); }
    if (![pool.running, pool.pending, pool.reserved, pool.limit].every((n) => Number.isSafeInteger(n) && n >= 0) || pool.limit < 1) {
      return wait('pod lease status incomplete', active);
    }
    const queueLaunching = current.filter((row) => row.status === 'launching' || row.status === 'launched').length;
    if (pool.running + pool.pending + pool.reserved + queueLaunching >= pool.limit) {
      return wait(`pool: ${pool.running}+${pool.pending}+${pool.reserved}+${queueLaunching}/${pool.limit}`, active);
    }
    const budget = decideSpawn({ seat: item.seat, running: active, caps, gate });
    if (!budget.allow) return wait(`${budget.reason}: seat ${item.seat}: ${active}/${budget.cap}`, active);
    const launching: QueueItem = { ...item, status: 'launching', launchId: `hq-${randomUUID()}` };
    save(path, current.map((row) => row.id === item.id ? launching : row));
    try {
      const pid = await (deps.launch ?? launch)(launching, queueLaunchArgs(launching), root);
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('launcher returned no pid');
      const launched: QueueItem = { ...launching, pid, status: 'launched' };
      save(path, current.map((row) => row.id === item.id ? launched : row));
      observe('launched', { id: item.id, seat: item.seat, pid, kind: item.kind, launchId: launched.launchId }, deps);
      return { outcome: 'launched', item: launched, reason: 'spawned' };
    } catch (error) {
      observe('skipped', { id: item.id, seat: item.seat, reason: `launch uncertain: ${String(error)}`, launchId: launching.launchId }, deps);
      throw error;
    }
  });
}
