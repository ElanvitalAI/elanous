import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { attachElsOverSsh, type SshAttachDeps, type SshSpawnHandlers } from '../../../els/attach-ssh.js';
import type { FederatedHost } from '../../../els/hosts.js';
import { mockSeatPtySequence } from '../../mock-seat-pty-sequence.js';
import type { SimWorldDeviceDef, SimWorldScenario } from '../types.js';

function device(root: string) {
  const pin = join(root, 'known_hosts');
  writeFileSync(pin, 'remote.tail123.ts.net ssh-ed25519 pinned-key\n', { mode: 0o600 });
  const host: FederatedHost = { name: 'remote', baseUrl: 'http://remote.tail123.ts.net:8790',
    attach: { sshTarget: 'tester@remote.tail123.ts.net', knownHostsFile: pin } };
  let calls = 0;
  let killed = 0;
  let wire: SshSpawnHandlers | undefined;
  let argv: readonly string[] = [];
  const deps: SshAttachDeps = { spawn: (args, handlers) => {
    calls += 1; argv = args; wire = handlers;
    return { write: () => {}, end: () => {}, kill: () => { killed += 1; } };
  } };
  return { host, deps, get calls() { return calls; }, get killed() { return killed; },
    get wire() { return wire; }, get argv() { return argv; } };
}

const DEVICE_ID = 'els-remote-ssh-transport';
const sshDevice: SimWorldDeviceDef<ReturnType<typeof device>> = {
  id: DEVICE_ID, title: 'Pinned SSH attach transport with injected host-key and disconnect events',
  create(ctx) { return device(ctx.universeRoot); },
};

const mismatch: SimWorldScenario = {
  id: 'SSH-HOST-KEY-MISMATCH', title: 'hostile SSH key is refused by strict pin policy before any frame',
  devices: [DEVICE_ID],
  async run(ctx) {
    const fake = ctx.device<ReturnType<typeof device>>(DEVICE_ID);
    const ends: string[] = []; const frames: string[] = [];
    attachElsOverSsh(fake.host, 'pane_1', { cols: 80, rows: 24 },
      { onFrame: frame => frames.push(frame.screen), onEnd: (_, reason) => ends.push(reason) }, fake.deps);
    // Fake SSH device presents a changed key; strict pin policy must be present on the actual spawned command.
    const pinned = fake.argv.includes('StrictHostKeyChecking=yes') && fake.argv.includes('GlobalKnownHostsFile=/dev/null')
      && fake.argv.includes(`UserKnownHostsFile=${fake.host.attach!.knownHostsFile}`) && fake.argv.includes('/dev/null');
    if (pinned) fake.wire?.onExit(255, 'Host key verification failed');
    else fake.wire?.onStdout(Buffer.from('{"op":"frame","screen":"UNTRUSTED"}\n'));
    ctx.recorder.event('els-remote-ssh-key', { pinned, calls: fake.calls, frames, ends });
    return pinned && fake.calls === 1 && frames.length === 0 && ends.length === 1 && ends[0] === 'Host key verification failed'
      ? { ok: true } : { ok: false, reason: 'changed host key entered remote attach', diff: JSON.stringify({ pinned, frames, ends }) };
  },
};

const unregistered: SimWorldScenario = {
  id: 'SSH-UNREGISTERED', title: 'unregistered remote address is refused before SSH spawn',
  devices: [DEVICE_ID],
  async run(ctx) {
    const fake = ctx.device<ReturnType<typeof device>>(DEVICE_ID);
    const root = ctx.universeRoot;
    const state = join(root, 'state'); const bin = join(root, 'bin'); const called = join(root, 'ssh-called');
    mkdirSync(join(state, 'els'), { recursive: true }); mkdirSync(bin);
    writeFileSync(join(state, 'els', 'hosts.json'), JSON.stringify({ hosts: [fake.host] }));
    const ssh = join(bin, 'ssh');
    writeFileSync(ssh, '#!/bin/sh\ntouch "$SSH_CALLED_FILE"\nexit 0\n'); chmodSync(ssh, 0o755);
    const run = await mockSeatPtySequence({ executable: process.execPath,
      args: [join(import.meta.dir, '../../../../bin/elanous.mjs'), '--test-state-dir', '{root}', 'side', 'attach', 'other:ws/tab/pane_1'],
      root: state, rows: 20, cols: 80,
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, SSH_CALLED_FILE: called },
      ready: { label: 'unregistered', timeoutMs: 10_000, until: screen => screen.includes('not registered') },
      steps: [{ label: 'refused', text: '', until: 'not registered', timeoutMs: 1_000 }], quitKeys: '' });
    const refused = run.exitCode === 2 && !existsSync(called);
    ctx.recorder.event('els-remote-unregistered', { refused, exitCode: run.exitCode, sshCalled: existsSync(called) });
    return refused && fake.calls === 0 ? { ok: true }
      : { ok: false, reason: 'unregistered host reached SSH', diff: JSON.stringify({ refused, calls: fake.calls }) };
  },
};

const disconnect: SimWorldScenario = {
  id: 'SSH-DISCONNECT', title: 'SSH disconnect ends one attached frame stream without retrying or input forwarding',
  devices: [DEVICE_ID],
  async run(ctx) {
    const fake = ctx.device<ReturnType<typeof device>>(DEVICE_ID);
    const frames: string[] = []; const ends: number[] = [];
    attachElsOverSsh(fake.host, 'pane_1', { cols: 80, rows: 24 },
      { onFrame: frame => frames.push(frame.screen), onEnd: code => ends.push(code) }, fake.deps);
    fake.wire?.onStdout(Buffer.from('{"op":"frame","pane":"pane_1","seq":1,"cols":80,"rows":24,"screen":"ready","back":0}\n'));
    fake.wire?.onExit(255, 'connection lost');
    fake.wire?.onExit(255, 'connection lost');
    ctx.recorder.event('els-remote-disconnect', { calls: fake.calls, frames, ends, killed: fake.killed });
    return fake.calls === 1 && frames.join() === 'ready' && ends.join() === '1' ? { ok: true }
      : { ok: false, reason: 'disconnect did not end exact stream once', diff: JSON.stringify({ calls: fake.calls, frames, ends }) };
  },
};

export const simWorldScenarios: readonly SimWorldScenario[] = [mismatch, unregistered, disconnect];
export const simWorldDevices: readonly SimWorldDeviceDef[] = [sshDevice];
