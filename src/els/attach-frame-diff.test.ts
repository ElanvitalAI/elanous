// ELS-ATTACH-FRAME-DIFF (OP #127484 ③ — «결함 0순위»): the attach wire sends only the rows that changed since the
// previous frame (herdr protocol/render_ansi.rs pattern), and the client assembles them back into the full screen
// the AttachHandlers contract has always promised. A client that does not opt in keeps the old full frames only.
import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { changedRowsPaint } from './attach-view.js';
import { attachEls, type AttachFrame } from './attach-client.js';
import { requestEls } from './client.js';
import type { ElsPty } from './core.js';
import { elsSocketPath, startElsServer } from './server.js';

// This test boots its own throwaway els server, so the credential this process inherited from whatever els pane is
// running it (ELANOUS_ELS_PANE_TOKEN etc.) is a foreign token to that server — the auth line it makes `requestEls`
// send would be refused and the answer misread (the ssh-bridge tests' pattern of scrubbing ELANOUS_ELS_*).
// The scrub is a process.env write, so it carries its restore pair (test-interference: env-without-restore) —
// the inherited values come back after this file's tests and the next test file runs on the env it started with.
const scrubbedElsEnv: Array<[string, string]> = [];
for (const name of Object.keys(process.env)) {
  if (!name.startsWith('ELANOUS_ELS_')) continue;
  const value = process.env[name];
  if (value !== undefined) scrubbedElsEnv.push([name, value]);
  delete process.env[name];
}
afterAll(() => { for (const [name, value] of scrubbedElsEnv) process.env[name] = value; });

const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const until = async (check: () => boolean, ms = 4_000): Promise<void> => {
  const stop = Date.now() + ms;
  while (!check()) { if (Date.now() > stop) throw new Error('timed out waiting'); await new Promise((resolve) => setTimeout(resolve, 10)); }
};

function boot() {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-att-diff-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const state = { screen: 'ready\n', alive: true };
  // onExit registers only — firing it here would kill the pane before `new` even answers (the ssh-bridge tests' pattern).
  const pty: ElsPty = { id: 'pty_1', isAlive: () => state.alive, write: () => {}, renderScreen: async () => state.screen,
    onExit: () => {}, kill: () => { state.alive = false; }, resize: () => {} };
  return { root, state, pty };
}

async function bootServer() {
  const { root, state, pty } = boot();
  const started = await startElsServer({ stateRoot: root, spawn: () => pty });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const created = await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: '/work', command: ['sh'] });
  const pane = (JSON.parse(created.message) as { pane: string }).pane;
  return { root, state, pane };
}

/** A raw attach socket: every line the server writes, as parsed objects — the wire as it really is. */
function rawAttach(root: string, pane: string, diff: boolean): { lines: Record<string, unknown>[]; done: () => void } {
  const lines: Record<string, unknown>[] = [];
  // The same credential `attachEls` picks up: the server-minted owner token under the state root.
  const token = readFileSync(join(root, 'els', 'owner-token'), 'utf8').trim();
  const socket = net.createConnection(elsSocketPath(root), () => {
    socket.write(`${JSON.stringify({ op: 'auth', token, pid: process.pid })}\n`);
    socket.write(`${JSON.stringify({ op: 'attach', pane, cols: 100, rows: 30, ...(diff ? { diff: true } : {}) })}\n`);
  });
  let buffer = '';
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) { lines.push(JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>); buffer = buffer.slice(nl + 1); }
  });
  cleanups.push(() => { socket.destroy(); });
  return { lines, done: () => socket.destroy() };
}

test('frame-diff wire: the first frame is full, one changed row arrives as a diff of exactly that row, and a client that did not opt in keeps full frames', async () => {
  const { root, state, pane } = await bootServer();
  const wire = rawAttach(root, pane, true);
  await until(() => wire.lines.some((line) => line.type === 'frame'));
  expect(wire.lines.find((line) => line.type === 'frame')).toMatchObject({ screen: 'ready\n' });

  // Same row count ('ready\n'.split('\n') = ['ready', '']): exactly one row changed — this is the diff path.
  state.screen = 'ready — one keystroke echoed\n';
  await until(() => wire.lines.some((line) => line.type === 'frame-diff'));
  const diff = wire.lines.find((line) => line.type === 'frame-diff') as { count: number; lines: { i: number; t: string }[] };
  expect(diff.count).toBe(2);
  expect(diff.lines).toEqual([{ i: 1, t: 'ready — one keystroke echoed' }]);

  // An opted-out client on the same pane still sees only full frames, never a diff.
  const plain = rawAttach(root, pane, false);
  await until(() => plain.lines.some((line) => line.type === 'frame'));
  state.screen = 'ready — second change\n';
  await until(() => plain.lines.filter((line) => line.type === 'frame').length === 2);
  expect(plain.lines.some((line) => line.type === 'frame-diff')).toBe(false);
  wire.done(); plain.done();
});

test('frame-diff wire: a change that rewrites most of the screen sends one full frame instead of a diff', async () => {
  const { root, state, pane } = await bootServer();
  // A fixed-height body (10 text rows + the trailing empty row) so a full rewrite exceeds the 60% diff budget.
  state.screen = `${Array.from({ length: 10 }, (_, i) => `row ${i}\n`).join('')}`;
  const wire = rawAttach(root, pane, true);
  await until(() => wire.lines.some((line) => line.type === 'frame'));
  state.screen = `${Array.from({ length: 10 }, (_, i) => `row ${i} rewritten entirely\n`).join('')}`;
  await until(() => wire.lines.filter((line) => line.type === 'frame').length === 2);
  expect(wire.lines.some((line) => line.type === 'frame-diff')).toBe(false);
  wire.done();
});

test('frame-diff client: attachEls with {diff:true} assembles the diff and still hands its handlers the full screen', async () => {
  const { root, state, pane } = await bootServer();
  const frames: AttachFrame[] = [];
  const attached = attachEls(elsSocketPath(root), pane, { cols: 100, rows: 30 }, { onFrame: (frame) => frames.push(frame), onEnd: () => {} }, { diff: true });
  cleanups.push(() => attached.detach());
  await until(() => frames.length === 1);
  expect(frames[0]).toMatchObject({ screen: 'ready\n' });
  state.screen = 'ready — assembled\n';   // same row count: arrives as a diff, leaves the handler with the full screen
  await until(() => frames.length === 2);
  expect(frames[1]).toMatchObject({ seq: 2, screen: 'ready — assembled\n' });
});

test('frame-diff after a scrolled full frame: scroll → live return hands the handler the correct live screen (JUD #127758)', async () => {
  const { root, state, pane } = await bootServer();
  const frames: AttachFrame[] = [];
  const attached = attachEls(elsSocketPath(root), pane, { cols: 100, rows: 30 }, { onFrame: (frame) => frames.push(frame), onEnd: () => {} }, { diff: true });
  cleanups.push(() => attached.detach());
  await until(() => frames.length === 1);
  expect(frames[0]).toMatchObject({ screen: 'ready\n' });
  // The pane scrolls back: the next full frame carries renderScreen's scrolled shape — a scroll header line first.
  state.screen = '[screen 100x30 scrolled-back=3]\nready\n';
  await until(() => frames.length === 2);
  expect(frames[1]).toMatchObject({ screen: '[screen 100x30 scrolled-back=3]\nready\n' });
  // Back to live: the server diffs against its header-stripped baseline — the client assembler must key the same body,
  // or every diff row lands one line off (the stale scrolled row stays on screen).
  state.screen = 'ready — live again\n';
  await until(() => frames.length === 3);
  expect(frames[2]).toMatchObject({ seq: 3, screen: 'ready — live again\n' });
});

test('frame-diff scrollback → live with repeated rows, differing trimmed counts and a live cursor header: the reconstructed frame is exactly the live frame (JUD-C #127882)', async () => {
  const { root, state, pane } = await bootServer();
  // The registry PTY trims trailing empty rows (src/pty-shell/registry.ts), so a scrolled-back body keeps more
  // rows than the live one — the concrete path of the prior HOLD: three repeated `x` rows scrolled, a cursor
  // header over two of them live. The raw wire and the attachEls contract watch the same pane at once.
  state.screen = '[screen 80x24 scrolled-back=1]\nx\nx\nx';
  const wire = rawAttach(root, pane, true);
  const frames: AttachFrame[] = [];
  const attached = attachEls(elsSocketPath(root), pane, { cols: 80, rows: 24 }, { onFrame: (frame) => frames.push(frame), onEnd: () => {} }, { diff: true });
  cleanups.push(() => attached.detach());
  await until(() => frames.length === 1 && wire.lines.some((line) => line.type === 'frame'));
  expect(frames[0]).toMatchObject({ seq: 1, back: 1, screen: '[screen 80x24 scrolled-back=1]\nx\nx\nx' });
  // Back to live at the same body length: one diff row swaps the scrolled header for the live cursor header;
  // the repeated `x` rows ride along untouched and the assembled frame is the live frame itself, row for row.
  state.screen = '[screen 80x24 cursor=(row 0, col 0, visible true)]\nx\nx';
  await until(() => frames.length === 2 && wire.lines.some((line) => line.type === 'frame-diff'));
  const diff = wire.lines.find((line) => line.type === 'frame-diff') as { count: number; lines: { i: number; t: string }[] };
  expect(diff.count).toBe(3);
  expect(diff.lines).toEqual([{ i: 1, t: '[screen 80x24 cursor=(row 0, col 0, visible true)]' }]);
  expect(frames[1]).toMatchObject({ seq: 2, back: 0, screen: '[screen 80x24 cursor=(row 0, col 0, visible true)]\nx\nx' });
  // Live trims one trailing row more, so the bodies are not comparable: one full frame, baseline reset.
  state.screen = '[screen 80x24 cursor=(row 0, col 0, visible true)]\nx';
  await until(() => frames.length === 3 && wire.lines.filter((line) => line.type === 'frame').length === 2);
  expect(frames[2]).toMatchObject({ seq: 3, back: 0, screen: '[screen 80x24 cursor=(row 0, col 0, visible true)]\nx' });
  wire.done();
});

test('frame-diff wire: a row-count change (a size switch) resets the baseline and sends one full frame', async () => {
  const { root, state, pane } = await bootServer();
  state.screen = `${Array.from({ length: 6 }, (_, i) => `row ${i}\n`).join('')}`;
  const wire = rawAttach(root, pane, true);
  await until(() => wire.lines.some((line) => line.type === 'frame'));
  state.screen = `${Array.from({ length: 4 }, (_, i) => `row ${i}\n`).join('')}`;   // fewer rows: bodies are not comparable
  await until(() => wire.lines.filter((line) => line.type === 'frame').length === 2);
  expect(wire.lines.some((line) => line.type === 'frame-diff')).toBe(false);
  wire.done();
});

test('changedRowsPaint: no previous paint changes every row; an unchanged body paints nothing; a single row is written cursor-addressed at that row', () => {
  const all = changedRowsPaint(undefined, ['a', 'b'], 10);
  expect(all.changed).toEqual([0, 1]);
  expect(all.paint).toBe('');
  const same = changedRowsPaint(['a', 'b'], ['a', 'b'], 10);
  expect(same.changed).toEqual([]);
  expect(same.paint).toBe('');
  const one = changedRowsPaint(['a', 'b'], ['a', 'c'], 10);
  expect(one.changed).toEqual([1]);
  expect(one.paint).toBe('\u001b[2;1Hc         ');
  const resized = changedRowsPaint(['a', 'b'], ['a'], 10);
  expect(resized.changed).toEqual([0]);
  expect(resized.paint).toBe('');
});
