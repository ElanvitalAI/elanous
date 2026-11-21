import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHostRegistry, registeredHostAtExecution } from './hosts.js';
import { remoteUpdateCommand, runRemoteUpdate } from './remote-update.js';

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
