import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createConnection, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { createFakeSsh } from '../ux-sim/fake-ssh.js';
import { createGridSshBroker, gridSshControlOptions, gridSshControlPath } from './ssh-broker.js';

test('grid ssh brokers keep 60 fake-ssh requests below MaxSessions across instances', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grid-ssh-broker-'));
  const device = createFakeSsh({ hosts: { gcp1: { activeSessions: 0, maxStartups: 10, maxSessions: 10 } } });
  try {
    const transport = async (host: string, script: string, timeoutMs?: number) => {
      const result = await device.openChannel(host, script, 2);
      return { status: result.rc, stdout: result.output, stderr: '' };
    };
    const brokers = Array.from({ length: 3 }, () => createGridSshBroker({
      controlDir: dir, maxSessions: 10, maxRetries: 0, observe: () => undefined, transport,
    }));
    const results = await Promise.all(Array.from({ length: 60 }, (_, index) =>
      brokers[index % brokers.length]!.run('gcp1', 'printf request-' + index, 5_000)));

    expect(results).toHaveLength(60);
    expect(results.every(result => result.status === 0)).toBe(true);
    const channels = device.channelStats('gcp1');
    expect(channels.active).toBe(0);
    expect(channels.peak).toBeGreaterThan(1);
    expect(channels.peak).toBeLessThanOrEqual(9);
    expect(channels.refused).toBe(0);
    expect(device.calls).toHaveLength(60);
    expect(brokers[0]!.snapshot('gcp1')).toMatchObject([{ active: 0, queued: 0, completed: 20, retries: 0, refused: 0, maxChannels: 9 }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


const sshdTest = test;

async function freeLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function waitForSshd(port: number, child: ReturnType<typeof spawn>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`test sshd exited early: ${child.exitCode}`);
    const ready = await new Promise<boolean>(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port });
      const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 100);
      socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
      socket.once('error', () => { clearTimeout(timer); resolve(false); });
    });
    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('test sshd did not become ready');
}

sshdTest('default ssh transport runs real OpenSSH against an instrumented sshd for 60 channels', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grid-ssh-broker-sshd-'));
  const port = await freeLocalPort();
  const user = process.env.USER ?? 'ubuntu';
  const hostAlias = 'broker-test';
  const privateKey = join(dir, 'client-key');
  const publicKey = privateKey + '.pub';
  const hostKey = join(dir, 'host-key');
  const authorizedKeys = join(dir, 'authorized_keys');
  const stateFile = join(dir, 'channel-state');
  const lockFile = join(dir, 'channel-state.lock');
  const wrapper = join(dir, 'remote-shell.sh');
  const configFile = join(dir, 'sshd_config');
  const clientConfig = join(dir, 'ssh_config');
  let server: ReturnType<typeof spawn> | undefined;
  try {
    execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', privateKey]);
    execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
    writeFileSync(authorizedKeys, readFileSync(publicKey));
    writeFileSync(stateFile, '0 0 0\n');
    writeFileSync(wrapper, `#!/bin/sh
state='${stateFile}'
lock='${lockFile}'
bump() {
  exec 9>"$lock"
  flock -x 9
  read active peak calls < "$state"
  active=$((active + $1))
  calls=$((calls + ($1 > 0 ? 1 : 0)))
  if [ "$active" -gt "$peak" ]; then peak=$active; fi
  printf '%s %s %s\n' "$active" "$peak" "$calls" > "$state"
  flock -u 9
}
bump 1
/bin/sh
rc=$?
bump -1
exit "$rc"
`, { mode: 0o700 });
    chmodSync(dir, 0o700); chmodSync(privateKey, 0o600); chmodSync(hostKey, 0o600); chmodSync(authorizedKeys, 0o600);
    writeFileSync(configFile, `Port ${port}
ListenAddress 127.0.0.1
HostKey ${hostKey}
PidFile ${join(dir, 'sshd.pid')}
AuthorizedKeysFile ${authorizedKeys}
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers ${user}
UsePAM no
StrictModes no
UseDNS no
MaxSessions 10
MaxStartups 100:100:100
ForceCommand ${wrapper}
LogLevel ERROR
`);
    writeFileSync(clientConfig, `Host ${hostAlias}
  HostName 127.0.0.1
  Port ${port}
  User ${user}
  IdentityFile ${privateKey}
  IdentitiesOnly yes
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
`);
    chmodSync(configFile, 0o600); chmodSync(clientConfig, 0o600);
    execFileSync('/usr/sbin/sshd', ['-t', '-f', configFile]);
    server = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', configFile], { stdio: ['ignore', 'ignore', 'pipe'] });
    await waitForSshd(port, server);
    const brokers = Array.from({ length: 3 }, () => createGridSshBroker({
      controlDir: join(dir, 'control'), sshOptions: ['-F', clientConfig], maxSessions: 10,
      maxRetries: 0, observe: () => undefined,
    }));
    const results = await Promise.all(Array.from({ length: 60 }, (_, index) =>
      brokers[index % brokers.length]!.run(hostAlias, `sleep 0.05; printf request-${index}`, 10_000)));
    const [active, peak, launches] = readFileSync(stateFile, 'utf8').trim().split(/\s+/).map(Number);
    expect(results).toHaveLength(60);
    expect(results.every(result => result.status === 0 && result.remoteStarted === true)).toBe(true);
    expect(results.map(result => result.stdout)).toEqual(Array.from({ length: 60 }, (_, index) => 'request-' + index));
    expect(launches).toBe(60);
    expect(active).toBe(0);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(9);
    expect(brokers.flatMap(broker => broker.snapshot(hostAlias)).reduce((sum, row) => sum + row.refused, 0)).toBe(0);
  } finally {
    spawnSync('ssh', ['-F', clientConfig, '-o', 'ControlPath=' + gridSshControlPath(hostAlias, join(dir, 'control')), '-O', 'exit', hostAlias], { stdio: 'ignore' });
    server?.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('grid ssh broker retries a pre-session Session open refused response and records it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grid-ssh-broker-retry-'));
  const device = createFakeSsh({ hosts: { gcp1: { activeSessions: 0, maxStartups: 10 } } });
  const events: string[] = [];
  const delays: number[] = [];
  let calls = 0;
  try {
    const broker = createGridSshBroker({
      controlDir: dir, retryDelayMs: 5, maxRetries: 2,
      sleep: async ms => { delays.push(ms); }, observe: event => { events.push(event); },
      transport: (host, script, timeoutMs) => {
        calls += 1;
        if (calls === 1) return { status: 255, stdout: '', stderr: 'channel 3: open failed: Session open refused by peer' };
        const result = device.ssh(host, script, timeoutMs);
        return { status: result.rc, stdout: result.output, stderr: '' };
      },
    });

    const result = await broker.run('gcp1', 'true', 5_000);

    expect(result.status).toBe(0);
    expect(calls).toBe(2);
    expect(delays).toEqual([5]);
    expect(events).toEqual(['shared-queued', 'start', 'retry', 'complete']);
    expect(broker.snapshot('gcp1')[0]).toMatchObject({ completed: 2, retries: 1, refused: 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('grid ssh broker retries the ssh-fail signature and respects the retry ceiling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grid-ssh-broker-fail-'));
  try {
    const broker = createGridSshBroker({
      controlDir: dir, maxRetries: 2, retryDelayMs: 0, sleep: async () => undefined,
      observe: () => undefined,
      transport: () => ({ status: 255, stdout: '', stderr: 'ssh-fail: Session open refused' }),
    });

    const result = await broker.run('node-b', 'true');

    expect(result.status).toBe(255);
    expect(broker.snapshot('node-b')[0]).toMatchObject({ completed: 3, retries: 2, refused: 3 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('grid ssh broker does not retry remote command output that mentions connection refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grid-ssh-broker-command-error-'));
  let calls = 0;
  try {
    const broker = createGridSshBroker({
      controlDir: dir, observe: () => undefined,
      transport: () => { calls += 1; return { status: 1, stdout: '', stderr: 'application error: connection refused', remoteStarted: true }; },
    });
    const result = await broker.run('gcp1', 'do-side-effect', 5_000);
    expect(result.status).toBe(1);
    expect(calls).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('grid ssh broker contains observer failures and times out while queued', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grid-ssh-broker-timeout-'));
  let finishFirst: (() => void) | undefined;
  try {
    const broker = createGridSshBroker({
      controlDir: dir, maxSessions: 2, observe: () => { throw new Error('observer failed'); },
      transport: async () => new Promise(resolve => { finishFirst = () => resolve({ status: 0, stdout: '', stderr: '' }); }),
    });
    const first = broker.run('gcp1', 'first');
    await Promise.resolve();
    const second = await broker.run('gcp1', 'second', 10);
    expect(second).toMatchObject({ status: null, error: 'grid-ssh-queue-timeout' });
    finishFirst?.();
    expect((await first).status).toBe(0);
    expect(broker.snapshot('gcp1')).toMatchObject([{ active: 0, queued: 0 }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('grid ssh broker uses a stable ControlMaster socket per host', () => {
  const first = gridSshControlPath('gcp1', '/tmp/control');
  expect(gridSshControlPath('gcp1', '/tmp/control')).toBe(first);
  expect(gridSshControlPath('node-b', '/tmp/control')).not.toBe(first);
  expect(gridSshControlPath('gcp1', '/tmp/control', ['-F', '/tmp/ssh-a']))
    .not.toBe(gridSshControlPath('gcp1', '/tmp/control', ['-F', '/tmp/ssh-b']));
  expect(gridSshControlOptions('gcp1', '/tmp/control')).toEqual([
    '-o', 'ControlMaster=auto', '-o', 'ControlPersist=60', '-o', `ControlPath=${first}`,
  ]);
});

test('generated ControlPath cannot be bypassed by an ssh -S option', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grid-ssh-broker-option-order-'));
  const sshOptions = ['-S', join(dir, 'user-control')];
  try {
    const args = ['-G', ...gridSshControlOptions('gcp1', dir, sshOptions), ...sshOptions, '--', 'gcp1'];
    const resolved = execFileSync('/usr/bin/ssh', args, { encoding: 'utf8' });
    const controlPath = resolved.split('\n').find(line => line.startsWith('controlpath '));
    expect(controlPath).toBe('controlpath ' + join(dir, 'user-control'));
    expect(() => createGridSshBroker({ controlDir: dir, sshOptions }))
      .toThrow('grid-ssh-ssh-options-cannot-set-control-socket');
    expect(() => createGridSshBroker({ controlDir: dir, sshOptions: ['-S' + join(dir, 'user-control')] }))
      .toThrow('grid-ssh-ssh-options-cannot-set-control-socket');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ssh broker snapshots options before building its transport', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grid-ssh-broker-option-snapshot-'));
  const configFile = join(dir, 'ssh_config');
  const userControlPath = join(dir, 'user-control');
  writeFileSync(configFile, 'Host gcp1\n  HostName 127.0.0.1\n');
  const sshOptions = ['-F', configFile];
  let capturedArgs: string[] = [];
  const spawnStub = ((command: string, args: readonly string[]) => {
    capturedArgs = [...args];
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => void };
    const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr, kill: () => undefined });
    stdin.once('finish', () => setImmediate(() => { stdout.end(); stderr.end(); child.emit('close', 0); }));
    return child;
  }) as unknown as typeof spawn;
  try {
    const broker = createGridSshBroker({ controlDir: dir, sshOptions, spawn: spawnStub, maxRetries: 0 });
    sshOptions.push('-S', userControlPath);
    expect((await broker.run('gcp1', 'true')).status).toBe(0);
    const separator = capturedArgs.indexOf('--');
    const resolved = execFileSync('/usr/bin/ssh', ['-G', ...capturedArgs.slice(0, separator), '--', 'gcp1'], { encoding: 'utf8' });
    const controlPath = resolved.split('\n').find(line => line.startsWith('controlpath '));
    expect(controlPath).toBe('controlpath ' + gridSshControlPath('gcp1', dir, ['-F', configFile]));
    expect(capturedArgs).not.toContain('-S');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('host-wide tickets preserve arrival order before an instance local queue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grid-ssh-broker-fifo-'));
  const tickets: number[] = [];
  const starts: string[] = [];
  let finishFirst: (() => void) | undefined;
  const observe = (event: string, data: Record<string, unknown>) => {
    if (event === 'shared-queued' && typeof data.ticket === 'number') tickets.push(data.ticket);
  };
  try {
    const make = () => createGridSshBroker({
      controlDir: dir, maxSessions: 2, observe,
      transport: async (_host, script) => {
        starts.push(script);
        if (script === 'first') await new Promise<void>(resolve => { finishFirst = resolve; });
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const firstBroker = make(); const secondBroker = make();
    const first = firstBroker.run('gcp1', 'first');
    while (starts.length < 1) await new Promise(resolve => setTimeout(resolve, 1));
    const second = firstBroker.run('gcp1', 'second');
    while (tickets.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
    const third = secondBroker.run('gcp1', 'third');
    while (tickets.length < 3) await new Promise(resolve => setTimeout(resolve, 1));
    expect(tickets).toEqual([1, 2, 3]);
    finishFirst?.();
    await Promise.all([first, second, third]);
    expect(starts).toEqual(['first', 'second', 'third']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shared queue removes a ticket when slot-directory setup throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grid-ssh-broker-cleanup-'));
  const controlDir = join(dir, 'control');
  mkdirSync(controlDir);
  writeFileSync(join(controlDir, 'slots'), 'not-a-directory');
  const broker = createGridSshBroker({
    controlDir, observe: () => undefined,
    transport: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  try {
    await expect(broker.run('gcp1', 'first')).rejects.toThrow();
    rmSync(join(controlDir, 'slots'));
    expect((await broker.run('gcp1', 'second')).status).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('grid ssh brokers apply a new shared channel budget after the host is idle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grid-ssh-broker-mismatch-'));
  try {
    const first = createGridSshBroker({ controlDir: dir, maxSessions: 10, observe: () => undefined, transport: () => ({ status: 0, stdout: '', stderr: '' }) });
    const second = createGridSshBroker({ controlDir: dir, maxSessions: 8, observe: () => undefined, transport: () => ({ status: 0, stdout: '', stderr: '' }) });
    expect((await first.run('gcp1', 'true')).status).toBe(0);
    expect((await second.run('gcp1', 'true')).status).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('grid ssh brokers still reject a shared channel budget change while a slot is active', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grid-ssh-broker-active-mismatch-'));
  let markStarted!: () => void;
  let finish!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const inFlight = new Promise<void>(resolve => { finish = resolve; });
  try {
    const first = createGridSshBroker({ controlDir: dir, maxSessions: 10, observe: () => undefined,
      transport: async () => { markStarted(); await inFlight; return { status: 0, stdout: '', stderr: '' }; } });
    const second = createGridSshBroker({ controlDir: dir, maxSessions: 8, observe: () => undefined,
      transport: () => ({ status: 0, stdout: '', stderr: '' }) });
    const active = first.run('gcp1', 'active');
    await started;
    await expect(second.run('gcp1', 'changed-budget')).rejects.toThrow('grid-ssh-host-channel-limit-mismatch');
    finish();
    expect((await active).status).toBe(0);
  } finally { finish(); rmSync(dir, { recursive: true, force: true }); }
});

test('grid ssh broker reserves one server session and rejects invalid limits', () => {
  expect(() => createGridSshBroker({ maxSessions: 1 })).toThrow('grid-ssh-invalid-max-sessions');
  expect(() => createGridSshBroker({ maxSessions: 10, maxChannels: 10 }))
    .toThrow('grid-ssh-channel-limit-must-be-below-max-sessions');
});
