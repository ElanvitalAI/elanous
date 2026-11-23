import { Command } from 'commander';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHostsCommands, renderUtilSnapshot } from './hosts-cli.js';
import { readHostLedger } from '../nexus/host-registry/store.js';
import type { HostLedger } from '../nexus/host-registry/types.js';
import type { CentralHeartbeatOutcome, HostHeartbeatEntry } from '../nexus/host-registry/heartbeat-http.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const NOW = 10_000_000; // 출처: #39774 FIXTURE 시각 기준(합성 · 테스트 전용)
const ledger: HostLedger = { version: 1, hosts: {
  'host-a': { host: 'host-a', seat: 'TC', channel: 'dev', installedSha: A, lastHeartbeatMs: NOW - 30_000, state: 'behind' },
  'host-b': { host: 'host-b', channel: 'release', installedSha: B, lastHeartbeatMs: NOW - 60_000, state: 'current' },
} };

test('hosts util preserves stopped and unmeasured values and identifies snapshot age', () => {
  const text = 'host\tload1\tncpu\trunning_pods\treview_slots_used_cap\naws1\tstopped\t16\t0\tunmeasured\nmsb1\t3.2\t32\t7\t1/8\nprovider_usage\tprovider\n';
  const output = renderUtilSnapshot({ text, path: '/util.tsv', modifiedAt: NOW - 60_000 }, NOW);
  expect(output).toContain('age=1m (snapshot, not live)');
  expect(output).toContain('aws1\tstopped\t16\tunmeasured\tunmeasured');
  expect(output).toContain('node-b\t3.2\t32\tunmeasured\t1/8');
  expect(output).not.toContain('provider_usage');
  expect(renderUtilSnapshot(undefined, NOW)).toContain('unmeasured');
  expect(renderUtilSnapshot({ text: 'host\tload1\na\t1', path: '/bad', modifiedAt: NOW }, NOW)).toContain('invalid UTIL columns');
});

test('hosts util trusts pod counts only when the collector confirms the probe', () => {
  const text = 'host\tload1\tncpu\trunning_pods\treview_slots_used_cap\tpod_probe_status\na\t1\t4\t0\t0/4\tok\nb\t1\t4\t0\t0/4\terror\n';
  const output = renderUtilSnapshot({ text, path: '/u', modifiedAt: NOW }, NOW);
  expect(output).toContain('a\t1\t4\t0\t0/4');
  expect(output).toContain('b\t1\t4\tunmeasured\t0/4');
});

test('hosts start uses the requested VM and does not call an unknown host', async () => {
  const started: string[] = [];
  const out: string[] = [];
  const program = new Command();
  registerHostsCommands(program, { startVm: async host => { started.push(host); }, readLedger: () => undefined,
    probeVm: async () => { throw new Error('offline'); }, utilSnapshot: () => undefined, now: () => NOW, write: line => out.push(line) });
  await program.parseAsync(['node', 'test', 'hosts', 'start', 'aws1']);
  expect(started).toEqual(['aws1']);
  expect(out.join('\n')).toContain('STARTED · READY UNMEASURED');
  const prior = process.exitCode;
  try {
    await program.parseAsync(['node', 'test', 'hosts', 'start', 'members']);
    expect(started).toEqual(['aws1']);
    expect(out.join('\n')).toContain('start refused');
  } finally { process.exitCode = prior ?? 0; }
});

test('hosts start reports live metrics only for the desired installed SHA', async () => {
  const out: string[] = [];
  const program = new Command();
  registerHostsCommands(program, { startVm: async () => {}, desired: () => B, write: line => out.push(line),
    probeVm: async () => ({ installedSha: B, load: 1.5, cpus: 16, pods: 2, reviewUsed: 1, reviewCapacity: 8 }) });
  await program.parseAsync(['node', 'test', 'hosts', 'start', 'aws1']);
  expect(out.join('\n')).toContain('aws1\tREADY\t1.5\t16\t2\t1/8');
});

test('hosts start refuses READY for an incorrect installed SHA', async () => {
  const out: string[] = [];
  const program = new Command();
  registerHostsCommands(program, { startVm: async () => {}, desired: () => B, write: line => out.push(line),
    probeVm: async () => ({ installedSha: A, load: 1.5, cpus: 16, pods: 2, reviewUsed: 1, reviewCapacity: 8 }) });
  await program.parseAsync(['node', 'test', 'hosts', 'start', 'aws1']);
  expect(out.join('\n')).toContain('READY UNMEASURED');
});

async function run(args: string[], l: HostLedger | undefined): Promise<string> {
  const out: string[] = [];
  const program = new Command();
  registerHostsCommands(program, { readLedger: () => l, desired: () => B, now: () => NOW, write: (s) => out.push(s) });
  await program.parseAsync(['node', 'test', 'hosts', 'list', ...args]);
  return out.join('\n');
}

test('hosts list prints columns and marks behind', async () => {
  const text = await run([], ledger);
  expect(text.split('\n')[0]).toBe(['HOST', 'SEAT', 'INSTALLED', 'DESIRED', 'STATE', 'HEARTBEAT'].join('\t'));
  expect(text).toContain('host-a\tTC\taaaaaaaaaa\tbbbbbbbbbb\tbehind !\t30s');
  expect(text).toContain('host-b\t-\tbbbbbbbbbb\tbbbbbbbbbb\tcurrent\t1m');
});

test('hosts list --json is structured', async () => {
  const j = JSON.parse(await run(['--json'], ledger));
  expect(j.outcome).toBe('measured');
  expect(j.hosts.map((h: { host: string; state: string }) => [h.host, h.state])).toEqual([['host-a', 'behind'], ['host-b', 'current']]);
});

test('no ledger -> unmeasured', async () => {
  expect(await run([], undefined)).toContain('unmeasured');
  expect(JSON.parse(await run(['--json'], undefined))).toEqual({ outcome: 'unmeasured', hosts: [] });
});

test('hosts heartbeat records via the CLI (production writer) and keeps channel unknown when omitted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hostscli-'));
  const path = join(dir, 'host-registry.json');
  try {
    const out: string[] = [];
    const program = new Command();
    registerHostsCommands(program, { ledgerPath: () => path, desired: () => B, now: () => NOW, write: (s) => out.push(s) });
    await program.parseAsync(['node', 'test', 'hosts', 'heartbeat', '--host', 'host-a', '--installed-sha', A, '--seat', 'TC']);
    const rec = readHostLedger(path)!.hosts['host-a'];
    expect(rec).toMatchObject({ host: 'host-a', seat: 'TC', installedSha: A, channel: 'unknown', state: 'behind' });
    expect(out.join('\n')).toContain('host-a');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hosts list skips malformed host entries instead of crashing', async () => {
  const bad = { version: 1, hosts: { 'host-a': ledger.hosts['host-a'], broken: { host: 7 } } } as unknown as HostLedger;
  const text = await run([], bad);
  expect(text).toContain('host-a\tTC');
  expect(text).not.toContain('broken');
});

interface CentralCall { entry: HostHeartbeatEntry; options: { baseUrl?: string; bearerToken?: string; queuePath?: string } }

async function runHeartbeat(args: string[], outcome: CentralHeartbeatOutcome, central: CentralCall[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'hostscli-hb-'));
  const path = join(dir, 'host-registry.json');
  const queuePath = join(dir, 'host-heartbeat-queue.jsonl');
  try {
    const out: string[] = [];
    const program = new Command();
    registerHostsCommands(program, {
      ledgerPath: () => path, desired: () => B, now: () => NOW, write: (s) => out.push(s),
      env: {}, nexusUrl: () => undefined,
      sendCentral: async (entry, options) => { central.push({ entry, options }); return outcome; },
      queuePath: () => queuePath,
    });
    await program.parseAsync(['node', 'test', 'hosts', 'heartbeat', '--host', 'host-a', '--installed-sha', A, ...args]);
    // finally 의 rmSync 가 임시 원장까지 지우므로, 판독은 반환식 안에서(정리 전) 일어난다.
    return { out, path, queuePath, ledger: readHostLedger(path) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('heartbeat: central send wires --url/--machine-token through the entry and prints central-sent', async () => {
  const central: CentralCall[] = [];
  const { out, path, ledger } = await runHeartbeat(['--url', 'http://nexus.test', '--machine-token', 'tok', '--seat', 'TC', '--channel', 'dev'],
    { outcome: 'sent', host: 'host-a', state: 'current', drained: { sent: 0, kept: 0 } }, central);
  expect(central).toEqual([{
    entry: { host: 'host-a', installedSha: A, seat: 'TC', channel: 'dev', at: new Date(NOW).toISOString() },
    options: { baseUrl: 'http://nexus.test', bearerToken: 'tok', queuePath: join(path, '..', 'host-heartbeat-queue.jsonl') },
  }]);
  expect(out.join('\n')).toContain('central-sent\thost-a\tcurrent');
  expect(ledger!.hosts['host-a']).toMatchObject({ installedSha: A });   // 로컬 기록도 그대로
});

test('heartbeat: central queue drain report prints when pending entries were re-sent', async () => {
  const { out } = await runHeartbeat(['--url', 'http://nexus.test', '--machine-token', 'tok'],
    { outcome: 'sent', host: 'host-a', state: 'current', drained: { sent: 2, kept: 1 } });
  expect(out.join('\n')).toContain('central-queue\t재전송 2 · 보류 1');
});

test('heartbeat: central send failure queues locally without failing the local record', async () => {
  const { out } = await runHeartbeat(['--url', 'http://nexus.test', '--machine-token', 'tok'],
    { outcome: 'queued', reason: 'endpoint-unavailable', queued: 1, drained: { sent: 0, kept: 0 } });
  expect(out.join('\n')).toContain('central-send 실패(endpoint-unavailable) · 로컬 큐 적체 1');
});

test('heartbeat: unconfigured (no URL, no token) stays local-only and silent; partial config prints a notice', async () => {
  const silent = await runHeartbeat([], { outcome: 'sent', host: 'host-a', state: 'current', drained: { sent: 0, kept: 0 } });
  expect(silent.out.filter((line) => line.startsWith('central'))).toEqual([]);
  expect(silent.out.join('\n')).not.toContain('central 미전송');

  const urlOnly = await runHeartbeat(['--url', 'http://nexus.test'], { outcome: 'unconfigured' });
  expect(urlOnly.out.join('\n')).toContain('central 미전송 · 기계 토큰 미구성 (--machine-token 또는 ELANOUS_NEXUS_MACHINE_TOKEN)');

  const program = new Command();
  const out: string[] = [];
  registerHostsCommands(program, {
    env: { ELANOUS_NEXUS_MACHINE_TOKEN: 'envtok' }, nexusUrl: () => undefined,
    readLedger: () => undefined, desired: () => B, now: () => NOW, write: (s) => out.push(s),
  });
  await program.parseAsync(['node', 'test', 'hosts', 'heartbeat', '--host', 'host-a', '--installed-sha', A]);
  expect(out.join('\n')).toContain('central 미전송 · Nexus base URL 미구성 (--url 또는 ELANOUS_NEXUS_URL)');
});
