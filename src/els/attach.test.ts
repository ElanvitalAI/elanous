import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { attachEls, noteAfterFrame, RECONNECT_NOTE, type AttachFrame } from './attach-client.js';
import { requestEls } from './client.js';
import type { ElsPty } from './core.js';
import { elsSocketPath, startElsServer } from './server.js';
import { elsJournalPath } from './journal.js';
import { AUTH_PANE_TOKEN_ENV, AUTH_OWNER_TOKEN_ENV } from './server-auth.js';
import net from 'node:net';

// SOCKET_SAFE_TMP: a Unix socket path holds at most 103 bytes (macOS), a long TMPDIR falls back to /tmp.
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const cleanups: (() => Promise<void> | void)[] = [];
// The credential tests below put a pane token in this process env; every test ends on the env it began with.
const envAtStart = process.env[AUTH_PANE_TOKEN_ENV];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  if (envAtStart === undefined) delete process.env[AUTH_PANE_TOKEN_ENV]; else process.env[AUTH_PANE_TOKEN_ENV] = envAtStart;
});
const until = async (check: () => boolean, ms = 4_000): Promise<void> => {
  const stop = Date.now() + ms;
  while (!check()) { if (Date.now() > stop) throw new Error('timed out waiting'); await new Promise((resolve) => setTimeout(resolve, 10)); }
};

function setup() {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-att-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const state = { screen: 'ready\n', writes: [] as string[], sizes: [] as [number, number][], alive: true, exit: () => {} };
  const pty: ElsPty = { id: 'pty_1', isAlive: () => state.alive, write: (text) => { state.writes.push(text); }, renderScreen: async () => state.screen,
    onExit: (cb) => { state.exit = () => { state.alive = false; cb(); }; }, kill: () => {}, resize: (cols, rows) => { state.sizes.push([cols, rows]); } };
  return { root, state, pty };
}

async function boot() {
  const { root, state, pty } = setup();
  const started = await startElsServer({ stateRoot: root, spawn: () => pty });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const created = await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: '/work', command: ['sh'] });
  const pane = (JSON.parse(created.message) as { pane: string }).pane;
  return { root, state, pane };
}

function open(root: string, pane: string, size = { cols: 100, rows: 30 }) {
  const frames: AttachFrame[] = [];
  const ends: [number, string][] = [];
  const errors: string[] = [];
  const attached = attachEls(elsSocketPath(root), pane, size, { onFrame: (frame) => frames.push(frame), onEnd: (code, reason) => ends.push([code, reason]), onError: (message) => errors.push(message) });
  cleanups.push(() => attached.detach());
  return { attached, frames, ends, errors };
}

test('attach: the first frame arrives at once, a frame is sent only when the screen changed, and seq counts frames', async () => {
  const { root, state, pane } = await boot();
  const view = open(root, pane);
  await until(() => view.frames.length === 1);
  expect(view.frames[0]).toEqual({ pane, seq: 1, cols: 100, rows: 30, back: 0, screen: 'ready\n' });
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(view.frames).toHaveLength(1);
  state.screen = 'ready\n$ ls\n';
  await until(() => view.frames.length === 2);
  expect(view.frames[1]).toMatchObject({ seq: 2, screen: 'ready\n$ ls\n' });
});

test('attach: input goes to the PTY as typed, resize reaches the PTY, a bad line is refused and the attach stays open', async () => {
  const { root, state, pane } = await boot();
  const view = open(root, pane);
  await until(() => view.frames.length === 1);
  expect(state.sizes).toEqual([[100, 30]]);
  view.attached.input('echo hi\r');
  view.attached.resize(120, 40);
  await until(() => state.writes.length === 1 && state.sizes.length === 2);
  expect(state.writes).toEqual(['echo hi\r']);
  expect(state.sizes[1]).toEqual([120, 40]);
  await until(() => view.frames.length === 2);
  expect(view.frames[1]).toMatchObject({ cols: 120, rows: 40 });
  view.attached.resize(5, 5);
  await until(() => view.errors.length === 1);
  expect(view.errors[0]).toContain('cols 10-500');
  view.attached.input('still works');
  await until(() => state.writes.length === 2);
  expect(view.ends).toEqual([]);
});

test('attach: an unknown pane is refused with an end line; a pane that exits ends the stream with its last screen', async () => {
  const { root, state, pane } = await boot();
  const bad = open(root, 'pdeadbeef');
  await until(() => bad.ends.length === 1);
  expect(bad.ends[0]![0]).toBe(1);
  expect(bad.ends[0]![1]).toContain('unknown pane');
  const view = open(root, pane);
  await until(() => view.frames.length === 1);
  state.screen = 'bye\n';
  state.exit();
  await until(() => view.ends.length === 1);
  expect(view.ends[0]).toEqual([0, 'pane exited']);
  expect(view.frames.at(-1)!.screen).toContain('bye');
});

test('attach: detaching (closing the connection) leaves the pane running; a second client can attach and type', async () => {
  const { root, state, pane } = await boot();
  const first = open(root, pane);
  await until(() => first.frames.length === 1);
  first.attached.detach();
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(state.alive).toBe(true);
  const listed = JSON.parse((await requestEls(elsSocketPath(root), { op: 'ls' })).message) as { panes: { state: string; ptyId: string }[] };
  expect([listed.panes[0]!.state === 'exited', listed.panes[0]!.ptyId]).toEqual([false, 'pty_1']);
  const second = open(root, pane);
  await until(() => second.frames.length === 1);
  second.attached.input('x');
  await until(() => state.writes.length === 1);
});

test('attach: no server → the end line says how to start one, nothing is started', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-att-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const view = open(root, 'p1');
  await until(() => view.ends.length === 1);
  expect(view.ends[0]![1]).toContain('no els server is running');
});

test('attach: lines that arrive in the same chunk as the attach line (input, resize) are kept and applied in order, none dropped', async () => {
  const { root, state, pane } = await boot();
  const { createConnection } = await import('node:net');
  const socket = createConnection(elsSocketPath(root));
  cleanups.push(() => { socket.destroy(); });
  let received = '';
  socket.on('data', (chunk) => { received += chunk.toString(); });
  // One write: auth (JUD #39096 ⓒ — typing is owner-token-only, so the raw chunk presents it like attachEls does) +
  // attach + two input lines + a resize, as a fast client sends them before the owner is «ready».
  await new Promise<void>((resolve) => socket.on('connect', () => {
    socket.write([JSON.stringify({ op: 'auth', token: process.env[AUTH_OWNER_TOKEN_ENV], pid: process.pid }), { op: 'attach', pane }, { op: 'input', bytes: 'one' }, { op: 'resize', cols: 111, rows: 33 }, { op: 'input', bytes: 'two' }].map((line) => `${typeof line === 'string' ? line : JSON.stringify(line)}\n`).join(''));
    resolve();
  }));
  await until(() => state.writes.length === 2 && state.sizes.some(([cols, rows]) => cols === 111 && rows === 33));
  expect(state.writes).toEqual(['one', 'two']);
  await until(() => received.includes('"cols":111'));
});

test('attach: a client that connects and goes away before the owner answers leaves no timer behind and the pane alone', async () => {
  const { root, state, pane } = await boot();
  const { createConnection } = await import('node:net');
  for (let index = 0; index < 5; index++) {
    const socket = createConnection(elsSocketPath(root));
    await new Promise<void>((resolve) => socket.on('connect', () => { socket.write(`${JSON.stringify({ op: 'attach', pane })}\n`); socket.destroy(); resolve(); }));
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(state.alive).toBe(true);
  const view = open(root, pane);
  await until(() => view.frames.length === 1);
});

test('non-object JSON (null, a number, a string, an array) is refused on that connection only — as the first request and inside an attach — and the owner keeps serving', async () => {
  const { root, state, pane } = await boot();
  const { createConnection } = await import('node:net');
  const talk = (lines: string[]) => new Promise<string>((resolve) => {
    const socket = createConnection(elsSocketPath(root));
    let received = '';
    socket.on('connect', () => socket.write(lines.map((line) => `${line}\n`).join('')));
    socket.on('data', (chunk) => { received += chunk.toString(); });
    socket.on('close', () => resolve(received));
    setTimeout(() => { socket.destroy(); }, 600);
  });
  for (const body of ['null', '7', '"text"', '[]', '[null]', 'true']) {
    const answer = JSON.parse((await talk([body])).trim().split('\n')[0]!) as { exitCode: number; message: string };
    expect([answer.exitCode, answer.message]).toEqual([2, 'els: malformed request']);
  }
  // Inside an attach, the same garbage refuses but the pane keeps taking authenticated input (JUD #39096 ⓒ:
  // the auth line goes first — typing is owner-token-only now, like every real attach client).
  const inside = await talk([JSON.stringify({ op: 'auth', token: process.env[AUTH_OWNER_TOKEN_ENV], pid: process.pid }), JSON.stringify({ op: 'attach', pane }), 'null', '7', '[1]', JSON.stringify({ op: 'input', bytes: 'after' })]);
  expect(inside.split('\n').filter((line) => line.includes('malformed line'))).toHaveLength(3);
  await until(() => state.writes.includes('after'));
  expect((await requestEls(elsSocketPath(root), { op: 'ping' })).exitCode).toBe(0);
});

test('attach client: input and resize called before the connection is up follow the attach line in order — none overtakes it, none is lost', async () => {
  const { root, state, pane } = await boot();
  const view = open(root, pane);
  // No wait at all: the socket is still connecting.
  view.attached.input('fast');
  view.attached.resize(101, 31);
  view.attached.input('typing');
  await until(() => state.writes.length === 2 && state.sizes.some(([cols, rows]) => cols === 101 && rows === 31));
  expect(state.writes).toEqual(['fast', 'typing']);
  expect(view.errors).toEqual([]);
  await until(() => view.frames.length >= 1);
});


// JUD #39096 ⓒ (OP #106366·#106663): attach 는 이제 문 판정을 통과한다 — 리터럴: ① 손 토큰으로 다른 좌석
// 워크스페이스의 pane attach 는 거부(pane PTY 미도달) ② attach 뒤의 input 줄은 같은 판정(허용 행 제거 시 거부).
test('JUD #39096 ⓒ — cross-seat attach 거부(문) · attach 뒤 input 줄 같은 판정', async () => {
  const { root, state, pty } = setup();
  const captured: Record<string, string>[] = [];
  const started = await startElsServer({ stateRoot: root, spawn: (command: readonly string[], cwd: string, title: string, env: Readonly<Record<string, string>>) => {
    captured.push({ ...(env as Record<string, string>) });
    return pty;
  } });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const handPane = (JSON.parse((await requestEls(elsSocketPath(root), { op: 'new', ws: 'HAND-ELN', cwd: '/work', command: ['sh'] })).message) as { pane: string }).pane;
  const opPane = (JSON.parse((await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: '/work', command: ['sh'] })).message) as { pane: string }).pane;
  const handToken = captured.at(-2)?.[AUTH_PANE_TOKEN_ENV];
  expect(typeof handToken).toBe('string');
  const openRaw = async (attachPane: string) => {
    const socket = net.createConnection(elsSocketPath(root));
    const lines: string[] = [];
    socket.on('data', (c: Buffer) => { for (const l of c.toString('utf8').split('\n')) if (l) lines.push(l); });
    const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
    socket.write(`${JSON.stringify({ op: 'auth', token: handToken, pid: process.pid })}\n`);
    socket.write(`${JSON.stringify({ op: 'attach', pane: attachPane, cols: 40, rows: 10 })}\n`);
    return { socket, lines, closed };
  };
  const cross = await openRaw(opPane);
  await cross.closed;
  const denial = cross.lines.map((l) => JSON.parse(l)).find((v) => v && v.exitCode === 1);
  expect(denial?.exitCode).toBe(1);
  expect(denial?.message).toMatch(/own workspaces|denied/);
  expect(state.writes.some((w) => w.includes('door-cross'))).toBe(false);
  const allowFile = join(dirname(elsJournalPath(root)), 'control-allow.json');
  mkdirSync(dirname(allowFile), { recursive: true });
  writeFileSync(allowFile, JSON.stringify({ rules: [{ principal: `els-pane:${handPane}`, workspace: 'HAND-ELN', pane: '*', actions: ['input'], effect: 'allow' }] }));
  const own = await openRaw(handPane);
  await until(() => own.lines.length > 0);
  own.socket.write(`${JSON.stringify({ op: 'input', bytes: 'door-ok\n' })}\n`);
  await until(() => state.writes.some((w) => w.includes('door-ok')));
  rmSync(allowFile);
  own.socket.write(`${JSON.stringify({ op: 'input', bytes: 'door-DENY\n' })}\n`);
  await until(() => own.lines.some((l) => { try { return JSON.parse(l).type === 'error'; } catch { return false; } }));
  expect(state.writes.some((w) => w.includes('door-DENY'))).toBe(false);
  own.socket.end();
});
test('attach client: an overlong socket path is refused with an end line — no socket is touched, nothing crashes', async () => {
  const ends: [number, string][] = [];
  const frames: AttachFrame[] = [];
  // 출처: 유닉스 도메인 소켓 경로 상한(sun_path)은 104바이트(종결 NUL 포함) — JUD-B #107737 재현과 같은 104자 경로.
  const attached = attachEls('x'.repeat(104), 'lit-pane', { cols: 20, rows: 5 }, { onFrame: (frame) => frames.push(frame), onEnd: (code, reason) => ends.push([code, reason]) });
  cleanups.push(() => attached.detach());
  // 출처: 거부는 queueMicrotask 로 온다 — until 헬퍼로 마이크로태스크 한 틱을 기다린다.
  await until(() => ends.length === 1);
  expect(ends.length).toBe(1);
  expect(ends[0]![0]).toBe(1);
  expect(ends[0]![1]).toContain('the state dir is too deep for a Unix socket');
  expect(ends[0]![1]).toContain('is 104 bytes; at most 103');
  expect(frames).toEqual([]);
});

// D1a r2 (remote review must «attach retry range»): a door-denied attach answers with a plain result line, then closes. The
// client must end with THAT message — the generic «connection closed» wording is the server-away signal a view retries on.
test('attach client: a door-denied attach ends with the denial message, never as a lost server (so no view retries it)', async () => {
  const { root, pty } = setup();
  const captured: Record<string, string>[] = [];
  const started = await startElsServer({ stateRoot: root, spawn: (_command: readonly string[], _cwd: string, _title: string, env: Readonly<Record<string, string>>) => { captured.push({ ...(env as Record<string, string>) }); return pty; } });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const handPane = (JSON.parse((await requestEls(elsSocketPath(root), { op: 'new', ws: 'HAND-ELN', cwd: '/work', command: ['sh'] })).message) as { pane: string }).pane;
  const opPane = (JSON.parse((await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: '/work', command: ['sh'] })).message) as { pane: string }).pane;
  const handToken = captured.at(-2)?.[AUTH_PANE_TOKEN_ENV];
  expect(typeof handToken).toBe('string');
  expect(handPane).not.toBe(opPane);
  process.env[AUTH_PANE_TOKEN_ENV] = handToken;                     // the client presents the hand pane's credential, as a pane process does
  const view = open(root, opPane);                                  // a hand attaching to the OP workspace's pane: refused at the door
  await until(() => view.ends.length === 1);
  expect(view.ends[0]![0]).toBe(1);
  expect(view.ends[0]![1]).toMatch(/own workspaces|denied/);
  expect(view.ends[0]![1]).not.toContain('closed the connection');
  expect(view.frames).toEqual([]);
});

// D1a r2 (remote review must «shutdown delay»): a graceful close ends every attach and must not wait on a peer that neither
// reads nor closes — the half-open raw client below holds its end open for the whole test.
test('server close: an attach peer that never reads nor closes its end cannot hold the shutdown (bounded, the pane is left alone)', async () => {
  const { root, pty } = setup();
  const started = await startElsServer({ stateRoot: root, spawn: () => pty });
  if ('exitCode' in started) throw new Error(started.message);
  const created = await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: '/work', command: ['sh'] });
  const pane = (JSON.parse(created.message) as { pane: string }).pane;
  const stuck = net.createConnection({ path: elsSocketPath(root), allowHalfOpen: true });
  cleanups.push(() => { stuck.destroy(); });
  stuck.pause();                                                      // never reads
  stuck.on('error', () => {});
  let received = '';
  stuck.on('data', (chunk: Buffer) => { received += chunk.toString('utf8'); });
  stuck.write(`${JSON.stringify({ op: 'attach', pane, cols: 40, rows: 10 })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 200));          // the attach is registered on the server
  const outcome = await Promise.race([started.close().then(() => 'closed'), new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 8_000))]);
  expect(outcome).toBe('closed');
  stuck.resume();                                                     // now it reads: the end line was queued for it (it was an attached peer)
  await until(() => received.includes('the server is stopping'));
});

// D1a r2 (remote review must «recovery display»): `els attach` (the single-pane view in cli/els-cli.ts) clears its note through
// this function on the first recovered frame; the view itself needs a TTY, so the rule is pinned here.
test('noteAfterFrame: the reconnect note goes with the first recovered frame, any other note stays', () => {
  expect(noteAfterFrame(RECONNECT_NOTE)).toBe('');
  expect(noteAfterFrame('ctrl+b x 는 아직 없음')).toBe('ctrl+b x 는 아직 없음');
  expect(noteAfterFrame('')).toBe('');
});
