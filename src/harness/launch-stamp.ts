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
  'nl-self-implement': 'self-implement',
  'daemon-self-implement': 'daemon-tool',
  'cli-self-orchestrate': 'self-orchestrate',
  'nl-self-orchestrate': 'self-orchestrate',
  'cli-harness-orchestrate': 'self-orchestrate',
  'cli-harness-mission': 'agent-mission',
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

/** Read the stamp off a ledger's first row. Missing or unreadable stamps are `unknown`. */
export function launchStampFromLedger(entries: readonly RunLedgerEntry[] | null | undefined): LaunchStamp {
  const first = entries?.[0];
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

export interface DoorTable {
  readonly sinceMs: number;
  readonly runs: number;
  readonly unknown: number;
  readonly outsideQueue: number;
  readonly viaQueue: number;
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

/** One row per door that actually fired, plus the period totals. Untagged ledgers count as `unknown`. */
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
  for (const file of list(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    const runId = file.slice(0, -'.jsonl'.length);
    const entries = load(runId, dir);
    if (!entries || entries.length === 0) continue;
    const started = entryTime(entries[0]);
    if (started !== undefined && started < cutoff) continue;
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
  return { sinceMs, runs, unknown, outsideQueue, viaQueue, rows };
}

export function renderLaunchDoors(table: DoorTable): string {
  const lines = [
    `doors  runs=${table.runs}  outside-queue=${table.outsideQueue}  via-queue=${table.viaQueue}  unknown=${table.unknown}`,
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
