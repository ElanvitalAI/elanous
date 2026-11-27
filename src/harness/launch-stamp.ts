/**
 * ONEDOOR-1 — every harness run stamps which door it came through,
 * who launched it, and whether it went through the queue.
 *
 * The stamp lives on the run ledger's first row (`run-origin`). A ledger
 * written before this stamp, or a launch that named no door, reads as
 * `unknown` — that is distinct from a count of zero.
 */
import { readdirSync } from 'node:fs';
import { loadRunLedger, runLedgerDir, type RunLedgerEntry } from '../self-implement/run-ledger.js';

export const LAUNCH_DOORS = [
  'harness-say',
  'harness-ask',
  'dev-ask',
  'self-implement',
  'self-orchestrate',
  'queue-tick',
  'agent-mission',
  'daemon-tool',
  'telegram',
  'pwa',
  'unknown',
] as const;

export type LaunchDoor = (typeof LAUNCH_DOORS)[number];

export const LAUNCH_SEATS = ['OP', 'TC', 'MK', 'UX'] as const;
export type LaunchSeat = (typeof LAUNCH_SEATS)[number];

export interface LaunchStamp {
  readonly entrance: LaunchDoor;
  /** Seat, human session, or loop name — whichever the launch actually named. */
  readonly actor: string;
  readonly viaQueue: boolean;
  readonly queueId?: string;
}

const ENTRANCE_TO_DOOR: Readonly<Record<string, LaunchDoor>> = {
  'cli-harness-say': 'harness-say',
  'cli-harness-ask': 'harness-ask',
  'cli-dev-ask': 'dev-ask',
  'cli-drive': 'dev-ask',
  'tui-slash-ask': 'dev-ask',
  'tui-slash-dev': 'dev-ask',
  'cli-self-implement': 'self-implement',
  // Retired CLI route retained for interpreting historical run-ledger rows.
  'cli-harness-mission': 'agent-mission',
  'nl-self-implement': 'self-implement',
  'daemon-self-implement': 'daemon-tool',
  'cli-self-orchestrate': 'self-orchestrate',
  'nl-self-orchestrate': 'self-orchestrate',
  'cli-harness-orchestrate': 'self-orchestrate',
  'agent-mission': 'agent-mission',
  'daemon-harness-ask': 'daemon-tool',
  'daemon-tool': 'daemon-tool',
  telegram: 'telegram',
  pwa: 'pwa',
};

const DOOR_SET = new Set<string>(LAUNCH_DOORS);

export function isLaunchDoor(value: string): value is LaunchDoor {
  return DOOR_SET.has(value);
}

/** Reuse an existing entrance tag. Anything unnamed or unrecognized is `unknown`, never a zero. */
export function doorFromEntrance(entrance: string | undefined | null): LaunchDoor {
  if (!entrance) return 'unknown';
  const trimmed = entrance.trim();
  if (!trimmed) return 'unknown';
  if (ENTRANCE_TO_DOOR[trimmed]) return ENTRANCE_TO_DOOR[trimmed];
  if (isLaunchDoor(trimmed)) return trimmed;
  return 'unknown';
}

export interface LaunchStampInput {
  readonly entrance?: string | null;
  readonly seat?: string | null;
  readonly session?: string | null;
  readonly loopName?: string | null;
  readonly viaQueue?: boolean;
  readonly queueId?: string | null;
  readonly env?: NodeJS.ProcessEnv;
}

function named(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Seat wins, then the human session, then the loop name. A blank actor stays blank. */
export function resolveLaunchActor(input: LaunchStampInput, env: NodeJS.ProcessEnv = process.env): string {
  const seat = named(input.seat) ?? named(env.ELANOUS_HARNESS_SEAT);
  if (seat && (LAUNCH_SEATS as readonly string[]).includes(seat)) return seat;
  return named(input.session)
    ?? named(env.ELANOUS_ORIGIN_SESSION)
    ?? named(input.loopName)
    ?? named(env.ELANOUS_LOOP_NAME)
    ?? '';
}

export function resolveLaunchStamp(input: LaunchStampInput = {}, env: NodeJS.ProcessEnv = input.env ?? process.env): LaunchStamp {
  const queueId = named(input.queueId) ?? named(env.ELANOUS_HARNESS_QUEUE_LAUNCH);
  const viaQueue = input.viaQueue === true || queueId !== undefined;
  const door = viaQueue ? 'queue-tick' : doorFromEntrance(input.entrance ?? env.ELANOUS_HARNESS_ENTRANCE);
  return {
    entrance: door,
    actor: resolveLaunchActor(input, env),
    viaQueue,
    ...(queueId ? { queueId } : {}),
  };
}

/** The row that carries the launch stamp: the first `run-origin` row (or any row with `data.launch`). A harness run
 *  writes authoring rows (`graph.unit` · `child-first-*`) before `run-origin`, so the first row is not the stamp. */
function stampRow(entries: readonly RunLedgerEntry[] | null | undefined): RunLedgerEntry | undefined {
  if (!entries) return undefined;
  return entries.find((entry) => entry?.event === 'run-origin')
    ?? entries.find((entry) => entry?.data && typeof entry.data === 'object' && 'launch' in entry.data)
    ?? entries[0];
}

/** Read the stamp off the ledger's `run-origin` row (first row for older ledgers). Missing or unreadable stamps are `unknown`. */
export function launchStampFromLedger(entries: readonly RunLedgerEntry[] | null | undefined): LaunchStamp {
  const first = stampRow(entries);
  const raw = first?.data?.launch;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { entrance: 'unknown', actor: '', viaQueue: false };
  }
  const launch = raw as Record<string, unknown>;
  const entrance = typeof launch.entrance === 'string' && isLaunchDoor(launch.entrance) ? launch.entrance : 'unknown';
  const queueId = typeof launch.queueId === 'string' && launch.queueId.trim() ? launch.queueId.trim() : undefined;
  return {
    entrance,
    actor: typeof launch.actor === 'string' ? launch.actor : '',
    viaQueue: launch.viaQueue === true || queueId !== undefined,
    ...(queueId ? { queueId } : {}),
  };
}

export interface DoorRow {
  readonly entrance: LaunchDoor;
  readonly runs: number;
  readonly viaQueue: number;
  readonly outsideQueue: number;
}

export interface DoorExcludedCounts {
  /** In-window graph-runner ledgers — first row names `data.graphId` without `data.launch`. */
  readonly graphRun: number;
  /** In-window seat-turn ledgers — first row event starts with `child-first-`. */
  readonly seatTurn: number;
}

export interface DoorTable {
  readonly sinceMs: number;
  readonly runs: number;
  readonly unknown: number;
  readonly outsideQueue: number;
  readonly viaQueue: number;
  readonly excluded: DoorExcludedCounts;
  readonly rows: readonly DoorRow[];
}

export interface DoorTableOptions {
  readonly dir?: string;
  readonly sinceMs?: number;
  readonly now?: number;
  readonly list?: (dir: string) => string[];
  readonly load?: (runId: string, dir: string) => RunLedgerEntry[] | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function entryTime(entry: RunLedgerEntry | undefined): number | undefined {
  if (!entry?.timestamp) return undefined;
  const parsed = Date.parse(entry.timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

type LedgerKind = 'harness' | 'graph-run' | 'seat-turn';

/**
 * Classify a ledger. Any `run-origin` row or `data.launch` property marks a harness run — a harness ledger starts
 * with authoring rows (`graph.unit` with graphId `self-implement`, `child-first-*` LLM calls) before its
 * `run-origin` row. Without one, a first row naming `data.graphId` is a graph-runner run and a first row event
 * starting with `child-first-` is a seat turn. Anything else is an unstamped legacy harness ledger.
 */
function ledgerKind(entries: readonly RunLedgerEntry[]): LedgerKind {
  const harness = entries.some((entry) => entry?.event === 'run-origin'
    || (entry?.data !== null && typeof entry?.data === 'object' && 'launch' in entry.data));
  if (harness) return 'harness';
  const first = entries[0];
  const data = first?.data;
  if (data && typeof data === 'object' && 'graphId' in data) return 'graph-run';
  if (typeof first?.event === 'string' && first.event.startsWith('child-first-')) return 'seat-turn';
  return 'harness';
}

/**
 * One row per door that actually fired, plus the period totals. Untagged
 * legacy harness ledgers count as `unknown`; graph-runner and seat-turn
 * ledgers never count as harness runs — they only tally in `excluded`.
 */
export function queryLaunchDoors(options: DoorTableOptions = {}): DoorTable {
  const dir = options.dir ?? runLedgerDir();
  const now = options.now ?? Date.now();
  const sinceMs = options.sinceMs ?? DAY_MS;
  const cutoff = now - sinceMs;
  const list = options.list ?? ((path: string) => {
    try { return readdirSync(path); } catch { return []; }
  });
  const load = options.load ?? ((runId: string, ledgerDir: string) => {
    try { return loadRunLedger(runId, ledgerDir); } catch { return null; }
  });
  const counts = new Map<LaunchDoor, { runs: number; viaQueue: number }>();
  let runs = 0;
  let unknown = 0;
  let outsideQueue = 0;
  let viaQueue = 0;
  let excludedGraphRun = 0;
  let excludedSeatTurn = 0;
  for (const file of list(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    const runId = file.slice(0, -'.jsonl'.length);
    const entries = load(runId, dir);
    if (!entries || entries.length === 0) continue;
    const started = entryTime(entries[0]);
    if (started !== undefined && started < cutoff) continue;
    const kind = ledgerKind(entries);
    if (kind === 'graph-run') {
      excludedGraphRun += 1;
      continue;
    }
    if (kind === 'seat-turn') {
      excludedSeatTurn += 1;
      continue;
    }
    const stamp = launchStampFromLedger(entries);
    runs += 1;
    if (stamp.entrance === 'unknown') unknown += 1;
    if (stamp.viaQueue) viaQueue += 1;
    else outsideQueue += 1;
    const row = counts.get(stamp.entrance) ?? { runs: 0, viaQueue: 0 };
    row.runs += 1;
    if (stamp.viaQueue) row.viaQueue += 1;
    counts.set(stamp.entrance, row);
  }
  const rows = [...counts.entries()]
    .map(([entrance, row]) => ({
      entrance,
      runs: row.runs,
      viaQueue: row.viaQueue,
      outsideQueue: row.runs - row.viaQueue,
    }))
    .sort((left, right) => right.runs - left.runs || left.entrance.localeCompare(right.entrance));
  return {
    sinceMs,
    runs,
    unknown,
    outsideQueue,
    viaQueue,
    excluded: { graphRun: excludedGraphRun, seatTurn: excludedSeatTurn },
    rows,
  };
}

export function renderLaunchDoors(table: DoorTable): string {
  const lines = [
    `doors  runs=${table.runs}  outside-queue=${table.outsideQueue}  via-queue=${table.viaQueue}  unknown=${table.unknown}`,
    `excluded graph-run=${table.excluded.graphRun} seat-turn=${table.excluded.seatTurn}`,
    'entrance          runs  via-queue  outside-queue',
  ];
  for (const row of table.rows) {
    lines.push(`${row.entrance.padEnd(16)} ${String(row.runs).padStart(4)}  ${String(row.viaQueue).padStart(9)}  ${String(row.outsideQueue).padStart(13)}`);
  }
  if (table.rows.length === 0) lines.push('(no runs)');
  const summed = table.rows.reduce((sum, row) => sum + row.runs, 0);
  lines.push(`total            ${String(summed).padStart(4)}`);
  return lines.join('\n');
}

const SINCE_PATTERN = /^(\d+)(m|h|d)$/;

/** `--since 1d` (also `30m`, `12h`). Anything else is refused rather than guessed. */
export function parseDoorSince(value: string | undefined, now = Date.now()): { sinceMs: number } | { error: string } {
  if (value === undefined || value === '') return { sinceMs: DAY_MS };
  const match = SINCE_PATTERN.exec(value.trim());
  if (!match) return { error: `--since 는 30m · 12h · 1d 형태여야 합니다: ${value}` };
  const amount = Number(match[1]);
  const unit = match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : DAY_MS;
  if (!Number.isSafeInteger(amount) || amount < 1) return { error: `--since 는 1 이상이어야 합니다: ${value}` };
  const sinceMs = amount * unit;
  if (sinceMs > now) return { sinceMs };
  return { sinceMs };
}
