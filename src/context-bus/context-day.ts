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

/** Read only the context journal, not recallEvents (which mutates recall counts) or the writable DB opener. */
export function contextDay(since = '24h', deps: { now?: () => Date; dbPath?: string } = {}): ContextDayReport {
  const hours = contextDayHours(since);
  const now = (deps.now ?? (() => new Date()))();
  const until = now.toISOString();
  const from = new Date(now.getTime() - hours * 3_600_000).toISOString();
  const rows: ContextDayRow[] = CONTEXT_DAY_SOURCES.map(source => ({
    source, counts: { 'task-claimed': 0, done: 0, asked: 0, 'guidance-changed': 0 }, lastAt: null, status: '안 들어옴',
  }));
  const bySource = new Map(rows.map(row => [row.source, row]));
  const path = deps.dbPath ?? surfaceEventsDbPath();
  if (!existsSync(path)) return { since: from, until, rows };
  const db = new Database(path, { readonly: true });
  try {
    const events = db.prepare(`SELECT surface, kind, ts, refs FROM events
      WHERE surface IN ('coord:channel', 'context:session', 'context:external')
        AND direction='outbound' AND ts>=? AND ts<=? ORDER BY ts ASC`).all(from, until) as Array<{
      surface: string; kind: string; ts: string; refs: string | null;
    }>;
    for (const event of events) {
      let refs: { seat?: unknown; origin?: unknown };
      try { refs = JSON.parse(event.refs ?? '{}') as typeof refs; } catch { continue; }
      const source = event.surface === 'context:external' ? refs.origin : refs.seat;
      if (typeof source !== 'string') continue;
      const row = bySource.get(source as ContextDaySource);
      if (!row) continue;
      // Do not attribute an external hook to a seat (or a seat event to an external origin).
      if ((event.surface === 'context:external') !== (rows.indexOf(row) >= 4)) continue;
      row.lastAt = event.ts;
      row.status = '들어옴';
      const kind = kindFor(event.surface, event.kind);
      if (kind) row.counts[kind]++;
    }
  } finally { db.close(); }
  return { since: from, until, rows };
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
