import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { debug } from '../../debug/log.js';
import { defaultListHarnessProcesses, type HarnessProcessRecord } from '../../harness/harness-cli-command.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../../instance/resolve.js';
import { devVersion, listChecklist, type ChecklistItem } from '../../release-loop/checklist.js';
import { listSchedules } from '../../release-loop/release-schedule.js';
import { withFileLockSync } from '../../storage/file-lock.js';
import { getUserConfig, ORCHESTRATOR_DEFAULTS, type OrchestratorLoopConfig, type OrchestratorSeat } from '../../user-config.js';
import { finishAdvice, measureFinish, type FinishAdvice, type FinishMetrics, type MeasureFinishDeps } from './finish-rate.js';
import { collectAuthorDepth, type AuthorDepthResult, type CollectAuthorDepthDeps } from './author-depth.js';
import { calculateSeatBaseShares } from './seat-share.js';

export const TRAFFIC_SEATS = ['OP', 'TC', 'MK', 'UX'] as const;
export type TrafficCell = Pick<ChecklistItem, 'id' | 'title' | 'owner' | 'status'>;
export type TrafficProcess = Pick<HarnessProcessRecord, 'command' | 'elapsedSeconds' | 'cwd'> & { seat: OrchestratorSeat | null };
export type TrafficSeatRow = { seat: OrchestratorSeat; running: number; cap: number; baseShare: number | null; borrowed: number; lent: number; launchCap: number; idleFor: number | null; idle: boolean; nextCell: TrafficCell | null };
export type TrafficResult = { seats: TrafficSeatRow[]; unassigned: number; now: Date; idleMinutes: number; finish?: { metrics: FinishMetrics; advice: FinishAdvice } };

/** Same bounded walk as the CTX1 hook: a marker at the git root is checked before stopping. */
export function seatOfTree(cwd: string | undefined, cfg: Pick<OrchestratorLoopConfig, 'seatTrees'>): OrchestratorSeat | null {
  if (!cwd || !isAbsolute(cwd)) return null;
  let dir = resolve(cwd);
  for (let level = 0; level <= 6; level++) {
    const marker = join(dir, '.claude', 'seat');
    if (existsSync(marker)) {
      const seat = readFileSync(marker, 'utf8').trim();
      return TRAFFIC_SEATS.some(id => id === seat) ? seat as OrchestratorSeat : null;
    }
    if (existsSync(join(dir, '.git'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Compare real paths: on macOS a process cwd under /var reports as /private/var (10-04 MK: UX trees under $TMPDIR
  // never matched their configured /var/folders/... paths).
  const path = realOrResolved(cwd);
  for (const seat of TRAFFIC_SEATS) {
    if (cfg.seatTrees[seat]?.some(tree => {
      if (!isAbsolute(tree)) return false;
      const root = realOrResolved(tree);
      return path === root || path.startsWith(root + sep);
    })) return seat;
  }
  return null;
}

function realOrResolved(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

const IS_LAUNCH = /(?:^|\s)(?:\S*\/)?elanous\.mjs\s+(?:(?:--test|--config-dir\s+\S+)\s+)?harness\s+(?:ask|say)(?=\s|$)/;
/** A `harness ask|say` launch command line — the only processes `trafficTick` counts. */
export const isTrafficLaunch = (command: string): boolean => IS_LAUNCH.test(command);

/** Process-to-seat resolution occurs at the boundary; this decision does no IO. */
export function trafficTick({ processes, now, caps, lastLaunchAt, idleSince, openCells, nextRound, totalSlots, idleMinutes = 30 }: {
  processes: readonly TrafficProcess[];
  now: Date;
  caps: Readonly<Record<OrchestratorSeat, number>>;
  lastLaunchAt?: Partial<Record<OrchestratorSeat, Date | null>>;
  idleSince?: Partial<Record<OrchestratorSeat, Date | null>>;
  openCells: readonly TrafficCell[];
  nextRound?: readonly TrafficCell[];
  totalSlots?: number;
  idleMinutes?: number;
}): TrafficResult {
  const launches = processes.filter(process => IS_LAUNCH.test(process.command));
  const slotBudget = totalSlots ?? TRAFFIC_SEATS.reduce((sum, seat) => sum + caps[seat], 0);
  // A missing next round is unknown, not an empty round with zero remaining work.
  const baseShares = nextRound === undefined ? null : calculateSeatBaseShares({
    totalSlots: slotBudget, currentRound: openCells, nextRound, seatCaps: caps,
  });
  const seats = TRAFFIC_SEATS.map((seat): TrafficSeatRow => {
    const owned = launches.filter(process => process.seat === seat);
    const latest = owned.reduce<number | null>((current, process) => {
      if (!Number.isFinite(process.elapsedSeconds) || process.elapsedSeconds < 0) return current;
      const start = now.getTime() - process.elapsedSeconds * 1000;
      return current === null ? start : Math.max(current, start);
    }, null);
    const fallback = owned.length ? lastLaunchAt?.[seat]?.getTime() : undefined;
    const idleStart = idleSince?.[seat]?.getTime();
    const last = idleStart !== undefined && Number.isFinite(idleStart) ? idleStart
      : latest ?? (fallback !== undefined && Number.isFinite(fallback) ? fallback : null);
    const idleFor = last === null ? null : Math.max(0, Math.floor((now.getTime() - last) / 60_000));
    const nextCell = openCells.find(cell => cell.status !== 'done' && cell.owner?.split('/')[0] === seat) ?? null;
    const baseShare = baseShares?.[seat] ?? null;
    return { seat, running: owned.length, cap: caps[seat], baseShare, borrowed: 0, lent: 0,
      launchCap: baseShare === null ? caps[seat] : Math.max(owned.length, baseShare), idleFor,
      idle: owned.length < caps[seat] && last !== null && now.getTime() - last > idleMinutes * 60_000, nextCell };
  });
  if (baseShares !== null) {
    // Account for outstanding loans before lending new capacity. A returning
    // lender cannot launch into a slot still occupied by the borrower's run.
    for (const borrower of seats) {
      let excess = Math.max(0, borrower.running - borrower.baseShare!);
      borrower.borrowed += excess;
      for (const lender of seats) {
        if (!excess) break;
        if (lender === borrower) continue;
        const amount = Math.min(excess, Math.max(0, lender.baseShare! - lender.running - lender.lent));
        lender.lent += amount;
        excess -= amount;
      }
    }
    for (const lender of seats) {
      if (lender.nextCell) continue;
      let available = Math.max(0, lender.baseShare! - lender.running - lender.lent);
      for (const borrower of seats) {
        if (!available) break;
        if (borrower === lender || !borrower.nextCell) continue;
        const needed = Math.max(0, Math.min(borrower.cap, borrower.running + 1) - borrower.launchCap);
        const amount = Math.min(available, needed);
        lender.lent += amount;
        borrower.borrowed += amount;
        borrower.launchCap += amount;
        available -= amount;
      }
    }
    for (const lender of seats) lender.launchCap = Math.max(lender.running, lender.launchCap - lender.lent);
  }
  // Reserve one available global slot per possible request, including unknown-seat
  // launches in the occupied count; returning a lent share does not end its old run.
  let freeSlots = Math.max(0, slotBudget - launches.length);
  for (const row of seats) {
    if (row.nextCell && row.idle && row.running < row.launchCap) {
      if (freeSlots > 0) freeSlots--;
      else row.launchCap = row.running;
    }
    row.idle = row.idle && (row.nextCell === null || row.running < row.launchCap);
    if (!row.idle) row.nextCell = null;
  }
  return { seats, unassigned: launches.filter(process => process.seat === null).length, now, idleMinutes };
}

export function withFinishAdvice(result: TrafficResult, deps: MeasureFinishDeps = {}): TrafficResult {
  const metrics = measureFinish(deps, result.now);
  const totalSlots = result.seats.reduce((total, row) => total + row.cap, 0);
  return { ...result, finish: { metrics, advice: finishAdvice(metrics, totalSlots) } };
}

export type TrafficRequest = { key: string; receiptId: string; seat: OrchestratorSeat; text: string; status: 'queued'; queuedAt: string; source: 'orchestrator-traffic' };
export interface TrafficApplyDeps {
  mode?: 'shadow' | 'live';
  root?: string;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
}

/** Only the live branch opens the journal. The lock serializes hourly-key checks across CLI processes. */
export function applyTraffic(result: TrafficResult, deps: TrafficApplyDeps = {}): number {
  const log = deps.log ?? ((category: string, event: string, data: Record<string, unknown>) => debug.log(category, event, data));
  const mode = deps.mode ?? 'shadow';
  log('loop.orchestrator', 'tick', { mode, seats: result.seats.map(({ seat, running, cap, baseShare, borrowed, lent, launchCap, idleFor, idle }) =>
    ({ seat, running, cap, baseShare, borrowed, lent, launchCap, idleFor, idle })), unassigned: result.unassigned });
  if (result.finish) {
    const { finishSlots, launchSlots, state, reasons } = result.finish.advice;
    log('loop.orchestrator', 'would-rebalance', { finishSlots, launchSlots, state, reasons });
  }
  let queued = 0;
  for (const row of result.seats) {
    if (!row.idle) continue;
    const data = { seat: row.seat, running: row.running, cap: row.cap, idleMinutes: row.idleFor, nextCell: row.nextCell };
    if (mode !== 'live') {
      log('loop.orchestrator', 'would-nudge', data);
      continue;
    }
    if (!row.nextCell) {
      log('loop.orchestrator', 'exchange', { ...data, outcome: 'no-cell' });
      continue;
    }
    const path = join(deps.root ?? effectiveInstanceRoot(), 'seat-requests', 'requests.jsonl');
    const key = `orch-traffic:${row.seat}:${result.now.toISOString().slice(0, 13)}`;
    mkdirSync(dirname(path), { recursive: true });
    const appended = withFileLockSync(`${path}.lock`, () => {
      const previous = existsSync(path) ? readFileSync(path, 'utf8') : '';
      if (previous.split('\n').some(line => {
        if (!line) return false;
        try { return (JSON.parse(line) as { key?: string }).key === key; } catch { throw new Error('invalid seat request journal'); }
      })) return false;
      const request: TrafficRequest = { key, receiptId: key, seat: row.seat,
        text: `다음 칸 쏘라: ${row.nextCell!.id} ${row.nextCell!.title.slice(0, 60)} (지금 ${row.running}/${row.cap} · ${row.idleFor}분 놂)`,
        status: 'queued', queuedAt: result.now.toISOString(), source: 'orchestrator-traffic' };
      appendFileSync(path, JSON.stringify(request) + '\n');
      return true;
    });
    if (appended) queued++;
    log('loop.orchestrator', 'exchange', { ...data, key, outcome: appended ? 'queued' : 'duplicate' });
  }
  return queued;
}

export function trafficLine(result: TrafficResult, mode: 'shadow' | 'live'): string {
  const parts = result.seats.map(row => `${row.seat} ${row.running}/${row.cap}`);
  const idle = result.seats.filter(row => row.idle).map(row => row.seat);
  const prefix = `traffic ${parts.join(' · ')} · idle=${idle.length ? idle.join(',') : '없음'} · mode=${mode}`;
  if (!result.finish) return prefix;
  const { metrics, advice } = result.finish;
  const rate = (value: number | null) => value === null ? '?' : value.toFixed(2);
  return `${prefix} · finish rate=${rate(metrics.landingRate)} stale=${metrics.staleDrafts ?? '?'} conflict=${rate(metrics.conflictRatio)} → finish=${advice.finishSlots}/${advice.finishSlots + advice.launchSlots}`;
}

export type AuthorShadow = { cells: number; held: number; queuedForAuthor: number; status: 'complete' | 'incomplete'; receiptFailures: number };

/** Traffic stays authoritative: shadow collection and its ledger cannot change its decision or exit status. */
export function runTrafficTick({ processes, now, caps, openCells, nextRound, totalSlots, mode, finishDeps, applyDeps, authorDeps, collectAuthor = collectAuthorDepth, log = debug.log.bind(debug) }: {
  processes: readonly TrafficProcess[];
  now: Date;
  caps: Readonly<Record<OrchestratorSeat, number>>;
  openCells: readonly TrafficCell[];
  nextRound?: readonly TrafficCell[];
  totalSlots?: number;
  mode: 'shadow' | 'live';
  finishDeps?: MeasureFinishDeps;
  applyDeps?: TrafficApplyDeps;
  authorDeps?: Omit<CollectAuthorDepthDeps, 'caps' | 'running' | 'now'>;
  collectAuthor?: (deps: CollectAuthorDepthDeps) => AuthorDepthResult;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
}): { result: TrafficResult; queued: number; authorShadow: AuthorShadow | null } {
  const metrics = measureFinish(finishDeps, now);
  const advice = finishAdvice(metrics, TRAFFIC_SEATS.reduce((sum, seat) => sum + caps[seat], 0));
  const result = { ...trafficTick({ processes, now, caps, openCells, nextRound, totalSlots: totalSlots ?? advice.launchSlots }),
    finish: { metrics, advice } };
  const queued = applyTraffic(result, { ...applyDeps, mode });
  let authorShadow: AuthorShadow | null = null;
  let shadowFailure: Record<string, unknown> | null = null;
  try {
    const depth = collectAuthor({ ...authorDeps, now, caps: () => caps,
      running: () => Object.fromEntries(result.seats.map(row => [row.seat, row.running])) });
    const receiptFailures = depth.receiptFailures ?? depth.unreadable.filter(item => item.source === 'author-ledger').length;
    const incomplete = depth.unreadable.length > 0 || !depth.receiptCounts;
    authorShadow = { cells: depth.seats.reduce((total, row) => total + row.wouldAuthor.length, 0),
      held: depth.receiptCounts?.held ?? 0, queuedForAuthor: depth.receiptCounts?.queuedForAuthor ?? 0,
      status: incomplete ? 'incomplete' : 'complete', receiptFailures };
    if (incomplete) shadowFailure = { unreadable: depth.unreadable, ...(depth.receiptCounts ? {} : { reason: 'receipt counts unavailable' }) };
  } catch (error) {
    shadowFailure = { reason: error instanceof Error ? error.message : String(error) };
  }
  if (shadowFailure) {
    try { log('loops.author-depth', 'shadow-failed', shadowFailure); }
    catch { /* Shadow logging cannot change traffic's outcome. */ }
  }
  return { result, queued, authorShadow };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const versionFlag = args.indexOf('--version');
    const version = versionFlag < 0 ? devVersion().replace(/-dev\.\d+$/, '') : args[versionFlag + 1];
    if (!version || version.startsWith('--')
      || args.some((arg, i) => arg !== '--json' && i !== versionFlag && (versionFlag < 0 || i !== versionFlag + 1))) {
      throw new Error('usage: traffic.ts [--version <판>] [--json]');
    }
    const cfg = getUserConfig().loops?.orchestrator ?? ORCHESTRATOR_DEFAULTS;
    const observation = defaultListHarnessProcesses();
    if (observation.status !== 'ok') throw new Error(`process observation ${observation.status}`);
    const now = new Date();
    const processes = observation.records.map(process => ({ ...process, seat: seatOfTree(process.cwdStatus === 'unknown' ? undefined : process.cwd, cfg) }));
    const upcoming = listSchedules(releaseLedgerRoot()).filter(row => Date.parse(row.cutAt) > now.getTime())
      .sort((a, b) => Date.parse(a.cutAt) - Date.parse(b.cutAt));
    const currentIndex = upcoming.findIndex(row => row.version === version);
    const nextVersion = currentIndex < 0 ? upcoming[0]?.version : upcoming[currentIndex + 1]?.version;
    const { result, queued, authorShadow } = runTrafficTick({
      processes, now, caps: cfg.seatCaps, openCells: listChecklist(version).items,
      ...(nextVersion ? { nextRound: listChecklist(nextVersion).items } : {}), mode: cfg.trafficMode,
    });
    if (args.includes('--json')) console.log(JSON.stringify({ ...result, mode: cfg.trafficMode, queued, version, authorShadow }));
    else console.log(trafficLine(result, cfg.trafficMode));
  } catch (error) {
    console.error(`traffic: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
