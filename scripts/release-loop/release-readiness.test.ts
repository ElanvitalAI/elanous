import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseReadiness, type ReleaseReadinessDeps } from './release-readiness.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../../src/elanous-config-dir.js';
import { setSchedule } from '../../src/release-loop/release-schedule.js';
import { addItem, listChecklist } from '../../src/release-loop/checklist.js';
import { debug } from '../../src/debug/log.js';
import { spyOn } from 'bun:test';

const version = '0.2.6';
const clear = { ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] };
const blocked = { ...clear, ok: false, red: ['K13'] };

function fixture(run: (dir: string, deps: ReleaseReadinessDeps, write: (name: string, value: unknown) => void) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'release-readiness-'));
  const dir = join(root, 'release', version);
  mkdirSync(dir, { recursive: true });
  const write = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value));
  try { run(dir, { ledgerRoot: root, checklist: () => clear }, write); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('publishedAt takes precedence over a live lock and checklist without calling the gate', () => fixture((_dir, deps, write) => {
  write('release.json', { version, publishedAt: '2026-09-30T10:00:00Z' });
  write('run.lock', { pid: process.pid });
  expect(releaseReadiness(version, { ...deps, checklist: () => { throw new Error('not reached'); } })).toEqual({
    ready: false, reason: 'already-published', details: '2026-09-30T10:00:00Z',
  });
}));

test('a prepared record without publishedAt and a live PID prevent the checklist', () => fixture((_dir, deps, write) => {
  write('release.json', { version, preparedAt: 'now' });
  write('run.lock', { pid: process.pid });
  expect(releaseReadiness(version, { ...deps, checklist: () => { throw new Error('not reached'); } })).toEqual({
    ready: false, reason: 'already-running', details: String(process.pid),
  });
}));

test('missing lock, dead PID and malformed PID are absent; checklist determines readiness', () => fixture((dir, deps, write) => {
  expect(releaseReadiness(version, deps)).toEqual({ ready: true, reason: 'ready', details: clear });
  expect(existsSync(join(deps.ledgerRoot!, 'release/features.sqlite'))).toBe(false);
  write('run.lock', { pid: 12345 });
  expect(releaseReadiness(version, { ...deps, isPidAlive: () => false })).toEqual({ ready: true, reason: 'ready', details: clear });
  for (const pid of [0, -1, '12345', 1.5, null]) {
    write('run.lock', { pid });
    expect(releaseReadiness(version, { ...deps, isPidAlive: () => { throw new Error('invalid PID probed'); } })).toEqual({ ready: true, reason: 'ready', details: clear });
  }
  for (const value of ['not json', 'null']) {
    writeFileSync(join(dir, 'run.lock'), value);
    expect(releaseReadiness(version, deps)).toEqual({ ready: true, reason: 'ready', details: clear });
  }
}));

test('checklist-blocked retains the full gate result after an absent lock', () => fixture((_dir, deps) => {
  expect(releaseReadiness(version, { ...deps, checklist: () => blocked })).toEqual({ ready: false, reason: 'checklist-blocked', details: blocked });
}));

test('version rejects path traversal before reading the ledger', () => fixture((_dir, deps) => {
  expect(() => releaseReadiness('../0.2.6', deps)).toThrow('release version must be x.y.z');
}));

test('주입 시계가 컷 전이면 before-cut · 정확히 컷 시각이면 기존 체크리스트 판정', () => fixture((_dir, deps) => {
  setElanousConfigDir(deps.ledgerRoot!);
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    setSchedule(version, { cutAt: '2026-10-03T08:00+09:00', landBy: '2026-10-03T06:30+09:00' }, 'OP');
    const early = { ...deps, now: () => new Date('2026-10-02T22:59:00Z'), checklist: () => { throw new Error('gate reached before cut'); } };
    expect(releaseReadiness(version, early)).toEqual({ ready: false, reason: 'before-cut', details: 'before-cut (10-03(토) 08:00 KST)' });
    expect(log).toHaveBeenCalledWith('release.schedule', 'before-cut', { version, cutAt: '2026-10-02T23:00:00.000Z', landBy: '2026-10-02T21:30:00.000Z' });
    expect(releaseReadiness(version, { ...deps, now: () => new Date('2026-10-02T23:00:00Z') })).toEqual({ ready: true, reason: 'ready', details: clear });
    expect(releaseReadiness(version, { ...deps, now: () => new Date('2026-10-02T23:00:00Z'), checklist: () => blocked })).toEqual({ ready: false, reason: 'checklist-blocked', details: blocked });
  } finally { log.mockRestore(); resetElanousConfigDir(); }
}));

test('해당 판 일정이 없으면 다른 판에 컷이 있어도 기존 판정 유지', () => fixture((_dir, deps) => {
  setElanousConfigDir(deps.ledgerRoot!);
  try {
    setSchedule('0.2.7', { cutAt: '2099-10-03T08:00+09:00' }, 'OP');
    expect(releaseReadiness(version, { ...deps, now: () => new Date('2026-10-02T22:59:00Z') })).toEqual({ ready: true, reason: 'ready', details: clear });
    expect(releaseReadiness(version, { ...deps, checklist: () => blocked })).toEqual({ ready: false, reason: 'checklist-blocked', details: blocked });
  } finally { resetElanousConfigDir(); }
}));

test('GATE-ENTRY-ALIGN: past the landing deadline readiness lets non-P0 yellows through and blocks on P0 yellows', () => fixture((_dir, deps) => {
  setElanousConfigDir(deps.ledgerRoot!);
  try {
    setSchedule(version, { cutAt: '2026-10-03T08:00+09:00', landBy: '2026-10-03T06:30+09:00' }, 'OP');
    addItem(version, { id: 'LATE', title: 'Missed deadline', owner: 'TC', priority: 'P1' });
    const real = { ledgerRoot: deps.ledgerRoot, now: () => new Date('2026-10-02T23:00:00Z') };
    expect(releaseReadiness(version, real)).toMatchObject({ ready: true, reason: 'ready', details: { moved: ['LATE'], undecided: [] } });
    addItem(version, { id: 'URGENT', title: 'P0 open', owner: 'TC', priority: 'P0' });
    expect(releaseReadiness(version, real)).toMatchObject({ ready: false, reason: 'checklist-blocked', details: { blocked: ['URGENT'] } });
    // Readiness only judges — nothing is carried to the next version.
    expect(listChecklist(version).items.map((item) => item.id)).toEqual(['LATE', 'URGENT']);
  } finally { resetElanousConfigDir(); }
}));

test('GATE-ENTRY-ALIGN: before the landing deadline an undecided non-P0 yellow still blocks readiness', () => fixture((_dir, deps) => {
  setElanousConfigDir(deps.ledgerRoot!);
  try {
    setSchedule(version, { cutAt: '2026-10-03T06:00+09:00', landBy: '2026-10-03T08:30+09:00' }, 'OP');
    addItem(version, { id: 'WAIT', title: 'Before deadline', priority: 'P1' });
    expect(releaseReadiness(version, { ledgerRoot: deps.ledgerRoot, now: () => new Date('2026-10-02T22:00:00Z') })).toMatchObject({ ready: false, reason: 'checklist-blocked', details: { undecided: ['WAIT'] } });
  } finally { resetElanousConfigDir(); }
}));
