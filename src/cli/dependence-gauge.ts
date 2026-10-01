import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import type { Command } from 'commander';

/** Attribution is evidence about the executor, not about the person who requested the work. */
export type DependenceAttribution = 'claude-code' | 'elanous' | 'other' | 'unknown';
export type DependenceAxis = 'positions' | 'executions' | 'changes' | 'decisions';
export interface DependenceObservation {
  at?: string;
  runtime?: string;
  agent?: string;
  track?: string;
  /** A direct attribution supplied by a source record; never inferred from the author. */
  actor?: string;
}
export interface DependenceSource {
  observations: readonly DependenceObservation[];
  /** A missing source is different from an observed empty source. */
  unmeasurable?: string;
}
export interface DependenceAxisResult {
  status: 'measured' | 'unmeasurable';
  total: number;
  covered: number;
  claudeCode: number;
  elanous: number;
  other: number;
  unknown: number;
  /** Records whose timestamp cannot place them inside or outside the requested window. Not in total. */
  undated: number;
  reason?: string;
}
export interface DependenceReport {
  since: string;
  until: string;
  axes: Record<DependenceAxis, DependenceAxisResult>;
}
export interface DependenceGaugeDeps {
  now?: () => Date;
  readPositions?: () => DependenceSource;
  readExecutions?: () => DependenceSource;
  readChanges?: (window: { since: string; until: string }) => DependenceSource;
  readDecisions?: () => DependenceSource;
  out?: Pick<Console, 'log'>;
}

const axes = ['positions', 'executions', 'changes', 'decisions'] as const;
const identity = (value: unknown): DependenceAttribution => {
  if (typeof value !== 'string' || !value.trim()) return 'unknown';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'claude-code' || normalized === 'claude code') return 'claude-code';
  if (normalized === 'elanous') return 'elanous';
  if (normalized === 'unknown') return 'unknown';
  return 'other';
};

/** Explicit per-event runtime wins over an agent label, which wins over the seat default. */
export function attributeDependence(row: DependenceObservation, positions: ReadonlyMap<string, DependenceAttribution>): DependenceAttribution {
  if (row.actor?.trim()) return identity(row.actor);
  if (row.runtime?.trim()) return identity(row.runtime);
  if (row.agent?.trim()) return identity(row.agent);
  return row.track ? (positions.get(row.track) ?? 'unknown') : 'unknown';
}

function instant(raw: string, label: string): Date {
  // Date.parse silently normalizes impossible days (e.g. February 30), including timestamps.
  const calendarDate = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(raw)?.[1];
  if (calendarDate) {
    const day = new Date(`${calendarDate}T00:00:00.000Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== calendarDate) {
      throw new Error(`invalid ${label}: ${raw}`);
    }
  }
  const date = new Date(calendarDate === raw ? `${raw}T00:00:00.000Z` : raw);
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid ${label}: ${raw}`);
  return date;
}

function observationTime(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(raw);
  if (!match) return undefined;
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (day.toISOString().slice(0, 10) !== raw.slice(0, 10)) return undefined;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? time : undefined;
}

export function dependenceWindow(since: string | undefined, until: string | undefined, now: Date): { since: string; until: string } {
  const end = until ? instant(until, '--until') : now;
  if (!Number.isFinite(end.getTime())) throw new Error('invalid current date');
  // Date-only --until includes that entire UTC day; relative lookback is anchored to its end.
  const inclusiveEnd = until && /^\d{4}-\d{2}-\d{2}$/.test(until)
    ? new Date(end.getTime() + 86_400_000 - 1) : end;
  const match = /^(\d+)d$/.exec(since ?? '7d');
  const start = match ? new Date(inclusiveEnd.getTime() - Number(match[1]) * 86_400_000)
    : instant(since ?? '7d', '--since');
  if (!Number.isFinite(start.getTime()) || start > inclusiveEnd) throw new Error('invalid --since: start must be at or before --until');
  return { since: start.toISOString(), until: inclusiveEnd.toISOString() };
}

export function readSeatRegistry(): DependenceSource {
  try {
    const raw = JSON.parse(readFileSync(resolve(import.meta.dir, '../../scripts/coord-tracks.json'), 'utf8')) as { tracks?: unknown };
    if (!Array.isArray(raw.tracks)) return { observations: [], unmeasurable: 'seat registry has no tracks' };
    return { observations: raw.tracks.filter((track): track is { id: string; title: string; runtime?: string } =>
      typeof track === 'object' && track !== null && typeof track.id === 'string' && typeof track.title === 'string')
      .map(track => ({ track: track.id, runtime: track.runtime })) };
  } catch (error) {
    return { observations: [], unmeasurable: `seat registry unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function unknownSource(description: string): DependenceSource {
  return { observations: [], unmeasurable: description };
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readRunExecutions(directory = join(elanousStateRoot(), 'run-ledger')): DependenceSource {
  try {
    if (!existsSync(directory)) return unknownSource('run-ledger directory absent');
    const observations: DependenceObservation[] = [];
    for (const name of readdirSync(directory).filter(name => name.endsWith('.jsonl')).sort()) {
      const lines = readFileSync(join(directory, name), 'utf8').split('\n').filter(Boolean);
      let launch: DependenceObservation | undefined;
      for (const line of lines) {
        const entry = object(JSON.parse(line));
        if (entry.event === 'run-origin') {
          const data = object(entry.data);
          launch = { at: stringField(entry.timestamp), runtime: stringField(data.runtime),
            agent: stringField(data.agent), track: stringField(data.track) };
          break;
        }
        if (!launch) launch = { at: stringField(entry.timestamp) };
      }
      if (launch) observations.push(launch);
    }
    return { observations };
  } catch (error) {
    return unknownSource(`run-ledger unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 이 저장소의 실제 표지 — `Co-Authored-By:` 트레일러(작성자·커미터는 전부 같은 사람이라 쓰지 않는다).
 *  하니스 착지(`elanous pod child`) > codex > Claude 순 — 한 병합에 여러 표지면 실제로 코드를 쓴 쪽이 앞선다. */
export function runtimeFromCoAuthors(body: string): string | undefined {
  const names = [...body.matchAll(/^co-authored-by:[^\S\r\n]*([^<\r\n]*)/gim)].map(m => m[1]!.trim().toLowerCase());
  if (names.some(n => n.includes('elanous'))) return 'elanous';
  if (names.some(n => n.includes('codex'))) return 'codex';
  if (names.some(n => n.includes('claude'))) return 'claude-code';
  return undefined;
}

export function readChangeCommits(window: { since: string; until: string }, repo = resolve(import.meta.dir, '../..')): DependenceSource {
  // Git object reads only: author and committer are deliberately NOT treated as the executor.
  // 착지 = main 의 첫 부모 줄(스쿼시 병합 하나 = 착지 하나) — `--all` 은 가지의 중간 커밋까지 세어 부풀린다.
  const result = spawnSync('git', ['log', 'origin/main', '--first-parent', '--format=%cI%x1f%B%x1e', `--since-as-filter=${window.since}`, `--until=${window.until}`], {
    cwd: repo, encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) return unknownSource(`git history unreadable: ${result.error?.message ?? result.stderr ?? result.status}`);
  if (result.stdout.length >= 16 * 1024 * 1024 - 1024) return unknownSource('git history exceeds gauge read limit');
  const observations = result.stdout.split('\x1e').filter(record => record.includes('\x1f')).map(record => {
    const [at, body] = record.trim().split('\x1f', 2);
    const attribution = /(?:^|\n)(?:Executed-By|Agent-Runtime|Runtime):[^\S\r\n]*([^\r\n]*)/im.exec(body ?? '');
    return { at, runtime: attribution?.[1]?.trim() ?? runtimeFromCoAuthors(body ?? '') };
  });
  return { observations };
}

/** No mutation of ledgers or state; absent attribution data is reported, never guessed from an author or requester. */
export function measureDependence(deps: DependenceGaugeDeps = {}, options: { since?: string; until?: string } = {}): DependenceReport {
  const window = dependenceWindow(options.since, options.until, (deps.now ?? (() => new Date()))());
  const sources: Record<DependenceAxis, DependenceSource> = {
    positions: (deps.readPositions ?? readSeatRegistry)(),
    executions: (deps.readExecutions ?? readRunExecutions)(),
    changes: (deps.readChanges ?? readChangeCommits)(window),
    decisions: (deps.readDecisions ?? (() => unknownSource('decision actor cannot be measured from the available data')))(),
  };
  const positions = new Map<string, DependenceAttribution>();
  for (const row of sources.positions.observations) {
    if (row.track) positions.set(row.track, identity(row.runtime));
  }
  const result = {} as Record<DependenceAxis, DependenceAxisResult>;
  for (const axis of axes) {
    const source = sources[axis];
    const counts: DependenceAxisResult = { status: source.unmeasurable ? 'unmeasurable' : 'measured', total: 0, covered: 0, claudeCode: 0, elanous: 0, other: 0, unknown: 0, undated: 0,
      ...(source.unmeasurable ? { reason: source.unmeasurable } : {}) };
    for (const row of source.observations) {
      if (axis !== 'positions') {
        const at = observationTime(row.at);
        if (at === undefined) { counts.undated++; continue; }
        if (at < Date.parse(window.since) || at > Date.parse(window.until)) continue;
      }
      counts.total++;
      const attribution = attributeDependence(row, positions);
      if (attribution === 'unknown') counts.unknown++;
      else {
        counts.covered++;
        if (attribution === 'claude-code') counts.claudeCode++;
        else if (attribution === 'elanous') counts.elanous++;
        else counts.other++;
      }
    }
    result[axis] = counts;
  }
  return { ...window, axes: result };
}

export function formatDependenceReport(report: DependenceReport): string {
  return [
    `Dependence · ${report.since} — ${report.until}`,
    ...axes.map(axis => {
      const row = report.axes[axis];
      return `${axis}: ${row.status}${row.reason ? ` (${row.reason})` : ''} · coverage ${row.covered}/${row.total} · claude-code ${row.claudeCode} · elanous ${row.elanous} · other ${row.other} · unknown ${row.unknown} · undated ${row.undated}`;
    }),
  ].join('\n');
}

/** Register below the existing `self` command rather than creating a second top-level command. */
export function registerDependenceCommand(self: Command, deps: DependenceGaugeDeps = {}): void {
  self.command('dependence').description('Read-only attribution gauge (unknown is not zero)')
    .option('--since <date>', 'UTC date or lookback period (default 7d)', '7d')
    .option('--until <date>', 'UTC date or timestamp').option('--json', 'JSON output')
    .action((options: { since?: string; until?: string; json?: boolean }) => {
      const report = measureDependence(deps, options);
      (deps.out ?? console).log(options.json ? JSON.stringify(report) : formatDependenceReport(report));
    });
}
