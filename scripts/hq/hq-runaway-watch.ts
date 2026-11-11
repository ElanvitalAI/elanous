#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, truncateSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { acquireLockSync } from '../../src/storage/file-lock.js';

export const HQ_RUNAWAY_LOAD_THRESHOLD = 40; // Source: seat-state/OP/ROSTER-0308-MAINT-1108.md
const HQ_WATCH_TIMEOUT_MS = 10_000;

export interface HqLoadSample {
  load1: number;
  processes: Array<{ pid: number; cpuPercent: number; executable: string }>;
}

type WatchState = { high: boolean; lastAt: string };
export type HqRunawayEvent = { event: 'hq-load-high' | 'hq-load-recovered'; at: string; load1: number;
  threshold: number; processes: HqLoadSample['processes'] };

export function parseHqLoad(uptime: string, ps: string): HqLoadSample {
  const match = uptime.match(/load averages?:\s*([0-9]+(?:\.[0-9]+)?)/i);
  const load1 = Number(match?.[1]);
  if (!match || !Number.isFinite(load1)) throw new Error('HQ load measurement unavailable');
  const processes = ps.split(/\r?\n/).map(line => {
    const parts = line.trim().match(/^(\d+)\s+([0-9]+(?:\.[0-9]+)?)\s+(.+)$/);
    if (!parts) return null;
    const pid = Number(parts[1]);
    const cpuPercent = Number(parts[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(cpuPercent)) return null;
    // ps comm= is an executable path (not argv); strip synthetic flag tails defensively.
    const commandPath = parts[3]!.trim();
    // comm= is an executable path; reject argv-looking rows rather than risk recording an argument.
    if (/\s+(?:--?\S|\/)/.test(commandPath)) return null;
    const name = basename(commandPath);
    if (/\s/.test(name) && !existsSync(commandPath)) return null;
    return { pid, cpuPercent, executable: name.replace(/[^A-Za-z0-9._ -]/g, '').slice(0, 80) };
  }).filter((row): row is HqLoadSample['processes'][number] => row !== null)
    .sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 5);
  return { load1, processes };
}

function command(program: string, args: string[]): string {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: HQ_WATCH_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error(`HQ ${program} measurement failed`);
  return result.stdout ?? '';
}

export function runHqRunawayWatch(directory: string, deps: {
  now?: () => Date;
  measure?: () => HqLoadSample;
  afterEventAppended?: () => void;
} = {}): { status: 'high' | 'normal'; event: HqRunawayEvent | null } {
  const statePath = join(directory, 'hq-runaway-watch.state.json');
  const ledgerPath = join(directory, 'hq-runaway-watch.events.jsonl');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = acquireLockSync(`${statePath}.lock`, { staleMs: 30_000, breakDeadHolder: true });
  try {
    const now = (deps.now ?? (() => new Date()))();
    if (!Number.isFinite(now.getTime())) throw new Error('invalid HQ watch clock');
    const sample = (deps.measure ?? (() => parseHqLoad(command('uptime', []), command('ps', ['-Ao', 'pid=,%cpu=,comm=']))))();
    if (!Number.isFinite(sample.load1) || sample.load1 < 0) throw new Error('invalid HQ load sample');
    let previous: WatchState | undefined;
    if (existsSync(statePath)) {
      const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || typeof (parsed as WatchState).high !== 'boolean')
        throw new Error('invalid HQ runaway watch state');
      previous = parsed as WatchState;
    }
    // The ledger is authoritative when a process stops after appending an event but before replacing state.
    if (existsSync(ledgerPath)) {
      chmodSync(ledgerPath, 0o600);
      const body = readFileSync(ledgerPath, 'utf8');
      const committedLength = body.lastIndexOf('\n') + 1;
      let completeBody = body;
      if (committedLength !== body.length) {
        const tail = body.slice(committedLength);
        let completeTail = false;
        try {
          const parsed: unknown = JSON.parse(tail);
          completeTail = !!parsed && typeof parsed === 'object' &&
            ['hq-load-high', 'hq-load-recovered'].includes(String((parsed as HqRunawayEvent).event));
        } catch { /* A torn trailing JSON record was never committed. */ }
        if (completeTail) { appendFileSync(ledgerPath, '\n'); completeBody += '\n'; }
        else { truncateSync(ledgerPath, Buffer.byteLength(body.slice(0, committedLength))); completeBody = body.slice(0, committedLength); }
      }
      const rows = completeBody.trim().split('\n').filter(Boolean);
      if (rows.length) {
        const latest: unknown = JSON.parse(rows.at(-1)!);
        if (!latest || typeof latest !== 'object' ||
          !['hq-load-high', 'hq-load-recovered'].includes(String((latest as HqRunawayEvent).event)))
          throw new Error('invalid HQ runaway watch ledger');
        previous = { high: (latest as HqRunawayEvent).event === 'hq-load-high', lastAt: (latest as HqRunawayEvent).at };
      }
    }
    const high = sample.load1 >= HQ_RUNAWAY_LOAD_THRESHOLD;
    const changed = previous === undefined ? high : previous.high !== high;
    const event: HqRunawayEvent | null = changed ? { event: high ? 'hq-load-high' : 'hq-load-recovered',
      at: now.toISOString(), load1: sample.load1, threshold: HQ_RUNAWAY_LOAD_THRESHOLD,
      processes: sample.processes } : null;
    if (event) { appendFileSync(ledgerPath, `${JSON.stringify(event)}\n`, { mode: 0o600 }); deps.afterEventAppended?.(); }
    const temporary = `${statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ high, lastAt: now.toISOString() })}\n`, { mode: 0o600 });
    renameSync(temporary, statePath);
    chmodSync(statePath, 0o600);
    return { status: high ? 'high' : 'normal', event };
  } finally { release(); }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--state-dir' || !process.argv[3])
      throw new Error('usage: hq-runaway-watch.ts --state-dir <OP tools directory>');
    console.log(JSON.stringify(runHqRunawayWatch(process.argv[3])));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
