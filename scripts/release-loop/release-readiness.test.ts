import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseReadiness, type ReleaseReadinessDeps } from './release-readiness.js';

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
