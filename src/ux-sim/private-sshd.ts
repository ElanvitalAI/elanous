// A private sshd for tests: the current user's own non-root sshd on a free loopback port, a throw-away host key and user key
// in a temp folder, public-key login only. It never touches ~/.ssh or the system sshd, and goes away with `stop()`.
// Used to drive a REAL ssh login (a real PTY over a real ssh channel) in ELS-SSH-ATTACH-ANYWHERE tests.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SSHD = '/usr/sbin/sshd';

/** True when this machine can run the private sshd (macOS/Linux with /usr/sbin/sshd and ssh-keygen on PATH). */
export function privateSshdAvailable(): boolean {
  return (process.platform === 'darwin' || process.platform === 'linux') && Bun.file(SSHD).size > 0 && spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error === undefined;
}

export interface PrivateSshd {
  readonly port: number;
  /** `ssh` arguments (before the remote command) that log in as the current user. */
  readonly sshArgs: readonly string[];
  readonly stop: () => void;
}

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const port = (probe.address() as { port: number }).port; probe.close(() => resolve(port)); });
});

export async function startPrivateSshd(): Promise<PrivateSshd> {
  const dir = mkdtempSync(join(tmpdir(), 'els-sshd-'));
  const keygen = (file: string): void => {
    const made = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file], { stdio: 'ignore' });
    if (made.status !== 0) throw new Error('ssh-keygen failed');
  };
  keygen(join(dir, 'host'));
  keygen(join(dir, 'user'));
  copyFileSync(join(dir, 'user.pub'), join(dir, 'authorized'));
  chmodSync(join(dir, 'authorized'), 0o600);
  const port = await freePort();
  writeFileSync(join(dir, 'sshd.conf'), [
    `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(dir, 'host')}`, `AuthorizedKeysFile ${join(dir, 'authorized')}`,
    `PidFile ${join(dir, 'sshd.pid')}`, 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes',
    'UsePAM no', 'StrictModes no', 'LogLevel ERROR', '',
  ].join('\n'));
  const child = spawn(SSHD, ['-D', '-e', '-f', join(dir, 'sshd.conf')], { stdio: 'ignore' });
  // Ready when it accepts a connection.
  const deadline = Date.now() + 10_000;
  for (;;) {
    const up = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(true));            // the port is taken = sshd is listening
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
    });
    if (up) break;
    if (child.exitCode !== null || Date.now() > deadline) { rmSync(dir, { recursive: true, force: true }); throw new Error('private sshd did not start'); }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    port,
    sshArgs: ['-i', join(dir, 'user'), '-p', String(port), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR'],
    stop: () => { child.kill('SIGTERM'); rmSync(dir, { recursive: true, force: true }); },
  };
}
