import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');

test('els side attach registered remote address reaches SSH wire and consumes a frame in the real TUI', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-ssh-cli-'));
  try {
    const binDir = join(root, 'bin');
    const stateDir = join(root, 'state');
    mkdirSync(binDir); mkdirSync(join(stateDir, 'els'), { recursive: true });
    const pin = join(root, 'known_hosts');
    writeFileSync(pin, 'remote.tail123.ts.net ssh-ed25519 test-key\n', { mode: 0o600 });
    writeFileSync(join(stateDir, 'els', 'hosts.json'), JSON.stringify({ hosts: [{ name: 'remote', baseUrl: 'http://remote.tail123.ts.net:8790',
      attach: { sshTarget: 'tester@remote.tail123.ts.net', knownHostsFile: pin } }] }));
    const argsFile = join(root, 'ssh-args');
    const ssh = join(binDir, 'ssh');
    writeFileSync(ssh, '#!/bin/sh\nprintf "%s\\n" "$@" > "$SSH_ARGS_FILE"\nIFS= read -r line\nprintf "%s\\n" \'{"op":"frame","pane":"pane_1","seq":1,"cols":80,"rows":19,"screen":"REMOTE_FRAME_READY","back":0}\'\nIFS= read -r line\n');
    chmodSync(ssh, 0o755);
    const run = await mockSeatPtySequence({ executable: process.execPath,
      args: [BIN, '--test-state-dir', '{root}', 'side', 'attach', 'remote:ws/tab/pane_1'], root: stateDir,
      rows: 20, cols: 80, env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, SSH_ARGS_FILE: argsFile },
      ready: { label: 'remote-frame', timeoutMs: 15_000, until: (screen) => screen.includes('REMOTE_FRAME_READY') },
      steps: [{ label: 'frame-consumed', text: '', until: 'REMOTE_FRAME_READY', timeoutMs: 1_000 }], quitKeys: '\u0002q' });
    expect(run.exitCode).toBe(0);
    const argv = readFileSync(argsFile, 'utf8');
    expect(argv).toContain('StrictHostKeyChecking=yes');
    expect(argv).toContain(`UserKnownHostsFile=${pin}`);
    expect(argv).toContain('GlobalKnownHostsFile=/dev/null');
    expect(argv).toContain('pane_1');
    expect(argv).toContain('http://remote.tail123.ts.net:8790');
    expect(argv).toContain('ws\n');
    expect(argv).toContain('tab\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test('els side attach unregistered remote address refuses in the real CLI before SSH spawn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-ssh-unregistered-'));
  try {
    const binDir = join(root, 'bin');
    const stateDir = join(root, 'state');
    mkdirSync(binDir); mkdirSync(join(stateDir, 'els'), { recursive: true });
    writeFileSync(join(stateDir, 'els', 'hosts.json'), JSON.stringify({ hosts: [] }));
    const called = join(root, 'ssh-called');
    const ssh = join(binDir, 'ssh');
    writeFileSync(ssh, '#!/bin/sh\ntouch "$SSH_CALLED_FILE"\nexit 0\n'); chmodSync(ssh, 0o755);
    const run = await mockSeatPtySequence({ executable: process.execPath,
      args: [BIN, '--test-state-dir', '{root}', 'side', 'attach', 'unknown:ws/tab/pane_1'], root: stateDir,
      rows: 20, cols: 80, env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, SSH_CALLED_FILE: called },
      ready: { label: 'unregistered', timeoutMs: 10_000, until: (screen) => screen.includes('not registered') },
      steps: [{ label: 'refused', text: '', until: 'not registered', timeoutMs: 1_000 }], quitKeys: '' });
    expect(run.exitCode).toBe(2);
    expect(existsSync(called)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);
