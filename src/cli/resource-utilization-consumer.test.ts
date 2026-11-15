import { afterEach, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerResourceLedgerCommands, type ResourceLedgerCliDeps } from './resource-ledger-cli.js';
import { readResourceLedger, type HostReadinessHeartbeat, type ResourceLedgerEvent } from '../resource-ledger/resource-ledger.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const at = '2026-11-12T06:00:00.000Z';
const now = new Date(at);
function fixture(): { path: string; deps: ResourceLedgerCliDeps } {
  const dir = mkdtempSync(join(tmpdir(), 'utilization-consumer-')); dirs.push(dir);
  const path = join(dir, 'events.jsonl');
  const events: ResourceLedgerEvent[] = ['busy', 'idle'].map(host => {
    const heartbeat: HostReadinessHeartbeat = { host, at, sshAvailable: true, maintenance: false, gateProtected: false,
      tools: {}, sample: { loadPercent: 5, load15Percent: 5, memoryAvailablePercent: 50, rootDiskUsedPercent: 40, tmpDiskUsedPercent: 40 } };
    return { event: 'host-readiness-heartbeat', at, heartbeat };
  });
  events.push({ event: 'lease-created', at, lease: { id: 'fp_consumer_gate', fp: 'fp_consumer_gate', host: 'busy', lane: 'gate',
    resources: {}, mission: { cell: 'OTHER' }, ttlMs: 60_000, startedAt: at, heartbeatAt: at } });
  writeFileSync(path, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  return { path, deps: { events: () => readResourceLedger(path), now: () => now,
    hosts: () => ['busy', 'idle'].map(host => ({ host, poolMapped: true, capacity: { gate: 2, ta: 4 } })),
    run: command => ({ status: 0, stdout: command === 'ps' ? '' : JSON.stringify({ items: [] }), stderr: '' }),
  } };
}
async function ledger(deps: ResourceLedgerCliDeps, args: string[]): Promise<string[]> {
  const root = new Command();
  registerResourceLedgerCommands(root.command('resources'), deps);
  const output: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...values: unknown[]) => { output.push(values.map(String).join(' ')); });
  const previous = process.exitCode;
  try {
    await root.parseAsync(['node', 'eln', 'resources', 'ledger', ...args]);
    return output;
  } finally { log.mockRestore(); process.exitCode = previous ?? 0; }
}

test('operating resources ledger JSON reads persisted leases into utilization and updates after lease end', async () => {
  const { path, deps } = fixture();
  const before = readFileSync(path, 'utf8');
  const result = JSON.parse((await ledger(deps, ['--json']))[0]!);
  expect(result.utilization.lanes.find((row: { host: string; lane: string }) => row.host === 'busy' && row.lane === 'gate'))
    .toMatchObject({ leases: 1, capacity: 2, utilizationRatio: 0.5 }); // 출처: R-TST43 — fixture의 단일 gate lease / 선언 용량 2.
  expect(result.utilization.hosts.find((row: { host: string }) => row.host === 'busy')).toMatchObject({ leases: 1, idle: false });
  expect(result.utilization.idleHosts).toEqual(['idle']);
  expect(readFileSync(path, 'utf8')).toBe(before);
  appendFileSync(path, JSON.stringify({ event: 'lease-ended', at, id: 'fp_consumer_gate', reason: 'done', stoppedBy: 'test' }) + '\n');
  const ended = JSON.parse((await ledger(deps, ['--json']))[0]!);
  expect(ended.utilization.idleHosts).toEqual(['busy', 'idle']);
});

test('operating resources ledger text displays lane utilization and observed idle hosts', async () => {
  const { deps } = fixture();
  const output = await ledger(deps, []);
  expect(output.some(line => line.includes('차선 활용률(전체 임대/용량)'))).toBe(true);
  expect(output.find(line => line.startsWith('busy\tgate\t'))?.endsWith('\t0.5')).toBe(true);
  expect(output).toContain('유휴 호스트\tidle');
});

test('text distinguishes no confirmed idle hosts from missing heartbeat observations', async () => {
  const { path, deps } = fixture();
  const withoutHeartbeats = { ...deps, events: () => readResourceLedger(path).filter(event => event.event !== 'host-readiness-heartbeat') };
  const output = await ledger(withoutHeartbeats, []);
  expect(output).toContain('유휴 호스트\t확인된 유휴 없음 · 유휴 여부 미측정: idle');
  expect(output).not.toContain('유휴 호스트\t없음');
  const result = JSON.parse((await ledger(withoutHeartbeats, ['--json']))[0]!);
  expect(result.utilization.hosts.find((row: { host: string }) => row.host === 'idle')).toMatchObject({ idle: null });
  expect(result.utilization.idleHosts).toEqual([]);
});

test('text keeps confirmed idle hosts visible beside hosts with unmeasured idle status', async () => {
  const { deps } = fixture();
  const mixed = { ...deps, hosts: () => [
    { host: 'busy', poolMapped: true, capacity: { gate: 2, ta: 4 } },
    { host: 'idle', poolMapped: true, capacity: { gate: 2, ta: 4 } },
    { host: 'unmeasured', poolMapped: true, capacity: { gate: 2, ta: 4 } },
  ] };
  const output = await ledger(mixed, []);
  expect(output).toContain('유휴 호스트\tidle · 유휴 여부 미측정: unmeasured');
  const result = JSON.parse((await ledger(mixed, ['--json']))[0]!);
  expect(result.utilization.idleHosts).toEqual(['idle']);
  expect(result.utilization.hosts.find((row: { host: string }) => row.host === 'unmeasured')).toMatchObject({ idle: null });
});

test('host/lane/mission filters cannot make a host with another consumer appear idle', async () => {
  const { deps } = fixture();
  const result = JSON.parse((await ledger(deps, ['--json', '--host', 'busy', '--lane', 'ta', '--mission', 'TARGET']))[0]!);
  expect(result.leases).toEqual([]);
  expect(result.utilization.hosts.map((row: { host: string }) => row.host)).toEqual(['busy']);
  expect(result.utilization.hosts[0]).toMatchObject({ leases: 1, idle: false });
  expect(result.utilization.idleHosts).toEqual([]);
  expect(result.utilization.lanes.map((row: { lane: string }) => row.lane)).toEqual(['ta']);
});

test('a failed remote ledger source cannot turn a partial snapshot into known idle capacity', async () => {
  const { deps } = fixture();
  const result = JSON.parse((await ledger({ ...deps,
    hosts: () => [{ host: 'idle', poolMapped: true, stateDir: '$HOME/.elanous', capacity: { gate: 2 } }],
    run: command => command === 'cat' ? { status: 1, stdout: '', stderr: 'read denied' }
      : { status: 0, stdout: command === 'ps' ? '' : JSON.stringify({ items: [] }), stderr: '' },
  }, ['--json']))[0]!);
  expect(result.utilization.readStatus).toBe('partial');
  expect(result.utilization.idleHosts).toEqual([]);
  expect(result.utilization.hosts.find((row: { host: string }) => row.host === 'idle')).toMatchObject({ idle: null, utilizationRatio: null });
});

test('remote transport errors with a missing-file phrase do not masquerade as absent ledgers', async () => {
  const { deps } = fixture();
  const hosts = () => [{ host: 'idle', poolMapped: true, stateDir: '$HOME/.elanous', capacity: { gate: 2 } }];
  const run = (status: number, stderr: string) => (command: string) => command === 'cat'
    ? { status, stdout: '', stderr }
    : { status: 0, stdout: command === 'ps' ? '' : JSON.stringify({ items: [] }), stderr: '' };
  const absent = JSON.parse((await ledger({ ...deps, hosts, run: run(1,
    'cat: /home/fake/.elanous/resource-ledger/events.jsonl: No such file or directory\n') }, ['--json']))[0]!);
  expect(absent.utilization.readStatus).toBe('ok');
  expect(absent.utilization.idleHosts).toEqual(['idle']);
  const absoluteDir = JSON.parse((await ledger({ ...deps,
    hosts: () => [{ host: 'idle', poolMapped: true, stateDir: '/srv/elanous', capacity: { gate: 2 } }],
    run: run(1, 'cat: /srv/elanous/resource-ledger/events.jsonl: No such file or directory\n'),
  }, ['--json']))[0]!);
  expect(absoluteDir.utilization.readStatus).toBe('ok');
  const wrongFile = JSON.parse((await ledger({ ...deps, hosts, run: run(1,
    'cat: /tmp/other/resource-ledger/events.jsonl: No such file or directory\n') }, ['--json']))[0]!);
  expect(wrongFile.utilization.readStatus).toBe('partial');
  expect(wrongFile.utilization.idleHosts).toEqual([]);
  const failed = JSON.parse((await ledger({ ...deps, hosts, run: run(255,
    'ssh: connection failed: No such file or directory') }, ['--json']))[0]!);
  expect(failed.utilization.readStatus).toBe('partial');
  expect(failed.utilization.idleHosts).toEqual([]);
  expect(failed.findings.some((finding: { detail: string }) => finding.detail.includes('remote resource ledger unavailable'))).toBe(true);
});

test('registered ledger command preserves six lanes and unknown stale/future idle states without writing the source', async () => {
  const { path, deps } = fixture();
  const lanes = ['gate', 'train', 'ta', 'hand', 'warm', 'bench'] as const;
  const extra: ResourceLedgerEvent[] = lanes.map(lane => ({ event: 'lease-created', at,
    lease: { id: `fp_six_${lane}`, fp: `fp_six_${lane}`, host: 'six', lane, resources: {},
      mission: { cell: 'OTHER' }, ttlMs: 60_000, startedAt: at, heartbeatAt: at } }));
  for (const [host, heartbeatAt] of [
    ['stale', '2026-11-12T05:00:00.000Z'], ['future', '2026-11-12T07:00:00.000Z'],
  ] as const) {
    const heartbeat: HostReadinessHeartbeat = { host, at: heartbeatAt, sshAvailable: true, maintenance: false,
      gateProtected: false, tools: {}, sample: { loadPercent: 5, load15Percent: 5,
        memoryAvailablePercent: 50, rootDiskUsedPercent: 40, tmpDiskUsedPercent: 40 } };
    extra.push({ event: 'host-readiness-heartbeat', at: heartbeatAt, heartbeat });
  }
  appendFileSync(path, extra.map(event => JSON.stringify(event)).join('\n') + '\n');
  const before = readFileSync(path, 'utf8');
  const result = JSON.parse((await ledger({ ...deps, hosts: () => ['busy', 'idle', 'six', 'stale', 'future'].map(host =>
    ({ host, poolMapped: true, capacity: { gate: 2, train: 2, ta: 4, hand: 1, warm: 2, bench: 1 } })) }, ['--json']))[0]!);
  expect(result.utilization.lanes.filter((row: { host: string; leases: number }) => row.host === 'six' && row.leases > 0)
    .map((row: { lane: string }) => row.lane)).toEqual(lanes);
  expect(result.utilization.hosts.find((row: { host: string }) => row.host === 'six')).toMatchObject({ leases: 6, idle: false });
  expect(result.utilization.hosts.filter((row: { host: string }) => row.host === 'stale' || row.host === 'future')
    .map((row: { idle: boolean | null }) => row.idle)).toEqual([null, null]);
  expect(result.utilization.idleHosts).toEqual(['idle']);
  expect(readFileSync(path, 'utf8')).toBe(before);
});
