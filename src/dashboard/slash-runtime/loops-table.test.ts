import { expect, test } from 'bun:test';
import { cronSecondDueAt, filterLoopRows, formatLoopsTable, graphLoopRow, scheduleRow, type LoopsTableRow } from './loops-table.js';
import type { LoopEntry } from '../../loops/registry.js';
import type { ScheduleRow } from '../../domains/schedule-registry.js';

const now = new Date('2026-01-01T12:00:00Z');
const cron: ScheduleRow = {
  id: 'job', name: 'pulse', source: 'crontab', cron: '* * * * *', interval_ms: 60_000, command: 'pulse',
  category: 'maintenance', domain: 'ops', enabled: 1, last_seen: null, last_run: '2026-01-01T11:57:00Z',
  note: null, managed_by: 'manual', raw: null, run_via: 'crontab', last_status: 'ok',
};

test('local cron rows use shared verdict and never conflate mode with owner', () => {
  expect(cronSecondDueAt('* * * * *', cron.last_run)).toBe('2026-01-01T11:59:00.000Z');
  expect(scheduleRow({ ...cron, interval_ms: null }, 'local cron', now).verdict).toBe('late');
  expect(scheduleRow({ ...cron, interval_ms: null, cron: '* * * * *', last_run: '2026-01-01T11:58:00Z' }, 'local cron', now).verdict).toBe('alive');
  expect(scheduleRow(cron, 'local cron', now)).toMatchObject({ owner: 'ops', mode: 'crontab', verdict: 'late' });
  expect(scheduleRow({ ...cron, last_exit: 1 }, 'local cron', now).verdict).toBe('failed');
  expect(scheduleRow({ ...cron, enabled: 0 }, 'local cron', now).verdict).toBe('off');
});

test('weekday cron stays alive over weekend and becomes late after two actual due runs', () => {
  const weekdayCron = '0 9 * * 1-5';
  const lastRun = '2026-01-09T09:00:00Z'; // Friday
  const friday = { ...cron, cron: weekdayCron, interval_ms: null, last_run: lastRun };
  const saturday = new Date('2026-01-10T12:00:00Z');
  const monday = new Date('2026-01-12T09:01:00Z');
  const tuesday = new Date('2026-01-13T09:01:00Z');
  expect(cronSecondDueAt(weekdayCron, lastRun)).toBe('2026-01-13T09:00:00.000Z');
  expect(scheduleRow(friday, 'local cron', saturday).verdict).toBe('alive');
  expect(scheduleRow(friday, 'local cron', monday).verdict).toBe('alive');
  expect(scheduleRow(friday, 'local cron', tuesday).verdict).toBe('late');
  expect(scheduleRow({ ...friday, interval_ms: 86_400_000 }, 'local cron', saturday).verdict).toBe('alive');
  const graph: LoopEntry = {
    id: 'weekday', title: 'Weekday', description: null, owner: 'ops', mode: 'cron', file: 'graphs/weekday.yaml',
    trigger: { cron: weekdayCron, events: [] }, jobs: [{ id: 'job', cron: weekdayCron, enabled: true }],
    enabled: true, lastRun: { at: lastRun, status: 'done', path: '', runId: 'r', failedNodes: [], durationMs: 5 }, nextRun: null,
  };
  expect(graphLoopRow(graph, [{ ...friday, interval_ms: 86_400_000 }], saturday).verdict).toBe('alive');
  expect(graphLoopRow(graph, [friday], tuesday).verdict).toBe('late');
});

test('graph loop rows preserve owner/mode and use graph last run', () => {
  const loop: LoopEntry = {
    id: 'pulse', title: 'Pulse graph', description: null, owner: 'ops', mode: 'autonomous', file: 'graphs/pulse.yaml',
    trigger: { cron: '* * * * *', events: [] }, jobs: [{ id: 'job', cron: '* * * * *', enabled: true }],
    enabled: true, nextRun: null, lastRun: { at: '2026-01-01T11:57:00Z', status: 'failed', path: '', runId: 'r', failedNodes: [], durationMs: 5 },
  };
  expect(graphLoopRow(loop, [cron], now)).toMatchObject({ owner: 'ops', mode: 'autonomous', lastRun: loop.lastRun!.at, verdict: 'failed' });
});

test('owner filter is exact case-insensitive and red applies to late and failed only', () => {
  const rows: LoopsTableRow[] = [
    { layer: 'daemon cron', name: 'pulse', owner: 'Ops', mode: 'cron', lastRun: null, verdict: 'late' },
    { layer: 'local loop', name: 'dig', owner: 'ops', mode: 'event', lastRun: null, verdict: 'failed' },
    { layer: 'local cron', name: 'other', owner: 'finance', mode: 'cron', lastRun: null, verdict: 'alive' },
    { layer: 'daemon loop', name: 'unknown', owner: '—', mode: 'exec', lastRun: null, verdict: 'alive' },
  ];
  expect(filterLoopRows(rows, '—')).toEqual([]);
  const filtered = filterLoopRows(rows, 'OPS');
  expect(filtered.map(r => r.name)).toEqual(['pulse', 'dig']);
  const lines = formatLoopsTable(rows, value => `<red>${value}</red>`);
  expect(lines[0]).toContain('VERDICT');
  expect(lines[1]).toContain('<red>late</red>');
  expect(lines[2]).toContain('<red>failed</red>');
  expect(lines[3]).not.toContain('<red>');
});
