// els end to end: `side serve` is the one owner process; `side ls/new/read/send` are separate client processes.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestEls } from '../els/client.js';
import { simCli } from '../ux-sim/in-process-cli.js';

// 출처: a fresh `elanous` process boots, loads the journal and binds the socket in a few seconds on the gate hosts.
const SERVE_READY_MS = 20_000;
// 출처: the whole one-owner scenario (three serves, a dozen client calls) finishes well inside this on the gate hosts.
const SERVE_LIFETIME_MS = 120_000;

const dirs: string[] = [];
const stops: AbortController[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop.abort();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };

/** Start `side serve` for `state` (through simCli) and wait until it listens or exits with its refusal.
 *  `kill()` SIGKILLs its process group: the server dies without removing its socket. */
async function serve(state: string, extra: string[] = [], env: Record<string, string> = {}): Promise<{ kill: () => void; exited: Promise<number>; output: () => string }> {
  const stop = new AbortController();
  stops.push(stop);
  let text = '';
  const run = simCli(['side', 'serve', ...extra], {
    mode: 'spawn', allowPaths: [['side']], stateRoot: state, cwd: state, env: { NODE_ENV: 'development', HERDR_ENV: '', ...env },
    signal: stop.signal, killSignal: 'SIGKILL', timeoutMs: SERVE_LIFETIME_MS, onStdout: (chunk) => { text += chunk; },
  });
  let exitCode: number | undefined;
  const exited = run.then((result) => { text += result.stderr; exitCode = result.exitCode; return result.exitCode; });
  const deadline = Date.now() + SERVE_READY_MS;
  while (Date.now() < deadline && !text.includes('listening on') && exitCode === undefined) await Bun.sleep(50);
  return { kill: () => stop.abort(), exited, output: () => text };
}

const side = (state: string, cwd: string, args: string[], env: Record<string, string> = {}) => simCli(['side', ...args], {
  mode: 'spawn', allowPaths: [['side']], stateRoot: state, cwd, env: { NODE_ENV: 'development', HERDR_ENV: '', ...env },
});

test('no server: the CLI says so and writes nothing', async () => {
  const state = tempDir('els-none-');
  const listed = await side(state, state, ['ls']);
  expect(listed.exitCode).toBe(1);
  expect(listed.stderr).toContain('els serve');
  expect(existsSync(join(state, 'els', 'journal.json'))).toBe(false);
});

test('one owner: new/send/read go through the server, a second serve is refused, a dead server is replaced and the pane keeps its cwd', async () => {
  const state = tempDir('els-owner-');
  const cwd = tempDir('els-cwd-');
  const first = await serve(state);
  expect(first.output()).toContain('listening on');

  // Concurrent serve while one answers: refused, the first keeps serving.
  const second = await serve(state);
  expect(await second.exited).toBe(1);
  expect(second.output()).toContain('already answers');

  const created = await side(state, cwd, ['new', '--ws', 'HQ', '--cwd', cwd, '--', 'sh']);
  expect(created.exitCode, created.stderr).toBe(0);
  const pane = (JSON.parse(created.stdout) as { pane: string }).pane;
  expect((await side(state, cwd, ['send', pane, 'echo els-hi\n'])).exitCode).toBe(0);
  let screen = '';
  for (let attempt = 0; attempt < 40 && !screen.includes('els-hi'); attempt += 1) {
    screen = (await side(state, cwd, ['read', pane])).stdout;
    if (!screen.includes('els-hi')) await Bun.sleep(100);
  }
  expect(screen).toContain('els-hi');

  // The owner dies without cleaning up: its socket file stays; nobody answers on it.
  first.kill();
  await first.exited;
  expect(existsSync(join(state, 'els', 'els.sock'))).toBe(true);
  expect((await side(state, cwd, ['ls'])).stderr).toContain('els serve');

  // Restart: a new serve clears the dead socket; the pane is back with its cwd and last screen, without a pty.
  const third = await serve(state);
  expect(third.output()).toContain('listening on');
  const listed = JSON.parse((await side(state, cwd, ['ls'])).stdout) as { panes: { pane: string; cwd: string; ptyId: string; state: string }[] };
  expect(listed.panes.map((row) => [row.pane, row.cwd, row.ptyId, row.state])).toEqual([[pane, cwd, '', 'idle']]);
  expect((await side(state, cwd, ['read', pane])).stdout).toContain('els-hi');
  const refused = await side(state, cwd, ['send', pane, 'x']);
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr).toContain('no live pty');
}, 120_000);

test('a state dir too deep for a Unix socket is reported by serve and by the CLI', async () => {
  const state = join(tempDir('els-deep-'), 'd'.repeat(120));
  mkdirSync(state, { recursive: true });
  const listed = await side(state, state, ['ls']);
  expect(listed.exitCode).toBe(1);
  expect(listed.stderr).toContain('too deep for a Unix socket');
  const server = await serve(state);
  expect(await server.exited).toBe(1);
  expect(server.output()).toContain('too deep for a Unix socket');
});

/** A free loopback port (bound and released; the serve under test binds it right after). */
const freePort = () => new Promise<number>((resolve) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
});

test('stage 2: ls and read reach a registered host through its read window; a host that stops answering stays listed as down', async () => {
  const hostA = tempDir('els-a-');
  const hostB = tempDir('els-b-');
  const port = await freePort();
  const b = await serve(hostB, ['--http', `127.0.0.1:${port}`], { ELANOUS_ELS_HOST: 'hostb' });
  expect(b.output()).toContain('listening on');
  const a = await serve(hostA, [], { ELANOUS_ELS_HOST: 'hosta' });
  expect(a.output()).toContain('listening on');
  const sideAt = (state: string, args: string[], host: string) => simCli(['side', ...args], {
    mode: 'spawn', allowPaths: [['side']], stateRoot: state, cwd: state, env: { NODE_ENV: 'development', HERDR_ENV: '', ELANOUS_ELS_HOST: host },
  });
  // A pane on host B, with something on its screen.
  const created = await sideAt(hostB, ['new', '--ws', 'GATE', '--cwd', hostB, '--', 'sh'], 'hostb');
  expect(created.exitCode, created.stderr).toBe(0);
  const bPane = JSON.parse(created.stdout) as { address: string; pane: string };
  await sideAt(hostB, ['send', bPane.pane, 'echo from-host-b\n'], 'hostb');
  // Host A registers B (and a public URL, which is rejected).
  mkdirSync(join(hostA, 'els'), { recursive: true });
  writeFileSync(join(hostA, 'els', 'hosts.json'), JSON.stringify({ hosts: [
    { name: 'hostb', baseUrl: `http://127.0.0.1:${port}` }, { name: 'pub', baseUrl: 'https://example.com' }] }));
  const listed = JSON.parse((await sideAt(hostA, ['ls'], 'hosta')).stdout) as {
    hosts: { name: string; reach: string }[]; rejectedHosts: string[]; panes: { address: string; reach: string }[] };
  expect(listed.hosts.map((host) => [host.name, host.reach])).toEqual([['hosta', 'local'], ['hostb', 'up']]);
  expect(listed.rejectedHosts).toEqual(['pub: baseUrl is not a tailnet or loopback http(s) URL']);
  expect(listed.panes.map((pane) => [pane.address, pane.reach])).toEqual([[`hostb:${bPane.address}`, 'up']]);
  let screen = '';
  for (let attempt = 0; attempt < 40 && !screen.includes('from-host-b'); attempt += 1) {
    screen = (await sideAt(hostA, ['read', `hostb:${bPane.address}`], 'hosta')).stdout;
    if (!screen.includes('from-host-b')) await Bun.sleep(100);
  }
  expect(screen).toContain('from-host-b');
  // Host B dies: A still lists it, as down; reading it says ? with the reason.
  b.kill();
  await b.exited;
  const after = JSON.parse((await sideAt(hostA, ['ls'], 'hosta')).stdout) as { hosts: { name: string; reach: string }[]; panes: unknown[] };
  expect(after.hosts.map((host) => [host.name, host.reach])).toEqual([['hosta', 'local'], ['hostb', 'down']]);
  expect(after.panes).toEqual([]);
  const failed = await sideAt(hostA, ['read', `hostb:${bPane.address}`], 'hosta');
  expect(failed.exitCode).toBe(1);
  expect(failed.stderr).toContain('hostb ?');
  // Host B restarts on the same window: A sees it up again, with B's pane (its pty gone after the restart).
  const bAgain = await serve(hostB, ['--http', `127.0.0.1:${port}`], { ELANOUS_ELS_HOST: 'hostb' });
  expect(bAgain.output()).toContain('listening on');
  const back = JSON.parse((await sideAt(hostA, ['ls'], 'hosta')).stdout) as { hosts: { name: string; reach: string }[]; panes: { address: string; state: string }[] };
  expect(back.hosts.map((host) => [host.name, host.reach])).toEqual([['hosta', 'local'], ['hostb', 'up']]);
  expect(back.panes.map((pane) => [pane.address, pane.state])).toEqual([[`hostb:${bPane.address}`, 'idle']]);
  expect((await sideAt(hostA, ['read', `hostb:${bPane.address}`], 'hosta')).stdout).toContain('from-host-b');
}, 120_000);

test('serve --http refuses a public bind address', async () => {
  const state = tempDir('els-pub-');
  const refused = await serve(state, ['--http', '0.0.0.0:8790']);
  expect(await refused.exited).toBe(2);
  expect(refused.output()).toContain('not a loopback or tailnet');
});

test('herdr words and defaults: workspace create with no options, pane run/send-keys/list/close, send presses Enter, options after -- are explained', async () => {
  const state = tempDir('els-parity-');
  const folder = join(realpathSync(tempDir('els-proj-')), 'myproj');   // the process cwd is the real path (/private/var on macOS)
  mkdirSync(folder);
  const server = await serve(state);
  expect(server.output()).toContain('listening on');
  const shell = { SHELL: '/bin/sh' };

  const created = await side(state, folder, ['workspace', 'create'], shell);
  expect(created.exitCode, created.stderr).toBe(0);
  const pane = (JSON.parse(created.stdout) as { result: { pane: { pane_id: string }; root_pane: { cwd: string } } }).result;
  expect(pane.root_pane.cwd).toBe(folder);
  const paneId = pane.pane.pane_id;
  const workspaces = JSON.parse((await side(state, folder, ['workspace', 'list'])).stdout) as { result: { workspaces: { name: string }[] } };
  expect(workspaces.result.workspaces.map((row) => row.name)).toEqual(['myproj']);

  const readUntil = async (needle: RegExp): Promise<string> => {
    let screen = '';
    for (let attempt = 0; attempt < 50 && !needle.test(screen); attempt += 1) {
      screen = (await side(state, folder, ['pane', 'read', paneId])).stdout;
      if (!needle.test(screen)) await Bun.sleep(100);
    }
    return screen;
  };
  expect((await side(state, folder, ['pane', 'run', paneId, 'echo run-ok'])).exitCode).toBe(0);
  expect(await readUntil(/^run-ok$/m)).toMatch(/^run-ok$/m);
  expect((await side(state, folder, ['send', paneId, 'echo enter-ok'])).exitCode).toBe(0);   // Enter by default
  expect(await readUntil(/^enter-ok$/m)).toMatch(/^enter-ok$/m);
  expect((await side(state, folder, ['pane', 'send-text', paneId, 'echo held'])).exitCode).toBe(0);   // no Enter
  await Bun.sleep(300);
  expect((await side(state, folder, ['pane', 'read', paneId])).stdout).not.toMatch(/^held$/m);
  expect((await side(state, folder, ['pane', 'send-keys', paneId, 'enter'])).exitCode).toBe(0);
  expect(await readUntil(/^held$/m)).toMatch(/^held$/m);
  const badKey = await side(state, folder, ['pane', 'send-keys', paneId, 'ctrl+c', 'bogus']);
  expect(badKey.exitCode).toBe(2);
  expect(badKey.stderr).toContain('nothing was sent');

  const misplaced = await side(state, folder, ['new', '--', 'sh', '--cwd', folder]);
  expect(misplaced.exitCode).toBe(2);
  expect(misplaced.stderr).toContain('must come before --');
  const raw = await side(state, folder, ['new', '--ws', 'R', '--cwd', folder, '--raw', '--', 'sh', '--cwd', folder]);   // a command that really takes --cwd runs
  expect(raw.exitCode, raw.stderr).toBe(0);
  expect((await side(state, folder, ['pane', 'close', (JSON.parse(raw.stdout) as { pane: string }).pane])).exitCode).toBe(0);

  const listed = JSON.parse((await side(state, folder, ['pane', 'list'])).stdout) as { result: { panes: { pane_id: string; cwd: string }[] } };
  expect(listed.result.panes.map((row) => [row.pane_id, row.cwd])).toEqual([[paneId, folder]]);
  expect((await side(state, folder, ['pane', 'close', paneId])).exitCode).toBe(0);
  expect((JSON.parse((await side(state, folder, ['pane', 'list'])).stdout) as { result: { panes: unknown[] } }).result.panes).toEqual([]);
}, 120_000);

test('bare `els` on an empty isolated state dir starts the server by itself (no launchd), shows the spaces, and a second run reuses it', async () => {
  const state = tempDir('els-bare-');
  const folder = tempDir('els-bare-cwd-');
  let pid = 0;
  try {
    const first = await side(state, folder, [], { SHELL: '/bin/sh' });
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.stdout).toContain('no panes yet');
    expect(existsSync(join(state, 'els', 'els.sock'))).toBe(true);
    expect(existsSync(join(state, 'els', 'events.jsonl'))).toBe(true);             // «serve-direct» recorded
    const ping = await requestEls(join(state, 'els', 'els.sock'), { op: 'ping' });
    pid = Number(/pid (\d+)/.exec(ping.message)?.[1]);
    expect(Number.isNaN(pid)).toBe(false);   // the ping answered with a pid
    expect(pid).not.toBe(0);
    expect((await side(state, folder, ['new', '--ws', 'W', '--cwd', folder, '--', 'sh'])).exitCode).toBe(0);
    const second = await side(state, folder, []);
    expect(second.exitCode, second.stderr).toBe(0);
    expect(second.stdout).toMatch(/working|idle/);
    expect(second.stderr).not.toContain('감독자');
    const status = await side(state, folder, ['supervisor', 'status']);
    expect(status.stdout).toContain('isolated state (never uses launchd)');
    expect(status.stdout).toContain('server answering');
  } finally {
    if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  }
}, 120_000);
