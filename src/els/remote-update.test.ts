import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHostRegistry, registeredHostAtExecution } from './hosts.js';
import { remoteProgressLines, remoteUpdateCommand, runRemoteUpdate, translateRemoteRows } from './remote-update.js';
import { updateResultsTable, updateSummary } from './update-all.js';

test('synthetic remote runtime survives translation and is counted as other runtime', () => {
  const panes = [{ address: 'aws1:w/t/p', host: 'aws1', reach: 'up', seat: 'TC', state: 'working', cwd: '/tmp', kind: 'pty' }];
  const rows = translateRemoteRows('aws1', panes, [{ tab: 'local:w/t/p', seat: 'TC', runtime: 'codex', result: 'skipped', detail: 'no migration' }]);
  expect(rows).toEqual([{ tab: 'aws1:w/t/p', seat: 'TC', runtime: 'codex', result: 'skipped', detail: 'no migration' }]);
  expect(updateResultsTable(rows)).toContain('| aws1:w/t/p | TC | codex | skipped | no migration |');
  expect(updateSummary(rows)).toContain('other runtimes: 1 (no migration needed)');
});

test('remote runtime remains optional for old receipts but rejects malformed values', () => {
  const panes = [{ address: 'aws1:w/t/p', host: 'aws1', reach: 'up', seat: 'TC', state: 'working', cwd: '/tmp' }];
  const row = { tab: 'local:w/t/p', seat: 'TC', result: 'skipped' as const, detail: 'old receipt' };
  expect(translateRemoteRows('aws1', panes, [row])).toEqual([{ ...row, tab: 'aws1:w/t/p' }]);
  expect(() => translateRemoteRows('aws1', panes, [{ ...row, runtime: 123 as unknown as string }])).toThrow('invalid remote pane receipt');
});

test('remote progress rejects split UTF-8 and control characters in arbitrary stderr', () => {
  const output: string[] = [];
  const lines = remoteProgressLines('node-b', line => output.push(line));
  const data = Buffer.from('남은 자리 2\nELS_UPDATE_PROGRESS remaining=2 eta=3\x1b[31m\nELS_UPDATE_PROGRESS remaining=1 eta=2\n');
  lines.write(data.subarray(0, 2));
  expect(output).toEqual([]);
  for (let i = 2; i < data.length; i++) lines.write(data.subarray(i, i + 1));
  lines.end();
  expect(output).toEqual(['[node-b] Remaining seats: 1 · 2s remaining']);
});

test('remote progress accepts only complete numeric records, never arbitrary stderr or split secrets', () => {
  const output: string[] = [];
  const lines = remoteProgressLines('node-b', line => output.push(line));
  const data = Buffer.from('token=secret-value /private/path\nELS_UPDATE_PROGRESS remaining=2 eta=35\nELS_UPDATE_PROGRESS remaining=3 eta=4 token=secret-value\n' + 'x'.repeat(200) + 'ELS_UPDATE_PROGRESS remaining=7 eta=8\n');
  for (let i = 0; i < data.length; i += 3) lines.write(data.subarray(i, i + 3));
  lines.write(Buffer.from('unfinished token=secret-value /private/path'));
  lines.end();
  expect(output).toEqual(['[node-b] Remaining seats: 2 · 35s remaining']);
});

test('registered remote update requires a URL-matched SSH target and a pinned known_hosts file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'els-remote-'));
  const hosts = join(dir, 'hosts.json');
  const known = join(dir, 'known_hosts');
  writeFileSync(known, '100.122.206.119 ssh-ed25519 AAAA\n', { mode: 0o600 });
  const entry = { name: 'aws1', baseUrl: 'http://100.122.206.119:18793', update: {
    sshTarget: 'ubuntu@100.122.206.119', knownHostsFile: known, catchUpSeat: 'TC',
    home: '/tmp/remote home', stateRoot: '/tmp/remote state', cwd: '/tmp/remote cwd', bin: '/usr/local/bin/eln',
  } };
  writeFileSync(hosts, JSON.stringify({ hosts: [entry] }));
  const registered = loadHostRegistry(hosts);
  expect(registered.rejected).toEqual([]);
  const command = remoteUpdateCommand(registered.hosts[0]!, 'a'.repeat(40));
  expect(command.argv).toContain('StrictHostKeyChecking=yes');
  expect(command.argv).toContain(`UserKnownHostsFile=${known}`);
  expect(command.argv).toContain('GlobalKnownHostsFile=/dev/null');
  expect(command.argv).toContain('HostName=100.122.206.119');
  expect(command.script).toContain("HOME='/tmp/remote home'");
  expect(command.script).toContain('ELS_UPDATE_ALL_BEFORE=');
  expect(command.script).toContain('remote desired differs from approved target');
  expect(command.script).toContain('self-update --catch-up --seat TC --json');
  expect(command.script).toContain('side update-all --local-only --json');
  expect(command.script).toContain("self-update --catch-up --seat TC --json --expected-desired 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'");
  expect(command.script).toContain("side update-all --local-only --json --expected-desired 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'");
  writeFileSync(hosts, JSON.stringify({ hosts: [{ ...entry, update: { ...entry.update, sshTarget: 'ubuntu@100.122.206.118' } }] }));
  expect(loadHostRegistry(hosts).rejected[0]).toContain('HostName differs');
  writeFileSync(hosts, JSON.stringify({ hosts: [{ ...entry, update: { ...entry.update, knownHostsFile: '' } }] }));
  expect(loadHostRegistry(hosts).rejected[0]).toContain('knownHostsFile must be absolute');
  writeFileSync(hosts, JSON.stringify({ hosts: [{ ...entry, update: { ...entry.update, knownHostsFile: `${known} ${known}` } }] }));
  expect(loadHostRegistry(hosts).rejected[0]).toContain('single literal file');
  writeFileSync(hosts, JSON.stringify({ hosts: [{ ...entry, update: { ...entry.update, catchUpSeat: undefined } }] }));
  expect(loadHostRegistry(hosts).rejected[0]).toContain('catchUpSeat must be');
});

test('remote OP ownership refuses before an SSH child can bypass its HITL', async () => {
  const host = { name: 'aws1', baseUrl: 'http://100.122.206.119:18793',
    update: { sshTarget: 'ubuntu@100.122.206.119', knownHostsFile: '/missing', catchUpSeat: 'OP' as const } };
  await expect(runRemoteUpdate(host, [], 'a'.repeat(40))).rejects.toThrow('remote OP seat requires');
  await expect(runRemoteUpdate({ ...host, update: { ...host.update, catchUpSeat: 'TC' as const } },
    [{ address: 'aws1:w/t/p', host: 'aws1', reach: 'up', seat: 'OP', state: 'working', cwd: '/tmp' }], 'a'.repeat(40)))
    .rejects.toThrow('remote OP seat requires');
  await expect(runRemoteUpdate({ ...host, update: { ...host.update, catchUpSeat: 'TC' as const } },
    [{ address: 'aws1:w/t/p', host: 'aws1', reach: 'up', state: 'working', cwd: '/tmp' }], 'a'.repeat(40)))
    .rejects.toThrow('remote seat identity unavailable');
});

test('a host registry changed between listing and the SSH effect revokes the selected host', () => {
  const dir = mkdtempSync(join(tmpdir(), 'els-remote-race-'));
  const path = join(dir, 'hosts.json');
  const before = { hosts: [{ name: 'aws1', baseUrl: 'http://100.122.206.119:18794', update: {
    sshTarget: 'ubuntu@100.122.206.119', knownHostsFile: '/tmp/pin', catchUpSeat: 'TC',
  } }] };
  writeFileSync(path, JSON.stringify(before));
  const snapshot = loadHostRegistry(path);
  expect(registeredHostAtExecution(path, snapshot, 'aws1').baseUrl).toBe(before.hosts[0]!.baseUrl);
  writeFileSync(path, JSON.stringify({ hosts: [{ ...before.hosts[0], baseUrl: 'http://100.122.206.119:18795' }] }));
  expect(() => registeredHostAtExecution(path, snapshot, 'aws1')).toThrow('changed after listing');
});
