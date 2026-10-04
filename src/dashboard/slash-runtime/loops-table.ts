import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { listLoops, type LoopEntry } from '../../loops/registry.js';
import { loopCronVerdict, type LoopCronVerdict } from '../../loops/verdict.js';
import { listSchedules, schedulesDbPath, type ScheduleRow } from '../../domains/schedule-registry.js';
import { nextRuns } from '../../domains/schedule-state.js';

export interface LoopsTableRow {
  layer: string;
  name: string;
  owner: string;
  mode: string;
  lastRun: string | null;
  verdict: LoopCronVerdict;
}

/** Read the already-inventoried local registry without opening/migrating a writable store. */
export function localLoopRows(now: Date): LoopsTableRow[] {
  let schedules: ScheduleRow[] = [];
  if (existsSync(schedulesDbPath())) {
    const db = new Database(schedulesDbPath(), { readonly: true });
    try { schedules = listSchedules(db); } finally { db.close(); }
  }
  const loops = listLoops({ schedules, now });
  const rows: LoopsTableRow[] = loops.map(loop => graphLoopRow(loop, schedules, now));
  const graphJobIds = new Set(loops.flatMap(loop => loop.jobs.map(job => job.id)));
  for (const schedule of schedules) {
    if (graphJobIds.has(schedule.id)) continue;
    rows.push(scheduleRow(schedule, 'local cron', now));
  }
  return rows;
}

export function cronSecondDueAt(cron: string | null, lastRun: string | null): string | null {
  if (!cron || !lastRun) return null;
  const last = new Date(lastRun);
  if (!Number.isFinite(last.getTime())) return null;
  return nextRuns(cron, last, 2)[1] ?? null;
}

export function graphLoopRow(loop: LoopEntry, schedules: ScheduleRow[], now: Date): LoopsTableRow {
  const active = loop.jobs.map(job => schedules.find(row => row.id === job.id)).filter((r): r is ScheduleRow => !!r);
  const cron = loop.trigger.cron ?? active[0]?.cron ?? null;
  const interval = active.find(r => r.interval_ms && r.interval_ms > 0)?.interval_ms ?? null;
  const lastRun = loop.lastRun?.at ?? active.map(r => r.last_run).filter((at): at is string => !!at).sort().at(-1) ?? null;
  const status = loop.lastRun?.status ?? active.find(r => r.last_run === lastRun)?.last_status ?? null;
  return {
    layer: 'local loop', name: loop.title, owner: loop.owner ?? '—', mode: loop.mode ?? (loop.trigger.cron ? 'cron' : 'event'), lastRun,
    verdict: loopCronVerdict({ enabled: loop.enabled, lastRunAt: lastRun, lastStatus: status, intervalMs: interval,
      secondDueAt: cronSecondDueAt(cron, lastRun) }, now.getTime()),
  };
}

export function scheduleRow(row: ScheduleRow, layer: string, now: Date): LoopsTableRow {
  return {
    layer, name: row.name, owner: row.domain ?? '—', mode: row.run_via || row.source,
    lastRun: row.last_run,
    verdict: loopCronVerdict({ enabled: !!row.enabled && row.disabled_reason !== 'vanished', lastRunAt: row.last_run,
      lastStatus: row.last_exit !== null && row.last_exit !== undefined && row.last_exit !== 0 ? 'failed' : row.last_status ?? null,
      intervalMs: row.interval_ms, secondDueAt: cronSecondDueAt(row.cron, row.last_run) }, now.getTime()),
  };
}

export function filterLoopRows(rows: LoopsTableRow[], owner?: string): LoopsTableRow[] {
  return owner ? rows.filter(row => row.owner !== '—' && row.owner.toLowerCase() === owner.toLowerCase()) : rows;
}

export function formatLoopsTable(rows: LoopsTableRow[], verdictColor: (text: string) => string): string[] {
  const columns = ['LAYER', 'NAME', 'OWNER', 'MODE', 'LAST RUN', 'VERDICT'];
  const data = rows.map(r => [r.layer, r.name, r.owner, r.mode, r.lastRun ?? '—', r.verdict]);
  const widths = columns.map((col, i) => Math.max(col.length, ...data.map(cells => cells[i]!.length)));
  const format = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i]!)).join('  ');
  return [format(columns), ...rows.map((row, i) => {
    const cells = data[i]!;
    return `${format(cells.slice(0, 5))}  ${row.verdict === 'late' || row.verdict === 'failed' ? verdictColor(cells[5]!) : cells[5]}`;
  })];
}
