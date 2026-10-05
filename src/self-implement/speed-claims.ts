import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prodInstanceRoot } from '../instance/resolve.js';
import { seatOfTree } from '../loops/orchestrator/traffic.js';
import { getUserConfig, ORCHESTRATOR_DEFAULTS } from '../user-config.js';
import { isRunStatus } from './run-status-mapping.js';
import { loadRunLedger, runLedgerDir, type RunLedgerEntry, type RunLedgerReader } from './run-ledger.js';

export type SpeedClaimsOutcome = 'merged' | 'failed' | 'abandoned' | 'completed-without-merge';
export type SpeedClaimsSeat = 'OP' | 'TC' | 'MK' | 'UX' | 'unknown';
export interface SpeedClaimsRow {
  seat: SpeedClaimsSeat;
  outcome: SpeedClaimsOutcome;
  count: number;
  underOneMinuteCount: number;
  medianMinutes: number;
  q1Minutes: number;
  q3Minutes: number;
}
export interface SpeedClaimsMeasurement {
  scope: 'self-implement-run-ledger';
  ledgerDirectory: string;
  status: 'measured' | 'cannot-measure';
  completedCount: number;
  inProgressCount: number;
  cannotMeasureCount: number;
  unknownSeatCount: number;
  rows: SpeedClaimsRow[];
  note: string;
  parent: ParentSpeedClaimsMeasurement;
}
export interface ParentSpeedClaimsEvent {
  ts: string;
  category: string;
  event: string;
  data: unknown;
}

export interface ParentSpeedClaimsRow {
  seat: 'OP' | 'TC' | 'MK' | 'UX' | 'direct' | 'unknown';
  stage: string;
  merged: boolean;
  count: number;
  medianMinutes: number;
  q1Minutes: number;
  q3Minutes: number;
}

export interface ParentSpeedClaimsMeasurement {
  scope: 'self-dev.orchestrate-parent-logs';
  status: 'measured' | 'cannot-measure';
  completedCount: number;
  inProgressCount: number;
  cannotMeasureCount: number;
  rows: ParentSpeedClaimsRow[];
  note: string;
}

export interface SpeedClaimsOptions {
  dir?: string;
  list?: (path: string) => string[];
  read?: RunLedgerReader;
  readSeat?: (runId: string, ledgerDirectory: string, entries: readonly RunLedgerEntry[]) => SpeedClaimsSeat;
  readParentEvents?: () => readonly ParentSpeedClaimsEvent[];
  readParentQueue?: () => unknown;
}

const NOTE = 'Child-ledger elapsed minutes from the first child event (or checkpoint creation when unavailable) to the recorded child end, including retries and resumes; this is not the parent launch-to-done interval. Only finished runs enter quartiles (linear interpolation at ranks (n-1)*p). In-progress runs (including parked) and missing, unreadable or invalid timestamps are excluded, not assigned zero. Seats come from the same state root checkpoint, launch queue or recorded launch tree; unresolved seats are counted separately. A completed run without a recorded merge is not a merge.';
const CANONICAL_RUN_ID = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEATS: readonly SpeedClaimsSeat[] = ['OP', 'TC', 'MK', 'UX', 'unknown'];

function checkpointFor(runId: string, ledgerDirectory: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dirname(ledgerDirectory), 'self-dev-runs', `${runId}.json`), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) && 'runId' in value && value.runId === runId
      ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function seatFromLaunch(runId: string, ledgerDirectory: string, entries: readonly RunLedgerEntry[]): SpeedClaimsSeat {
  const checkpoint = checkpointFor(runId, ledgerDirectory);
  if (SEATS.includes(checkpoint?.seat as SpeedClaimsSeat) && checkpoint?.seat !== 'unknown') return checkpoint!.seat as SpeedClaimsSeat;
  // Queue ids and launch ids are not run ids. Only an exact, unique ask-file match can attribute a queued launch.
  const goalFiles = new Set(entries.filter((entry) => entry.event === 'start')
    .map((entry) => entry.data.goalFile).filter((file): file is string => typeof file === 'string' && isAbsolute(file)));
  if (goalFiles.size === 1) {
    try {
      const queue: unknown = JSON.parse(readFileSync(join(dirname(ledgerDirectory), 'harness', 'queue.json'), 'utf8'));
      if (Array.isArray(queue)) {
        const matched = queue.filter((row) => row && typeof row === 'object' && row.kind === 'ask'
          && (row.status === 'launching' || row.status === 'launched' || row.status === 'finished')
          && row.input === [...goalFiles][0] && SEATS.includes(row.seat));
        if (matched.length === 1 && matched[0]!.seat !== 'unknown') return matched[0]!.seat as SpeedClaimsSeat;
      }
    } catch { /* An absent or unreadable queue cannot establish attribution. */ }
  }
  try {
    const cfg = getUserConfig().loops?.orchestrator ?? ORCHESTRATOR_DEFAULTS;
    const paths = entries.flatMap((entry) => entry.event === 'start' ? [entry.data.targetRoot] : entry.event === 'worktree' ? [entry.data.path] : []);
    const seats = new Set<SpeedClaimsSeat>();
    for (const path of paths) {
      if (typeof path !== 'string' || !isAbsolute(path)) continue;
      try {
        const seat = seatOfTree(path, cfg);
        if (seat) seats.add(seat);
      } catch { /* A removed or unreadable launch tree does not prove a seat. */ }
    }
    if (seats.size === 1) return [...seats][0]!;
  } catch { /* Unavailable seat configuration does not erase a readable run. */ }
  return 'unknown';
}

function parseTime(timestamp: unknown): number | null {
  if (typeof timestamp !== 'string') return null;
  const match = /^(\d{4})-(\d\d)-(\d\d)T\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.exec(timestamp);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) return null;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function time(entry: RunLedgerEntry | undefined): number | null {
  return parseTime(entry?.timestamp);
}

function percentile(sorted: readonly number[], p: number): number {
  const rank = (sorted.length - 1) * p;
  const low = Math.floor(rank);
  return sorted[low]! + (sorted[Math.ceil(rank)]! - sorted[low]!) * (rank - low);
}

function endOfRun(entries: readonly RunLedgerEntry[]): { entry: RunLedgerEntry; outcome: SpeedClaimsOutcome } | null {
  let end: { entry: RunLedgerEntry; outcome: SpeedClaimsOutcome } | null = null;
  for (const entry of entries) {
    if (entry.event === 'start') { end = null; continue; }
    if (entry.event === 'merged' && entry.data.merged === true) end = { entry, outcome: 'merged' };
    if (end?.outcome === 'merged') continue;
    if (entry.event === 'human-stop') end = { entry, outcome: 'abandoned' };
    if (entry.event === 'run-status' && isRunStatus(entry.data.runStatus)) {
      const status = entry.data.runStatus;
      if (status === 'completed') end = { entry, outcome: 'completed-without-merge' };
      else if (status === 'failed') end = { entry, outcome: entry.data.stage === 'aborted' ? 'abandoned' : 'failed' };
      else if (status === 'cancelled') end = { entry, outcome: 'abandoned' };
      else end = null;
    }
  }
  return end;
}

const PARENT_NOTE = 'Elapsed minutes from the earliest valid parent self-dev.orchestrate start log to the latest valid done log, grouped by that done.data.outcomes[].stage and merged flag. Only runs with both events and valid timestamps enter quartiles. A start without done is in progress. Seats use the same-runId queue seat when available, or direct when a readable queue has no matching entry; an unreadable queue remains unknown. Parent log queries are read-only and independent of child run ledgers.';
type ParentSeat = ParentSpeedClaimsRow['seat'];
const PARENT_SEATS: readonly ParentSeat[] = ['OP', 'TC', 'MK', 'UX', 'direct', 'unknown'];

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Read the first-class logs CLI rather than opening logs.db in the measurement process. */
function readParentEventsFromLogs(): ParentSpeedClaimsEvent[] {
  const command = fileURLToPath(new URL('../../bin/elanous.mjs', import.meta.url));
  const events: ParentSpeedClaimsEvent[] = [];
  let before: string | undefined;
  const seenCursors = new Set<string>();
  for (;;) {
    const result = spawnSync(process.execPath, [command, `--test=${fileURLToPath(new URL('../../', import.meta.url))}`, 'logs', '--instance', 'prod', '--category', 'self-dev.orchestrate', '--json', '--json-data', '--limit', '5000', ...(before ? ['--before', before] : [])], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || 'parent logs query failed');
    const lines = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    if (lines.some((line) => object(line._meta)?.type === 'log-query-unreadable-instances')) throw new Error('parent logs query incomplete');
    events.push(...lines.filter((line): line is Record<string, unknown> & ParentSpeedClaimsEvent =>
      line.store === 'prod' && line.category === 'self-dev.orchestrate' && typeof line.ts === 'string' && typeof line.event === 'string'));
    const limit = lines.find((line) => object(line._meta)?.type === 'log-query-limit');
    if (!limit) return events;
    const meta = object(limit._meta);
    const cursor = meta?.nextCursors ?? meta?.nextCursor;
    if (typeof cursor !== 'number' && !object(cursor)) throw new Error('parent logs pagination incomplete');
    const next = typeof cursor === 'number' ? String(cursor) : JSON.stringify(cursor);
    if (seenCursors.has(next)) throw new Error('parent logs pagination repeated a cursor');
    seenCursors.add(next);
    before = next;
  }
}

function readParentQueueFromState(): unknown {
  return JSON.parse(readFileSync(join(prodInstanceRoot(), 'harness', 'queue.json'), 'utf8')) as unknown;
}

/** Parent launch-to-done census; no child ledger id is used as a join key. */
export function measureParentSpeedClaims(
  events: readonly ParentSpeedClaimsEvent[], queue?: unknown,
): ParentSpeedClaimsMeasurement {
  const result: ParentSpeedClaimsMeasurement = {
    scope: 'self-dev.orchestrate-parent-logs', status: 'measured', completedCount: 0,
    inProgressCount: 0, cannotMeasureCount: 0, rows: [], note: PARENT_NOTE,
  };
  const queueRows = Array.isArray(queue) ? queue : object(queue)?.items;
  const queueByRun = new Map<string, ParentSeat | null>();
  if (Array.isArray(queueRows)) for (const raw of queueRows) {
    const entry = object(raw);
    if (entry && typeof entry.runId === 'string' && PARENT_SEATS.includes(entry.seat as ParentSeat) && entry.seat !== 'direct') {
      const seat = entry.seat as ParentSeat;
      queueByRun.set(entry.runId, queueByRun.has(entry.runId) && queueByRun.get(entry.runId) !== seat ? null : seat);
    }
  }
  const runs = new Map<string, { start?: number; end?: number; outcomes?: unknown }>();
  for (const event of events) {
    if (event.category !== 'self-dev.orchestrate' || (event.event !== 'start' && event.event !== 'done')) continue;
    const data = object(event.data);
    const runId = data?.runId;
    if (typeof runId !== 'string' || !CANONICAL_RUN_ID.test(runId)) { result.cannotMeasureCount++; continue; }
    const run = runs.get(runId) ?? {};
    const at = parseTime(event.ts);
    if (event.event === 'start') {
      if (at !== null) run.start = run.start === undefined || !Number.isFinite(run.start) ? at : Math.min(run.start, at);
      else if (run.start === undefined) run.start = NaN;
    } else if (at !== null && (run.end === undefined || !Number.isFinite(run.end) || at > run.end)) {
      run.end = at;
      run.outcomes = data?.outcomes;
    } else if (at === null && run.end === undefined) {
      run.end = NaN;
    }
    runs.set(runId, run);
  }
  const groups = new Map<string, { seat: ParentSeat; stage: string; merged: boolean; values: number[] }>();
  for (const [runId, run] of runs) {
    if (run.start === undefined && run.end !== undefined) { result.cannotMeasureCount++; continue; }
    if (run.end === undefined) { result.inProgressCount++; continue; }
    if (run.start === undefined || !Number.isFinite(run.start) || !Number.isFinite(run.end) || run.end < run.start || !Array.isArray(run.outcomes) || run.outcomes.length === 0) {
      result.cannotMeasureCount++;
      continue;
    }
    const seat = queueByRun.has(runId) ? (queueByRun.get(runId) ?? 'unknown') : Array.isArray(queueRows) ? 'direct' : 'unknown';
    const outcomes = run.outcomes.map(object);
    if (outcomes.some((outcome) => !outcome)) {
      result.cannotMeasureCount++;
      continue;
    }
    for (const outcome of outcomes) {
      const stage = typeof outcome!.stage === 'string' ? outcome!.stage : 'unknown';
      const merged = outcome!.merged === true;
      const key = JSON.stringify([seat, stage, merged]);
      const group = groups.get(key) ?? { seat, stage, merged, values: [] };
      group.values.push((run.end - run.start!) / 60_000);
      groups.set(key, group);
    }
    result.completedCount++;
  }
  result.rows = [...groups.values()].map(({ seat, stage, merged, values }) => {
    values.sort((a, b) => a - b);
    return { seat, stage, merged, count: values.length, medianMinutes: percentile(values, 0.5), q1Minutes: percentile(values, 0.25), q3Minutes: percentile(values, 0.75) };
  }).sort((a, b) => PARENT_SEATS.indexOf(a.seat) - PARENT_SEATS.indexOf(b.seat) || a.stage.localeCompare(b.stage));
  if (result.cannotMeasureCount > 0) result.status = 'cannot-measure';
  return result;
}

/** Read-only elapsed-time census of canonical local run ledgers, including unsuccessful runs. */
export function measureSpeedClaims(options: SpeedClaimsOptions = {}): SpeedClaimsMeasurement {
  const ledgerDirectory = resolve(options.dir ?? runLedgerDir());
  let parent: ParentSpeedClaimsMeasurement;
  try {
    const events = (options.readParentEvents ?? readParentEventsFromLogs)();
    let queue: unknown;
    try { queue = (options.readParentQueue ?? readParentQueueFromState)(); } catch { /* Queue absence does not erase parent observations or establish a direct launch. */ }
    parent = measureParentSpeedClaims(events, queue);
  } catch {
    parent = { ...measureParentSpeedClaims([]), status: 'cannot-measure' };
  }
  const result: SpeedClaimsMeasurement = {
    scope: 'self-implement-run-ledger', ledgerDirectory, status: 'measured',
    completedCount: 0, inProgressCount: 0, cannotMeasureCount: 0, unknownSeatCount: 0, rows: [], note: NOTE, parent,
  };
  let files: string[];
  try { files = (options.list ?? readdirSync)(ledgerDirectory); }
  catch { return { ...result, status: 'cannot-measure' }; }

  const groups = new Map<string, { seat: SpeedClaimsSeat; outcome: SpeedClaimsOutcome; values: number[] }>();
  for (const file of files.sort()) {
    const runId = file.endsWith('.jsonl') ? file.slice(0, -'.jsonl'.length) : '';
    if (!CANONICAL_RUN_ID.test(runId)) continue;
    try {
      const entries = loadRunLedger(runId, ledgerDirectory, options.read);
      if (!entries || entries.length === 0) { result.cannotMeasureCount++; continue; }
      const end = endOfRun(entries);
      const first = time(entries[0]);
      const createdAt = checkpointFor(runId, ledgerDirectory)?.createdAt;
      const creation = typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt >= 0 ? createdAt : null;
      const start = first === null ? creation : first;
      const endTime = end ? time(end.entry) : null;
      if (start === null || (end && (endTime === null || endTime < start))) {
        result.cannotMeasureCount++;
        continue;
      }
      if (!end) { result.inProgressCount++; continue; }
      const seat = (options.readSeat ?? seatFromLaunch)(runId, ledgerDirectory, entries);
      const safeSeat = SEATS.includes(seat) ? seat : 'unknown';
      if (safeSeat === 'unknown') result.unknownSeatCount++;
      const key = `${safeSeat}:${end.outcome}`;
      const group = groups.get(key) ?? { seat: safeSeat, outcome: end.outcome, values: [] };
      group.values.push((endTime! - start) / 60_000);
      groups.set(key, group);
      result.completedCount++;
    } catch { result.cannotMeasureCount++; }
  }
  result.rows = [...groups.values()].map(({ seat, outcome, values }) => {
    values.sort((a, b) => a - b);
    return { seat, outcome, count: values.length, underOneMinuteCount: values.filter((minutes) => minutes < 1).length, medianMinutes: percentile(values, 0.5), q1Minutes: percentile(values, 0.25), q3Minutes: percentile(values, 0.75) };
  }).sort((a, b) => SEATS.indexOf(a.seat) - SEATS.indexOf(b.seat) || a.outcome.localeCompare(b.outcome));
  if (result.cannotMeasureCount > 0) result.status = 'cannot-measure';
  return result;
}

export function renderSpeedClaims(result: SpeedClaimsMeasurement): string {
  return [
    'child run-ledger (child start → child end):',
    `ledger directory: ${result.ledgerDirectory}`,
    `status: ${result.status}`,
    `finished (quartile denominator): ${result.completedCount}`,
    `in progress (excluded): ${result.inProgressCount}`,
    `cannot measure (excluded): ${result.cannotMeasureCount}`,
    `unknown seat (finished): ${result.unknownSeatCount}`,
    ...result.rows.map((row) => `seat=${row.seat} outcome=${row.outcome} count=${row.count} underOneMinute=${row.underOneMinuteCount} median=${row.medianMinutes}m q1=${row.q1Minutes}m q3=${row.q3Minutes}m`),
    `note: ${result.note}`,
    'parent launch → done (self-dev.orchestrate):',
    `parent status: ${result.parent.status}`,
    `parent finished (quartile denominator): ${result.parent.completedCount}`,
    `parent in progress (excluded): ${result.parent.inProgressCount}`,
    `parent cannot measure (excluded): ${result.parent.cannotMeasureCount}`,
    ...result.parent.rows.map((row) => `seat=${row.seat} stage=${row.stage} merged=${row.merged} count=${row.count} median=${row.medianMinutes}m q1=${row.q1Minutes}m q3=${row.q3Minutes}m`),
    `parent note: ${result.parent.note}`,
  ].join('\n');
}
