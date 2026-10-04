import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';
import { getUserConfig } from '../user-config.js';
import { hostLeaseCounts, leaseHasPendingPod } from '../pod-lease/host-lease.js';
import { leaseKubectl, measurePoolLease } from '../task-orchestrator/surfaces/pod-lease.js';
import { parsePodPool, podPoolHostLease, resolvePodPoolSpec } from '../task-orchestrator/surfaces/pod-pool.js';
import { writeHarnessQueueReceipt } from './harness-queue-child.js';

export type QueueSeat = 'OP' | 'TC' | 'MK' | 'UX';
export type QueueItem = {
  id: string; seat: QueueSeat; kind: 'say' | 'ask'; input: string; hold: boolean; heavy: boolean;
  at: string; status: 'queued' | 'launching' | 'launched' | 'finished'; pid?: number; launchId?: string;
};
export type QueuePool = { running: number; pending: number; reserved: number; limit: number };
export type QueueTick = { outcome: 'launched' | 'waiting' | 'skipped'; item?: QueueItem; reason: string };
export type QueueProcess = { pid: number; seat?: QueueSeat; launchId?: string };

export interface HarnessQueueDeps {
  root?: string;
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
    && (row.launchId === undefined || typeof row.launchId === 'string'))) {
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

export async function addHarnessQueue(input: { seat: string; say?: string; ask?: string; hold?: boolean; heavy?: boolean }, deps: HarnessQueueDeps = {}): Promise<QueueItem> {
  const assigned = seat(input.seat);
  if ((input.say === undefined) === (input.ask === undefined)) throw new Error('harness queue add: --say 또는 --ask 중 하나만 필요');
  const kind = input.ask === undefined ? 'say' : 'ask';
  const text = kind === 'say' ? input.say! : input.ask!;
  if (!text.trim()) throw new Error('harness queue add: 빈 입력');
  const value = kind === 'ask' ? resolve(text) : text;
  if (kind === 'ask' && !existsSync(value)) throw new Error(`harness queue add: goal file not found: ${value}`);
  const root = deps.root ?? effectiveInstanceRoot();
  return locked(root, async (path) => {
    const item: QueueItem = { id: `hq-${randomUUID()}`, seat: assigned, kind, input: value,
      hold: input.hold === true, heavy: input.heavy === true, at: new Date().toISOString(), status: 'queued' };
    save(path, [...read(path), item]);
    observe('enqueued', { id: item.id, seat: item.seat, kind }, deps);
    return item;
  });
}

export function listHarnessQueue(deps: HarnessQueueDeps = {}): QueueItem[] {
  return read(harnessQueuePath(deps.root ?? effectiveInstanceRoot()));
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
export function readHarnessQueueProcesses(): readonly QueueProcess[] {
  const result = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') throw new Error('harness process inventory unavailable');
  const rows: QueueProcess[] = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const command = match[2]!;
    if (!/^(?:\S*\/)?(?:bun|node)(?:\s|$)/.test(command)
      || !/(?:elanous\.mjs|harness-queue-child\.ts)/.test(command)
      || !/(?:\bharness\s+(?:say|ask)\b|\bdev\s+.*(?:--say|--ask|--file|--implement)\b|\bself\s+(?:implement|orchestrate)\b|harness-queue-child\.ts)/.test(command)) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid harness pid');
    let envSeat: string | undefined;
    let envLaunch: string | undefined;
    if (process.platform === 'linux') {
      try {
        const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
        envSeat = env.find((entry) => entry.startsWith('ELANOUS_HARNESS_SEAT='))?.slice('ELANOUS_HARNESS_SEAT='.length);
        envLaunch = env.find((entry) => entry.startsWith('ELANOUS_HARNESS_QUEUE_LAUNCH='))?.slice('ELANOUS_HARNESS_QUEUE_LAUNCH='.length);
      } catch { /* Unknown attribution is charged to all seats. */ }
    }
    const assigned = envSeat ?? /--seat[=\s]+(OP|TC|MK|UX)(?:\s|$)/.exec(command)?.[1];
    rows.push({ pid, ...(assigned && /^(OP|TC|MK|UX)$/.test(assigned) ? { seat: assigned as QueueSeat } : {}),
      ...(envLaunch ? { launchId: envLaunch } : {}) });
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
    const cap = (deps.cap ?? ((s: QueueSeat) => getUserConfig().harness?.queue?.seatCap?.[s] ?? 8))(item.seat);
    if (!Number.isSafeInteger(cap) || cap < 1) throw new Error(`harness queue: invalid seat cap for ${item.seat}`);
    const wait = (reason: string, active: number): QueueTick => {
      observe('waiting', { id: item.id, seat: item.seat, reason, active, cap }, deps);
      return { outcome: 'waiting', item, reason };
    };
    let processes: readonly QueueProcess[];
    try { processes = (deps.processes ?? readHarnessQueueProcesses)(); }
    catch (error) { return wait(`harness process inventory unavailable: ${String(error)}`, 0); }
    const current = items.flatMap((row) => {
      if ((row.status !== 'launched' && row.status !== 'launching') || !row.launchId) return [row];
      const state = (deps.receipt ?? receipt)(root, row.launchId);
      if (state !== 'finished' && state !== 'not-started'
        || processes.some((process) => process.launchId === row.launchId)) return [row];
      return state === 'finished' && row.status === 'launched' ? [{ ...row, status: 'finished' as const }] : [];
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
