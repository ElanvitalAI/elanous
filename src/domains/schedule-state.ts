import { execFileSync } from 'node:child_process';
import { cronMatches, matchField } from './cron-match.js';
import { calendarFields, resolveTimeZone } from '../time/format.js';
import { parseCronLine, unwrapCronCommand, type ScheduleRow } from './schedule-registry.js';

export type ScheduleState = 'live' | 'firing' | 'stale' | 'off';
/** Next scheduled instants in the runner's configured timezone, including DST folds/gaps. */
export function nextRuns(cron: string, now: Date, count = 5, opts?: { timeZone?: string }): string[] {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5 || !fields.every(f => /^[\d*,\-/]+$/.test(f)) ||
      !Number.isFinite(now.getTime()) || !Number.isInteger(count) || count < 1) return [];
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  if (count > 5) return [];
  const minutes = Array.from({ length: 60 }, (_, i) => i).filter(i => matchField(minute, i, 0, 59));
  const hours = Array.from({ length: 24 }, (_, i) => i).filter(i => matchField(hour, i, 0, 23));
  if (!minutes.length || !hours.length || !Array.from({ length: 12 }, (_, i) => i + 1).some(i => matchField(month, i, 1, 12))) return [];
  const timeZone = opts?.timeZone ?? resolveTimeZone().timeZone;
  const start = calendarFields(now, { timeZone });
  const result: number[] = [];
  // Five leap-day occurrences can span 20 years. For the API's count=5,
  // even impossible dates require only ~14,600 cheap calendar checks.
  const firstDay = Date.UTC(start.year, start.month - 1, start.day);
  const endDay = Date.UTC(start.year + Math.max(6, Math.min(count, 5) * 8), start.month - 1, start.day);
  for (let day = firstDay; day < endDay && result.length < count; day += 86_400_000) {
    const date = new Date(day);
    const mon = date.getUTCMonth() + 1, dateNum = date.getUTCDate();
    if (!matchField(month, mon, 1, 12)) continue;
    const weekday = date.getUTCDay();
    const domMatches = matchField(dom, dateNum, 1, 31);
    const dowMatches = matchField(dow.replace(/7/g, '0'), weekday, 0, 6);
    if (dom !== '*' && dow !== '*' ? !(domMatches || dowMatches) : !(domMatches && dowMatches)) continue;

    // UTC noon of this wall date and its neighbors cover ordinary DST folds/gaps.
    // Validate each projected instant with the runner's canonical cron matcher.
    const offsets = new Set<number>();
    for (const delta of [-12, 12, 36]) {
      const sample = day + delta * 3_600_000;
      const wall = calendarFields(new Date(sample), { timeZone });
      offsets.add((Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - sample) / 60_000);
    }
    const candidates: number[] = [];
    for (const h of hours) for (const m of minutes) {
      const wallMs = day + h * 3_600_000 + m * 60_000;
      for (const offset of offsets) {
        const ms = wallMs - offset * 60_000;
        if (ms > now.getTime()) candidates.push(ms);
      }
    }
    candidates.sort((a, b) => a - b);
    for (const ms of candidates) {
      if (ms === result[result.length - 1]) continue;
      if (cronMatches(cron, new Date(ms), { timeZone })) result.push(ms);
      if (result.length === count) break;
    }
  }
  return result.map(ms => new Date(ms).toISOString());
}

function futureRuns(row: ScheduleRow, now: Date): string[] {
  if (row.cron) return nextRuns(row.cron, now, 5);
  if (row.interval_ms && row.interval_ms > 0) {
    const origin = row.last_run ? Date.parse(row.last_run) : now.getTime();
    const base = Number.isFinite(origin) ? origin : now.getTime();
    const first = base + (Math.floor((now.getTime() - base) / row.interval_ms) + 1) * row.interval_ms;
    return Array.from({ length: 5 }, (_, i) => new Date(first + i * row.interval_ms!).toISOString());
  }
  return [];
}

/** Only actual scheduler ownership confers liveness; registry.enabled is not evidence. */
export function computeScheduleState({ row, crontabLines, triggerRegistered, launchdLoaded, now, nextRuns: upcoming, timeZone }: {
  row: ScheduleRow;
  crontabLines: readonly string[];
  triggerRegistered: boolean;
  launchdLoaded: boolean;
  now: Date;
  nextRuns: readonly string[];
  timeZone?: string;
}): ScheduleState {
  const inCrontab = crontabLines.some(line => {
    const parsed = parseCronLine(line);
    return !!parsed && parsed.cron === row.cron &&
      (unwrapCronCommand(parsed.command).trim() === unwrapCronCommand(row.command ?? '').trim() ||
        (!!row.raw && line.trim() === row.raw.trim()));
  });
  const owned = inCrontab || triggerRegistered || launchdLoaded;
  if (!owned) return 'off';
  const last = row.last_run ? Date.parse(row.last_run) : NaN;
  const interval = row.interval_ms && row.interval_ms > 0 ? row.interval_ms : null;
  const first = upcoming.length ? Date.parse(upcoming[0]!) : NaN;
  const second = upcoming.length > 1 ? Date.parse(upcoming[1]!) : NaN;
  const period = interval ?? (Number.isFinite(first) && Number.isFinite(second) ? second - first : null);
  // No recorded fire means a miss cannot be measured — that is `no-history` (a card flag), not `stale` (a suspected miss).
  if (!Number.isFinite(last)) return 'live';
  if (row.cron) {
    // Only due instants after the last fire can be missed. In particular, a
    // weekday cron has no missing fires over the weekend, however long it is.
    const due = nextRuns(row.cron, new Date(last), 3, { timeZone });
    if (due.length === 3 && Date.parse(due[2]!) <= now.getTime()) return 'stale';
  } else if (period && period > 0 && now.getTime() - last > 2 * period) return 'stale';
  if (period && period > 0 && now.getTime() - last <= period) return 'firing';
  return 'live';
}

function normalizedCommand(command: string | null): string {
  return unwrapCronCommand(command ?? '').trim()
    .replace(/\s*>>?\s*\S+(?:\s+2>&1)?\s*$/, '')
    .replace(/^(?:cd\s+\S+\s*&&\s*)?(?:\S*\/)?(?:bun|node)\s+/, '')
    .replace(/\s+/g, ' ');
}

/** Mark every concurrently owned copy, not historical/off copies. */
export function findDuplicates<T extends { command: string | null; state: ScheduleState; flags?: string[] }>(rows: T[]): T[] {
  const byCommand = new Map<string, T[]>();
  for (const row of rows) {
    if (row.state === 'off') continue;
    const key = normalizedCommand(row.command);
    if (key) byCommand.set(key, [...(byCommand.get(key) ?? []), row]);
  }
  for (const group of byCommand.values()) {
    if (group.length < 2) continue;
    for (const row of group) row.flags = [...new Set([...(row.flags ?? []), 'duplicate'])];
  }
  return rows;
}

export function displayName(command: string): string {
  let text = command.trim().replace(/^cd\s+(?:'[^']+'|"[^"]+"|\S+)\s*&&\s*/, '');
  text = text.replace(/^(?:(?:export\s+)?[\w]+=(?:'[^']*'|"[^"]*"|\S+)\s+)+/, '');
  text = text.replace(/^(?:\S*\/)?(?:bun|node)\s+/, '');
  text = text.replace(/^(?:\S*\/)?scripts\/cron-run\.ts\s+(?:--shell\s+(?:bash|sh|zsh)\s+)?/, '');
  text = text.replace(/^(?:\S*\/)?bin\/elanous\.mjs\s*/, '');
  text = text.replace(/^(?:\S*\/)?scripts\//, 'scripts/');
  text = text.replace(/^elanous\s+/, '');
  return text.replace(/\s*>>?\s*\S+(?:\s+2>&1)?\s*$/, '').trim() || command.trim();
}

export interface LaunchdEntry { label: string; pid: number | null; lastExit: number | null }

/** launchctl list only; never load/unload services. */
export function listLaunchdElanous({ run = () => execFileSync('launchctl', ['list'], { encoding: 'utf8' }) }: {
  run?: () => string;
} = {}): LaunchdEntry[] {
  try {
    return run().split('\n').slice(1).map(line => {
      const m = /^\s*(-|\d+)\s+(-|\d+)\s+(com\.elanous\.[^\s]+)\s*$/.exec(line);
      return m ? { label: m[3]!, pid: m[1] === '-' ? null : Number(m[1]), lastExit: m[2] === '-' ? null : Number(m[2]) } : null;
    }).filter((entry): entry is LaunchdEntry => entry !== null);
  } catch { return []; }
}

export { futureRuns };
