import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { autoStartScheduledRelease, selectScheduledCut } from './auto-start.js';
import { listSchedules, setSchedule } from './release-schedule.js';

let root = '';
const cut = '2026-10-04T04:00:00.000Z';
function setup() {
  root = mkdtempSync(join(tmpdir(), 'release-auto-start-'));
  setElanousConfigDir(root);
  setSchedule('0.2.8', { cutAt: '2026-10-04T13:00+09:00' }, 'OP', root);
}
afterEach(() => { resetElanousConfigDir(); if (root) rmSync(root, { recursive: true, force: true }); root = ''; });

test('cut window includes the exact cut and its last millisecond; excludes before and after', () => {
  setup();
  const schedules = listSchedules(root);
  expect(selectScheduledCut(schedules, new Date('2026-10-04T03:59:59.999Z'), 15)).toBeNull();
  expect(selectScheduledCut(schedules, new Date(cut), 15)?.version).toBe('0.2.8');
  expect(selectScheduledCut(schedules, new Date('2026-10-04T04:15:00.000Z'), 15)?.version).toBe('0.2.8');
  expect(selectScheduledCut(schedules, new Date('2026-10-04T04:15:00.001Z'), 15)).toBeNull();
  expect(() => selectScheduledCut(schedules, new Date(cut), 0)).toThrow('windowMinutes');
  expect(() => selectScheduledCut(schedules, new Date(cut), Number.NaN)).toThrow('windowMinutes');
});

test('multiple eligible cuts choose earliest cut, independent of ledger row ordering', () => {
  setup();
  setSchedule('0.2.9', { cutAt: '2026-10-04T13:05+09:00' }, 'OP', root);
  const schedules = listSchedules(root);
  const at = new Date('2026-10-04T04:06:00Z');
  expect(selectScheduledCut(schedules, at, 15)?.version).toBe('0.2.8');
  expect(selectScheduledCut(schedules.reverse(), at, 15)?.version).toBe('0.2.8');
});

test('default is read-only; apply launches once and forwards the selected version', async () => {
  setup();
  const called: string[] = [];
  const now = new Date(cut);
  const launch = (version: string) => { called.push(version); };
  expect(await autoStartScheduledRelease({ ledgerRoot: root, windowMinutes: 15, now, launch })).toEqual({ status: 'planned', version: '0.2.8', cutAt: cut });
  expect(called).toEqual([]);
  expect(await autoStartScheduledRelease({ ledgerRoot: root, windowMinutes: 15, now, apply: true,
    readiness: () => ({ ready: true, reason: 'ready', details: { ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] } }), launch })).toEqual({ status: 'started', version: '0.2.8', cutAt: cut });
  expect(called).toEqual(['0.2.8']);
  expect(await autoStartScheduledRelease({ ledgerRoot: root, windowMinutes: 15, now: new Date('2026-10-04T04:15:00.001Z'), apply: true, launch })).toEqual({ status: 'no-cut' });
  expect(called).toEqual(['0.2.8']);
});

test('a live run for the selected version is skipped without launching or changing its lock', async () => {
  setup();
  const dir = join(root, 'release', '0.2.8');
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'run.lock');
  const data = JSON.stringify({ pid: process.pid, startedAt: cut });
  writeFileSync(lock, data);
  let launched = false;
  expect(await autoStartScheduledRelease({ ledgerRoot: root, windowMinutes: 15, now: new Date(cut), apply: true,
    launch: () => { launched = true; } })).toEqual({ status: 'skipped', version: '0.2.8', reason: 'already-running' });
  expect(launched).toBe(false);
  expect(readFileSync(lock, 'utf8')).toBe(data);
});

test('blocked checklist is skipped and does not launch the release', async () => {
  setup();
  let launched = false;
  expect(await autoStartScheduledRelease({ ledgerRoot: root, windowMinutes: 15, now: new Date(cut), apply: true,
    readiness: () => ({ ready: false, reason: 'checklist-blocked', details: { ok: false, red: ['K1'], undecided: [], blocked: [], moved: [], knownIssues: [] } }),
    launch: () => { launched = true; } })).toEqual({ status: 'skipped', version: '0.2.8', reason: 'checklist-blocked' });
  expect(launched).toBe(false);
});

test('a launch-time deferral is reported as skipped, not started', async () => {
  setup();
  expect(await autoStartScheduledRelease({ ledgerRoot: root, windowMinutes: 15, now: new Date(cut), apply: true,
    readiness: () => ({ ready: true, reason: 'ready', details: { ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] } }),
    launch: () => ({ deferred: true, reason: 'frozen' }),
  })).toEqual({ status: 'skipped', version: '0.2.8', reason: 'frozen' });
});

test('already published version is skipped before launch', async () => {
  setup();
  mkdirSync(join(root, 'release', '0.2.8'), { recursive: true });
  writeFileSync(join(root, 'release', '0.2.8', 'release.json'), JSON.stringify({ publishedAt: cut }));
  let launched = false;
  expect(await autoStartScheduledRelease({ ledgerRoot: root, windowMinutes: 15, now: new Date(cut), apply: true,
    launch: () => { launched = true; } })).toEqual({ status: 'skipped', version: '0.2.8', reason: 'already-published' });
  expect(launched).toBe(false);
});
