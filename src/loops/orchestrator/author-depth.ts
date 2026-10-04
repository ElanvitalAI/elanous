import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { defaultListHarnessProcesses } from '../../harness/harness-cli-command.js';
import { listHarnessQueue, type QueueItem } from '../../harness/harness-queue.js';
import { releaseLedgerRoot } from '../../instance/resolve.js';
import { listChecklist, type ChecklistItem } from '../../release-loop/checklist.js';
import { listSchedules } from '../../release-loop/release-schedule.js';
import { getUserConfig, ORCHESTRATOR_DEFAULTS, type OrchestratorSeat } from '../../user-config.js';
import { collectWork, findOverlaps, type WorkItem } from './overlap.js';
import { seatOfTree, trafficTick, TRAFFIC_SEATS } from './traffic.js';

export type AuthorCell = Pick<ChecklistItem, 'id' | 'title' | 'owner' | 'status'> & { version: string };
export type AuthorQueueRow = Pick<QueueItem, 'seat' | 'status'> & Partial<Pick<QueueItem, 'input' | 'kind'>>;
export type AuthorDepthResult = {
  seats: Array<{ seat: OrchestratorSeat; cap: number | null; running: number | null; queued: number | null;
    target: number | null; short: number | null; wouldAuthor: Array<{ cellId: string; version: string; title: string }> }>;
  unreadable: Array<{ source: string; reason: string }>;
};
export type AuthorDepthInput = {
  seats: readonly OrchestratorSeat[];
  caps: Partial<Record<OrchestratorSeat, number | null>>;
  running: Partial<Record<OrchestratorSeat, number | null>> | null;
  queued: readonly AuthorQueueRow[] | null;
  cells: readonly AuthorCell[] | null;
  overlaps: readonly WorkItem[] | null;
  now: Date;
  unreadable?: AuthorDepthResult['unreadable'];
};

const cellRefs = (text: string): string[] => [...new Set([...text.matchAll(/\b\d+\.\d+\.\d+\s+칸\s+([A-Za-z][A-Za-z0-9-]*)/g)]
  .map(match => match[1]!))];

/** A shadow decision: candidates are compared against existing work, never entered into the queue. */
export function authorDepth({ seats, caps, running, queued, cells, overlaps, now, unreadable = [] }: AuthorDepthInput): AuthorDepthResult {
  const errors = [...unreadable];
  // Version selection happens in the collector at `now`; the pure calculation receives those cells already selected.
  // Reject an invalid snapshot clock rather than presenting its candidates as a valid shadow decision.
  const validClock = Number.isFinite(now.getTime());
  if (!validClock) errors.push({ source: 'clock', reason: 'invalid observation time' });
  const busy = queued === null ? null : queued.filter(row => row.status === 'queued' || row.status === 'launching');
  const queueWork: WorkItem[] = busy?.map((row, index) => ({
    kind: 'goal', ref: `queue:${index}`, seat: row.seat, files: [], cells: row.input ? cellRefs(row.input) : [],
  })) ?? [];
  const base = overlaps === null ? null : [...overlaps, ...queueWork];
  const unknownWorkCells = overlaps?.some(item => item.unreadable) ?? false;
  const availableCells = cells ?? [];
  // The collector supplies current release before next; numeric version order need not match release order.
  const versionOrder = new Map([...new Set(availableCells.map(cell => cell.version))]
    .map((version, index) => [version, index]));
  const missing = (source: string, seat: OrchestratorSeat): void => {
    if (!errors.some(item => item.source === source)) errors.push({ source, reason: `missing ${seat} observation` });
  };
  const rows = seats.map(seat => {
    const cap = caps[seat] ?? null;
    const active = running?.[seat] ?? null;
    if (cap === null) missing('caps', seat);
    if (active === null) missing('running', seat);
    if (queued === null) missing('queue', seat);
    if (cells === null && !errors.some(item => item.source === 'checklist' || item.source === 'versions')) missing('checklist', seat);
    if (overlaps === null || unknownWorkCells) missing('overlap', seat);
    const unknownQueueCells = busy?.some(row => row.seat === seat && (!row.input || cellRefs(row.input).length === 0)) ?? false;
    if (unknownQueueCells) missing('queue-cells', seat);
    const have = busy === null ? null : busy.filter(row => row.seat === seat).length;
    const depthKnown = cap !== null && active !== null && have !== null;
    const candidateKnown = validClock && cells !== null && base !== null && !unknownQueueCells && !unknownWorkCells;
    const target = cap === null || active === null ? null : Math.max(0, cap - active) + 2;
    const short = !depthKnown || !candidateKnown || target === null ? null : Math.max(0, target - have);
    return { seat, cap, running: active, queued: have, target, short,
      wouldAuthor: [] as Array<{ cellId: string; version: string; title: string }> };
  });
  const chosen = new Set<string>();
  for (const cell of [...availableCells].sort((a, b) => versionOrder.get(a.version)! - versionOrder.get(b.version)! || a.id.localeCompare(b.id))) {
    if (cell.status === 'green' || cell.status === 'done' || !cell.title.trim() || chosen.has(cell.id)) continue;
    const row = rows.find(entry => entry.seat === cell.owner?.split('/')[0]);
    if (!row || row.short === null || row.wouldAuthor.length >= row.short) continue;
    const candidate: WorkItem = { kind: 'goal', ref: `candidate:${cell.version}:${cell.id}`, seat: row.seat, files: [], cells: [cell.id] };
    if (findOverlaps([...base!, candidate]).some(overlap => overlap.type === 'cell' && overlap.cell === cell.id
      && overlap.refs.some(ref => ref.ref === candidate.ref))) continue;
    chosen.add(cell.id);
    row.wouldAuthor.push({ cellId: cell.id, version: cell.version, title: cell.title });
  }
  return { seats: rows, unreadable: errors };
}

export interface CollectAuthorDepthDeps {
  seats?: readonly OrchestratorSeat[];
  now?: Date;
  caps?: () => Partial<Record<OrchestratorSeat, number>>;
  running?: () => Partial<Record<OrchestratorSeat, number>>;
  queued?: () => readonly AuthorQueueRow[];
  cells?: (version: string) => readonly AuthorCell[];
  overlaps?: () => readonly WorkItem[];
  versions?: () => readonly [string, string];
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
}

function defaultVersions(now: Date): readonly [string, string] {
  if (!existsSync(join(releaseLedgerRoot(), 'release', 'features.sqlite'))) throw new Error('release schedule ledger unavailable');
  const upcoming = listSchedules().filter(row => row.cutAt && Date.parse(row.cutAt) > now.getTime())
    .sort((a, b) => Date.parse(a.cutAt) - Date.parse(b.cutAt));
  if (upcoming.length < 2) throw new Error('current and next release schedules unavailable');
  return [upcoming[0]!.version, upcoming[1]!.version];
}

/** Independent collection failures are surfaced, never substituted with an apparently empty source. */
export function collectAuthorDepth(deps: CollectAuthorDepthDeps = {}): AuthorDepthResult {
  const seats = deps.seats ?? TRAFFIC_SEATS;
  const now = deps.now ?? new Date();
  const unreadable: AuthorDepthResult['unreadable'] = [];
  const observe = <T>(source: string, read: () => T): T | null => {
    try { return read(); }
    catch (error) { unreadable.push({ source, reason: error instanceof Error ? error.message : String(error) }); return null; }
  };
  const cfg = deps.caps && deps.running ? null : observe('config', () => getUserConfig().loops?.orchestrator ?? ORCHESTRATOR_DEFAULTS);
  const caps = deps.caps ? observe('caps', deps.caps) : cfg === null ? null : observe('caps', () => cfg.seatCaps);
  const running = deps.running ? observe('running', deps.running) : cfg === null ? null : observe('running', () => {
    const observation = defaultListHarnessProcesses();
    if (observation.status !== 'ok') throw new Error(`process observation ${observation.status}`);
    const processes = observation.records.map(process => ({ ...process,
      seat: seatOfTree(process.cwdStatus === 'unknown' ? undefined : process.cwd, cfg) }));
    const measured = trafficTick({ processes, now, caps: cfg.seatCaps, openCells: [] });
    if (measured.unassigned) throw new Error(`${measured.unassigned} unassigned harness launch process(es)`);
    return Object.fromEntries(measured.seats.map(row => [row.seat, row.running]));
  });
  const queued = observe('queue', deps.queued ?? (() => listHarnessQueue()));
  const versions = observe('versions', deps.versions ?? (() => defaultVersions(now)));
  const cells = versions === null ? null : observe('checklist', () => versions.flatMap(version => {
    if (!deps.cells && !existsSync(join(releaseLedgerRoot(), 'release', 'features.sqlite')))
      throw new Error('checklist ledger unavailable');
    return deps.cells?.(version) ?? listChecklist(version).items.map(item => ({ ...item, version }));
  }));
  const overlaps = observe('overlap', deps.overlaps ?? (() => {
    const observed = collectWork();
    if (observed.unreadableTrees || observed.unreadableGoals || observed.work.some(item => item.unreadable))
      throw new Error(`incomplete work observation: trees=${observed.unreadableTrees} goals=${observed.unreadableGoals}`);
    return observed.work;
  }));
  const result = authorDepth({ seats, now, caps: caps ?? {}, running, queued, cells, overlaps, unreadable });
  const log = deps.log ?? ((category: string, event: string, data: Record<string, unknown>) => debug.log(category, event, data));
  for (const row of result.seats) log('loop.orchestrator', 'would-author', {
    seat: row.seat, target: row.target, have: row.queued, short: row.short, cells: row.wouldAuthor,
  });
  return result;
}

export function authorDepthLines(result: AuthorDepthResult): string[] {
  return result.seats.map(row => `${row.seat} ${row.running ?? '?'}/${row.cap ?? '?'} · 대기 ${row.queued ?? '?'} · 목표 ${row.target ?? '?'} · 모자람 ${row.short ?? '?'} → ${row.wouldAuthor.map(cell => cell.cellId).join(', ') || '없음'}`);
}

if (import.meta.main) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--json')) throw new Error('usage: author-depth.ts [--json]');
    const result = collectAuthorDepth();
    if (process.argv.includes('--json')) console.log(JSON.stringify(result));
    else {
      for (const line of authorDepthLines(result)) console.log(line);
      for (const source of result.unreadable) console.error(`author-depth ${source.source}: ${source.reason}`);
    }
  } catch (error) {
    console.error(`author-depth: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
