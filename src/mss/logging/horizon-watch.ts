import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { debug } from '../../debug/log.js';
import { registerStandaloneLogSink } from '../../domains/standalone-log-sink.js';
import { LogStore, logsDbPath } from './log-store.js';

type HorizonStatus = 'present' | 'empty' | 'unreadable';
type Attribution = 'first-sample' | 'none' | 'attributed' | 'unattributed-loss';

export interface HorizonSample {
  atMs: number;
  oldestTsMs: number | null;
  status: HorizonStatus;
  spanHours: number | null;
  advancedMs: number;
  deletedEvents: number;
  attribution: Attribution;
}

export type HorizonTick = HorizonSample & { outcome: 'ok' | 'fail' };

export interface HorizonWatchOptions { db?: string; state?: string }
export interface HorizonWatchDeps {
  openStore?: (path: string) => Pick<LogStore, 'horizon' | 'queryAll' | 'close'>;
  now?: () => number;
  stateDir?: string;
}

function lastReadableSample(path: string): HorizonSample | null {
  let content = '';
  try { content = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const line of content.trimEnd().split('\n').reverse()) {
    if (!line) continue;
    const sample = JSON.parse(line) as HorizonSample;
    if (sample.status !== 'unreadable') return sample;
  }
  try { return JSON.parse(readFileSync(join(dirname(path), 'last-readable.json'), 'utf8')) as HorizonSample; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function saveReadableCheckpoint(path: string, sample: HorizonSample): void {
  const checkpoint = join(dirname(path), 'last-readable.json');
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${checkpoint}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(sample) + '\n');
    renameSync(temporary, checkpoint);
  } finally { rmSync(temporary, { force: true }); }
}

function saveSample(path: string, sample: HorizonSample): void {
  let lines: string[];
  try { lines = readFileSync(path, 'utf8').trimEnd().split('\n').filter(Boolean); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    lines = [];
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, [...lines.slice(-499), JSON.stringify(sample)].join('\n') + '\n');
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
  if (sample.status !== 'unreadable') saveReadableCheckpoint(path, sample);
}

/** Read the store only; samples live outside logs.db and observations go through debug sinks. */
export function runHorizonWatchTick(opts: HorizonWatchOptions = {}, deps: HorizonWatchDeps = {}): HorizonTick {
  const path = join(deps.stateDir ?? opts.state ?? join(elanousStateRoot(), 'log-horizon'), 'samples.jsonl');
  // Serialize the entire read/compare/append transaction across cron and manual processes.
  // This lock database is in the sample state directory, never in logs.db.
  mkdirSync(dirname(path), { recursive: true });
  const lock = new Database(join(dirname(path), 'samples.lock.db'));
  try {
    lock.run('PRAGMA busy_timeout = 120000');
    lock.run('BEGIN IMMEDIATE');
    try {
      return recordSample();
    } finally {
      lock.run('ROLLBACK');
    }
  } finally {
    lock.close();
  }

  function recordSample(): HorizonTick {
    const now = deps.now ?? Date.now;
    // The tick clock is read *after* the horizon read (see below), so every `deleted` event logged before the
    // horizon was observed has ts <= atMs. Windows are half-open (prev.atMs, atMs]: each event is counted once.
    let atMs: number | undefined;
    let oldestTsMs: number | null = null;
  let status: HorizonStatus = 'unreadable';
  let deletedEvents = 0;
  let store: ReturnType<NonNullable<HorizonWatchDeps['openStore']>> | undefined;
  let previous: HorizonSample | null = null;
  try {
    store = (deps.openStore ?? LogStore.openReadOnly)(opts.db ?? logsDbPath());
    const horizon = store.horizon();
    atMs = now();
    status = horizon.status;
    oldestTsMs = horizon.status === 'present' ? horizon.oldestTsMs : null;
    previous = lastReadableSample(path);
    if (previous) {
      deletedEvents = store.queryAll({
        exactCategories: ['log-store.retention'], events: ['deleted'], sinceMs: previous.atMs + 1, untilMs: atMs,
      }).length;
    }
  } catch (error) {
    debug.log('log-store.horizon', 'read-failed', { reason: String(error) }, { level: 'warn' });
    status = 'unreadable';
    oldestTsMs = null;
  } finally { store?.close(); }
  atMs ??= now();

  const advancedMs = status === 'present' && previous?.status === 'present' && previous.oldestTsMs !== null
    ? Math.max(0, oldestTsMs! - previous.oldestTsMs) : 0;
  const attribution: Attribution = status === 'unreadable' ? 'none'
    : !previous ? 'first-sample'
    : advancedMs === 0 ? 'none'
    : deletedEvents > 0 ? 'attributed' : 'unattributed-loss';
  const sample: HorizonSample = {
    atMs, oldestTsMs, status,
    spanHours: oldestTsMs === null ? null : (atMs - oldestTsMs) / 3_600_000,
    advancedMs, deletedEvents, attribution,
  };
  try { saveSample(path, sample); }
  catch (error) {
    debug.log('log-store.horizon', 'sample-write-failed', { reason: String(error) }, { level: 'warn' });
    return { ...sample, outcome: 'fail' };
  }
  debug.log('log-store.horizon', 'sample', {
    oldestTs: oldestTsMs === null ? null : new Date(oldestTsMs).toISOString(),
    spanHours: sample.spanHours, advancedMs, deletedEvents, attribution,
  }, { level: attribution === 'unattributed-loss' ? 'warn' : 'info' });
  return { ...sample, outcome: status === 'unreadable' ? 'fail' : 'ok' };
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opts: HorizonWatchOptions = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (arg === '--db' && args[i + 1]) opts.db = args[++i];
    else if (arg === '--state' && args[i + 1]) opts.state = args[++i];
    else { process.stderr.write(`Unknown or incomplete option: ${arg}\n`); process.exit(1); }
  }
  const sinkReady = await registerStandaloneLogSink('log-horizon');
  // A sink failure must not suppress the sample: the store read (and an 'unreadable' record) still happens,
  // but the tick cannot claim success because its observation never reached logs.db.
  const tick = runHorizonWatchTick(opts);
  const result = sinkReady ? tick : { ...tick, outcome: 'fail' as const, reason: 'log-sink-registration-failed' };
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`${result.outcome}: ${result.attribution} (${result.status})${sinkReady ? '' : ' · log-sink-registration-failed'}\n`);
  if (result.outcome === 'fail') process.exitCode = 1;
}
