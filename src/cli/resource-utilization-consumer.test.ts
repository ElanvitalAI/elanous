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
