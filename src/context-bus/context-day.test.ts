import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openSurfaceEventsDb, recordEvent } from '../domains/surface-events.js';
import { emitSessionEvent } from './session-events.js';
import { recordExternalEvent } from './external-events.js';
import { recordCoordEvent } from './coord-events.js';
import { contextDay, contextDayHours, renderContextDay } from './context-day.js';

const now = '2026-10-04T12:00:00.000Z';

test('fake bus events count per seat and external origin, boundary, latest time and absent origins without writing on read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'context-day-'));
  const path = join(dir, 'events.db');
  const db = openSurfaceEventsDb(path);
  try {
    emitSessionEvent({ seat: 'OP', kind: 'task-claimed', text: 'claim', at: '2026-10-03T12:00:00.000Z' }, { db });
    emitSessionEvent({ seat: 'OP', kind: 'task-done', text: 'done', at: '2026-10-04T08:00:00.000Z' }, { db });
    emitSessionEvent({ seat: 'TC', kind: 'asked', text: 'ask', at: '2026-10-04T10:00:00.000Z' }, { db });
    emitSessionEvent({ seat: 'MK', kind: 'guidance-changed', text: 'guide', at: '2026-10-04T09:00:00.000Z' }, { db });
    recordCoordEvent({ seat: 'UX', kind: '요청', headline: 'help', recipients: [], all: false, slot: null, deadline: null, url: 'https://example.org/ux', at: '2026-10-04T11:00:00.000Z' }, { db });
    recordExternalEvent({ origin: 'claude-code', kind: 'claimed', summary: 'claim', source: 'elanous://test/claim', at: '2026-10-04T07:00:00.000Z' }, { db });
    recordExternalEvent({ origin: 'claude-code', kind: 'guide-changed', summary: 'guide', source: 'elanous://test/guide', at: '2026-10-04T11:30:00.000Z' }, { db });
    recordExternalEvent({ origin: 'codex-agent-mission', kind: 'started', summary: 'start', source: 'elanous://test/start', at: '2026-10-04T05:00:00.000Z' }, { db });
    recordExternalEvent({ origin: 'harness-child', kind: 'finished', summary: 'finish', source: 'elanous://test/finish', at: '2026-10-04T06:00:00.000Z' }, { db });
    emitSessionEvent({ seat: 'TC', kind: 'task-done', text: 'old', at: '2026-10-03T11:59:59.999Z' }, { db });
    emitSessionEvent({ seat: 'OP', kind: 'asked', text: 'future', at: '2026-10-04T12:00:00.001Z' }, { db });
    recordEvent(db, { surface: 'unrelated', direction: 'outbound', kind: 'asked', text: 'noise', ts: '2026-10-04T10:00:00.000Z' });
    recordEvent(db, { surface: 'context:session', direction: 'outbound', kind: 'unknown', text: 'seat activity', refs: JSON.stringify({ seat: 'TC' }), ts: '2026-10-04T10:30:00.000Z' });
    const before = (db.prepare('SELECT count(*) AS n, sum(recall_count) AS recalls FROM events').get() as { n: number; recalls: number });
    const report = contextDay('24h', { now: () => new Date(now), dbPath: path });
    expect(report.since).toBe('2026-10-03T12:00:00.000Z');
    expect(report.until).toBe(now);
    expect(report.rows.map(row => [row.source, row.counts, row.lastAt, row.status])).toEqual([
      ['OP', { 'task-claimed': 1, done: 1, asked: 0, 'guidance-changed': 0 }, '2026-10-04T08:00:00.000Z', '들어옴'],
      ['TC', { 'task-claimed': 0, done: 0, asked: 1, 'guidance-changed': 0 }, '2026-10-04T10:30:00.000Z', '들어옴'],
      ['MK', { 'task-claimed': 0, done: 0, asked: 0, 'guidance-changed': 1 }, '2026-10-04T09:00:00.000Z', '들어옴'],
      ['UX', { 'task-claimed': 0, done: 0, asked: 1, 'guidance-changed': 0 }, '2026-10-04T11:00:00.000Z', '들어옴'],
      ['claude-code', { 'task-claimed': 1, done: 0, asked: 0, 'guidance-changed': 1 }, '2026-10-04T11:30:00.000Z', '들어옴'],
      ['codex-agent-mission', { 'task-claimed': 1, done: 0, asked: 0, 'guidance-changed': 0 }, '2026-10-04T05:00:00.000Z', '들어옴'],
      ['harness-child', { 'task-claimed': 0, done: 1, asked: 0, 'guidance-changed': 0 }, '2026-10-04T06:00:00.000Z', '들어옴'],
    ]);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(renderContextDay(report)).toContain('| OP | 1 | 1 | 0 | 0 | 2026-10-04T08:00:00.000Z | 들어옴 |');
    expect((db.prepare('SELECT count(*) AS n, sum(recall_count) AS recalls FROM events').get())).toEqual(before);
    const short = contextDay('1h', { now: () => new Date(now), dbPath: path });
    expect(short.rows.find(row => row.source === 'claude-code')).toMatchObject({ status: '들어옴', lastAt: '2026-10-04T11:30:00.000Z' });
    expect(short.rows.find(row => row.source === 'harness-child')).toMatchObject({ status: '안 들어옴', lastAt: null });
    expect(renderContextDay(short)).toContain('| harness-child | 0 | 0 | 0 | 0 | — | 안 들어옴 |');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('missing bus remains absent and does not create a store; invalid windows fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'context-day-empty-'));
  try {
    const path = join(dir, 'missing.db');
    const report = contextDay(undefined, { now: () => new Date(now), dbPath: path });
    expect(report.rows).toHaveLength(7);
    expect(report.rows.every(row => row.status === '안 들어옴' && row.lastAt === null)).toBe(true);
    expect(() => statSync(path)).toThrow();
    for (const bad of ['0h', '-1h', '1.5h', '24', '99999999999999999999h']) expect(() => contextDayHours(bad)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI JSON reads an isolated fake bus without altering its store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'context-day-cli-'));
  const path = join(dir, 'surface_events.db');
  const db = openSurfaceEventsDb(path);
  try {
    emitSessionEvent({ seat: 'OP', kind: 'task-done', text: 'done' }, { db });
    const root = resolve(import.meta.dir, '../..');
    const result = Bun.spawnSync(['bun', 'bin/elanous.mjs', '--test', 'context', 'day', '--json'], {
      cwd: root, env: { ...process.env, ELANOUS_STATE_DIR: dir }, stdout: 'pipe', stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(new TextDecoder().decode(result.stdout)) as ReturnType<typeof contextDay>;
    expect(report.rows.find(row => row.source === 'OP')).toMatchObject({ status: '들어옴', counts: { done: 1 } });
    expect(report.rows.find(row => row.source === 'claude-code')).toMatchObject({ status: '안 들어옴', lastAt: null });
    expect(report.rows).toHaveLength(7);
    expect(existsSync(join(dir, 'config.json'))).toBe(false);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('CLI exposes the context day options in the real command tree', () => {
  const root = resolve(import.meta.dir, '../..');
  const result = Bun.spawnSync(['bun', 'bin/elanous.mjs', '--test', 'context', 'day', '--help'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).toBe(0);
  const output = new TextDecoder().decode(result.stdout);
  expect(output).toContain('Usage: elanous context day [options]');
  expect(output).toContain('--since <hours>');
  expect(output).toContain('--json');
});
