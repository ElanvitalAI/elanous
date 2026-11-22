// ELS-SSH-ATTACH-ANYWHERE: the remote half, `els side attach-stdio`, run for real as a child process on a pipe (what a plain
// `ssh host elanous side attach-stdio …` is). It carries frames out; and it is VIEW-ONLY: a pipe is not the person's terminal,
// so the human-terminal gate gives it no owner token, and an owner token placed on the wire (even the real one) is never honored.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { spawnElanous } from '../instance/spawn-elanous.js';
import { requestEls } from './client.js';
import type { ElsPty } from './core.js';
import { elsSocketPath, startElsServer } from './server.js';

// SOCKET_SAFE_TMP: a Unix socket path holds at most 103 bytes (macOS), a long TMPDIR falls back to /tmp.
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test('attach-stdio on a pipe: even an inherited real owner credential cannot authorize typing', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-sb-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const writes: string[] = [];
  const pty: ElsPty = { id: 'pty_1', isAlive: () => true, write: (text) => { writes.push(text); }, renderScreen: async () => 'bridge-ready\n', onExit: () => {}, kill: () => {}, resize: () => {} };
  const started = await startElsServer({ stateRoot: root, spawn: () => pty });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const created = await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: '/work', command: ['sh'] });
  const pane = (JSON.parse(created.message) as { pane: string }).pane;
  const ownerToken = readFileSync(join(root, 'els', 'owner-token'), 'utf8').trim();

  const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'development' };
  for (const name of Object.keys(env)) if (name.startsWith('ELANOUS_ELS_')) delete env[name];
  env.ELANOUS_ELS_OWNER_TOKEN = ownerToken;
  const child = spawnElanous(['--test-state-dir', root, 'side', 'attach-stdio', pane, '100', '30'], { stateDir: root, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  cleanups.push(() => { child.kill('SIGTERM'); });
  let out = '';
  child.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
  const until = async (check: () => boolean, ms: number): Promise<void> => {
    const stop = Date.now() + ms;
    while (!check()) { if (Date.now() > stop) throw new Error(`timed out waiting; got: ${out}`); await new Promise((resolve) => setTimeout(resolve, 25)); }
  };
  // The real owner token on the wire is ignored by the bridge.
  child.stdin!.write(`${JSON.stringify({ op: 'auth', token: ownerToken })}\n${JSON.stringify({ op: 'attach', cols: 100, rows: 30 })}\n`);
  await until(() => out.includes('"op":"frame"') || out.includes('"op":"end"'), 30_000); // one bridge response
  expect(out).not.toContain('"op":"frame"');
  expect(out).toContain('"op":"end"');
  await new Promise((resolve) => setTimeout(resolve, 300)); // 출처: negative check — a refused write must stay absent for several pty-write turns
  expect(writes).toEqual([]);
  expect(out).not.toContain(ownerToken);
}, 60_000); // 출처: cold child start + the negative wait above, under the rail's 60 s live-process bound

test('SSH pipe bridge reads the registered HTTP window as frames and refuses input with inherited owner credential', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-sb-http-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const writes: string[] = [];
  const pty: ElsPty = { id: 'pty_1', isAlive: () => true, write: text => { writes.push(text); },
    renderScreen: async () => 'remote-read-frame\n', onExit: () => {}, kill: () => {}, resize: () => {} };
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const selected = address && typeof address === 'object' ? address.port : 0;
      probe.close(() => resolve(selected));
    });
  });
  const started = await startElsServer({ stateRoot: root, http: { host: '127.0.0.1', port }, spawn: () => pty });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const created = await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: '/work', command: ['sh'] });
  const pane = (JSON.parse(created.message) as { pane: string }).pane;
  const listed = JSON.parse((await requestEls(elsSocketPath(root), { op: 'ls' })).message) as { panes: { pane: string; address: string; tab: string }[] };
  const row = listed.panes.find(entry => entry.pane === pane)!;
  const ws = row.address.split('/')[0]!;
  const ownerToken = readFileSync(join(root, 'els', 'owner-token'), 'utf8').trim();
  const env: NodeJS.ProcessEnv = { ...process.env, ELANOUS_ELS_OWNER_TOKEN: ownerToken,
    ELANOUS_ELS_PANE_TOKEN: 'inherited-pane-token', NODE_ENV: 'development' };
  const child = spawnElanous(['--test-state-dir', root, 'side', 'attach-stdio', pane, '80', '24',
    `http://127.0.0.1:${port}`, ws, row.tab], { stateDir: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  cleanups.push(() => { child.kill('SIGTERM'); });
  let out = '';
  child.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
  child.stdin!.write(`${JSON.stringify({ op: 'attach', cols: 80, rows: 24 })}\n`);
  const until = async (text: string) => {
    const stop = Date.now() + 15_000;
    while (!out.includes(text)) { if (Date.now() > stop) throw new Error(`timed out waiting for ${text}: ${out}`); await Bun.sleep(25); }
  };
  await until('remote-read-frame');
  expect(out).toContain('"op":"frame"');
  child.stdin!.write(`${JSON.stringify({ op: 'input', bytes: 'echo forbidden\r' })}\n`);
  await until('view-only');
  expect(writes).toEqual([]);
  child.stdin!.end(`${JSON.stringify({ op: 'end' })}\n`);
}, 40_000);
