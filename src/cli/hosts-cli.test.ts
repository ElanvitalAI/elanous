import { Command } from 'commander';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHostsCommands } from './hosts-cli.js';
import { readHostLedger } from '../nexus/host-registry/store.js';
import type { HostLedger } from '../nexus/host-registry/types.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const NOW = 10_000_000;
const ledger: HostLedger = { version: 1, hosts: {
  'host-a': { host: 'host-a', seat: 'TC', channel: 'dev', installedSha: A, lastHeartbeatMs: NOW - 30_000, state: 'behind' },
  'host-b': { host: 'host-b', channel: 'release', installedSha: B, lastHeartbeatMs: NOW - 60_000, state: 'current' },
} };

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
