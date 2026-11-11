import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeResourceLeases, beginResourceLease, endResourceLease, readResourceLedger, reapResourceLeaseIfCurrent } from '../resource-ledger/resource-ledger.js';
import { createFakeKubectl } from './fake-kubectl.js';
import { createFakePsDevice, createFakePsObserver } from './fake-ps.js';
import { createWorldHostChaosController } from './world-host-chaos.js';
import type { SimWorldSpec } from './world-schema.js';

test('gorilla takes every process on its host down and re-registers them when the host returns', async () => {
  const hosts: NonNullable<SimWorldSpec['hosts']> = [
    { name: 'node-b', arch: 'arm64', cpu: 32, pools: ['gate'], egress: true },
    { name: 'gcp2', arch: 'amd64', cpu: 8, pools: ['gate'], egress: true },
  ];
  const processTable = createFakePsDevice({ processes: [
    { id: 'worker-a', host: 'node-b', releaseVersion: '0.3.5', fingerprint: 'declared-a' },
    { id: 'worker-b', host: 'node-b', releaseVersion: '0.3.5', fingerprint: 'declared-b' },
    { id: 'survivor', host: 'gcp2', releaseVersion: '0.3.5', fingerprint: 'declared-survivor' },
  ] });
  const devices = new Map(hosts.map((host) => {
    const kubectl = createFakeKubectl({ context: `gorilla-world-${host.name}-context`,
      node: `gorilla-${host.name}-node`, arch: host.arch, cpu: host.cpu, pools: [...host.pools] });
    kubectl.setHostState({ egress: true });
    return [`fake-kubectl:${host.name}`, kubectl] as const;
  }));
  let now = 0;
  const controller = createWorldHostChaosController({ world: 'gorilla-world', hosts, devices,
    stateRoot: '/tmp/sim-gorilla', baseTimeMs: 0, clock: { now: () => now }, processTable });
  const pending = await controller.start({ at: '+1m', gorilla: { host: 'node-b', egress: false, cpu: 0, for: '+5m' } }, 60_000);
  expect(processTable.list('node-b')).toEqual([]);
  expect(processTable.list('gcp2').map(({ id, fp }) => ({ id, fp }))).toEqual([{ id: 'survivor', fp: 'declared-survivor' }]);
  now = 360_000;
  const result = await pending.complete();
  expect(result).toMatchObject({ kind: 'gorilla', recoveredAtMs: 360_000, recoveryMs: 300_000,
    recoveryVerdict: expect.stringContaining('surviving host gcp2'), metrics: { hitlCount: 0 } });
  expect(processTable.list('node-b').map(({ id, fp }) => ({ id, fp }))).toEqual([
    { id: 'worker-a', fp: 'declared-a' }, { id: 'worker-b', fp: 'declared-b' },
  ]);
  expect(processTable.find('worker-a', 'node-b')?.pid).toBeGreaterThan(1_700_000_000);
});

test('gorilla recovery fails when the world process device refuses to restart host processes', async () => {
  const hosts: NonNullable<SimWorldSpec['hosts']> = [
    { name: 'node-b', arch: 'arm64', cpu: 32, pools: ['gate'], egress: true },
    { name: 'gcp2', arch: 'amd64', cpu: 8, pools: ['gate'], egress: true },
  ];
  const processTable = createFakePsDevice({ processes: [
    { id: 'worker', host: 'node-b', releaseVersion: '0.3.5', fingerprint: 'declared-worker' },
  ], startAllowed: () => false });
  const devices = new Map(hosts.map((host) => {
    const kubectl = createFakeKubectl({ context: `gorilla-refusal-${host.name}-context`,
      node: `gorilla-refusal-${host.name}-node`, arch: host.arch, cpu: host.cpu, pools: [...host.pools] });
    kubectl.setHostState({ egress: true });
    return [`fake-kubectl:${host.name}`, kubectl] as const;
  }));
  let now = 0;
  const controller = createWorldHostChaosController({ world: 'gorilla-refusal', hosts, devices,
    stateRoot: '/tmp/sim-gorilla-refusal', baseTimeMs: 0, clock: { now: () => now }, processTable });
  const pending = await controller.start({ at: '+1m', gorilla: { host: 'node-b', egress: false, cpu: 0, for: '+5m' } }, 60_000);
  now = 360_000;
  const result = await pending.complete();
  expect(result).toMatchObject({ recoveredAtMs: null, recoveryMs: null,
    recoveryVerdict: 'host recovery failed (selected=gcp2; restarted=0/1)', metrics: { hitlCount: 1 } });
  expect(processTable.list('node-b')).toEqual([]);
});

test('disaster restart refusal is found by reconciliation from independent observed process rows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-disaster-observed-absence-'));
  const hosts: NonNullable<SimWorldSpec['hosts']> = [
    { name: 'node-b', arch: 'arm64', cpu: 32, pools: ['gate'], egress: true },
    { name: 'gcp2', arch: 'amd64', cpu: 8, pools: ['gate'], egress: true },
  ];
  const processTable = createFakePsDevice({ processes: [
    { id: 'headquarters', host: 'node-b', releaseVersion: '0.3.5', role: 'headquarters', fingerprint: 'fp_hq_headquarters', lane: 'hand', mission: 'hq-handoff', command: 'elanous-hq' },
    { id: 'mailbox', host: 'node-b', releaseVersion: '0.3.5', fingerprint: 'fp_hq_mailbox', lane: 'hand', mission: 'hq-handoff', command: 'mailbox' },
  ], startAllowed: () => false });
  const devices = new Map(hosts.map((host) => {
    const kubectl = createFakeKubectl({ context: `disaster-world-${host.name}-context`,
      node: `disaster-${host.name}-node`, arch: host.arch, cpu: host.cpu, pools: [...host.pools] });
    kubectl.setHostState({ egress: true });
    return [`fake-kubectl:${host.name}`, kubectl] as const;
  }));
  let now = Date.parse('2026-11-05T00:10:00.000Z');
  const ledgerPath = join(root, 'resource-ledger', 'events.jsonl');
  const originalHeadquartersLease = beginResourceLease({ fp: 'fp_hq_headquarters', host: 'node-b', lane: 'hand',
    resources: { cpu: 2, memoryBytes: 8_192 }, mission: { goalId: 'hq-handoff' }, ttlMs: 250,
    now: new Date(now - 1_000) }, ledgerPath);
  const observed: string[][] = [];
  const observer = createFakePsObserver(processTable);
  try {
    const controller = createWorldHostChaosController({ world: 'disaster-world', hosts, devices,
      stateRoot: root, baseTimeMs: now - 600_000, clock: { now: () => now }, processTable,
      processObserver: { observe(host) { const rows = observer.observe(host); if (!rows) throw new Error('observer unavailable');
        observed.push(rows.map(({ id }) => id)); return rows; } } });
    const pending = await controller.start({ at: '+10m', disaster: { host: 'node-b', down: true } }, 600_000);
    now += 1_000;
    const result = await pending.complete();
    expect(processTable.list('node-b')).toEqual([]);
    expect(observed).toEqual([[]]);
    expect(result).toMatchObject({ kind: 'disaster', recoveredAtMs: null, recoveryMs: null,
      recoveryVerdict: expect.stringContaining('reaped-candidate'), metrics: { hitlCount: 1, lostLedgerRows: 1 } });
    expect(activeResourceLeases(readResourceLedger(ledgerPath))).toMatchObject([
      { id: originalHeadquartersLease.id, host: 'gcp2', fp: 'fp_hq_headquarters' },
    ]);
    expect(readResourceLedger(ledgerPath)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'lease-reaped', id: originalHeadquartersLease.id }),
    ]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a refused disaster lease reap is reported as one missing ledger receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-disaster-reap-refused-'));
  const hosts: NonNullable<SimWorldSpec['hosts']> = [
    { name: 'node-b', arch: 'arm64', cpu: 32, pools: ['gate'], egress: true },
    { name: 'gcp2', arch: 'amd64', cpu: 8, pools: ['gate'], egress: true },
  ];
  const processTable = createFakePsDevice({ processes: [
    { id: 'headquarters', host: 'node-b', releaseVersion: '0.3.5', role: 'headquarters', fingerprint: 'fp_hq_headquarters', lane: 'hand', mission: 'hq-handoff', command: 'elanous-hq' },
  ] });
  const devices = new Map(hosts.map((host) => {
    const kubectl = createFakeKubectl({ context: `disaster-reap-refused-${host.name}-context`,
      node: `disaster-reap-refused-${host.name}-node`, arch: host.arch, cpu: host.cpu, pools: [...host.pools] });
    kubectl.setHostState({ egress: true });
    return [`fake-kubectl:${host.name}`, kubectl] as const;
  }));
  const baseTimeMs = Date.parse('2026-11-05T00:00:00.000Z');
  let now = baseTimeMs;
  const ledgerPath = join(root, 'resource-ledger', 'events.jsonl');
  beginResourceLease({ fp: 'fp_hq_headquarters', host: 'node-b', lane: 'hand', resources: { cpu: 2 },
    mission: { goalId: 'hq-handoff' }, ttlMs: 300_000, now: new Date(baseTimeMs + 1_000) }, ledgerPath);
  try {
    const controller = createWorldHostChaosController({ world: 'disaster-reap-refused', hosts, devices,
      stateRoot: root, baseTimeMs, clock: { now: () => now }, processTable });
    const pending = await controller.start({ at: '+1m', disaster: { host: 'node-b', down: true } }, 60_000);
    now = baseTimeMs + 61_000;
    const result = await pending.complete();
    expect(result).toMatchObject({ kind: 'disaster', recoveredAtMs: null, recoveryMs: null,
      recoveryVerdict: expect.stringContaining('reaped=false'), metrics: { hitlCount: 1, lostLedgerRows: 3 } });
    expect(readResourceLedger(ledgerPath)).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('disaster hands the declared headquarters process and active lease to the measured survivor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-disaster-success-'));
  const hosts: NonNullable<SimWorldSpec['hosts']> = [
    { name: 'node-b', arch: 'arm64', cpu: 32, pools: ['gate'], egress: true },
    { name: 'gcp2', arch: 'amd64', cpu: 8, pools: ['gate'], egress: true },
  ];
  const processTable = createFakePsDevice({ processes: [
    { id: 'headquarters', host: 'node-b', releaseVersion: '0.3.5', role: 'headquarters', fingerprint: 'fp_hq_headquarters', lane: 'hand', mission: 'hq-handoff', command: 'elanous-hq' },
    { id: 'background', host: 'node-b', releaseVersion: '0.3.5', fingerprint: 'fp_hq_background', lane: 'hand', mission: 'background-work', command: 'background' },
    { id: 'survivor-worker', host: 'gcp2', releaseVersion: '0.3.5', fingerprint: 'fp_hq_worker', lane: 'hand', mission: 'worker-work', command: 'worker' },
  ] });
  const devices = new Map(hosts.map((host) => {
    const kubectl = createFakeKubectl({ context: `disaster-success-${host.name}-context`,
      node: `disaster-success-${host.name}-node`, arch: host.arch, cpu: host.cpu, pools: [...host.pools] });
    kubectl.setHostState({ egress: true });
    return [`fake-kubectl:${host.name}`, kubectl] as const;
  }));
  const baseTimeMs = Date.parse('2026-11-05T00:00:00.000Z');
  let now = baseTimeMs + 600_000;
  const observedHosts: string[] = [];
  try {
    const ledgerPath = join(root, 'resource-ledger', 'events.jsonl');
    beginResourceLease({ fp: 'fp_hq_background', host: 'node-b', lane: 'hand', resources: { cpu: 1 },
      mission: { goalId: 'background-work' }, ttlMs: 300_000, now: new Date(baseTimeMs + 590_000) }, ledgerPath);
    beginResourceLease({ fp: 'fp_hq_worker', host: 'gcp2', lane: 'hand', resources: { cpu: 1 },
      mission: { goalId: 'worker-work' }, ttlMs: 300_000, now: new Date(baseTimeMs + 590_000) }, ledgerPath);
    const originalHeadquartersLease = beginResourceLease({ fp: 'fp_hq_headquarters', host: 'node-b', lane: 'hand',
      resources: { cpu: 2, memoryBytes: 8_192 }, mission: { goalId: 'hq-handoff' }, ttlMs: 300_000,
      now: new Date(baseTimeMs + 590_000) }, ledgerPath);
    const controller = createWorldHostChaosController({ world: 'disaster-success', hosts, devices,
      stateRoot: root, baseTimeMs, clock: { now: () => now }, processTable,
      processObserver: { observe(host) { observedHosts.push(host); return createFakePsObserver(processTable).observe(host); } } });
    const pending = await controller.start({ at: '+10m', disaster: { host: 'node-b', down: true } }, 600_000);
    now += 1_000;
    const result = await pending.complete();
    expect(result).toMatchObject({ kind: 'disaster', recoveredAtMs: 601_000, recoveryMs: 1_000,
      recoveryVerdict: 'headquarters handoff to gcp2; handoff leases=1 findings=0', metrics: { hitlCount: 0, lostLedgerRows: 0 } });
    expect(observedHosts.sort()).toEqual(['gcp2']);
    expect(processTable.list('node-b')).toEqual([]);
    expect(processTable.list('gcp2').map(({ id, fp }) => ({ id, fp }))).toEqual([
      { id: 'survivor-worker', fp: 'fp_hq_worker' }, { id: 'headquarters', fp: 'fp_hq_headquarters' },
    ]);
    expect(activeResourceLeases(readResourceLedger(ledgerPath))).toMatchObject([
      { id: 'fp_hq_background', host: 'node-b' },
      { id: 'fp_hq_worker', host: 'gcp2' },
      { id: originalHeadquartersLease.id, fp: originalHeadquartersLease.fp, host: 'gcp2', lane: originalHeadquartersLease.lane,
        resources: originalHeadquartersLease.resources, mission: originalHeadquartersLease.mission,
        startedAt: expect.any(String), heartbeatAt: expect.any(String) },
    ]);
    expect(readResourceLedger(ledgerPath)).toHaveLength(6);
    const ledgerAfterHandoff = readResourceLedger(ledgerPath);
    const replayTable = createFakePsDevice({ processes: [
      { id: 'headquarters', host: 'node-b', releaseVersion: '0.3.5', role: 'headquarters',
        fingerprint: 'fp_hq_headquarters', lane: 'hand', mission: 'hq-handoff' },
    ] });
    const replay = createWorldHostChaosController({ world: 'disaster-success', hosts, devices,
      stateRoot: root, baseTimeMs, clock: { now: () => now }, processTable: replayTable });
    await expect(replay.start({ at: '+10m', disaster: { host: 'node-b', down: true } }, 600_000))
      .rejects.toThrow('matching active lease');
    expect(readResourceLedger(ledgerPath)).toEqual(ledgerAfterHandoff);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('disaster remains unmeasured when the independent survivor process observer is unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-disaster-observer-unavailable-'));
  const hosts: NonNullable<SimWorldSpec['hosts']> = [
    { name: 'node-b', arch: 'arm64', cpu: 32, pools: ['gate'], egress: true },
    { name: 'gcp2', arch: 'amd64', cpu: 8, pools: ['gate'], egress: true },
  ];
  const processTable = createFakePsDevice({ processes: [
    { id: 'headquarters', host: 'node-b', releaseVersion: '0.3.5', role: 'headquarters',
      fingerprint: 'fp_hq_headquarters', lane: 'hand', mission: 'hq-handoff' },
  ] });
  const devices = new Map(hosts.map((host) => {
    const kubectl = createFakeKubectl({ context: `observer-unavailable-${host.name}-context`,
      node: `observer-unavailable-${host.name}-node`, arch: host.arch, cpu: host.cpu, pools: [...host.pools] });
    kubectl.setHostState({ egress: true });
    return [`fake-kubectl:${host.name}`, kubectl] as const;
  }));
  const baseTimeMs = Date.parse('2026-11-05T00:00:00.000Z');
  // Source: #35046 disaster fixture uses a five-minute HQ lease to distinguish missing measurement from expiry.
  const ttlMs = 300_000;
  beginResourceLease({ fp: 'fp_hq_headquarters', host: 'node-b', lane: 'hand', resources: { cpu: 2 },
    mission: { goalId: 'hq-handoff' }, ttlMs, now: new Date(baseTimeMs) }, join(root, 'resource-ledger', 'events.jsonl'));
  let now = baseTimeMs + 60_000;
  try {
    const controller = createWorldHostChaosController({ world: 'observer-unavailable', hosts, devices,
      stateRoot: root, baseTimeMs, clock: { now: () => now }, processTable,
      processObserver: { observe: () => null } });
    const pending = await controller.start({ at: '+1m', disaster: { host: 'node-b', down: true } }, 60_000);
    now += 1_000;
    const result = await pending.complete();
    expect(result).toMatchObject({ kind: 'disaster', recoveredAtMs: null,
      recoveryVerdict: expect.stringContaining('unmeasured'), metrics: { hitlCount: 1, lostLedgerRows: null } });
    expect(String(result.recoveryVerdict).includes('reaped-candidate')).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Source: #35046 disaster handoff fixtures use two gate-capable hosts and a pre-existing HQ resource lease. */
function handoffFixture(extraHost = false) {
  const root = mkdtempSync(join(tmpdir(), 'sim-disaster-handoff-boundary-'));
  const hosts: NonNullable<SimWorldSpec['hosts']> = [
    { name: 'node-b', arch: 'arm64', cpu: 32, pools: ['gate'], egress: true },
    { name: 'gcp2', arch: 'amd64', cpu: 8, pools: ['gate'], egress: true },
    ...(extraHost ? [{ name: 'gcp3', arch: 'amd64' as const, cpu: 4, pools: ['gate'], egress: true }] : []),
  ];
  const processTable = createFakePsDevice({ processes: [
    { id: 'headquarters', host: 'node-b', releaseVersion: '0.3.5', role: 'headquarters',
      fingerprint: 'fp_hq_headquarters', lane: 'hand', mission: 'hq-handoff' },
    ...(extraHost ? [{ id: 'background', host: 'gcp3', releaseVersion: '0.3.5',
      fingerprint: 'fp_hq_background', lane: 'hand', mission: 'background' }] : []),
  ] });
  const devices = new Map(hosts.map((host) => {
    const kubectl = createFakeKubectl({ context: `handoff-boundary-${host.name}-context`,
      node: `handoff-boundary-${host.name}-node`, arch: host.arch, cpu: host.cpu, pools: [...host.pools] });
    kubectl.setHostState({ egress: true });
    return [`fake-kubectl:${host.name}`, kubectl] as const;
  }));
  const baseTimeMs = Date.parse('2026-11-05T00:00:00.000Z');
  const ledgerPath = join(root, 'resource-ledger', 'events.jsonl');
  beginResourceLease({ fp: 'fp_hq_headquarters', host: 'node-b', lane: 'hand', resources: { cpu: 2, memoryBytes: 8_192 },
    mission: { goalId: 'hq-handoff' }, ttlMs: 300_000, now: new Date(baseTimeMs) }, ledgerPath);
  if (extraHost) beginResourceLease({ fp: 'fp_hq_background', host: 'gcp3', lane: 'hand', resources: { cpu: 1 },
    mission: { goalId: 'background' }, ttlMs: 300_000, now: new Date(baseTimeMs) }, ledgerPath);
  return { root, hosts, processTable, devices, baseTimeMs, ledgerPath };
}

test('no surviving placement keeps the original active HQ lease and produces a failed recovery', async () => {
  const fixture = handoffFixture();
  try {
    fixture.devices.get('fake-kubectl:gcp2')!.setHostState({ egress: false, cpu: 0, ready: false });
    const before = readResourceLedger(fixture.ledgerPath);
    let now = fixture.baseTimeMs + 60_000;
    const controller = createWorldHostChaosController({ world: 'handoff-boundary', ...fixture,
      stateRoot: fixture.root, clock: { now: () => now } });
    const pending = await controller.start({ at: '+1m', disaster: { host: 'node-b', down: true } }, 60_000);
    now += 1_000;
    const result = await pending.complete();
    expect(result).toMatchObject({ recoveredAtMs: null, recoveryVerdict: expect.stringContaining('unmeasured'),
      metrics: { hitlCount: 1, lostLedgerRows: null } });
    expect(readResourceLedger(fixture.ledgerPath)).toEqual(before);
    expect(activeResourceLeases(readResourceLedger(fixture.ledgerPath))[0]).toMatchObject({
      host: 'node-b', resources: { cpu: 2, memoryBytes: 8_192 }, ttlMs: 300_000,
    });
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('failed survivor lease creation restores the original lease and counts missing handoff receipts', async () => {
  const fixture = handoffFixture();
  try {
    let now = fixture.baseTimeMs + 60_000;
    const controller = createWorldHostChaosController({ world: 'handoff-boundary', ...fixture,
      stateRoot: fixture.root, clock: { now: () => now },
      createSurvivorLease: () => { throw new Error('simulated survivor write failure'); } });
    const pending = await controller.start({ at: '+1m', disaster: { host: 'node-b', down: true } }, 60_000);
    expect(activeResourceLeases(readResourceLedger(fixture.ledgerPath))).toMatchObject([{
      host: 'node-b', resources: { cpu: 2, memoryBytes: 8_192 }, ttlMs: 300_000,
    }]);
    now += 1_000;
    const result = await pending.complete();
    expect(result).toMatchObject({ recoveredAtMs: null,
      recoveryVerdict: expect.stringContaining('restored=true'), metrics: { hitlCount: 1, lostLedgerRows: 2 } });
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('a missing observation on another surviving lease host makes the whole handoff unmeasured', async () => {
  const fixture = handoffFixture(true);
  try {
    let now = fixture.baseTimeMs + 60_000;
    const actualObserver = createFakePsObserver(fixture.processTable);
    const controller = createWorldHostChaosController({ world: 'handoff-boundary', ...fixture,
      stateRoot: fixture.root, clock: { now: () => now },
      processObserver: { observe(host) { return host === 'gcp3' ? null : actualObserver.observe(host); } } });
    const pending = await controller.start({ at: '+1m', disaster: { host: 'node-b', down: true } }, 60_000);
    now += 1_000;
    const result = await pending.complete();
    expect(result).toMatchObject({ recoveredAtMs: null,
      recoveryVerdict: expect.stringContaining('unmeasured'), metrics: { hitlCount: 1, lostLedgerRows: null } });
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('a measured drift on another surviving lease host rejects the disaster handoff', async () => {
  const fixture = handoffFixture(true);
  try {
    let now = fixture.baseTimeMs + 60_000;
    const actualObserver = createFakePsObserver(fixture.processTable);
    const controller = createWorldHostChaosController({ world: 'handoff-boundary', ...fixture,
      stateRoot: fixture.root, clock: { now: () => now },
      processObserver: { observe(host) {
        const processes = actualObserver.observe(host);
        return host === 'gcp3' && processes
          ? processes.map((process) => ({ ...process, mission: 'different-mission' })) : processes;
      } } });
    const pending = await controller.start({ at: '+1m', disaster: { host: 'node-b', down: true } }, 60_000);
    now += 1_000;
    const result = await pending.complete();
    expect(result).toMatchObject({ recoveredAtMs: null, recoveryMs: null,
      recoveryVerdict: expect.stringContaining('findings=drift'), metrics: { hitlCount: 1, lostLedgerRows: 0 } });
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('a new run recovers a source lease after interruption between reap and replacement', async () => {
  const fixture = handoffFixture();
  try {
    const prior = activeResourceLeases(readResourceLedger(fixture.ledgerPath))[0]!;
    const now = fixture.baseTimeMs + 60_000;
    expect(reapResourceLeaseIfCurrent({ id: prior.id, expectedHeartbeatAt: prior.heartbeatAt,
      expectedExpiresAtMs: Date.parse(prior.heartbeatAt) + prior.ttlMs,
      observedAtMs: now, reason: 'machine-disappeared' }, fixture.ledgerPath)).toBe(true);
    expect(activeResourceLeases(readResourceLedger(fixture.ledgerPath))).toEqual([]);
    const controller = createWorldHostChaosController({ world: 'handoff-boundary', ...fixture,
      stateRoot: fixture.root, clock: { now: () => now } });
    const pending = await controller.start({ at: '+1m', disaster: { host: 'node-b', down: true } }, 60_000);
    const result = await pending.complete();
    expect(result).toMatchObject({ kind: 'disaster', metrics: { lostLedgerRows: 0 } });
    expect(activeResourceLeases(readResourceLedger(fixture.ledgerPath))).toMatchObject([{
      host: 'gcp2', fp: prior.fp, resources: prior.resources, ttlMs: prior.ttlMs,
    }]);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('an intentionally ended survivor lease is never resurrected from an older source reap', async () => {
  const fixture = handoffFixture();
  try {
    const prior = activeResourceLeases(readResourceLedger(fixture.ledgerPath))[0]!;
    const now = fixture.baseTimeMs + 60_000;
    expect(reapResourceLeaseIfCurrent({ id: prior.id, expectedHeartbeatAt: prior.heartbeatAt,
      expectedExpiresAtMs: Date.parse(prior.heartbeatAt) + prior.ttlMs,
      observedAtMs: now, reason: 'machine-disappeared' }, fixture.ledgerPath)).toBe(true);
    beginResourceLease({ fp: prior.fp, host: 'gcp2', lane: prior.lane,
      resources: prior.resources, mission: prior.mission, ttlMs: prior.ttlMs,
      now: new Date(now) }, fixture.ledgerPath);
    endResourceLease(prior.id, 'completed', 'sim', new Date(now + 1_000), fixture.ledgerPath);
    const before = readResourceLedger(fixture.ledgerPath);
    const controller = createWorldHostChaosController({ world: 'handoff-boundary', ...fixture,
      stateRoot: fixture.root, clock: { now: () => now + 2_000 } });
    await expect(controller.start({ at: '+1m', disaster: { host: 'node-b', down: true } }, 60_000))
      .rejects.toThrow('matching active lease');
    expect(readResourceLedger(fixture.ledgerPath)).toEqual(before);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
