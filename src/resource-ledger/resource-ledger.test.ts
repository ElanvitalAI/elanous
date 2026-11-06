import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { activeResourceLeases, activeResourcePools, beginResourceLease, declareResourcePool, endResourceLease, heartbeatResourceLease, latestWarmPoolPodReceipts, readResourceLedger, recordWarmPoolPodReceipt,
  reconcileResourceLeases, reapResourceLeaseIfCurrent, resourceMatrix, reassignResourcePools, type ResourceLease, type ResourceMeasurement } from './resource-ledger.js';
import { buildResourceLedgerSnapshot, collectResourceMeasurement, registerResourceLedgerCommands, type ResourceCommandRunner } from '../cli/resource-ledger-cli.js';
import { Command } from 'commander';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const lease = (overrides: Partial<ResourceLease> = {}): ResourceLease => ({ id: 'fp_run001', fp: 'fp_run001', host: 'node-b', lane: 'ta',
  resources: { cpu: 2, memoryBytes: 1024 }, mission: { cell: 'TA-1' }, ttlMs: 1000,
  heartbeatAt: '2026-11-01T00:00:00.000Z', startedAt: '2026-11-01T00:00:00.000Z', ...overrides });

test('Nexus resource ledger records per-Pod digest, runtime, skill, last job, and cleanup receipt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resource-ledger-pod-receipt-')); dirs.push(dir);
  const path = join(dir, 'events.jsonl');
  const receipt = { purpose: 'ta' as const, host: 'aws1', podUid: 'pod-uid-1', digest: 'sha256:' + 'c'.repeat(64),
    runtime: 'bun-v1', environment: 'linux-amd64', skillPacks: [{ name: 'research', version: '2' }],
    lastJob: 'crawl-shard-1', cleanupResult: { state: 'unclean' as const, procedure: 'clean-v1',
      reason: 'host-disappeared', verifiedAt: '2026-11-02T00:00:00.000Z' } };
  recordWarmPoolPodReceipt(receipt, new Date('2026-11-02T00:00:01.000Z'), path);
  expect(latestWarmPoolPodReceipts(readResourceLedger(path))).toEqual([receipt]);
});

test('Nexus resource ledger retains validated pool declarations independently of host-local files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resource-ledger-pools-')); dirs.push(dir);
  const path = join(dir, 'events.jsonl');
  const pool = { purpose: 'ta' as const, fanoutGroupId: 'ta-mesh-v1',
    members: [{ host: 'gcp1', count: 2, digest: 'sha256:' + 'a'.repeat(64), role: 'both' as const }],
    fanoutGroup: { shard: { kind: 'skill' as const, input: 'research-shard', result: 'citation-rows', fingerprint: 'runtime-env-skills' } },
    fingerprint: { runtime: 'bun-v1', environment: 'linux', skillPacks: [{ name: 'research', version: '2' }] }, cleanup: { procedure: 'clean-v1', verify: 'verify-v1' } };
  declareResourcePool(pool, new Date('2026-11-02T00:00:00Z'), path);
  expect(activeResourcePools(readResourceLedger(path))).toEqual([pool]);
  expect(activeResourceLeases(readResourceLedger(path))).toEqual([]);
});

test('HQ pool reassignment appends a new authoritative declaration and leaves prior ledger history intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resource-ledger-reassign-')); dirs.push(dir);
  const path = join(dir, 'events.jsonl');
  const pool = { purpose: 'ta' as const, fanoutGroupId: 'hq-move-v1',
    members: [{ host: 'mbp', count: 2, digest: 'sha256:' + 'a'.repeat(64), role: 'both' as const }],
    fanoutGroup: { shard: { kind: 'skill' as const, input: 'move', result: 'moved', fingerprint: 'hq-move-v1' } },
    fingerprint: { runtime: 'bun', environment: 'sim', skillPacks: [] }, cleanup: { procedure: 'clean', verify: 'verified' } };
  declareResourcePool(pool, new Date('2026-11-09T00:00:00Z'), path);
  expect(reassignResourcePools('mbp', 'node-b', new Date('2026-11-09T00:01:00Z'), path)).toBe(1);
  expect(activeResourcePools(readResourceLedger(path))[0]?.members[0]?.host).toBe('node-b');
  expect(readResourceLedger(path)).toHaveLength(2);
});

test('lease C/U/D appends an auditable history and active view reflects terminal endRun', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resource-ledger-')); dirs.push(dir);
  const path = join(dir, 'events.jsonl');
  const started = beginResourceLease({ fp: 'fp_run001', host: 'node-b', lane: 'ta', resources: { cpu: 2 }, mission: { cell: 'TA-1' }, ttlMs: 60_000, now: new Date('2026-11-01T00:00:00Z') }, path);
  heartbeatResourceLease(started.id, { cpu: 3 }, new Date('2026-11-01T00:00:10Z'), path);
  expect(activeResourceLeases(readResourceLedger(path))[0]).toMatchObject({ fp: 'fp_run001', resources: { cpu: 3 }, heartbeatAt: '2026-11-01T00:00:10.000Z' });
  endResourceLease(started.id, 'completed', 'self', new Date('2026-11-01T00:00:20Z'), path);
  expect(activeResourceLeases(readResourceLedger(path))).toEqual([]);
  expect(readResourceLedger(path).map(row => row.event)).toEqual(['lease-created', 'lease-heartbeat', 'lease-ended']);
  expect(readResourceLedger(path)[2]).toMatchObject({ event: 'lease-ended', reason: 'completed', stoppedBy: 'self' });
});

test('machine disappearance is recorded as a distinct lease-reap reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resource-ledger-disappeared-')); dirs.push(dir);
  const path = join(dir, 'events.jsonl');
  const started = beginResourceLease({ fp: 'fp_disappeared', host: 'gcp1', lane: 'warm',
    resources: { pods: 1 }, mission: { cell: 'warm-pool' }, ttlMs: 60_000,
    now: new Date('2026-11-02T00:00:00.000Z') }, path);
  const expiresAt = Date.parse(started.heartbeatAt) + started.ttlMs;
  expect(reapResourceLeaseIfCurrent({ id: started.id, expectedHeartbeatAt: started.heartbeatAt,
    expectedExpiresAtMs: expiresAt, observedAtMs: Date.parse(started.heartbeatAt) - 1, reason: 'machine-disappeared' }, path)).toBe(false);
  expect(reapResourceLeaseIfCurrent({ id: started.id, expectedHeartbeatAt: started.heartbeatAt,
    expectedExpiresAtMs: expiresAt, observedAtMs: Date.parse(started.heartbeatAt) + 1, reason: 'machine-disappeared' }, path)).toBe(true);
  expect(readResourceLedger(path).at(-1)).toMatchObject({ event: 'lease-reaped', reason: 'machine-disappeared' });
});

test('reconcile reaps only the exact expired heartbeat version under the ledger lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resource-ledger-reap-')); dirs.push(dir);
  const path = join(dir, 'events.jsonl');
  const started = beginResourceLease({ fp: 'fp_run001', host: 'aws2', lane: 'gate', resources: {}, mission: {}, ttlMs: 1_000,
    now: new Date('2026-11-01T00:00:00.000Z') }, path);
  const firstExpiry = Date.parse(started.heartbeatAt) + started.ttlMs;
  heartbeatResourceLease(started.id, undefined, new Date(firstExpiry + 1), path);
  expect(reapResourceLeaseIfCurrent({ id: started.id, expectedHeartbeatAt: started.heartbeatAt,
    expectedExpiresAtMs: firstExpiry, observedAtMs: firstExpiry + 2 }, path)).toBe(false);
  const current = activeResourceLeases(readResourceLedger(path))[0]!;
  const currentExpiry = Date.parse(current.heartbeatAt) + current.ttlMs;
  expect(reapResourceLeaseIfCurrent({ id: current.id, expectedHeartbeatAt: current.heartbeatAt,
    expectedExpiresAtMs: currentExpiry, observedAtMs: currentExpiry }, path)).toBe(true);
  expect(activeResourceLeases(readResourceLedger(path))).toEqual([]);
  expect(readResourceLedger(path).at(-1)).toMatchObject({ event: 'lease-reaped', id: started.id,
    expectedHeartbeatAt: current.heartbeatAt, expectedExpiresAt: new Date(currentExpiry).toISOString(),
    observedAt: new Date(currentExpiry).toISOString(), reason: 'expired-and-absent' });
});

test('reconcile reports stale, reaped-candidate, orphan and drift without mutating the ledger', () => {
  const stale = lease();
  const measured: ResourceMeasurement = { host: 'node-b', observedAt: '2026-11-01T00:01:00Z',
    pods: [{ id: 'ns/untracked', lane: 'gate', managed: true, phase: 'Running' }], processes: [], errors: [] };
  const findings = reconcileResourceLeases({ leases: [stale], measurements: [measured], now: new Date('2026-11-01T00:01:00Z') });
  expect(findings.map(row => row.kind)).toEqual(['stale', 'reaped-candidate', 'orphan']);
  expect(findings.every(row => row.action === 'report-only')).toBe(true);
  const drift = reconcileResourceLeases({ leases: [lease({ heartbeatAt: '2026-11-01T00:00:59Z', ttlMs: 60_000 })],
    measurements: [{ ...measured, pods: [{ id: 'ns/p', fp: 'fp_run001', lane: 'gate', mission: 'OTHER', phase: 'Running' }] }], now: new Date('2026-11-01T00:01:00Z') });
  expect(drift.map(row => row.kind)).toEqual(['drift']);
});

test('fake kubectl and ps output feeds host-by-lane matrix and dry-run report', async () => {
  const calls: string[] = [];
  const run = (command: string, args: string[], host?: string) => {
    calls.push(`${command}:${host ?? 'local'}:${args.join(' ')}`);
    if (command === 'kubectl' && args.includes('nodes')) return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'node-b' } }] }), stderr: '' };
    if (command === 'kubectl') return { status: 0, stdout: JSON.stringify({ items: [
      { metadata: { namespace: 'ta', name: 'child', labels: { 'elanous.ai/fp': 'fp_run001', 'elanous.ai/lane': 'ta', 'elanous.ai/cell': 'TA-1' } }, status: { phase: 'Running' }, spec: { nodeName: 'node-b', containers: [{ resources: { requests: { cpu: '2', memory: '1Gi' } } }] } },
      { metadata: { namespace: 'ta', name: 'orphan', labels: { 'elanous.substrate': 'pod' } }, status: { phase: 'Pending' }, spec: { nodeName: 'node-b', containers: [] } },
    ] }), stderr: '' };
    return { status: 0, stdout: '101 1 bun bin/elanous.mjs harness say fp_run001\n202 1 node worker\n303 1 bun elanous-job\n', stderr: '' };
  };
  const measured = collectResourceMeasurement('node-b', 'pool-node-b', run, new Date('2026-11-01T00:01:00Z'));
  expect(calls).toEqual(['kubectl:local:--context pool-node-b get pods -A -o json', 'ps:node-b:-eo pid=,ppid=,args=', 'kubectl:local:--context pool-node-b get nodes -o json']);
  expect(measured).toMatchObject({ pods: [{ fp: 'fp_run001', lane: 'ta', phase: 'Running', cpu: 2, memoryBytes: 1024 ** 3 }, { phase: 'Pending' }], processes: [{ fp: 'fp_run001' }, {}], errors: [] });
  const matrix = resourceMatrix({ hosts: [{ host: 'node-b', capacity: { ta: 4 } }], leases: [lease({ resources: { cpu: 2, memoryBytes: 1024 ** 3 }, heartbeatAt: '2026-11-01T00:00:59Z', ttlMs: 60_000 })], measurements: [measured] });
  expect(matrix.find(row => row.lane === 'ta')).toMatchObject({ capacity: 4, leases: 1, measuredPods: 1, measuredProcesses: 1, unknownProcesses: 1, deltaLeasesVsPods: 0, observedPodCpuRequests: 2, observedPodMemoryRequestsBytes: 1024 ** 3, deltaCpuRequests: 0, deltaMemoryRequestsBytes: 0 });
  expect(matrix).toHaveLength(7);

  const root = new Command(); const resources = root.command('resources');
  registerResourceLedgerCommands(resources, { events: () => [{ event: 'lease-created', at: '2026-11-01T00:00:00Z', lease: lease({ heartbeatAt: '2026-11-01T00:00:00Z' }) }],
    hosts: () => [{ host: 'node-b', context: 'pool-node-b', capacity: { ta: 4 } }], run, now: () => new Date('2026-11-01T00:01:00Z') });
  const output: string[] = []; const original = console.log; console.log = (line?: unknown) => { output.push(String(line)); };
  try { await root.parseAsync(['node', 'eln', 'resources', 'reconcile', '--dry-run', '--json']); }
  finally { console.log = original; }
  const report = JSON.parse(output[0]!);
  expect(report).toMatchObject({ mode: 'dry-run', unknownProcessCount: 1, mutations: [], findings: expect.arrayContaining([expect.objectContaining({ kind: 'stale', action: 'report-only' }), expect.objectContaining({ kind: 'orphan', action: 'report-only' })]) });
  expect(calls.some(call => call.startsWith('kubectl:'))).toBe(true);
});

test('unavailable kubectl or ps is unknown, never an empty healthy measurement', () => {
  const measured = collectResourceMeasurement('node-b', 'pool-node-b', () => ({ status: 1, stdout: '', stderr: 'offline' }));
  expect(measured).toMatchObject({ pods: [], processes: [], errors: ['kubectl: offline', 'ps: offline'] });
  expect(resourceMatrix({ hosts: [{ host: 'node-b' }], leases: [], measurements: [measured] })[0]).toMatchObject({ measuredPods: null, measuredProcesses: null, deltaLeasesVsPods: null });
  expect(reconcileResourceLeases({ leases: [lease()], measurements: [measured], now: new Date('2026-11-01T00:01:00Z') }).map(row => row.kind)).toEqual(['stale', 'measurement-unavailable']);
});

test('a parent host without a kube context is measured through its remote kubectl and ps', () => {
  const calls: string[] = [];
  const measured = collectResourceMeasurement('gcp1', undefined, (command, args, host) => {
    calls.push(`${command}@${host}:${args.join(' ')}`);
    return command === 'kubectl'
      ? { status: 0, stdout: args.includes('nodes') ? '{"items":[{"metadata":{"name":"gcp1"}}]}' : '{"items":[]}', stderr: '' }
      : { status: 0, stdout: '', stderr: '' };
  });
  expect(calls).toEqual(['kubectl@gcp1:get pods -A -o json', 'ps@gcp1:-eo pid=,ppid=,args=', 'kubectl@gcp1:get nodes -o json']);
  expect(measured.errors).toEqual([]);
});

test('shared kube contexts are unknown per host and spawn failures remain measurement errors', () => {
  const calls: string[] = [];
  const snapshot = buildResourceLedgerSnapshot({
    events: () => [], hosts: () => [{ host: 'gcp1', context: 'shared' }, { host: 'gcp2', context: 'shared' }],
    run: (command, args, host) => { calls.push(`${command}:${host ?? 'local'}`); return { status: 0, stdout: command === 'kubectl' ? '{"items":[]}' : '', stderr: '' }; },
    now: () => new Date('2026-11-01T00:00:00Z'),
  });
  expect(calls.filter(call => call.startsWith('kubectl'))).toEqual([]);
  expect(snapshot.measurements.every(row => row.errors.some(error => error.includes('shared kube context')))).toBe(true);
  const spawnFailure = collectResourceMeasurement('offline', undefined,
    (() => ({ status: null, stdout: '', stderr: null as unknown as string })) as ResourceCommandRunner);
  expect(spawnFailure.errors).toEqual(['kubectl: exit unknown', 'ps: exit unknown']);
  const missingBinaries = mkdtempSync(join(tmpdir(), 'resource-ledger-empty-path-')); dirs.push(missingBinaries);
  const oldPath = process.env.PATH;
  process.env.PATH = missingBinaries;
  try {
    const actualSpawnFailure = collectResourceMeasurement('offline', undefined, undefined, new Date('2026-11-01T00:00:00Z'));
    expect(actualSpawnFailure.errors).toEqual(['kubectl: exit unknown', 'ps: exit unknown']);
  } finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
});

test('Kubernetes decimal memory suffixes are measured in SI bytes', () => {
  const measured = collectResourceMeasurement('gcp1', undefined, (command, args) => command === 'kubectl'
    ? { status: 0, stdout: args.includes('nodes') ? '{"items":[{"metadata":{"name":"gcp1"}}]}' : JSON.stringify({ items: ['1G', '500M', '1e3', '1Pi', '500m', '.5Gi', '1.', '2Z'].map((memory, index) => ({ metadata: { name: `decimal-memory-${index}` }, spec: { nodeName: 'gcp1', containers: [{ resources: { requests: { memory } } }] } })) }), stderr: '' }
    : { status: 0, stdout: '', stderr: '' });
  expect(measured.pods.map(pod => pod.memoryBytes)).toEqual([1_000_000_000, 500_000_000, 1_000, 1024 ** 5, 0.5, 0.5 * 1024 ** 3, 1, undefined]);
  expect(measured.pods[7]?.memoryUnknown).toBe(true);
  expect(measured.errors).toContain('kubectl: unsupported memory quantity preserved as unknown');
});

test('multiple nodes in one context make Pod host attribution unknown', () => {
  const measured = collectResourceMeasurement('gcp1', 'pool-gcp', (command, args) => command === 'kubectl'
    ? { status: 0, stdout: args.includes('nodes')
      ? '{"items":[{"metadata":{"name":"node-a"}},{"metadata":{"name":"node-b"}}]}'
      : '{"items":[{"metadata":{"name":"p"},"spec":{"nodeName":"node-a","containers":[]}}]}', stderr: '' }
    : { status: 0, stdout: '', stderr: '' });
  expect(measured.errors).toContain('kubectl nodes: context spans 2 nodes; host=unknown');
  expect(measured.pods[0]).toMatchObject({ host: 'unknown', managed: false });
});

test('lane and mission filters scope leases and measured objects together while preserving unknown Pods', () => {
  const otherLease = lease({ id: 'fp_gate01', fp: 'fp_gate01', lane: 'gate', mission: { cell: 'OTHER' } });
  const snapshot = buildResourceLedgerSnapshot({
    events: () => [lease(), otherLease].map(row => ({ event: 'lease-created' as const, at: row.startedAt, lease: row })),
    hosts: () => [{ host: 'node-b', context: 'pool-node-b' }], now: () => new Date('2026-11-01T00:00:05Z'),
    run: (command, args) => command === 'kubectl'
      ? { status: 0, stdout: args.includes('nodes') ? '{"items":[{"metadata":{"name":"node-b"}}]}' : JSON.stringify({ items: [
        { metadata: { name: 'ta', labels: { 'elanous.ai/fp': 'fp_run001', 'elanous.ai/lane': 'ta', 'elanous.ai/cell': 'TA-1' } }, spec: { nodeName: 'node-b', containers: [] } },
        { metadata: { name: 'gate', labels: { 'elanous.ai/fp': 'fp_gate01', 'elanous.ai/lane': 'gate', 'elanous.ai/cell': 'OTHER' } }, spec: { nodeName: 'node-b', containers: [] } },
        { metadata: { name: 'unlabeled', labels: { 'elanous.substrate': 'pod' } }, spec: { nodeName: 'node-b', containers: [] } },
      ] }), stderr: '' }
      : { status: 0, stdout: '1 0 bun elanous fp_run001\n2 0 bun elanous fp_gate01\n', stderr: '' },
  }, { lane: 'ta', mission: 'TA-1' });
  expect(snapshot.leases.map(row => row.fp)).toEqual(['fp_run001']);
  expect(snapshot.matrix.map(row => row.lane)).toEqual(['ta']);
  expect(snapshot.matrix[0]).toMatchObject({ leases: 1, measuredPods: 1, unknownPods: 1 });
  expect(snapshot.findings.some(row => row.kind === 'orphan')).toBe(false);
});

test('ps failure reports unknown process count as null and status unmeasured', async () => {
  const root = new Command(); const resources = root.command('resources');
  registerResourceLedgerCommands(resources, { events: () => [], hosts: () => [{ host: 'gcp1', context: 'pool-gcp1' }],
    run: (command, args) => command === 'kubectl'
      ? { status: 0, stdout: args.includes('nodes') ? '{"items":[{"metadata":{"name":"gcp1"}}]}' : '{"items":[]}', stderr: '' }
      : { status: 1, stdout: '', stderr: 'ps offline' }, now: () => new Date('2026-11-01T00:00:00Z') });
  const output: string[] = []; const original = console.log; console.log = (line?: unknown) => { output.push(String(line)); };
  try { await root.parseAsync(['node', 'eln', 'resources', 'reconcile', '--dry-run', '--json']); }
  finally { console.log = original; }
  expect(JSON.parse(output[0]!)).toMatchObject({ unknownProcessCount: null, unknownProcessStatus: 'unmeasured' });
});
