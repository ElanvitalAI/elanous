import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { debug } from '../../debug/log.js';
import { defaultListHarnessProcesses, type HarnessProcessRecord } from '../../harness/harness-cli-command.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { devVersion, listChecklist, type ChecklistItem } from '../../release-loop/checklist.js';
import { withFileLockSync } from '../../storage/file-lock.js';
import { getUserConfig, ORCHESTRATOR_DEFAULTS, type OrchestratorLoopConfig, type OrchestratorSeat } from '../../user-config.js';

export const TRAFFIC_SEATS = ['OP', 'TC', 'MK', 'UX'] as const;
export type TrafficCell = Pick<ChecklistItem, 'id' | 'title' | 'owner' | 'status'>;
export type TrafficProcess = Pick<HarnessProcessRecord, 'command' | 'elapsedSeconds' | 'cwd'> & { seat: OrchestratorSeat | null };
export type TrafficSeatRow = { seat: OrchestratorSeat; running: number; cap: number; idleFor: number | null; idle: boolean; nextCell: TrafficCell | null };
export type TrafficResult = { seats: TrafficSeatRow[]; unassigned: number; now: Date; idleMinutes: number };

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

/** Process-to-seat resolution occurs at the boundary; this decision does no IO. */
export function trafficTick({ processes, now, caps, lastLaunchAt, openCells, idleMinutes = 30 }: {
  processes: readonly TrafficProcess[];
  now: Date;
  caps: Readonly<Record<OrchestratorSeat, number>>;
  lastLaunchAt?: Partial<Record<OrchestratorSeat, Date | null>>;
  openCells: readonly TrafficCell[];
  idleMinutes?: number;
}): TrafficResult {
  const launches = processes.filter(process => IS_LAUNCH.test(process.command));
  const seats = TRAFFIC_SEATS.map((seat): TrafficSeatRow => {
    const owned = launches.filter(process => process.seat === seat);
    const latest = owned.reduce<number | null>((current, process) => {
      if (!Number.isFinite(process.elapsedSeconds) || process.elapsedSeconds < 0) return current;
      const start = now.getTime() - process.elapsedSeconds * 1000;
      return current === null ? start : Math.max(current, start);
    }, null);
    const fallback = owned.length ? lastLaunchAt?.[seat]?.getTime() : undefined;
    const last = latest ?? (fallback !== undefined && Number.isFinite(fallback) ? fallback : null);
    const idleFor = last === null ? null : Math.max(0, Math.floor((now.getTime() - last) / 60_000));
    const idle = owned.length < caps[seat] && last !== null && now.getTime() - last > idleMinutes * 60_000;
    return { seat, running: owned.length, cap: caps[seat], idleFor, idle,
      nextCell: idle ? openCells.find(cell => cell.status !== 'done' && cell.owner?.split('/')[0] === seat) ?? null : null };
  });
  return { seats, unassigned: launches.filter(process => process.seat === null).length, now, idleMinutes };
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
  log('loop.orchestrator', 'tick', { mode, seats: result.seats.map(({ seat, running, cap, idleFor, idle }) => ({ seat, running, cap, idleFor, idle })), unassigned: result.unassigned });
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
  return `traffic ${parts.join(' · ')} · idle=${idle.length ? idle.join(',') : '없음'} · mode=${mode}`;
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
    const result = trafficTick({ processes, now, caps: cfg.seatCaps, openCells: listChecklist(version).items });
    const queued = applyTraffic(result, { mode: cfg.trafficMode });
    if (args.includes('--json')) console.log(JSON.stringify({ ...result, mode: cfg.trafficMode, queued, version }));
    else console.log(trafficLine(result, cfg.trafficMode));
  } catch (error) {
    console.error(`traffic: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
