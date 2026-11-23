// 출처: TC #100374 — `els snapshot`/`els record` (classic PTY capture ported to the thin els connection).
// A literal test of the real socket door: an isolated universe (own state root), one fake pane PTY whose output a
// test fires, and the recording store reset per test. Artifacts land under <stateRoot>/artifacts (owner-only).
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetRecordingStoreForTest, getRecordingStore } from '../capture/recording-store.js';
import type { ElsPty } from './core.js';
import { elsSocketPath, startElsServer } from './server.js';
import { AUTH_OWNER_TOKEN_ENV, AUTH_PANE_TOKEN_ENV } from './server-auth.js';

// A Unix socket path holds at most 103 bytes (macOS): under a long TMPDIR the state dir falls back to /tmp (each test removes its own dir).
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const cleanups: (() => Promise<void> | void)[] = [];
const OWNER_TOKEN_BEFORE = process.env[AUTH_OWNER_TOKEN_ENV]; // startElsServer publishes the owner token into this process's env
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { if (OWNER_TOKEN_BEFORE === undefined) delete process.env[AUTH_OWNER_TOKEN_ENV]; else process.env[AUTH_OWNER_TOKEN_ENV] = OWNER_TOKEN_BEFORE; }
});

const state = (): string => {
  const dir = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-record-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// A fake pane PTY whose output stream a test can fire on demand (`emit`): the same door registryPty wires in prod.
const fakePty = (screen: string, withTap = true): { pty: ElsPty; emit: (data: string) => void } => {
  let out: ((data: string) => void) | undefined;
  const pty: ElsPty = {
    id: `pty_${Math.random().toString(16).slice(2)}`,
    isAlive: () => true,
    write: () => {},
    renderScreen: async () => screen,
    onExit: () => {},
    kill: () => {},
    ...(withTap ? { onOutput: (cb: (data: string) => void) => { out = cb; return { dispose: () => { out = undefined; } }; } } : {}),
  };
  return { pty, emit: (data) => out?.(data) };
};

// One request over the real socket; with `token` the caller first presents that pane credential (the door's `auth` line).
const ask = (root: string, request: object, token?: string): Promise<{ exitCode: number; message: string }> => new Promise((resolve, reject) => {
  const socket = createConnection(elsSocketPath(root));
  const lines: string[] = [];
  let data = '';
  const want = token ? 2 : 1;
  socket.on('connect', () => socket.write(`${token ? `${JSON.stringify({ op: 'auth', token, pid: process.pid })}\n` : ''}${JSON.stringify(request)}\n`));
  socket.on('data', (chunk: Buffer) => {
    data += chunk.toString();
    for (let at = data.indexOf('\n'); at >= 0; at = data.indexOf('\n')) { lines.push(data.slice(0, at)); data = data.slice(at + 1); }
    if (lines.length >= want) { socket.destroy(); resolve(JSON.parse(lines[want - 1] as string) as { exitCode: number; message: string }); }
  });
  // A door that refuses the credential answers once and closes: that answer comes back instead of a hang.
  socket.on('close', () => {
    if (lines.length === 0) reject(new Error('els door closed without an answer'));
    else resolve(JSON.parse(lines[lines.length - 1] as string) as { exitCode: number; message: string });
  });
  socket.on('error', reject);
});

/**
 * A server with one pane whose PTY shows `screen`; the pane id, the caller credential and the PTY's output trigger come back.
 * The caller is the server owner: these tests judge what record/snapshot do to the pane's bytes, artifacts and the
 * recording store. A pane credential is only honoured from that pane's own process tree, which a fake PTY in a TTY-less
 * test process cannot be (peer-seat processIdentity needs a controlling terminal), so the owner speaks instead.
 * The pane-credential door itself is judged by the «without a pane credential» tests below.
 */
const serverWithPane = async (screen: string, withTap = true): Promise<{ root: string; pane: string; token: string; emit: (data: string) => void; close: () => Promise<void> }> => {
  const root = state();
  const { pty, emit } = fakePty(screen, withTap);
  const started = await startElsServer({ stateRoot: root, spawn: () => pty });
  if ('exitCode' in started) throw new Error(`startElsServer: ${started.message}`);
  let closed = false;
  const close = async (): Promise<void> => { if (!closed) { closed = true; await started.close(); } };
  cleanups.push(close);
  // The owner registers the OP seat, then spawns the pane and keeps speaking as the server owner.
  const owner = process.env[AUTH_OWNER_TOKEN_ENV] as string;
  expect((await ask(root, { op: 'seat-set', seat: 'OP' }, owner)).exitCode).toBe(0);
  const made = JSON.parse((await ask(root, { op: 'new', ws: 'REC', cwd: '/tmp', command: ['sh'] }, owner)).message) as { pane: string };
  return { root, pane: made.pane, token: owner, emit, close };
};

test('closed recording is stoppable by the same seat but not another seat', async () => {
  __resetRecordingStoreForTest();
  const root = state();
  const tokens: string[] = [];
  const started = await startElsServer({ stateRoot: root, stall: false, spawn: (_c, _d, _t, env) => {
    tokens.push(env[AUTH_PANE_TOKEN_ENV]!);
    return fakePty('record').pty;
  } });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const make = (ws: string, seat: string) => JSON.parse(started.core.newPane({ ws, cwd: '/tmp', command: ['sh'], ownerSeat: seat, parent: { kind: 'hand', seat, workspaces: [ws] } }).message).pane as string;
  const caller = make('A', 'HAND-A');
  const target = make('A', 'HAND-A');
  make('B', 'HAND-B');
  expect((await ask(root, { op: 'record', pane: target }, tokens[0])).exitCode).toBe(0);
  expect(started.core.close(target).exitCode).toBe(0);
  expect((await ask(root, { op: 'record', pane: target }, tokens[2])).exitCode).toBe(1);
  expect(getRecordingStore().size()).toBe(1);
  const stop = await ask(root, { op: 'record', pane: target }, tokens[0]);
  expect(stop.exitCode).toBe(0);
  expect(existsSync(castPath(stop))).toBe(true);
  expect(getRecordingStore().size()).toBe(0);
  expect(caller).not.toBe(target);
});

test('child lifecycle stays within the caller owned workspace', async () => {
  const root = state();
  const tokens: string[] = [];
  const started = await startElsServer({ stateRoot: root, stall: false, spawn: (_c, _d, _t, env) => {
    tokens.push(env[AUTH_PANE_TOKEN_ENV]!);
    return fakePty('child').pty;
  } });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const make = (ws: string, seat: string) => started.core.newPane({ ws, cwd: '/tmp', command: ['sh'], ownerSeat: seat, parent: { kind: 'hand', seat, workspaces: [ws] } });
  expect(make('A', 'HAND-A').exitCode).toBe(0);
  expect(make('B', 'HAND-B').exitCode).toBe(0);
  const child = (action: string, extra: object = {}) => ({ op: 'child', action, ...extra });
  expect((await ask(root, child('start', { id: 'c', ws: 'A', label: 'own' }), tokens[0])).exitCode).toBe(0);
  expect((await ask(root, child('progress', { id: 'c', line: 'bad' }), tokens[1])).exitCode).toBe(1);
  expect((await ask(root, child('status', { id: 'c', state: 'blocked' }), tokens[1])).exitCode).toBe(1);
  expect((await ask(root, child('status', { id: 'c', state: 'blocked' }))).exitCode).toBe(1);
  expect((await ask(root, child('tree', { ws: 'A' }), tokens[1])).exitCode).toBe(1);
  expect((await ask(root, child('start', { id: 'bad', ws: 'B', parent: 'c', label: 'bad' }), tokens[1])).exitCode).toBe(1);
  expect((await ask(root, child('progress', { id: 'c', line: 'good' }), tokens[0])).exitCode).toBe(0);
  expect((await ask(root, child('status', { id: 'c', state: 'blocked' }), tokens[0])).exitCode).toBe(0);
  const tree = await ask(root, child('tree', { ws: 'A' }), tokens[0]);
  expect(tree.exitCode).toBe(0);
  expect(tree.message).toContain('blocked');
  expect((await ask(root, child('end', { id: 'c', ok: true, summary: 'done' }), tokens[0])).exitCode).toBe(0);
});

// ── snapshot ─────────────────────────────────────────────────────
test('snapshot saves an svg artifact holding the pane screen, owner-only, under the state root', async () => {
  __resetRecordingStoreForTest();
  const { root, pane, token } = await serverWithPane('hello-side-screen');
  const answer = await ask(root, { op: 'snapshot', pane }, token);
  expect(answer.exitCode).toBe(0);
  const { path } = JSON.parse(answer.message) as { path: string };
  expect(path.startsWith(join(root, 'artifacts'))).toBe(true);
  expect(path.endsWith('.svg')).toBe(true);
  expect(readFileSync(path, 'utf8')).toContain('hello-side-screen');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const again = JSON.parse((await ask(root, { op: 'snapshot', pane }, token)).message) as { path: string };
  expect(again.path).toBe(path); // one file per pane: repeated calls overwrite, the directory cannot grow
});

test('snapshot without a pane credential is refused by the door and writes no file', async () => {
  __resetRecordingStoreForTest();
  const { root, pane } = await serverWithPane('hello-side-screen');
  const answer = await ask(root, { op: 'snapshot', pane });
  expect(answer.exitCode).toBe(1);
  expect(answer.message).toContain('snapshot denied');
  expect(existsSync(join(root, 'artifacts'))).toBe(false);
});

test('snapshot of an unknown pane: exitCode 1, the pane is named, no artifact', async () => {
  __resetRecordingStoreForTest();
  const root = state();
  const started = await startElsServer({ stateRoot: root, spawn: (): ElsPty => { throw new Error('no PTY'); } });
  if ('exitCode' in started) throw new Error(`startElsServer: ${started.message}`);
  cleanups.push(() => started.close());
  const answer = await ask(root, { op: 'snapshot', pane: '../../etc/passwd' }, process.env[AUTH_OWNER_TOKEN_ENV]);
  expect(answer.exitCode).toBe(1);
  expect(answer.message).toContain('unknown pane');
  expect(answer.message).toContain('../../etc/passwd');
});

// ── record: first call starts, second call stops and saves ───────
test('record starts, PTY bytes land in the .cast the second call saves', async () => {
  __resetRecordingStoreForTest();
  const { root, pane, token, emit } = await serverWithPane('rec-screen');
  const start = await ask(root, { op: 'record', pane }, token);
  expect(start.exitCode).toBe(0);
  expect(typeof (JSON.parse(start.message) as { recordingId: string }).recordingId).toBe('string');
  emit('hello-recorded-frame\r');
  const stop = await ask(root, { op: 'record', pane }, token);
  expect(stop.exitCode).toBe(0);
  const { path } = JSON.parse(stop.message) as { path: string };
  expect(path.startsWith(join(root, 'artifacts'))).toBe(true);
  expect(path.endsWith('.cast')).toBe(true);
  expect(readFileSync(path, 'utf8')).toContain('hello-recorded-frame');
});

test('record of an unknown pane: exitCode 1 and the pane is named', async () => {
  __resetRecordingStoreForTest();
  const { root, token } = await serverWithPane('rec-screen');
  const answer = await ask(root, { op: 'record', pane: 'p-nope' }, token);
  expect(answer.exitCode).toBe(1);
  expect(answer.message).toContain('p-nope');
});

test('record without a pane credential is refused by the door and starts nothing', async () => {
  __resetRecordingStoreForTest();
  const { root, pane } = await serverWithPane('rec-screen');
  const answer = await ask(root, { op: 'record', pane });
  expect(answer.exitCode).toBe(1);
  expect(answer.message).toContain('record denied');
});

// ── JUD must 4 (c): the recording store never grows and a closing server stops what still runs ──
test('record on a pane with no PTY stream, repeated: every call fails and the recording store stays empty', async () => {
  __resetRecordingStoreForTest();
  const { root, pane, token } = await serverWithPane('rec-screen', false);
  for (let call = 0; call < 3; call += 1) {
    const answer = await ask(root, { op: 'record', pane }, token);
    expect(answer.exitCode).toBe(1);
    expect(answer.message).toContain('no live PTY stream');
    expect(getRecordingStore().size()).toBe(0);
  }
});

test('a finished record start/stop leaves no entry in the recording store', async () => {
  __resetRecordingStoreForTest();
  const { root, pane, token, emit } = await serverWithPane('rec-screen');
  expect((await ask(root, { op: 'record', pane }, token)).exitCode).toBe(0);
  expect(getRecordingStore().size()).toBe(1);
  emit('x\r');
  expect((await ask(root, { op: 'record', pane }, token)).exitCode).toBe(0);
  expect(getRecordingStore().size()).toBe(0);
});

test('closing the server stops every recording still running and removes it from the store', async () => {
  __resetRecordingStoreForTest();
  const { root, pane, token, close } = await serverWithPane('rec-screen');
  const { recordingId } = JSON.parse((await ask(root, { op: 'record', pane }, token)).message) as { recordingId: string };
  const entry = getRecordingStore().get(recordingId);
  expect(entry?.handle.status).not.toBe('stopped');
  await close();
  expect(entry?.handle.status).toBe('stopped');
  expect(getRecordingStore().size()).toBe(0);
});

// ── JUD must 4 (d): `mode` does not change an existing file/dir, so the write tightens them ──
test('snapshot over an existing 0644 file in a 0755 artifacts dir leaves 0600 file and 0700 dir', async () => {
  __resetRecordingStoreForTest();
  const { root, pane, token } = await serverWithPane('hello-side-screen');
  const dir = join(root, 'artifacts');
  const old = join(dir, `snapshot-${pane.replace(/[^A-Za-z0-9_-]/g, '_')}.svg`);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  writeFileSync(old, 'stale', { mode: 0o644 });
  chmodSync(old, 0o644);
  const answer = await ask(root, { op: 'snapshot', pane }, token);
  expect(answer.exitCode).toBe(0);
  expect((JSON.parse(answer.message) as { path: string }).path).toBe(old); // the same pre-existing file was overwritten
  expect(readFileSync(old, 'utf8')).toContain('hello-side-screen');
  expect(statSync(old).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});

// ── JUD-B #114149 / JUD #114181 must ⓑ: a closed pane must not strand its recording ──
const castPath = (answer: { message: string }): string => (JSON.parse(answer.message) as { path: string }).path;

test('record → close pane → record returns the saved .cast path (0600) and leaves the store empty', async () => {
  __resetRecordingStoreForTest();
  const { root, pane, token, emit } = await serverWithPane('rec-screen');
  expect((await ask(root, { op: 'record', pane }, token)).exitCode).toBe(0);
  emit('before-close-frame\r');
  expect((await ask(root, { op: 'close', pane, confirmed: true }, token)).exitCode).toBe(0);
  expect(getRecordingStore().size()).toBe(1); // the close itself does not drop it: it waits for the stop
  const stop = await ask(root, { op: 'record', pane }, token);
  expect(stop.exitCode).toBe(0);
  const path = castPath(stop);
  expect(path.startsWith(join(root, 'artifacts'))).toBe(true);
  expect(readFileSync(path, 'utf8')).toContain('before-close-frame');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(getRecordingStore().size()).toBe(0);
});

test('record → close → record → record: the second stop after the save is a clean «unknown pane», no crash, store stays empty', async () => {
  __resetRecordingStoreForTest();
  const { root, pane, token } = await serverWithPane('rec-screen');
  expect((await ask(root, { op: 'record', pane }, token)).exitCode).toBe(0);
  expect((await ask(root, { op: 'close', pane, confirmed: true }, token)).exitCode).toBe(0);
  expect((await ask(root, { op: 'record', pane }, token)).exitCode).toBe(0);
  for (let call = 0; call < 2; call += 1) {
    const again = await ask(root, { op: 'record', pane }, token);
    expect(again.exitCode).toBe(1);
    expect(again.message).toContain('unknown pane');
    expect(getRecordingStore().size()).toBe(0);
  }
});

test('control: a pane that is kept still stops and saves exactly as before', async () => {
  __resetRecordingStoreForTest();
  const { root, pane, token, emit } = await serverWithPane('rec-screen');
  expect((await ask(root, { op: 'record', pane }, token)).exitCode).toBe(0);
  emit('kept-frame\r');
  const stop = await ask(root, { op: 'record', pane }, token);
  expect(stop.exitCode).toBe(0);
  expect(readFileSync(castPath(stop), 'utf8')).toContain('kept-frame');
  expect(getRecordingStore().size()).toBe(0);
});

test('after a close an unrelated ref still names nothing, and the recording survives until its own pane id stops it', async () => {
  __resetRecordingStoreForTest();
  const { root, pane, token } = await serverWithPane('rec-screen');
  expect((await ask(root, { op: 'record', pane }, token)).exitCode).toBe(0);
  expect((await ask(root, { op: 'close', pane, confirmed: true }, token)).exitCode).toBe(0);
  expect((await ask(root, { op: 'record', pane: 'p-never-existed' }, token)).exitCode).toBe(1); // an unrelated ref still names nothing
  expect(getRecordingStore().size()).toBe(1);
  expect((await ask(root, { op: 'record', pane }, token)).exitCode).toBe(0);
  expect(getRecordingStore().size()).toBe(0);
});
