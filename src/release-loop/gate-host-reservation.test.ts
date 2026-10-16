import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectReleaseGateHost, reserveReleaseGateHosts } from './gate-host-reservation.js';

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), 'gate-host-reserve-')); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

test('release gate publishes run and host, then releases exactly its own claim', () => {
  const state = root();
  const release = reserveReleaseGateHosts(state, 'run-gate-1', ['node-b']);
  expect(inspectReleaseGateHost(state, 'node-b')).toMatchObject({ status: 'reserved', runId: 'run-gate-1' });
  expect(inspectReleaseGateHost(state, 'node-c')).toEqual({ status: 'free' });
  release();
  expect(inspectReleaseGateHost(state, 'node-b')).toEqual({ status: 'free' });
});

test('a dead owner is automatically released; corrupt evidence fails closed', () => {
  const state = root();
  reserveReleaseGateHosts(state, 'run-gate-2', ['node-b']);
  const dir = join(state, 'release', 'gate-host-reservations');
  const file = join(dir, readdirSync(dir).find(name => name.endsWith('.json'))!);
  const claim = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...claim, pid: 99999999, pidStartedAt: null }));
  expect(inspectReleaseGateHost(state, 'node-b')).toEqual({ status: 'free' });
  expect(readdirSync(dir).filter(name => name.endsWith('.json'))).toEqual([]);
  writeFileSync(file, '{not-json');
  expect(inspectReleaseGateHost(state, 'node-b').status).toBe('unknown');
  expect(inspectReleaseGateHost(state, 'node-c').status).toBe('unknown');
});

test('a missing reservation directory is unmeasured, not a free host', () => {
  const state = root();
  expect(inspectReleaseGateHost(state, 'node-b').status).toBe('unknown');
  const release = reserveReleaseGateHosts(state, 'run-gate-3', ['node-c']);
  release();
  expect(inspectReleaseGateHost(state, 'node-b')).toEqual({ status: 'free' });
});

test('an impossible owner start time cannot make a live claim look stale', () => {
  const state = root();
  const release = reserveReleaseGateHosts(state, 'run-gate-4', ['node-b']);
  const dir = join(state, 'release', 'gate-host-reservations');
  const file = join(dir, readdirSync(dir).find(name => name.endsWith('.json'))!);
  const claim = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...claim, pidStartedAt: -1 }));
  expect(inspectReleaseGateHost(state, 'node-b').status).toBe('unknown');
  expect(readdirSync(dir).some(name => name.endsWith('.json'))).toBe(true);
  writeFileSync(file, JSON.stringify({ ...claim, pidStartedAt: Date.now() + 4_000 }));
  expect(inspectReleaseGateHost(state, 'node-b').status).toBe('unknown');
  expect(readdirSync(dir).some(name => name.endsWith('.json'))).toBe(true);
  writeFileSync(file, JSON.stringify({ ...claim, hosts: [] }));
  expect(inspectReleaseGateHost(state, 'node-b').status).toBe('unknown');
  expect(readdirSync(dir).some(name => name.endsWith('.json'))).toBe(true);
  writeFileSync(file, JSON.stringify(claim));
  release();
});
