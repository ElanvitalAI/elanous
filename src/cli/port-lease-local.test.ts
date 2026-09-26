import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { leaseTestPort, releaseTestPort, transferTestPort, RESERVED, TEST_BAND } from './port-lease-local.js';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'lease-test-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('local test-port lease', () => {
  test('sequential claims use the lowest free ports; dead PID is reclaimed and decisions logged', async () => {
    const dir = temp();
    const before = debug.events(500).length;
    const opts = { dir, now: () => 1234567890000, isAlive: (pid: number) => pid === process.pid, inUse: () => false };
    const first = await leaseTestPort({ ...opts, owner: 'tree-a' });
    const second = await leaseTestPort({ ...opts, owner: 'tree-b' });
    expect(first).toEqual({ port: 31450, pid: process.pid, owner: 'tree-a', startedAt: new Date(1234567890000).toISOString() });
    expect(second).toMatchObject({ port: 31451, owner: 'tree-b' });
    writeFileSync(join(dir, '31450.json'), JSON.stringify({ ...first, pid: 999999999 }));
    const third = await leaseTestPort({ ...opts, owner: 'tree-c' });
    expect(third).toMatchObject({ port: 31450, owner: 'tree-c' });
    expect(debug.events(500).slice(before).filter(e => e.category === 'nexus.port-lease').map(e => e.event)).toEqual(['leased', 'leased', 'skipped-stale', 'leased']);
  });

  test('parallel contenders never claim the same port', async () => {
    const dir = temp();
    const [one, two] = await Promise.all([
      leaseTestPort({ owner: 'a', dir, inUse: () => false }),
      leaseTestPort({ owner: 'b', dir, inUse: () => false }),
    ]);
    expect([one, two].map(r => 'port' in r ? r.port : 0).sort()).toEqual([31450, 31451]);
    expect(readdirSync(dir).sort()).toEqual(['31450.json', '31451.json']);
  });

  test('reserved ports are never issued; ports in use are skipped; exhaustion returns no-port', async () => {
    const dir = temp();
    expect(RESERVED).toEqual([31413, 31415, 31420]);
    expect(TEST_BAND).toEqual({ start: 31450, end: 31499 });
    const taken = await leaseTestPort({ owner: 'taken', dir, inUse: port => port === 31450 });
    expect(taken).toMatchObject({ port: 31451 });
    const none = await leaseTestPort({ owner: 'full', dir, inUse: () => true });
    expect(none).toEqual({ error: 'no-port' });
    expect(RESERVED).not.toContain('port' in none ? none.port : -1);
    expect(readdirSync(dir)).toEqual(['31451.json']);
  });

  test('only a matching PID can release a lease', async () => {
    const dir = temp();
    const claim = await leaseTestPort({ owner: 'mine', dir, inUse: () => false });
    if (!('port' in claim)) throw new Error('no lease');
    const path = join(dir, `${claim.port}.json`);
    releaseTestPort(claim.port, claim.pid + 1, dir);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(claim);
    releaseTestPort(claim.port, claim.pid, dir);
    expect(readdirSync(dir)).toEqual([]);
  });

  test('detached daemon takes the lease and only its PID may release it', async () => {
    const dir = temp();
    const claim = await leaseTestPort({ owner: 'daemon', dir, inUse: () => false });
    if (!('port' in claim)) throw new Error('no lease');
    transferTestPort(claim.port, claim.pid, claim.pid + 100, dir);
    releaseTestPort(claim.port, claim.pid, dir);
    expect(JSON.parse(readFileSync(join(dir, `${claim.port}.json`), 'utf8')).pid).toBe(claim.pid + 100);
    releaseTestPort(claim.port, claim.pid + 100, dir);
    expect(readdirSync(dir)).toEqual([]);
  });
});

// 🩸 2026-09-27: pid 1(launchd · 늘 살아 있음)이 주인으로 적힌 임대가 영영 안 풀려 시험 대역이 샜다.
test('a lease owned by pid 1 is reclaimed, and transfers to pid 1 are refused', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'lease-pid1-'));
  writeFileSync(join(dir, '31450.json'), JSON.stringify({ port: 31450, pid: 1, owner: 'leaked', startedAt: '2026-09-26T00:00:00.000Z' }));
  const got = await leaseTestPort({ owner: 'next', dir, inUse: () => false, isAlive: () => true });
  expect('port' in got && got.port).toBe(31450);
  transferTestPort(31450, process.pid, 1, dir);
  expect(JSON.parse(readFileSync(join(dir, '31450.json'), 'utf8')).pid).toBe(process.pid);
});
