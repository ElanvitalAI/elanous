import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { surfaceEventsDbPath } from '../domains/surface-events.js';

export const CONTEXT_DAY_SOURCES = ['OP', 'TC', 'MK', 'UX', 'claude-code', 'codex-agent-mission', 'harness-child'] as const;
export type ContextDaySource = typeof CONTEXT_DAY_SOURCES[number];
export type ContextDayKind = 'task-claimed' | 'done' | 'asked' | 'guidance-changed';
export interface ContextDayRow {
  source: ContextDaySource;
  counts: Record<ContextDayKind, number>;
  lastAt: string | null;
  status: '들어옴' | '안 들어옴';
}
export interface ContextDayReport { since: string; until: string; rows: ContextDayRow[] }
export interface ContextDayTimelineEvent {
  at: string;
  source: ContextDaySource;
  kind: ContextDayKind | 'other';
  summary: string;
  link: string | null;
}
export interface ContextDayTimelineReport { since: string; until: string; events: ContextDayTimelineEvent[] }
interface JournalEvent { surface: string; kind: string; ts: string; refs: string | null; summary: string | null }
type DayDeps = { now?: () => Date; dbPath?: string; seat?: ContextDaySource };

/** Reject malformed windows instead of silently changing the time range being judged. */
export function contextDayHours(since: string): number {
  if (!/^[1-9]\d*h$/.test(since)) throw new Error('--since requires positive hours, e.g. 24h');
  const hours = Number(since.slice(0, -1));
  if (!Number.isSafeInteger(hours) || hours * 3_600_000 > 8.64e15) throw new Error('--since is out of range');
  return hours;
}

function kindFor(surface: string, kind: string): ContextDayKind | null {
  if (surface === 'context:external') {
    if (kind === 'started' || kind === 'claimed') return 'task-claimed';
    if (kind === 'finished' || kind === 'done') return 'done';
    if (kind === 'guide-changed') return 'guidance-changed';
  }
  if (kind === 'task-claimed' || kind === 'claimed') return 'task-claimed';
  if (kind === 'task-done' || kind === 'done') return 'done';
  if (kind === 'asked' || (surface === 'coord:channel' && kind === '요청')) return 'asked';
  if (kind === 'guidance-changed' || kind === 'guide-changed') return 'guidance-changed';
  return null;
}

function sourceFor(event: JournalEvent): { source: ContextDaySource; refs: { url?: unknown; source?: unknown } } | null {
  let refs: { seat?: unknown; origin?: unknown; url?: unknown; source?: unknown };
  try { refs = JSON.parse(event.refs ?? '{}') as typeof refs; } catch { return null; }
  if (!refs || typeof refs !== 'object') return null;
  const source = event.surface === 'context:external' ? refs.origin : refs.seat;
  if (typeof source !== 'string' || !CONTEXT_DAY_SOURCES.some(item => item === source)) return null;
  const isExternal = CONTEXT_DAY_SOURCES.indexOf(source as ContextDaySource) >= 4;
  // Do not attribute an external hook to a seat (or a seat event to an external origin).
  if ((event.surface === 'context:external') !== isExternal) return null;
  return { source: source as ContextDaySource, refs };
}

/** Read only the context journal, not recallEvents (which mutates recall counts) or the writable DB opener. */
function readDay(since: string, deps: DayDeps): { since: string; until: string; events: JournalEvent[] } {
  const hours = contextDayHours(since);
  const now = (deps.now ?? (() => new Date()))();
  const until = now.toISOString();
  const from = new Date(now.getTime() - hours * 3_600_000).toISOString();
  const path = deps.dbPath ?? surfaceEventsDbPath();
  if (!existsSync(path)) return { since: from, until, events: [] };
  const db = new Database(path, { readonly: true });
  try {
    const events = db.prepare(`SELECT surface, kind, ts, refs, summary FROM events
      WHERE surface IN ('coord:channel', 'context:session', 'context:external')
        AND direction='outbound' AND ts>=? AND ts<=? ORDER BY ts ASC`).all(from, until) as JournalEvent[];
    return { since: from, until, events };
  } finally { db.close(); }
}

export function contextDay(since = '24h', deps: { now?: () => Date; dbPath?: string } = {}): ContextDayReport {
  const { since: from, until, events } = readDay(since, deps);
  const rows: ContextDayRow[] = CONTEXT_DAY_SOURCES.map(source => ({
    source, counts: { 'task-claimed': 0, done: 0, asked: 0, 'guidance-changed': 0 }, lastAt: null, status: '안 들어옴',
  }));
  const bySource = new Map(rows.map(row => [row.source, row]));
  for (const event of events) {
    const attribution = sourceFor(event);
    if (!attribution) continue;
    const row = bySource.get(attribution.source)!;
    row.lastAt = event.ts;
    row.status = '들어옴';
    const kind = kindFor(event.surface, event.kind);
    if (kind) row.counts[kind]++;
  }
  return { since: from, until, rows };
}

export function contextDayTimeline(since = '24h', deps: DayDeps = {}): ContextDayTimelineReport {
  if (deps.seat !== undefined && !CONTEXT_DAY_SOURCES.some(source => source === deps.seat)) {
    throw new Error(`unknown --seat: ${deps.seat}`);
  }
  const { since: from, until, events } = readDay(since, deps);
  const timeline: ContextDayTimelineEvent[] = [];
  for (const event of events) {
    const attribution = sourceFor(event);
    if (!attribution || (deps.seat && attribution.source !== deps.seat)) continue;
    const { url, source } = attribution.refs;
    const link = [url, source].find(value => typeof value === 'string' && /^(?:https?:\/\/|elanous:\/\/)[^\s]+$/.test(value));
    timeline.push({ at: event.ts, source: attribution.source, kind: kindFor(event.surface, event.kind) ?? 'other',
      summary: event.summary ?? '', link: typeof link === 'string' ? link : null });
  }
  return { since: from, until, events: timeline };
}

const kstFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function kst(at: string): string {
  const parts = Object.fromEntries(kstFormatter.formatToParts(new Date(at)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} KST`;
}

export function renderContextDayTimeline(report: ContextDayTimelineReport, dbPath = surfaceEventsDbPath()): string {
  const lines = [`맥락 사건 ${kst(report.since)} ~ ${kst(report.until)}`];
  if (!report.events.length) lines.push(`이 창에 사건 0건 — 원장 경로: ${dbPath}`);
  else lines.push(...report.events.map(event => `${kst(event.at).slice(11)} · ${event.source} · ${event.kind} · ${event.summary.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')} · ${event.link ?? '—'}`));
  lines.push(`${report.events.length}건 · 출처 ${new Set(report.events.map(event => event.source)).size}곳`);
  return lines.join('\n');
}

export function renderContextDay(report: ContextDayReport): string {
  return [
    `맥락 이벤트 ${report.since} ~ ${report.until} (UTC)`,
    '| 출처 | task-claimed | done | asked | guidance-changed | 마지막 시각 (UTC) | 상태 |',
    '| --- | ---: | ---: | ---: | ---: | --- | --- |',
    ...report.rows.map(row => `| ${row.source} | ${row.counts['task-claimed']} | ${row.counts.done} | ${row.counts.asked} | ${row.counts['guidance-changed']} | ${row.lastAt ?? '—'} | ${row.status} |`),
    '안 들어옴 = 이 시간 창에서 해당 출처 이벤트 0건 (Claude Code 훅 미설치 가능성; 설치 여부는 미확인). 카운트 열은 네 종류만 셈.',
  ].join('\n');
}
