// ELS-SSH-ATTACH-ANYWHERE (OP #108522) — `attachElsOverSsh`: the same attach wire
// (auth/attach/input/resize out, frame/end/error in) carried by an ssh stdio stream instead
// of a unix socket, so a pane on any reachable ssh host can be attached from anywhere.
// The fake ssh below records the argv and the written lines, and replays remote lines back.
import { describe, expect, test } from 'bun:test';
import { attachElsOverSsh, resolveSshAttach, sshAttachArgv, type SshAttachDeps } from './attach-ssh.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { FederatedHost } from './hosts.js';
import type { AttachFrame } from './attach-client.js';

interface FakeSsh {
  argv: string[];
  written: string[];
  killed: number;
  respond(line: string): void;
  respondRaw(chunk: Buffer): void;
  stderr(chunk: Buffer): void;
  exit(code: number | null, message: string): void;
}

function fakeSshDeps(): { deps: SshAttachDeps; ssh: FakeSsh } {
  const ssh: FakeSsh = { argv: [], written: [], killed: 0, respond: () => {}, respondRaw: () => {}, stderr: () => {}, exit: () => {} };
  const decoder = { push: (): void => {} };
  let onLine: (line: string) => void = () => {};
  ssh.respond = (line) => onLine(line + '\n');
  ssh.exit = (code, message) => {
    // flush any pending decode, then end
    onExiters.forEach((fn) => fn(code, message));
  };
  const onExiters: ((code: number | null, message: string) => void)[] = [];
  const deps: SshAttachDeps = {
    spawn: (argv, handlers) => {
      ssh.argv = [...argv];
      onLine = (line) => handlers.onStdout(Buffer.from(line, 'utf8'));
      ssh.respondRaw = handlers.onStdout;
      ssh.stderr = handlers.onStderr;
      onExiters.push((code, message) => handlers.onExit(code, message));
      return {
        write: (text) => ssh.written.push(text),
        kill: () => { ssh.killed += 1; },
        end: () => {},
      };
    },
  };
  return { deps, ssh };
}

const knownHostsFile = join(mkdtempSync(join(tmpdir(), 'els-ssh-attach-')), 'known_hosts');
writeFileSync(knownHostsFile, 'minim5 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBOGUS\n', { mode: 0o600 });
const host: FederatedHost = { name: 'minim5', baseUrl: 'http://minim5.tail123.ts.net:8790',
  attach: { sshTarget: 'tester@minim5.tail123.ts.net', knownHostsFile } };

describe('attachElsOverSsh', () => {
  test('registered pinned address resolves; unregistered, unpinned and changed origin refuse before spawn', () => {
    const registry = { hosts: [host], rejected: [] };
    expect(resolveSshAttach(registry, 'minim5:ws/tab/pane_1')).toEqual({ host, pane: 'pane_1' });
    expect(() => resolveSshAttach(registry, 'other:ws/tab/pane_1')).toThrow('not registered');
    expect(() => resolveSshAttach({ hosts: [{ name: 'other', baseUrl: 'http://other.tail123.ts.net' }], rejected: [] }, 'other:ws/tab/pane_1')).toThrow('no pinned');
    expect(() => sshAttachArgv({ ...host, baseUrl: 'http://changed.tail123.ts.net' }, 'pane_1', 80, 24)).toThrow('HostName differs');
    expect(() => sshAttachArgv({ ...host, attach: { ...host.attach!, knownHostsFile: '/missing/pin' } }, 'pane_1', 80, 24)).toThrow();
  });

  test('hostile user SSH config cannot override the effective pin and strict verification', () => {
    const home = mkdtempSync(join(tmpdir(), 'els-ssh-hostile-'));
    const sshDir = join(home, '.ssh');
    mkdirSync(sshDir);
    writeFileSync(join(sshDir, 'config'), 'Host *\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n  GlobalKnownHostsFile /etc/ssh/ssh_known_hosts\n');
    const argv = sshAttachArgv(host, 'pane_1', 80, 24);
    const effective = execFileSync('ssh', ['-G', ...argv.slice(0, argv.indexOf('--')), host.attach!.sshTarget],
      { env: { ...process.env, HOME: home }, encoding: 'utf8' }).toLowerCase();
    expect(effective).toContain('stricthostkeychecking true');
    expect(effective).toContain(`userknownhostsfile ${knownHostsFile.toLowerCase()}`);
    expect(effective).toContain('globalknownhostsfile /dev/null');
  });

  test('no-newline stdout and oversized stderr terminate during receipt', () => {
    for (const stream of ['stdout', 'stderr'] as const) {
      const { deps, ssh } = fakeSshDeps();
      const ends: string[] = [];
      attachElsOverSsh(host, 'pane_1', { cols: 80, rows: 24 },
        { onFrame: () => {}, onEnd: (_, reason) => ends.push(reason) }, deps);
      if (stream === 'stdout') {
        ssh.respondRaw(Buffer.alloc(1024 * 1024 + 1, 0x78));
      } else ssh.stderr(Buffer.alloc(64 * 1024 + 1, 0x78));
      expect(ssh.killed).toBe(1);
      ssh.exit(255, '');
      expect(ends).toEqual(['els attach: SSH output exceeded limit']);
    }
  });

  test('many bounded frame lines can keep a long attach open', () => {
    const { deps, ssh } = fakeSshDeps();
    const ends: string[] = [];
    attachElsOverSsh(host, 'pane_1', { cols: 80, rows: 24 },
      { onFrame: () => {}, onEnd: (_, reason) => ends.push(reason) }, deps);
    for (let index = 0; index < 1100; index++) ssh.respondRaw(Buffer.alloc(1024, 10));
    expect(ssh.killed).toBe(0);
    expect(ends).toEqual([]);
  });

  test('spawns ssh with the host, the remote bridge command, the pane and the size, and speaks the same wire', async () => {
    const { deps, ssh } = fakeSshDeps();
    const frames: AttachFrame[] = [];
    const ends: [number | null, string][] = [];
    const errors: string[] = [];
    const attached = attachElsOverSsh(host, 'pane_1', { cols: 100, rows: 30 },
      { onFrame: (frame) => frames.push(frame), onEnd: (code, reason) => ends.push([code, reason]), onError: (message) => errors.push(message) },
      deps);
    expect(ssh.argv).toEqual(['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHostsFile}`,
      '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'HostName=minim5.tail123.ts.net', '-o', 'ConnectTimeout=10', '--',
      'tester@minim5.tail123.ts.net', 'elanous', 'side', 'attach-stdio', 'pane_1', '100', '30']);
    // no credential crosses ssh: the first line is the attach, no auth line, no token anywhere
    expect(ssh.written[0]).toBe(JSON.stringify({ op: 'attach', cols: 100, rows: 30 }) + '\n');
    expect(ssh.written.join('')).not.toMatch(/token|auth/i);
    // a remote frame line decodes into a frame
    // the bridge emits op-based lines ({op:'frame',...}) on stdout
    ssh.respond(JSON.stringify({ op: 'frame', pane: 'pane_1', seq: 1, cols: 100, rows: 30, screen: 'ready\n' }));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ seq: 1, screen: 'ready\n' });
    // input and resize go through the stream as typed
    attached.input('echo hi\r');
    attached.resize(120, 40);
    expect(ssh.written[1]).toBe(JSON.stringify({ op: 'input', bytes: 'echo hi\r' }) + '\n');
    expect(ssh.written[2]).toBe(JSON.stringify({ op: 'resize', cols: 120, rows: 40 }) + '\n');
    // a remote end line ends the attach
    ssh.respond(JSON.stringify({ op: 'end', code: 0, reason: 'pty exit' }));
    await new Promise((resolve) => setTimeout(resolve, 10)); // 출처: one macrotask turn so the exit/end callbacks (microtask-queued) have run; no real I/O
    expect(ends).toEqual([[0, 'pty exit']]);
    expect(errors).toHaveLength(0);
  });

  test('a host or pane that is not a plain name is refused before ssh runs (no remote shell injection, no ssh option injection)', async () => {
    for (const pane of ['p; rm -rf ~', '-x', '$(id)', '']) {
      const { deps, ssh } = fakeSshDeps();
      const ends: [number | null, string][] = [];
      const attached = attachElsOverSsh(host, pane, { cols: 80, rows: 24 }, { onFrame: () => {}, onEnd: (code, reason) => ends.push([code, reason]) }, deps);
      attached.input('x'); attached.detach();
      await new Promise((resolve) => setTimeout(resolve, 5)); // 출처: one macrotask turn after the refusal microtask, no real I/O involved
      expect([pane, ssh.argv, ssh.written, ends.map((e) => e[0])]).toEqual([pane, [], [], [2]]);
    }
  });

  test('a remote error line reports onError, a detach kills the ssh child, and a ssh exit reports onEnd', async () => {
    const { deps, ssh } = fakeSshDeps();
    const ends: [number | null, string][] = [];
    const errors: string[] = [];
    const attached = attachElsOverSsh(host, 'pane_2', { cols: 80, rows: 24 },
      { onFrame: () => {}, onEnd: (code, reason) => ends.push([code, reason]), onError: (message) => errors.push(message) },
      deps);
    ssh.respond(JSON.stringify({ op: 'error', message: 'no such pane' }));
    expect(errors).toEqual(['no such pane']);
    attached.detach();
    expect(ssh.killed).toBe(1);
    ssh.exit(255, 'ssh: connect failed');
    await new Promise((resolve) => setTimeout(resolve, 10)); // 출처: one macrotask turn so the exit/end callbacks (microtask-queued) have run; no real I/O
    expect(ends).toEqual([[1, 'ssh: connect failed']]);
  });
});
