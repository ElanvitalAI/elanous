import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { debug } from '../debug/log.js';
import { stateDirSourceForChild } from '../agent/identity-env.js';
import { findTreeRoot } from '../cli/test-flag.js';
import { readLogInstances, type LogInstanceView } from '../mss/logging/instance-registry.js';
import { effectiveInstanceRoot, prodInstanceRoot, releaseLedgerRoot } from '../instance/resolve.js';
import { listChecklist, type ChecklistItem } from '../release-loop/checklist.js';
import { readLandingFreeze } from '../release-loop/landing-freeze.js';
import { listSchedules } from '../release-loop/release-schedule.js';
import { parseRubric, readRubricItems, rubricScore } from '../release-loop/rubric.js';
import { withFileLockSync } from '../storage/file-lock.js';
import { trafficTick, TRAFFIC_SEATS, type TrafficCell } from '../loops/orchestrator/traffic.js';
import { decideSpawn, SEAT_CAP_STALE_RUN_MINUTES, SEAT_CAP_UNKNOWN_SEAT_CAP, seatCapDetails, seatCapExclusion, seatCapReason } from '../loops/budget.js';
import { listSelfDevRuns, processBirthId, selfDevRunsDir } from '../self-dev/run-store.js';
import { getUserConfig, userConfigPath, type OrchestratorLoopConfig } from '../user-config.js';
import { hostLeaseCounts, leaseHasPendingPod } from '../pod-lease/host-lease.js';
import { leaseKubectl, measurePoolLease } from '../task-orchestrator/surfaces/pod-lease.js';
import { parsePodPool, podPoolHostLease, resolvePodPoolSpec } from '../task-orchestrator/surfaces/pod-pool.js';
import { writeHarnessQueueReceipt } from './harness-queue-child.js';
import { adviseLaunch, compareLaunchAdvice, type LaunchAdvice } from './launch-advice.js';
import { finishAdvice, measureFinish, recordFinishHistory, type FinishMetrics } from '../loops/orchestrator/finish-rate.js';

export type QueueSeat = 'OP' | 'TC' | 'MK' | 'UX';
export type QueueItem = {
  id: string; seat: QueueSeat; kind: 'say' | 'ask'; input: string; hold: boolean; heavy: boolean;
  at: string; status: 'queued' | 'launching' | 'launched' | 'finished'; pid?: number; launchId?: string; idempotencyKey?: string; waitingReason?: string;
  launchArgs?: string[]; poolHint?: string; /** 힌트를 넣은 쪽 — 'grid' 면 GRID 가 소유(그것만 GRID 가 바꾸거나 지운다). */ poolHintSource?: 'grid'; launchCwd?: string; cellId?: string;
  /** TASK-QUEUE: larger launches first within a seat; a row without it ranks below every prioritized row (FIFO among equals). */
  priority?: number;
};
export type QueuePool = { running: number; pending: number; reserved: number; limit: number };
export type QueueTick = { outcome: 'launched' | 'waiting' | 'skipped'; item?: QueueItem; reason: string;
  /** QUEUE-BURST: every row this tick launched, first one = `item` (present only on a scheduled tick that launched). */ launched?: QueueItem[] };
/** progressAt = newest run-ledger updatedAt among the tree's members; stopReason = the ledger's supervisor stop (SEAT-CAP-STALE).
 *  ledgerRunIds = run ids of the members' ledger records — the `elanous.run` label of their Pod Jobs (SEAT-CAP-STALE2). */
export type QueueProcess = { pid: number; seat?: QueueSeat; launchId?: string; runId?: string; rootPid?: number;
  progressAt?: number; stopReason?: string; ledgerRunIds?: string[];
  /** CHILD-UNIV-COUNT: present only when a member's ledger record lives in a derived child universe (not the parent's). */
  universe?: 'child' };
/** CHILD-UNIV-COUNT: the host inventory plus which derived child universes it read. `unreadable` roots are «못 읽음» —
 *  their runs may hold a seat but cannot be attributed, so the count is not trusted as complete. */
export type QueueInventory = { processes: readonly QueueProcess[]; childUniverses: { roots: readonly string[]; unreadable: readonly string[] } };
type ProcessProbe = {
  run?: typeof spawnSync; platform?: NodeJS.Platform;
  cwd?: (pid: number) => string;
  seatTrees?: Partial<Record<QueueSeat, string[]>>;
  runsDir?: string;
  environ?: (pid: number) => string;
  birthId?: (pid: number) => string | undefined;
  /** CHILD-UNIV-COUNT: derived child universe roots whose self-dev ledgers are read with the parent's. Default:
   *  `harnessQueueChildUniverseRoots` (never in a test process). */
  childUniverseRoots?: () => readonly string[];
  /** Extra launch trees (queue rows' launchCwd) whose derived universes the default enumeration includes. */
  launchTrees?: readonly string[];
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
  /** Shadow-only advice seam; exceptions must not affect the queue decision. */
  advice?: typeof adviseLaunch;
  launch?: (item: QueueItem, args: string[], root: string) => Promise<number>;
  /** Test seam: runs after a direct CLI call enqueued its row and before that call's own tick (race tests). */
  afterEnqueue?: (item: QueueItem) => void | Promise<void>;
  /** Script the default launcher runs under the queue child wrapper (default bin/elanous.mjs). */
  launchCommand?: string;
  /** QUEUE-BURST: most launches one scheduled tick makes. Absent = `harness.queue.burstMax`, else 5. A requested (direct) tick always launches at most one. */
  burstMax?: number;
  /** QUEUE-BURST: least gap between two queue launches, across ticks and processes (default 30 s — simultaneous Pod launches died in a chain). */
  launchStaggerMs?: number;
  /** Test seam: the wait between burst launches (default Bun.sleep). */
  sleep?: (ms: number) => Promise<void>;
  alive?: (pid: number) => boolean;
  processes?: () => readonly QueueProcess[];
  /** CHILD-UNIV-COUNT: inventory with child-universe coverage; wins over `processes`. A `processes`-only seam reads no
   *  child universe, so its limit line stays parent-only. */
  inventory?: (launchTrees: readonly string[]) => QueueInventory;
  /** Production freeze root a tick also honors (a work-tree launch ticks in its test universe). Default: prodInstanceRoot(),
   *  except in a test process where it is the tick's own root. */
  prodFreezeRoot?: string;
  /** CHILD-UNIV-HOLD: ops-health alert for a universe unreadable over an hour (default: sendOutbound 'ops-health'; none in
   *  a test process). */
  unreadableAlert?: (text: string) => void | Promise<void>;
  receipt?: (root: string, launchId: string) => 'started' | 'finished' | 'not-started' | null;
  now?: () => Date;
  authorShadow?: (root: string, now: Date) => void | Promise<void>;
  idleRequest?: (root: string, now: Date, items: readonly QueueItem[], deps: HarnessQueueDeps) => void | Promise<void>;
  idleCells?: (now: Date) => { current: readonly Pick<ChecklistItem, 'id' | 'title' | 'owner' | 'status' | 'evidence'>[];
    next: readonly Pick<ChecklistItem, 'id' | 'title' | 'owner' | 'status' | 'evidence'>[] };
  idleLog?: (category: string, event: string, data: Record<string, unknown>) => void;
  log?: (event: 'enqueued' | 'launched' | 'waiting' | 'skipped', data: Record<string, unknown>) => void;
  /** TASK-QUEUE seam: default priority for a cell at enqueue (default: rubric score of that cell in an unreleased schedule). */
  cellPriority?: (cellId: string, root: string, now: Date) => number | undefined;
  /** FINISH-RATE metrics source; a test process without it skips the real measurement. */
  finishMetrics?: (now: Date) => FinishMetrics | Promise<FinishMetrics>;
  /** SEAT-CAP-STALE2: run ids with an unfinished Pod Job (running or pending); throws when unreadable. A test process without
   *  it sees no Pod work (never a real kubectl). */
  podRuns?: () => ReadonlySet<string>;
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
  // 새로 잰 뒤에만 시간별 이력 한 줄(캐시 적중 틱은 안 쓴다) — 실패해도 발사 판정은 그대로다.
  try { recordFinishHistory(root, metrics, now); }
  catch (error) {
    try { debug.log('loop.orchestrator', 'finish-history-write-failed', { reason: String(error) }); } catch { /* observation is fail-soft */ }
  }
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
    && (row.launchArgs === undefined || Array.isArray(row.launchArgs) && row.launchArgs.every((arg: unknown) => typeof arg === 'string'))
    && (row.poolHint === undefined || typeof row.poolHint === 'string')
    && (row.poolHintSource === undefined || row.poolHintSource === 'grid')
    && (row.launchCwd === undefined || typeof row.launchCwd === 'string' && row.launchCwd.startsWith('/'))
    && (row.cellId === undefined || typeof row.cellId === 'string')
    && (row.priority === undefined || typeof row.priority === 'number' && Number.isFinite(row.priority))
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

/** QUEUE-BURST: when the queue last launched (epoch ms), from the round-robin marker. Missing or unreadable = unknown. */
function lastQueueLaunchAt(path: string): number | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(`${path}.round-robin.json`, 'utf8'));
    const at = value && typeof value === 'object' ? (value as { lastLaunchAt?: unknown }).lastLaunchAt : undefined;
    return typeof at === 'number' && Number.isFinite(at) ? at : undefined;
  } catch { return undefined; }
}

function saveLastLaunchedSeat(path: string, lastSeat: QueueSeat, lastLaunchAt?: number): void {
  const marker = `${path}.round-robin.json`;
  const temporary = `${marker}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ lastSeat, ...(lastLaunchAt === undefined ? {} : { lastLaunchAt }) }), { flag: 'wx', mode: 0o600 });
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

/** Cell id named in a goal text (`칸: ONEDOOR-2` · `칸 ONEDOOR-2`) — ids carry at least one hyphen. */
export function queueCellId(text: string): string | undefined {
  return /칸[:\s]\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)/u.exec(text)?.[1];
}

/** A say row names its cell in the sentence; an ask row names it inside the goal document (unreadable → none). */
function queueRowCellId(kind: QueueItem['kind'], input: string): string | undefined {
  if (kind === 'say') return queueCellId(input);
  try { return queueCellId(readFileSync(input, 'utf8')); } catch { return undefined; }
}

/** A CEO directive mark on the cell (crown U+1F451 · 대표 지시) lifts it above every rubric score (max rubric ≈ 25.5). */
export const QUEUE_CEO_PRIORITY_BONUS = 100;
const CEO_MARK = /\u{1F451}|대표\s*지시/u;

/** Rubric score of a cell, searched in unreleased schedules by cut order; no ledger, no cell, or no rubric → undefined. */
export function queueCellRubricPriority(cellId: string, root: string, now: Date): number | undefined {
  const ledger = root === effectiveInstanceRoot() ? releaseLedgerRoot() : root;
  if (!existsSync(join(ledger, 'release', 'features.sqlite'))) return undefined;
  const versions = listSchedules(ledger).filter((row) => Date.parse(row.cutAt) > now.getTime())
    .sort((a, b) => Date.parse(a.cutAt) - Date.parse(b.cutAt)).map((row) => row.version);
  for (const version of versions) {
    const cell = readRubricItems(version, ledger).find((item) => item.id === cellId);
    if (!cell) continue;
    const text = `${cell.title}\n${cell.evidence ?? ''}`;
    const rubric = parseRubric(text);
    const ceo = CEO_MARK.test(text);
    if (!rubric && !ceo) return undefined;
    return (rubric ? rubricScore(rubric) : 0) + (ceo ? QUEUE_CEO_PRIORITY_BONUS : 0);
  }
  return undefined;
}

/** A failed rubric lookup leaves the row without priority (FIFO) — it never refuses the enqueue. */
function defaultQueuePriority(cellId: string | undefined, root: string, deps: HarnessQueueDeps): number | undefined {
  if (cellId === undefined) return undefined;
  try {
    const value = (deps.cellPriority ?? queueCellRubricPriority)(cellId, root, (deps.now ?? (() => new Date()))());
    return value !== undefined && Number.isFinite(value) ? value : undefined;
  } catch (error) {
    try { debug.log('harness.queue', 'priority-lookup-failed', { cellId, reason: String(error) }); }
    catch { /* Observation cannot affect enqueue. */ }
    return undefined;
  }
}

/** Seat head order: priority descending (none = lowest), then arrival ascending, then file order. */
function queueHeadBefore(a: QueueItem, b: QueueItem): boolean {
  const pa = a.priority ?? -Infinity, pb = b.priority ?? -Infinity;
  if (pa !== pb) return pa > pb;
  const ta = Date.parse(a.at), tb = Date.parse(b.at);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta < tb;
}

export class HarnessQueueDuplicateError extends Error {
  constructor(existing: QueueItem, key: string) {
    super(`같은 ${key} 이 이미 대기열에 있거나 도는 중이다 — ${existing.id} (${existing.status})`);
  }
}

export async function addHarnessQueue(input: { seat: string; say?: string; ask?: string; hold?: boolean; heavy?: boolean; idempotencyKey?: string; launchArgs?: string[]; poolHint?: string; poolHintSource?: 'grid'; launchCwd?: string; refuseDuplicate?: boolean }, deps: HarnessQueueDeps = {}): Promise<QueueItem> {
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
    // Recorded at enqueue: a later edit or deletion of an ask document cannot reopen its cell.
    const cellId = queueRowCellId(kind, value);
    if (input.refuseDuplicate) {
      const cell = cellId;
      const existing = rows.find((row) => row.status !== 'finished'
        && !['retryable', 'succeeded'].includes(queueRowOutcome(row, root))
        && ((row.kind === kind && row.input === value) || (cell !== undefined && (row.cellId ?? queueRowCellId(row.kind, row.input)) === cell)));
      if (existing) {
        const key = existing.kind === kind && existing.input === value ? '골' : `칸 ${cell}`;
        observe('skipped', { id: existing.id, seat: assigned, reason: 'duplicate', key }, deps);
        throw new HarnessQueueDuplicateError(existing, key);
      }
    }
    const priority = defaultQueuePriority(cellId, root, deps);
    const item: QueueItem = { id: `hq-${randomUUID()}`, seat: assigned, kind, input: value,
      hold: input.hold === true, heavy: input.heavy === true, at: new Date().toISOString(), status: 'queued',
      ...(input.launchArgs === undefined ? {} : { launchArgs: input.launchArgs }),
      ...(input.poolHint === undefined ? {} : { poolHint: input.poolHint, ...(input.poolHintSource ? { poolHintSource: input.poolHintSource } : {}) }),
      ...(input.launchCwd === undefined ? {} : { launchCwd: input.launchCwd }),
      ...(cellId === undefined ? {} : { cellId }),
      ...(priority === undefined ? {} : { priority }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }) };
    save(path, [...rows, item]);
    observe('enqueued', { id: item.id, seat: item.seat, kind, ...(priority === undefined ? {} : { priority }) }, deps);
    return item;
  });
}

export function listHarnessQueue(deps: HarnessQueueDeps = {}): QueueItem[] {
  return read(harnessQueuePath(deps.root ?? effectiveInstanceRoot()));
}

/** A missing row is not proof of failure; explicit removal and terminal receipts have distinct markers. */
export function harnessQueueOutcome(id: string, deps: HarnessQueueDeps = {}): 'pending' | 'succeeded' | 'retryable' | 'removed' | 'unknown' {
  const root = deps.root ?? effectiveInstanceRoot();
  const row = listHarnessQueue(deps).find((item) => item.id === id);
  if (!row) {
    const marker = join(root, 'harness', `${id}.outcome`);
    if (!existsSync(marker)) return 'unknown';
    const value = readFileSync(marker, 'utf8');
    return value === 'succeeded' || value === 'retryable' || value === 'removed' ? value : 'unknown';
  }
  return queueRowOutcome(row, root);
}

const keyMarkerPath = (root: string, key: string) => join(root, 'harness', 'by-key', `${createHash('sha256').update(key).digest('hex')}.id`);

function recordQueueOutcome(root: string, id: string, outcome: 'succeeded' | 'retryable' | 'removed', key?: string): void {
  const path = join(root, 'harness', `${id}.outcome`);
  if (outcome === 'removed') writeFileSync(path, outcome, { mode: 0o600 });
  else if (!existsSync(path)) writeFileSync(path, outcome, { flag: 'wx', mode: 0o600 });
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

/** 아직 발사 전(queued)인 항목의 풀 힌트만 바꾼다 — 발사 중·발사 뒤 항목은 손대지 않는다. 바꿨으면 true. */
export async function setQueuedPoolHint(id: string, poolHint: string | undefined, deps: HarnessQueueDeps = {}, stillValid?: (item: QueueItem) => boolean): Promise<boolean> {
  const root = deps.root ?? effectiveInstanceRoot();
  return locked(root, async (path) => {
    const rows = read(path);
    const item = rows.find((row) => row.id === id);
    if (!item || item.status !== 'queued' || item.poolHint === poolHint) return false;
    // GRID 가 소유하지 않은 힌트(사람·다른 경로가 넣은 것)는 바꾸지도 지우지도 않는다. 힌트가 없던 항목에 새로 넣는 것은 허용.
    if (item.poolHint !== undefined && item.poolHintSource !== 'grid') return false;
    // 바꾸기 직전, 같은 잠금 안에서 호출자의 전제(예: 의뢰가 아직 queued)를 다시 확인한다.
    if (stillValid && !stillValid(item)) return false;
    if (poolHint === undefined) { delete item.poolHint; delete item.poolHintSource; } else { item.poolHint = poolHint; item.poolHintSource = 'grid'; }
    save(path, rows);
    return true;
  });
}

/** TASK-QUEUE: re-rank a waiting row; launched or launching rows are refused (their slot is already taken).
 * `by` is required — the caller names who asked; the audit never invents an actor. */
export async function setHarnessQueuePriority(id: string, priority: number, by: string, deps: HarnessQueueDeps = {}): Promise<QueueItem> {
  if (!by.trim()) throw new Error('harness queue prio: 요청 주체(by)가 비었다');
  if (!Number.isFinite(priority)) throw new Error(`harness queue prio: 우선순위는 유한한 수여야 한다 — ${priority}`);
  const root = deps.root ?? effectiveInstanceRoot();
  return locked(root, async (path) => {
    const rows = read(path);
    const item = rows.find((row) => row.id === id);
    if (!item) throw new Error(`harness queue prio: 항목 없음 — ${id}`);
    if (item.status !== 'queued') throw new Error(`harness queue prio: 대기(queued) 행만 바꾼다 — ${id} (${item.status})`);
    const updated: QueueItem = { ...item, priority };
    save(path, rows.map((row) => row.id === id ? updated : row));
    // The audit is part of the change: a failed audit write restores the previous file and fails the call.
    try { debug.log('harness.queue', 'prio', { id, from: item.priority ?? null, to: priority, by }); }
    catch (error) {
      save(path, rows);
      throw new Error(`harness queue prio: 감사 기록 실패로 되돌림 — ${String(error)}`);
    }
    return updated;
  });
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
    const outcome = queueRowOutcome(item, root) === 'succeeded' ? 'succeeded' : 'removed';
    if (item.idempotencyKey) recordQueueOutcome(root, id, outcome, item.idempotencyKey);
    save(path, rows.filter((row) => row.id !== id));
    observe('skipped', { id, seat: item.seat, reason: 'removed' }, deps);
    return true;
  });
}

export function queueLaunchArgs(item: Pick<QueueItem, 'kind' | 'input' | 'hold' | 'heavy' | 'launchArgs' | 'poolHint'>): string[] {
  const args = item.launchArgs ?? ['harness', item.kind, item.input, '--substrate', 'pod',
    ...(item.hold ? ['--no-auto-merge'] : []), ...(item.heavy ? ['--pod-memory', 'high'] : [])];
  if (!item.poolHint || args[0] !== 'harness' || !['say', 'ask'].includes(args[1] ?? '')) return args;
  const substrateIndex = args.indexOf('--substrate');
  if (substrateIndex < 0 || args[substrateIndex + 1] !== 'pod') return args;
  const poolIndex = args.indexOf('--pod-pool');
  if (poolIndex >= 0) return args;
  return [...args, '--pod-pool', item.poolHint];
}

function harnessQueuePoolMembers(): ReturnType<typeof parsePodPool> {
  const config = getUserConfig();
  const spec = resolvePodPoolSpec(undefined, process.env, () => config.harness?.podPool ?? config.pod?.pool);
  const current = spec ? null : leaseKubectl(['config', 'current-context']);
  const context = spec ?? (current?.status === 0 ? current.stdout.trim() : '');
  if (!context) throw new Error('pod lease status: no pool/context');
  return parsePodPool(context);
}

export function readHarnessQueuePool(): QueuePool {
  const members = harnessQueuePoolMembers();
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

/** Same sanitizing as `k8sLabelValue` (self-implement-pod.ts), which writes the `elanous.run` label value. */
export function queueRunLabelValue(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 63).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
}

/** SEAT-CAP-STALE2: `elanous.run` / `elanous.child-run` labels of Jobs without a Complete/Failed condition (running or pending). */
export function queuePodRunsFromJobs(stdout: string): Set<string> {
  const parsed = JSON.parse(stdout) as { items?: unknown };
  if (!Array.isArray(parsed.items)) throw new Error('pod jobs: invalid response');
  const runs = new Set<string>();
  for (const job of parsed.items as { metadata?: { labels?: Record<string, unknown> };
    status?: { conditions?: { type?: unknown; status?: unknown }[] } }[]) {
    const finished = (job.status?.conditions ?? []).some((c) => (c.type === 'Complete' || c.type === 'Failed') && c.status === 'True');
    if (finished) continue;
    for (const key of ['elanous.run', 'elanous.child-run']) {
      const value = job.metadata?.labels?.[key];
      if (typeof value === 'string' && value) runs.add(value);
    }
  }
  return runs;
}

/** One read-only Job list per pool member; any unreadable member makes the whole answer unavailable (throws). */
export function readHarnessQueuePodRuns(kubectl: typeof leaseKubectl = leaseKubectl,
  members: readonly { context: string }[] = harnessQueuePoolMembers()): ReadonlySet<string> {
  const runs = new Set<string>();
  for (const member of members) {
    const result = kubectl(['--context', member.context, '--request-timeout=10s', '-n', 'elanous-test', 'get', 'jobs',
      '-l', 'elanous.substrate=pod', '-o', 'json']);
    if (result.status !== 0) throw new Error(`pod jobs ${member.context}: ${result.stderr.trim().split('\n').pop() || `rc=${result.status}`}`);
    for (const run of queuePodRunsFromJobs(result.stdout)) runs.add(run);
  }
  return runs;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** CHILD-UNIV-COUNT: derived child universes a tick reads with its own — never a glob of home directories. Sources: the
 *  instance registry's live local test universes (`~/.elanous/logs/instances.json`), the derived universe
 *  (`<tree>/.elanous-test`) of every seat tree, of every queue row's launch tree and of this process's own tree. A derived
 *  root that does not exist was never a child universe and is skipped; the parent root itself is never a child. */
export function harnessQueueChildUniverseRoots(input: {
  parentRoot: string;
  seatTrees?: Partial<Record<QueueSeat, string[]>>;
  launchTrees?: readonly string[];
  registry?: () => readonly Pick<LogInstanceView, 'stateDir' | 'kind' | 'liveness'>[];
  exists?: (path: string) => boolean;
  ownTree?: string | null;
}): string[] {
  const exists = input.exists ?? existsSync;
  const parent = resolve(input.parentRoot);
  const roots = new Set<string>();
  const add = (root: string | null | undefined): void => {
    if (!root || !root.startsWith('/')) return;
    const resolved = resolve(root);
    if (resolved !== parent && exists(resolved)) roots.add(resolved);
  };
  const derived = (tree: string): string | null => {
    if (!tree.startsWith('/')) return null;
    const top = findTreeRoot(tree);
    return top ? join(top, '.elanous-test') : null;
  };
  try {
    for (const entry of (input.registry ?? readLogInstances)()) {
      if (entry.kind === 'test' && entry.liveness === 'alive') add(entry.stateDir);
    }
  } catch (error) {
    try { debug.log('harness.queue', 'child-universe-registry-unavailable', { error: String(error).slice(0, 240) }, { level: 'warn' }); }
    catch { /* Observation cannot affect dispatch. */ }
  }
  for (const trees of Object.values(input.seatTrees ?? {})) for (const tree of trees ?? []) add(derived(tree));
  for (const tree of input.launchTrees ?? []) add(derived(tree));
  add(input.ownTree === undefined ? derived(process.cwd()) : input.ownTree);
  return [...roots].sort();
}

/** A child universe's self-dev ledgers; a store that exists but cannot be listed is «unreadable», never «none». */
function readChildUniverseRuns(root: string): ReturnType<typeof listSelfDevRuns> | 'unreadable' {
  const dir = selfDevRunsDir(root);
  try { statSync(dir); readdirSync(dir); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : 'unreadable'; }
  return listSelfDevRuns(dir);
}

/** Host inventory includes harness authoring before it has a run ledger. Unattributed processes count for every seat. */
export function readHarnessQueueProcesses(probe: ProcessProbe = {}): readonly QueueProcess[] {
  return readHarnessQueueInventory(probe).processes;
}

/** CHILD-UNIV-COUNT: the host inventory with the parent's ledgers ⊕ the derived child universes' ledgers. */
export function readHarnessQueueInventory(probe: ProcessProbe = {}): QueueInventory {
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
  const ledgerProgress = new Map<number, { at: number; stopReason?: string }>();
  const ledgerRunIds = new Map<number, Set<string>>();
  const childPids = new Set<number>();
  const testProcess = process.env.NODE_ENV === 'test' || Boolean(process.env.ELANOUS_TEST_HOME);
  const childRoots = (probe.childUniverseRoots ?? (testProcess ? () => [] : () => harnessQueueChildUniverseRoots({
    parentRoot: effectiveInstanceRoot(), seatTrees: trees, launchTrees: probe.launchTrees ?? [] })))();
  const unreadable: string[] = [];
  const sources: { records: ReturnType<typeof listSelfDevRuns>; child: boolean }[] = [
    { records: listSelfDevRuns(probe.runsDir ?? selfDevRunsDir()), child: false }];
  for (const root of childRoots) {
    const records = readChildUniverseRuns(root);
    if (records === 'unreadable') unreadable.push(root);
    else sources.push({ records, child: true });
  }
  if (unreadable.length) {
    try { debug.log('harness.queue', 'child-universe-unreadable', { roots: unreadable, read: childRoots.length - unreadable.length }, { level: 'warn' }); }
    catch { /* Observation cannot affect dispatch. */ }
  }
  for (const { records, child } of sources) for (const record of records) {
    const pid = record.pid;
    if (!pid || !candidatePids.has(pid) || !record.pidStart) continue;
    if (!births.has(pid)) {
      try { births.set(pid, (probe.birthId ?? ((id: number) => processBirthId(id, platform)))(pid)); }
      catch { births.set(pid, undefined); }
    }
    if (births.get(pid) !== record.pidStart) continue;
    if (child) childPids.add(pid);
    if (record.runId) ledgerRunIds.set(pid, (ledgerRunIds.get(pid) ?? new Set<string>()).add(record.runId));
    // Newest updatedAt is the process's latest progress; it is stopped only when every matched record stopped.
    if (Number.isFinite(record.updatedAt)) {
      const prior = ledgerProgress.get(pid);
      const stopped = (prior ? prior.stopReason !== undefined : true) && Boolean(record.supervisorStopReason);
      const stopReason = stopped ? (prior?.stopReason ?? record.supervisorStopReason) : undefined;
      ledgerProgress.set(pid, { at: Math.max(prior?.at ?? -Infinity, record.updatedAt), ...(stopReason ? { stopReason } : {}) });
    }
    if (!queueSeatNames.some((name) => name === record.seat) || ambiguousPids.has(pid)) continue;
    const prior = ledgerSeats.get(pid);
    if (prior && prior !== record.seat) { ledgerSeats.delete(pid); ambiguousPids.add(pid); }
    else ledgerSeats.set(pid, record.seat!);
  }
  // One lsof for every candidate: a per-pid lsof (~0.1–0.3 s each) made a tick on a busy host take 10 s+ (10-08). lsof exits 1
  // when some pid is gone yet still prints the others; a pid it does not print stays unattributed (charged to all seats).
  let batchCwds: Map<number, string> | undefined;
  const readBatchCwds = (): Map<number, string> => {
    const cwds = new Map<number, string>();
    const started = Date.now();
    const lsof = run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', candidates.map(({ pid }) => pid).join(',')],
      { encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024 });
    if (!lsof.error && typeof lsof.stdout === 'string') {
      let current: number | undefined;
      for (const line of lsof.stdout.split('\n')) {
        if (line.startsWith('p')) current = Number(line.slice(1));
        else if (line.startsWith('n/') && current !== undefined) cwds.set(current, line.slice(1));
      }
    }
    try { debug.log('harness.queue', 'cwd-batch', { pids: candidates.length, read: cwds.size, ms: Date.now() - started,
      ...(lsof.error ? { error: String(lsof.error).slice(0, 240) } : {}) }); }
    catch { /* Observation cannot affect dispatch. */ }
    return cwds;
  };
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
      // The queue wrapper's argv carries its receipt path, so its launch id is its identity on every platform.
      launchId ??= /\/harness\/(hq-[0-9a-f-]{36})\.receipt\.json(?:\s|$)/.exec(command)?.[1];
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
          const found = (batchCwds ??= readBatchCwds()).get(pid);
          if (found === undefined) throw new Error('cwd unavailable');
          cwd = found;
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
    const progress = members.flatMap(({ process: { pid } }) => ledgerProgress.has(pid) ? [ledgerProgress.get(pid)!] : []);
    const progressAt = progress.length ? Math.max(...progress.map((entry) => entry.at)) : undefined;
    // Stopped only when every ledger-bearing member's supervisor stopped; one live supervisor keeps the run in progress.
    const stopReason = progress.length && progress.every((entry) => entry.stopReason) ? progress[0]!.stopReason : undefined;
    const runIds = [...new Set(members.flatMap(({ process: { pid } }) => [...(ledgerRunIds.get(pid) ?? [])]))];
    try { debug.log('harness.queue', 'attributed', { pid: root.pid, seat: assigned?.seat ?? null, source: assigned?.source ?? 'all' }); }
    catch { /* Observation does not block inventory. */ }
    rows.push({ pid: root.pid, ...(assigned ? { seat: assigned.seat } : {}), ...(launchId ? { launchId } : {}),
      ...(runId ? { runId } : {}), ...(progressAt !== undefined ? { progressAt } : {}), ...(stopReason ? { stopReason } : {}),
      ...(runIds.length ? { ledgerRunIds: runIds } : {}),
      ...(members.some(({ process: { pid } }) => childPids.has(pid)) ? { universe: 'child' as const } : {}) });
  }
  return { processes: rows, childUniverses: { roots: childRoots, unreadable } };
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

/** Launch time embedded in a UUIDv7 launch id (48-bit ms prefix); undefined for older v4 ids. */
export function queueLaunchTime(launchId: string): number | undefined {
  const match = /^hq-([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(launchId);
  if (!match) return undefined;
  const at = parseInt(`${match[1]}${match[2]}`, 16);
  return Number.isSafeInteger(at) && at > 0 ? at : undefined;
}

/** When the wrapper wrote its receipt (≈ spawn time); undefined when absent or unreadable. */
function receiptTime(root: string, launchId: string): number | undefined {
  try {
    const record = JSON.parse(readFileSync(harnessQueueReceiptPath(root, launchId), 'utf8')) as { at?: unknown };
    const at = typeof record.at === 'string' ? Date.parse(record.at) : NaN;
    return Number.isFinite(at) ? at : undefined;
  } catch { return undefined; }
}

function defaultLaunch(command?: string) {
  return (item: QueueItem, args: string[], root: string) => launch(item, args, root, command);
}

async function launch(item: QueueItem, args: string[], root: string, command?: string): Promise<number> {
  const repo = resolve(import.meta.dir, '../..');
  const logPath = join(root, 'harness', `${item.id}.log`);
  const fd = openSync(logPath, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [join(repo, 'src', 'harness', 'harness-queue-child.ts'),
      harnessQueueReceiptPath(root, item.launchId!), command ?? join(repo, 'bin', 'elanous.mjs'),
      ...(resolve(root) === prodInstanceRoot() ? [] : [`--test=${root}`]), ...args], {
      cwd: item.launchCwd ?? repo, detached: true, stdio: ['ignore', fd, fd],
      env: { ...process.env, ELANOUS_STATE_DIR: root,
        ELANOUS_STATE_DIR_SOURCE: stateDirSourceForChild(root), ELANOUS_HARNESS_SEAT: item.seat,
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

type QueueRun = { seat?: QueueSeat; launchIds: Set<string>; pids: Set<number>; runIds: Set<string>; progressAt?: number; stopReason?: string;
  /** Every run id of the group (env and ledger) — matched against Pod Job labels only, never used for grouping. */
  podRunIds: Set<string>;
  /** CHILD-UNIV-COUNT: some member's ledger lives in a derived child universe. */
  universe?: 'child' };

function groupQueueRuns(processes: readonly QueueProcess[]): QueueRun[] {
  const groups: { seats: Set<QueueSeat>; unknown: boolean; launchIds: Set<string>; keys: Set<string>; rows: QueueProcess[] }[] = [];
  for (const row of processes) {
    const keys = [row.runId && `run:${row.runId}`, `root:${row.rootPid ?? row.pid}`,
      row.launchId && `launch:${row.launchId}`, `pid:${row.pid}`].filter((key): key is string => Boolean(key));
    const matching = groups.filter((group) => keys.some((key) => group.keys.has(key)));
    const group = matching[0] ?? { seats: new Set<QueueSeat>(), unknown: false,
      launchIds: new Set<string>(), keys: new Set<string>(), rows: [] };
    for (const other of matching.slice(1)) {
      for (const key of other.keys) group.keys.add(key);
      for (const seat of other.seats) group.seats.add(seat);
      for (const id of other.launchIds) group.launchIds.add(id);
      group.rows.push(...other.rows);
      group.unknown ||= other.unknown;
      groups.splice(groups.indexOf(other), 1);
    }
    for (const key of keys) group.keys.add(key);
    if (row.seat) group.seats.add(row.seat);
    else group.unknown = true;
    if (row.launchId) group.launchIds.add(row.launchId);
    group.rows.push(row);
    if (!matching.length) groups.push(group);
  }
  return groups.map((group) => {
    const progress = group.rows.filter((row) => row.progressAt !== undefined);
    const progressAt = progress.length ? Math.max(...progress.map((row) => row.progressAt!)) : undefined;
    const stopReason = progress.length && progress.every((row) => row.stopReason) ? progress[0]!.stopReason : undefined;
    return {
      ...(group.unknown || group.seats.size !== 1 ? {} : { seat: [...group.seats][0] }),
      launchIds: group.launchIds,
      pids: new Set(group.rows.flatMap((row) => [row.pid, ...(row.rootPid ? [row.rootPid] : [])])),
      runIds: new Set(group.rows.flatMap((row) => row.runId ? [row.runId] : [])),
      podRunIds: new Set(group.rows.flatMap((row) => [...(row.runId ? [row.runId] : []), ...(row.ledgerRunIds ?? [])])),
      ...(progressAt !== undefined ? { progressAt } : {}), ...(stopReason ? { stopReason } : {}),
      ...(group.rows.some((row) => row.universe === 'child') ? { universe: 'child' as const } : {}),
    };
  });
}

/** SEAT-CAP-STALE limits: config harness.queue > env > default. */
export function harnessQueueCountingLimits(queue: { staleRunMinutes?: number; unknownSeatCap?: number } | undefined,
  env: NodeJS.ProcessEnv = process.env): { staleRunMinutes: number; unknownSeatCap: number } {
  const fromEnv = (name: string, min: number): number | undefined => {
    const raw = env[name];
    if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
    const value = Number(raw.trim());
    return Number.isSafeInteger(value) && value >= min ? value : undefined;
  };
  const valid = (value: unknown, min: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
  return {
    staleRunMinutes: valid(queue?.staleRunMinutes, 1) ? queue!.staleRunMinutes!
      : fromEnv('ELANOUS_HARNESS_QUEUE_STALE_RUN_MINUTES', 1) ?? SEAT_CAP_STALE_RUN_MINUTES,
    unknownSeatCap: valid(queue?.unknownSeatCap, 0) ? queue!.unknownSeatCap!
      : fromEnv('ELANOUS_HARNESS_QUEUE_UNKNOWN_SEAT_CAP', 0) ?? SEAT_CAP_UNKNOWN_SEAT_CAP,
  };
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

/** ORCH2 ③ — 발사를 막는 동결이면 사유(waitingReason)와 관측 칸을, 아니면 null. 동결 파일을 못 읽으면 닫힌 쪽(막는다). */
type UnreadableUniverseState = { holding: boolean; penalty: number };
/** CHILD-UNIV-HOLD: ticks a newly unreadable child universe holds every launch before the pool penalty takes over. */
export const UNREADABLE_UNIVERSE_HOLD_TICKS = 2;
/** CHILD-UNIV-HOLD: a universe unreadable this long raises one ops-health alert per universe per (KST) day. */
export const UNREADABLE_UNIVERSE_ALERT_MS = 60 * 60 * 1_000;

export function unreadableUniverseStatePath(root: string): string {
  return join(root, 'harness', 'child-universe-unreadable.sqlite');
}

/** CHILD-UNIV-HOLD — the «못 읽음» hold is finite. Per unreadable universe the queue state keeps when it first became
 *  unreadable and how many ticks it held: the first `UNREADABLE_UNIVERSE_HOLD_TICKS` scheduled/direct passes hold every
 *  launch; afterwards launches go on with one pool slot charged per unreadable universe. A universe readable again (or no
 *  longer enumerated) drops its row. Unpersistable state never holds (a hold that cannot count its ticks would be endless). */
async function trackUnreadableUniverses(root: string, unreadable: readonly string[], now: Date, followUp: boolean,
  deps: HarnessQueueDeps): Promise<UnreadableUniverseState> {
  const nowMs = now.getTime();
  const day = new Date(nowMs + 9 * 3_600_000).toISOString().slice(0, 10);
  const alerts: string[] = [];
  let holding = false;
  let rows: { universe: string; firstAt: number; heldTicks: number }[] = [];
  try {
    mkdirSync(join(root, 'harness'), { recursive: true, mode: 0o700 });
    const db = new Database(unreadableUniverseStatePath(root), { create: true, strict: true });
    try {
      db.exec('CREATE TABLE IF NOT EXISTS unreadable_universe (universe TEXT PRIMARY KEY, first_at INTEGER NOT NULL, held_ticks INTEGER NOT NULL, alerted_day TEXT)');
      const known = db.query('SELECT universe, first_at AS firstAt, held_ticks AS heldTicks, alerted_day AS alertedDay FROM unreadable_universe')
        .all() as { universe: string; firstAt: number; heldTicks: number; alertedDay: string | null }[];
      const current = new Set(unreadable);
      const cleared = known.filter((row) => !current.has(row.universe)).map((row) => row.universe);
      for (const universe of cleared) db.query('DELETE FROM unreadable_universe WHERE universe = ?').run(universe);
      if (cleared.length) {
        try { debug.log('harness.queue', 'unreadable-universe-cleared', { universes: cleared }); }
        catch { /* Observation cannot affect dispatch. */ }
      }
      for (const universe of unreadable) {
        db.query('INSERT OR IGNORE INTO unreadable_universe (universe, first_at, held_ticks, alerted_day) VALUES (?, ?, 0, NULL)').run(universe, nowMs);
      }
      const live = db.query('SELECT universe, first_at AS firstAt, held_ticks AS heldTicks, alerted_day AS alertedDay FROM unreadable_universe')
        .all() as { universe: string; firstAt: number; heldTicks: number; alertedDay: string | null }[];
      holding = live.some((row) => row.heldTicks < UNREADABLE_UNIVERSE_HOLD_TICKS);
      // A burst follow-up pass belongs to a tick already counted.
      if (holding && !followUp) db.query('UPDATE unreadable_universe SET held_ticks = held_ticks + 1 WHERE held_ticks < ?').run(UNREADABLE_UNIVERSE_HOLD_TICKS);
      for (const row of live) {
        if (nowMs - row.firstAt < UNREADABLE_UNIVERSE_ALERT_MS || row.alertedDay === day) continue;
        db.query('UPDATE unreadable_universe SET alerted_day = ? WHERE universe = ?').run(day, row.universe);
        alerts.push(row.universe);
      }
      rows = live;
    } finally { db.close(); }
  } catch (error) {
    holding = false;
    try { debug.log('harness.queue', 'unreadable-universe-state-unavailable', { error: String(error).slice(0, 240), universes: unreadable }, { level: 'warn' }); }
    catch { /* Observation cannot affect dispatch. */ }
  }
  const penalty = holding ? 0 : unreadable.length;
  if (unreadable.length) {
    try { debug.log('harness.queue', 'unreadable-universe', { universes: unreadable, holding, penalty,
      rows: rows.map((row) => ({ universe: row.universe, firstAt: new Date(row.firstAt).toISOString(), heldTicks: row.heldTicks })) }, { level: 'warn' }); }
    catch { /* Observation cannot affect dispatch. */ }
  }
  for (const universe of alerts) {
    const first = rows.find((row) => row.universe === universe)?.firstAt ?? nowMs;
    const text = `⚠️ 하니스 대기열: 자식 우주를 ${Math.floor((nowMs - first) / 60_000)}분째 못 읽는다 — ${universe} · 발사는 Pod 풀 여유에서 1칸 보수 차감 중`;
    try {
      const send = deps.unreadableAlert ?? (process.env.NODE_ENV === 'test' || process.env.ELANOUS_TEST_HOME ? () => {}
        : async (body: string) => { (await import('../domains/outbound-alert.js')).sendOutbound(body, 'ops-health'); });
      await send(text);
      debug.log('harness.queue', 'unreadable-universe-alert', { universe, firstAt: new Date(first).toISOString(), day });
    } catch (error) {
      try { debug.log('harness.queue', 'unreadable-universe-alert-failed', { universe, error: String(error).slice(0, 240) }, { level: 'warn' }); }
      catch { /* Observation cannot affect dispatch. */ }
    }
  }
  return { holding, penalty };
}

/** CHILD-UNIV-COUNT: the production freeze binds a tick in any universe (a work-tree launch ticks in its derived test
 *  universe and used not to see it); the tick's own root still counts. A test process defaults to its own root only. */
function queueProdFreezeRoot(root: string, deps: HarnessQueueDeps): string {
  if (deps.prodFreezeRoot !== undefined) return deps.prodFreezeRoot;
  return process.env.NODE_ENV === 'test' || process.env.ELANOUS_TEST_HOME ? root : prodInstanceRoot();
}

function launchFreezeHold(root: string, now: Date, prodRoot: string = root): { reason: string; freezeReason: string; until: string | null } | null {
  let freeze: ReturnType<typeof readLandingFreeze> = null;
  try {
    for (const authority of new Set([prodRoot, root])) {
      const found = readLandingFreeze(authority, now);
      if (found?.holdLaunches === true) { freeze = found; break; }
    }
  }
  catch { return { reason: '동결 상태 읽기 실패', freezeReason: '동결 상태 읽기 실패', until: null }; }
  if (freeze?.holdLaunches !== true) return null;
  return { reason: `동결 — ${freeze.reason}${freeze.until ? ` · ~${freeze.until}` : ''}`, freezeReason: freeze.reason, until: freeze.until };
}

/** QUEUE-BURST default: five launches 30 s apart fit one two-minute cron interval. */
export const QUEUE_BURST_MAX_DEFAULT = 5;
export const QUEUE_LAUNCH_STAGGER_MS = 30_000;
const queueStaggerPrefix = '발사 간격';

/**
 * One scheduled tick launches several queued heads when seats and the Pod pool have room (QUEUE-BURST). Each launch is its
 * own locked pass that re-measures seat counts, pool headroom, the finish gate and the freeze, so the pool headroom is what
 * bounds the burst; launches are `launchStaggerMs` apart. A requested tick (direct `harness say|ask`) launches at most its row.
 */
export async function tickHarnessQueue(deps: HarnessQueueDeps = {}, requestedId?: string): Promise<QueueTick> {
  if (requestedId) return tickHarnessQueueOnce(deps, requestedId, false);
  const first = await tickHarnessQueueOnce(deps, undefined, false);
  if (first.outcome !== 'launched' || !first.item) return first;
  const configured = deps.burstMax ?? (deps.configPath === undefined ? getUserConfig() : getUserConfig(deps.configPath)).harness?.queue?.burstMax;
  const burstMax = typeof configured === 'number' && Number.isSafeInteger(configured) && configured > 0 ? configured : QUEUE_BURST_MAX_DEFAULT;
  const stagger = deps.launchStaggerMs ?? QUEUE_LAUNCH_STAGGER_MS;
  const launched: QueueItem[] = [first.item];
  let stop = burstMax <= 1 ? 'burst-max' : '';
  while (!stop && launched.length < burstMax) {
    // Nothing left to launch: end the burst without spending the stagger wait.
    if (!listHarnessQueue(deps).some((row) => row.status === 'queued')) { stop = 'empty'; break; }
    if (stagger > 0) await (deps.sleep ?? ((ms: number) => Bun.sleep(ms)))(stagger);
    let next: QueueTick;
    // Launches already made stand: a failing follow-up pass ends the burst (its own row stays for reconcile) instead of
    // turning the whole tick into an error.
    try { next = await tickHarnessQueueOnce(deps, undefined, true); }
    catch (error) { stop = `follow-up failed: ${String(error).slice(0, 240)}`; break; }
    if (next.outcome !== 'launched' || !next.item) { stop = next.reason.split('\n')[0] ?? next.outcome; break; }
    launched.push(next.item);
  }
  try { debug.log('harness.queue', 'burst', { launched: launched.length, burstMax, staggerMs: stagger, stop: stop || 'burst-max',
    ids: launched.map((row) => row.id), seats: launched.map((row) => row.seat) }); }
  catch { /* Observation cannot change launches already made. */ }
  return { ...first, launched };
}

async function tickHarnessQueueOnce(deps: HarnessQueueDeps, requestedId: string | undefined, followUp: boolean): Promise<QueueTick> {
  const root = deps.root ?? effectiveInstanceRoot();
  const caller = 'harness-queue-tick' as const;
  let advice: LaunchAdvice = { verdict: 'unknown', why: 'pool not measured before queue decision' };
  const shadow = (pool: QueuePool | undefined): void => {
    try { advice = (deps.advice ?? adviseLaunch)({ pool, caller }); }
    catch { advice = { verdict: 'unknown', why: 'launch advice unavailable' }; }
  };
  const actual = await locked<QueueTick>(root, async (path): Promise<QueueTick> => {
    // A burst follow-up already ran the author shadow and the idle request in this tick's first pass.
    if (!followUp) try {
      const now = (deps.now ?? (() => new Date()))();
      // A test process must not run the real author shadow — it reads operational ledgers and blew the 5s test budget (10-05 P0).
      if (!deps.authorShadow && process.env.ELANOUS_AUTHOR_SHADOW_LIVE !== '1' && (process.env.NODE_ENV === 'test' || process.env.ELANOUS_TEST_HOME)) {
        debug.log('loops.author-depth', 'shadow-skipped-test', {});
      } else {
        const shadow = deps.authorShadow ?? (await import('../loops/orchestrator/author-depth.js')).runAuthorDepthShadow;
        const started = Date.now();
        await shadow(root, now);
        // The shadow runs inside the queue lock; its duration is what other ticks wait on.
        try { debug.log('harness.queue', 'author-shadow', { ms: Date.now() - started }); }
        catch { /* Observation cannot affect dispatch. */ }
      }
    } catch (error) {
      try { debug.log('loops.author-depth', 'shadow-failed', { reason: String(error) }); }
      catch { /* Shadow observation cannot affect queue dispatch. */ }
    }
    const items = read(path);
    // ORCH2 ③ 동결 창의 «발사» 절반 — `freeze on --hold-launches` 면 이 틱은 발사 0. 동결 파일을 못 읽으면 착지 쪽과 같이 닫힌 쪽(발사 0).
    const hold = launchFreezeHold(root, (deps.now ?? (() => new Date()))(), queueProdFreezeRoot(root, deps));
    if (hold) {
      const reason = hold.reason;
      const queued = items.filter((item) => item.status === 'queued');
      const updated = items.map((item) => item.status === 'queued' && item.waitingReason !== reason ? { ...item, waitingReason: reason } : item);
      if (updated.some((item, index) => item !== items[index])) save(path, updated);
      for (const item of queued) observe('waiting', { id: item.id, seat: item.seat, reason }, deps);
      if (queued.length) {
        try { debug.log('loop.orchestrator', 'freeze-held-launch', { reason: hold.freezeReason, until: hold.until, queued: queued.length, phase: 'tick-start' }); }
        catch { /* Observation cannot affect dispatch. */ }
      }
      const subject = (requestedId ? queued.find((item) => item.id === requestedId) : undefined) ?? (!requestedId ? queued[0] : undefined);
      return subject ? { outcome: 'waiting', item: { ...subject, waitingReason: reason }, reason }
        : { outcome: 'skipped', reason: requestedId ? '이미 처리됨 또는 항목 없음' : 'empty' };
    }
    if (!followUp) try { await (deps.idleRequest ?? requestIdleSeats)(root, (deps.now ?? (() => new Date()))(), items, deps); }
    catch (error) {
      try { debug.log('loop.orchestrator', 'idle-request-failed', { reason: String(error) }); }
      catch { /* Idle observation cannot affect queue dispatch. */ }
    }
    const heads = new Map<QueueSeat, QueueItem>();
    for (const row of items) {
      if (row.status !== 'queued') continue;
      const head = heads.get(row.seat);
      if (!head || queueHeadBefore(row, head)) heads.set(row.seat, row);
    }
    if (requestedId && ![...heads.values()].some((row) => row.id === requestedId)) {
      const row = items.find((item) => item.id === requestedId);
      if (!row || row.status !== 'queued') return { outcome: 'skipped', item: row, reason: '이미 처리됨 또는 항목 없음' };
      const reason = '앞선 대기열 항목 차례';
      if (row.waitingReason !== reason) save(path, items.map((item) => item.id === requestedId ? { ...item, waitingReason: reason } : item));
      observe('waiting', { id: row.id, seat: row.seat, reason }, deps);
      return { outcome: 'waiting', item: { ...row, waitingReason: reason }, reason };
    }
    if (!heads.size) { observe('skipped', { reason: 'empty' }, deps); return { outcome: 'skipped', reason: 'empty' }; }
    const lastSeat = lastLaunchedSeat(path);
    const first = lastSeat ? (queueSeatNames.indexOf(lastSeat) + 1) % queueSeatNames.length
      : queueSeatNames.indexOf(items.find((row) => row.status === 'queued')!.seat);
    // A requested tick (direct CLI call) keeps the seat round-robin: it launches its row only when that row is the first
    // head with room; an earlier seat's head with room means the requested row waits for its turn.
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
      const subject = (requestedId ? candidates.find((item) => item.id === requestedId) : undefined) ?? candidates[0]!;
      const subjectReason = blocked.get(subject.seat)!.reason;
      return { outcome: 'waiting', item: { ...subject, waitingReason: subjectReason }, reason: requestedId ? subjectReason : reason };
    };
    for (const item of candidates) {
      const injectedCap = deps.cap?.(item.seat);
      if (injectedCap !== undefined && (!Number.isSafeInteger(injectedCap) || injectedCap < 0)) throw new Error(`harness queue: invalid seat cap for ${item.seat}`);
    }
    let current = items;
    let processes: readonly QueueProcess[];
    let childUniverses: QueueInventory['childUniverses'] | undefined;
    let unreadableState: UnreadableUniverseState = { holding: false, penalty: 0 };
    try {
      const launchTrees = [...new Set(items.flatMap((row) => row.launchCwd ? [row.launchCwd] : []))];
      const inventory: QueueInventory = deps.inventory ? deps.inventory(launchTrees)
        : deps.processes ? { processes: deps.processes(), childUniverses: { roots: [], unreadable: [] } }
        : readHarnessQueueInventory({ launchTrees });
      processes = inventory.processes;
      // A seam or host that read no child universe keeps the parent-only line; any consulted universe shows the split.
      if (inventory.childUniverses.roots.length || inventory.childUniverses.unreadable.length) childUniverses = inventory.childUniverses;
      // CHILD-UNIV-HOLD: a `processes`-only seam consulted no child universe, so it neither sets nor clears the state.
      if (deps.inventory || !deps.processes) {
        unreadableState = await trackUnreadableUniverses(root, inventory.childUniverses.unreadable,
          (deps.now ?? (() => new Date()))(), followUp, deps);
      }
    }
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
    const limits = harnessQueueCountingLimits(config.harness?.queue);
    const nowMs = (deps.now ?? (() => new Date()))().getTime();
    const excludedLogged = new Set<string>();
    const logExcluded = (key: string, data: Record<string, unknown>): void => {
      if (excludedLogged.has(key)) return;
      excludedLogged.add(key);
      try { debug.log('harness.queue', 'seat-cap-excluded', data); }
      catch { /* Observation cannot affect dispatch. */ }
    };
    const runLabel = (run: QueueRun): Record<string, unknown> => ({ runId: [...run.runIds][0] ?? [...run.podRunIds][0] ?? null,
      launchId: [...run.launchIds][0] ?? null, pid: [...run.pids][0] });
    const runKey = (run: QueueRun): string => `run:${[...run.pids].join(',')}`;
    // SEAT-CAP-STALE2: a run quiet in its host ledger may be working in a Pod (POD-OBS writes elsewhere). Its unfinished Job
    // keeps it progressing. One Job read per tick, only once some run would go stale; an unreadable read keeps every such run.
    let podRuns: { ok: true; runs: ReadonlySet<string> } | { ok: false } | undefined;
    const podState = (): typeof podRuns & {} => {
      if (podRuns) return podRuns;
      const testProcess = process.env.NODE_ENV === 'test' || Boolean(process.env.ELANOUS_TEST_HOME);
      try { podRuns = { ok: true, runs: (deps.podRuns ?? (testProcess ? () => new Set<string>() : () => readHarnessQueuePodRuns()))() }; }
      catch (error) {
        podRuns = { ok: false };
        try { debug.log('harness.queue', 'progress-source-unavailable', { source: 'pod-jobs', error: String(error).slice(0, 240) }, { level: 'warn' }); }
        catch { /* Observation cannot affect dispatch. */ }
      }
      return podRuns;
    };
    const progressLogged = new Set<string>();
    const runVerdict = (run: QueueRun, seat: QueueSeat, extra: Record<string, unknown> = {}): ReturnType<typeof seatCapExclusion> => {
      const verdict = seatCapExclusion({ kind: 'run', seat, progressAt: run.progressAt, stopReason: run.stopReason }, nowMs, limits);
      if (verdict?.reason !== 'stale') return verdict;
      const pod = podState();
      const podRunId = pod.ok ? [...run.podRunIds].find((id) => pod.runs.has(queueRunLabelValue(id))) : undefined;
      if (pod.ok && !podRunId) return verdict;
      if (!progressLogged.has(runKey(run))) {
        progressLogged.add(runKey(run));
        try { debug.log('harness.queue', 'seat-cap-progress', { ...runLabel(run), ...extra, seat, source: pod.ok ? 'pod-job' : 'pod-unavailable',
          ...(podRunId ? { podRunId } : {}), ledgerIdleMin: verdict.idleMin }); }
        catch { /* Observation cannot affect dispatch. */ }
      }
      return null;
    };
    // Identity is the launch id only: a recycled wrapper pid must never adopt an unrelated run.
    const matches = (run: QueueRun, row: QueueItem): boolean => Boolean(row.launchId && run.launchIds.has(row.launchId));
    let unknownLogged = false;
    // A seat-less run that is a queue row's launch takes that row's seat; only the rest form the unknown-seat bucket.
    const logUnknownBucket = (): void => {
      if (unknownLogged) return;
      unknownLogged = true;
      const launchedRows = current.filter((row) => row.status === 'launching' || row.status === 'launched');
      const bucket = runs.filter((run) => !run.seat && !launchedRows.some((row) => matches(run, row)));
      for (const run of bucket) {
        const verdict = seatCapExclusion({ kind: 'run', progressAt: run.progressAt }, nowMs, limits);
        logExcluded(runKey(run), { ...runLabel(run), seat: null, reason: 'unknown-seat', idleMin: verdict?.idleMin ?? null });
      }
      if (bucket.length > limits.unknownSeatCap) {
        try { debug.log('harness.queue', 'unknown-seat-over-cap', { count: bucket.length, cap: limits.unknownSeatCap }, { level: 'warn' }); }
        catch { /* Observation cannot affect dispatch. */ }
      }
    };
    // Seat-less runs live in their own bucket; a seat is charged only by its own live, progressing runs and rows.
    const countSeat = (seat: QueueSeat): number => {
      logUnknownBucket();
      const own = runs.filter((run) => run.seat === seat);
      let active = 0;
      for (const run of own) {
        const verdict = runVerdict(run, seat);
        if (!verdict) { active++; continue; }
        logExcluded(runKey(run), { ...runLabel(run), seat, reason: verdict.reason, idleMin: verdict.idleMin });
      }
      for (const row of current) {
        if (row.seat !== seat || (row.status !== 'launching' && row.status !== 'launched')) continue;
        // A row whose own-seat run is already in the inventory is that run (matched by launch id).
        if (own.some((run) => matches(run, row))) continue;
        // A seat-less run that is this row's launch takes the row's seat; its progress still decides whether it holds it.
        const unattributedRun = runs.find((run) => !run.seat && matches(run, row));
        if (unattributedRun) {
          const verdict = runVerdict(unattributedRun, seat, { launchId: row.launchId ?? null });
          if (!verdict) { active++; continue; }
          logExcluded(runKey(unattributedRun), { ...runLabel(unattributedRun), launchId: row.launchId ?? null, seat, reason: verdict.reason, idleMin: verdict.idleMin });
          continue;
        }
        // A legacy row without a launch id has no receipt; wrapper liveness and the launch grace still decide.
        const state = row.launchId ? (deps.receipt ?? receipt)(root, row.launchId) : null;
        // A row with a launch id is live only through the inventory (its wrapper argv carries the id; matched above), so a
        // recycled pid can never keep it; the launch grace covers the moment before the wrapper appears. Only a legacy row
        // without a launch id falls back to its recorded pid's liveness.
        const live = !row.launchId && row.pid !== undefined && (deps.alive ?? alive)(row.pid);
        // The grace runs from the receipt time (written at spawn), else the launch id's own time (UUIDv7), else enqueue time
        // (legacy v4 ids only).
        const launchedAt = (row.launchId ? receiptTime(root, row.launchId) ?? queueLaunchTime(row.launchId) : undefined)
          ?? Date.parse(row.at);
        const verdict = seatCapExclusion({ kind: 'row', status: row.status, receipt: state, live,
          ...(Number.isFinite(launchedAt) ? { launchedAt } : {}) }, nowMs, limits);
        if (!verdict) { active++; continue; }
        logExcluded(`row:${row.id}`, { runId: null, launchId: row.launchId ?? null, queueId: row.id, seat, reason: verdict.reason, idleMin: verdict.idleMin });
      }
      return active;
    };
    const seatCounts = new Map<QueueSeat, number>();
    const seatActive = (seat: QueueSeat): number => {
      if (!seatCounts.has(seat)) seatCounts.set(seat, countSeat(seat));
      return seatCounts.get(seat)!;
    };
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
    // Every seat is counted once per tick so each excluded run or row is observed even when its seat has no queued head.
    for (const seat of queueSeatNames) seatActive(seat);
    let pool: QueuePool | undefined;
    let poolReason: string | undefined;
    let finishHeld: string | null | undefined;
    // CHILD-UNIV-COUNT: a seat's live runs whose ledger lives in a derived child universe (a work-tree launch's children).
    const childActive = (seat: QueueSeat): number => runs.filter((run) => run.seat === seat && run.universe === 'child'
      && !runVerdict(run, seat)).length;
    const universeSplit = (seat: QueueSeat, active: number): string => {
      if (!childUniverses) return '';
      const child = childActive(seat);
      const parent = active - child;
      const n = childUniverses.unreadable.length;
      return !n ? ` · 부모 ${parent} ⊕ 자식 우주 ${child}`
        : unreadableState.holding ? ` · 부모 ${parent} ⊕ 자식 우주 ${child} ⊕ 못 읽음 ${n}곳`
        : ` · 부모 ${parent} ⊕ 자식 우주 ${child} ⊕ 못 읽음 ${n}곳(보수 차감)`;
    };
    const seatLine = (seat: QueueSeat, active: number, details: ReturnType<typeof seatCapDetails>): string =>
      `${seatCapReason(seat, active, details)}${universeSplit(seat, active)}`;
    if (childUniverses?.unreadable.length && unreadableState.holding) {
      // «못 읽음» is not «0»: an unreadable child universe may hold this seat's runs, so no seat launches on a partial count —
      // but only for the first ticks (CHILD-UNIV-HOLD); afterwards the pool headroom is reduced instead.
      for (const item of candidates) {
        const details = seatCapDetails({ seat: item.seat, caps, gate, injectedCap: deps.cap?.(item.seat) });
        const active = seatActive(item.seat);
        blocked.set(item.seat, { reason: `${seatLine(item.seat, active, details)} — 자식 우주 못 읽음: ${childUniverses.unreadable.join(', ')}`, active });
      }
      return waiting();
    }
    for (const item of candidates) {
      const injectedCap = deps.cap?.(item.seat);
      const details = seatCapDetails({ seat: item.seat, caps, gate, injectedCap });
      const active = seatActive(item.seat);
      if (active >= details.cap) { blocked.set(item.seat, { reason: seatLine(item.seat, active, details), active }); continue; }
      if (!pool && !poolReason) {
        try { pool = (deps.pool ?? readHarnessQueuePool)(); }
        catch (error) { poolReason = `pod lease status unavailable: ${String(error)}`; }
        if (pool && (![pool.running, pool.pending, pool.reserved, pool.limit].every((n) => Number.isSafeInteger(n) && n >= 0) || pool.limit < 1)) {
          poolReason = 'pod lease status incomplete';
        }
        shadow(poolReason ? undefined : pool);
        if (pool && !poolReason) {
          const queueLaunching = current.filter((row) => row.status === 'launching' || row.status === 'launched').length;
          // CHILD-UNIV-HOLD: each unreadable child universe is charged one pool slot (conservative), never a seat slot.
          const penalty = unreadableState.penalty;
          if (pool.running + pool.pending + pool.reserved + queueLaunching + penalty >= pool.limit) {
            poolReason = `pool: ${pool.running}+${pool.pending}+${pool.reserved}+${queueLaunching}${penalty ? `+못 읽음 ${penalty}곳(보수 차감)` : ''}/${pool.limit}`;
          }
        }
      }
      if (poolReason) { blocked.set(item.seat, { reason: poolReason, active }); continue; }
      const budget = decideSpawn({ seat: item.seat, running: active, caps, gate, injectedCap });
      if (!budget.allow) {
        blocked.set(item.seat, { reason: `${budget.reason}: ${seatLine(item.seat, active, details)}`, active });
        continue;
      }
      if (finishHeld === undefined) {
        finishHeld = await finishGateReason(root, (deps.now ?? (() => new Date()))(), config.loops?.orchestrator?.finishGate ?? 'shadow',
          pool!.running + pool!.pending + pool!.reserved + unreadableState.penalty
          + current.filter((row) => row.status === 'launching' || row.status === 'launched').length, pool!.limit, deps);
      }
      if (finishHeld) { blocked.set(item.seat, { reason: finishHeld, active }); continue; }
      if (requestedId && item.id !== requestedId) {
        const requested = current.find((row) => row.id === requestedId)!;
        // The requested row's own block is the truthful reason — even when its seat comes later in the rotation and was not
        // evaluated yet; «another seat's turn» only when the requested seat itself has room.
        const own = blocked.get(requested.seat)?.reason ?? (() => {
          const ownCap = deps.cap?.(requested.seat);
          const details = seatCapDetails({ seat: requested.seat, caps, gate, injectedCap: ownCap });
          const active = seatActive(requested.seat);
          if (active >= details.cap) return seatLine(requested.seat, active, details);
          const budget = decideSpawn({ seat: requested.seat, running: active, caps, gate, injectedCap: ownCap });
          return budget.allow ? undefined : `${budget.reason}: ${seatLine(requested.seat, active, details)}`;
        })();
        const reason = own ?? `다른 자리 차례 — ${item.seat}`;
        if (requested.waitingReason !== reason) save(path, current.map((row) => row.id === requestedId ? { ...row, waitingReason: reason } : row));
        observe('waiting', { id: requested.id, seat: requested.seat, reason }, deps);
        return { outcome: 'waiting', item: { ...requested, waitingReason: reason }, reason };
      }
      // 발사 직전 다시 본다 — 틱 앞의 확인과 여기 사이에 await(idleRequest·pool·finish 측정)가 있어 그새 켜진 동결을 놓치지 않게.
      const lateHold = launchFreezeHold(root, (deps.now ?? (() => new Date()))(), queueProdFreezeRoot(root, deps));
      if (lateHold) {
        save(path, current.map((row) => row.id === item.id ? { ...row, waitingReason: lateHold.reason } : row));
        observe('waiting', { id: item.id, seat: item.seat, reason: lateHold.reason }, deps);
        try { debug.log('loop.orchestrator', 'freeze-held-launch', { reason: lateHold.freezeReason, until: lateHold.until, queued: 1, phase: 'pre-launch' }); }
        catch { /* Observation cannot affect dispatch. */ }
        return { outcome: 'waiting', item: { ...item, waitingReason: lateHold.reason }, reason: lateHold.reason };
      }
      // QUEUE-BURST: scheduled launches stay `launchStaggerMs` after the last queue launch — any tick or process, a direct
      // launch included — so an overlapping cron tick cannot double a burst. A requested (direct say/ask) tick keeps its
      // launch-at-once contract (ONEDOOR-2) and only records its time for the next scheduled tick.
      const stagger = requestedId ? 0 : deps.launchStaggerMs ?? QUEUE_LAUNCH_STAGGER_MS;
      const lastAt = stagger > 0 ? lastQueueLaunchAt(path) : undefined;
      const sinceLast = lastAt === undefined ? undefined : (deps.now ?? (() => new Date()))().getTime() - lastAt;
      if (sinceLast !== undefined && sinceLast >= 0 && sinceLast < stagger) {
        const reason = `${queueStaggerPrefix} — 마지막 발사 ${Math.floor(sinceLast / 1000)}s 전 · ${Math.round(stagger / 1000)}s 간격`;
        save(path, current.map((row) => row.id === item.id ? { ...row, waitingReason: reason } : row));
        observe('waiting', { id: item.id, seat: item.seat, reason, sinceLastMs: sinceLast, staggerMs: stagger }, deps);
        return { outcome: 'waiting', item: { ...item, waitingReason: reason }, reason };
      }
      // UUIDv7 carries the launch time, so the dead-row grace can run from launch without a new queue field.
      const launching: QueueItem = { ...item, status: 'launching', launchId: `hq-${Bun.randomUUIDv7()}` };
      delete launching.waitingReason;
      save(path, current.map((row) => row.id === item.id ? launching : row));
      try {
        const pid = await (deps.launch ?? defaultLaunch(deps.launchCommand))(launching, queueLaunchArgs(launching), root);
        if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('launcher returned no pid');
        const launched: QueueItem = { ...launching, pid, status: 'launched' };
        save(path, current.map((row) => row.id === item.id ? launched : row));
        try { saveLastLaunchedSeat(path, item.seat, (deps.now ?? (() => new Date()))().getTime()); }
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
  // An empty queue tick has nothing to advise on; logging it would flood the advice-unknown sample.
  if (actual.outcome === 'skipped' && !actual.item) return actual;
  try {
    const { kind } = compareLaunchAdvice(advice, actual.outcome);
    debug.log('resource.advice', 'launch-advice', {
      caller, verdict: advice.verdict, why: advice.why, actual: actual.outcome, kind, itemId: actual.item?.id ?? null,
    });
  } catch { /* Shadow observation cannot affect the queue result. */ }
  return actual;
}
