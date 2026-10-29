import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectReleaseGateHost, readGateHostResourcesForHost, reserveReleaseGateHosts } from './gate-host-reservation.js';
import { podPoolHostLease, type PodPoolMember } from '../task-orchestrator/surfaces/pod-pool.js';

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

test('a claim publishes when it was reserved, and pre-existing claims stay readable', () => {
  const state = root();
  const before = Date.now();
  const release = reserveReleaseGateHosts(state, 'run-gate-5', ['node-b']);
  const reserved = inspectReleaseGateHost(state, 'node-b');
  expect(reserved.status).toBe('reserved');
  if (reserved.status === 'free') throw new Error('unreachable');
  expect(reserved.reservedAt).toBeGreaterThanOrEqual(before);
  expect(reserved.reservedAt).toBeLessThanOrEqual(Date.now());
  const dir = join(state, 'release', 'gate-host-reservations');
  const file = join(dir, readdirSync(dir).find(name => name.endsWith('.json'))!);
  const claim = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const { reservedAt: _dropped, ...legacy } = claim;
  writeFileSync(file, JSON.stringify(legacy));
  expect(inspectReleaseGateHost(state, 'node-b')).toMatchObject({ status: 'reserved', runId: 'run-gate-5' });
  expect((inspectReleaseGateHost(state, 'node-b') as { reservedAt?: number }).reservedAt).toBeUndefined();
  writeFileSync(file, JSON.stringify({ ...claim, reservedAt: Date.now() + 60_000 }));
  expect(inspectReleaseGateHost(state, 'node-b').status).toBe('unknown');
  writeFileSync(file, JSON.stringify(claim));
  release();
});

import type { HostLeaseRecord, PendingJobIdentity } from '../pod-lease/host-lease.js';
import { readGateHostResources } from './gate-host-reservation.js';

const activeJob: PendingJobIdentity = { context: 'k3d-release', namespace: 'elanous-test', job: 'gate-shard-1' };

test('empty resource ledgers report an empty host despite the bun test argv false-positive shape', () => {
  // The argv row models the unrelated parent counted at T−10. argv is deliberately absent from the probe input.
  const unrelatedParent = { pid: 321, argv: ['bun', 'test', 'src/release-loop/gate-node.test.ts'] };
  expect(unrelatedParent.argv.join(' ')).toContain('bun test');
  expect(readGateHostResources({ leases: [], activeJobs: [] })).toEqual({
    status: 'measured', empty: true, reservations: 0, authoringLeases: 0, waitingJobs: 0, activeJobs: 0,
  });
});

test('mock E3-E5 host probe emits raw measured-empty evidence while ignoring unrelated parent argv', () => {
  const leaseRoot = root();
  mkdirSync(leaseRoot, { recursive: true });
  const script = `
    import { debug } from './src/debug/log.ts';
    import { readGateHostResourcesForHost } from './src/release-loop/gate-host-reservation.ts';
    const rows = [];
    const calls = [];
    debug.log = (category, event, data) => rows.push({ category, event, data });
    const reading = readGateHostResourcesForHost('node-b', {}, {
      members: [{ context: 'e3-e5-sim-host', sshHost: 'node-b', capacity: 1, k3dCluster: 'sim' }],
      processStart: () => null,
      kubectl: (args) => { calls.push(args); return { status: 0, stdout: JSON.stringify({ items: [] }) }; },
    });
    console.log(JSON.stringify({ argv: process.argv, reading, calls,
      probe: rows.find((row) => row.category === 'release-loop.gate' && row.event === 'host-resource-probe') }));
  `;
  const child = spawnSync(process.execPath, ['-e', script, 'bun', 'test', 'src/release-loop/gate-node.test.ts'], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, ELANOUS_POD_LEASE_DIR: leaseRoot },
  });
  expect(child.status).toBe(0);
  const report = JSON.parse(child.stdout.trim()) as {
    argv: string[];
    reading: unknown;
    calls: string[][];
    probe: { category: string; event: string; data: unknown };
  };
  expect(report.argv[1]).toBe('bun');
  expect(report.argv[2]).toBe('test');
  expect(report.argv[3]).toBe('src/release-loop/gate-node.test.ts');
  expect(report.calls).toHaveLength(1);
  expect(report.calls[0]).toContain('get');
  expect(report.calls[0]).toContain('pods');
  const contextIndex = report.calls[0]?.indexOf('--context') ?? -1;
  expect(contextIndex).toBeGreaterThanOrEqual(0);
  expect(report.calls[0]?.[contextIndex + 1]).toBe('e3-e5-sim-host');
  const measuredEmpty = { status: 'measured', empty: true, reservations: 0, authoringLeases: 0, waitingJobs: 0, activeJobs: 0 };
  expect(report.reading).toEqual(measuredEmpty);
  expect(report.probe).toMatchObject({ category: 'release-loop.gate', event: 'host-resource-probe',
    data: { host: 'node-b', poolContexts: ['e3-e5-sim-host'], ...measuredEmpty } });
});

test('live pool probe reads matching Pending Job and lease once and never prunes stale lease files', () => {
  const member: PodPoolMember = { context: `probe-${Date.now()}`, sshHost: 'node-b', capacity: 1, k3dCluster: 'probe' };
  const leaseRoot = root();
  const previousLeaseDir = process.env.ELANOUS_POD_LEASE_DIR;
  process.env.ELANOUS_POD_LEASE_DIR = leaseRoot;
  const leasePool = podPoolHostLease([member]);
  roots.push(leasePool.dir);
  try {
    mkdirSync(leasePool.dir, { recursive: true });
    const liveName = '41-live.json';
    const deadName = '42-dead.json';
    const pending = { context: member.context, namespace: 'elanous-test', job: 'gate-shard-1' };
    writeFileSync(join(leasePool.dir, liveName), JSON.stringify({ pid: 41, startedAt: 'start-41', at: 'now', stage: 'job', ...pending }));
    writeFileSync(join(leasePool.dir, deadName), JSON.stringify({ pid: 42, startedAt: 'start-42', at: 'now', stage: 'authoring' }));
    const reading = readGateHostResourcesForHost('node-b', {}, {
      members: [member],
      processStart: pid => pid === 41 ? 'start-41' : null,
      kubectl: args => {
        expect(args).toContain('--context');
        expect(args).toContain('get');
        expect(args).toContain('pods');
        return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'gate-shard-1-abc', namespace: 'elanous-test', ownerReferences: [{ kind: 'Job', name: 'gate-shard-1' }] }, status: { phase: 'Pending' } }] }) };
      },
    });
    expect(reading).toEqual({ status: 'measured', empty: false, reservations: 1, authoringLeases: 0, waitingJobs: 0, activeJobs: 1 });
    expect(readdirSync(leasePool.dir).sort()).toEqual([liveName, deadName]);
  } finally {
    if (previousLeaseDir === undefined) delete process.env.ELANOUS_POD_LEASE_DIR;
    else process.env.ELANOUS_POD_LEASE_DIR = previousLeaseDir;
  }
});

test('an authoring lease occupies the host before a Job exists', () => {
  const leases: HostLeaseRecord[] = [{ pid: 44, startedAt: 'start', at: 'now', stage: 'authoring' }];
  expect(readGateHostResources({ leases, activeJobs: [] })).toMatchObject({ status: 'measured', empty: false, reservations: 1, authoringLeases: 1 });
});

test('a Job lease without an observed Pod remains reserved', () => {
  const leases: HostLeaseRecord[] = [{ pid: 44, startedAt: 'start', at: 'now', stage: 'job', ...activeJob }];
  expect(readGateHostResources({ leases, activeJobs: [] })).toMatchObject({ status: 'measured', empty: false, reservations: 1, waitingJobs: 1 });
});

test('a lease and matching active Job count once, and duplicate Job rows collapse', () => {
  const leases: HostLeaseRecord[] = [{ pid: 44, startedAt: 'start', at: 'now', stage: 'job', ...activeJob }];
  expect(readGateHostResources({ leases, activeJobs: [activeJob, activeJob] })).toMatchObject({
    status: 'measured', empty: false, reservations: 1, waitingJobs: 0, activeJobs: 1,
  });
});

test('an active Job occupies the host even when its lease row is absent', () => {
  expect(readGateHostResources({ leases: [], activeJobs: [activeJob] })).toMatchObject({ status: 'measured', empty: false, reservations: 1, activeJobs: 1 });
});

test('unreadable or invalid resource ledgers are measurement-unavailable', () => {
  expect(readGateHostResources({ leases: null, activeJobs: [] })).toEqual({ status: 'unmeasurable', empty: null, reason: 'lease-ledger-unavailable' });
  expect(readGateHostResources({ leases: [], activeJobs: null })).toEqual({ status: 'unmeasurable', empty: null, reason: 'pod-list-unavailable' });
  expect(readGateHostResources({ leases: [{ pid: 0, startedAt: '', at: '' }], activeJobs: [] })).toEqual({ status: 'unmeasurable', empty: null, reason: 'lease-ledger-invalid' });
  expect(readGateHostResources({ leases: [], activeJobs: [{ context: '', namespace: '', job: '' }] })).toEqual({ status: 'unmeasurable', empty: null, reason: 'pod-list-invalid' });
});
