// ELS-FIRST-RUN-FU3 (OP #101546 · follow-up of #38964): ① the attach status line is cut to the width, ② a subscribed attach
// never polls or re-sends the screen (only output pushes a frame; the list poll does not repaint), ③ herdr's spaces are one
// folded bundle under a «herdr» head, below this host's own spaces. Expectations are literals (OP rule 11).
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachEls, type AttachFrame } from './attach-client.js';
import { composeView, parsePaneRows, parseRemoteRows } from './attach-view.js';
import { requestEls } from './client.js';
import type { ElsPty } from './core.js';
import { elsSocketPath, startElsServer } from './server.js';
import { buildSpaceList, buildTabRow, withCommands } from './space-tabs-view.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const until = async (check: () => boolean, ms = 4_000): Promise<void> => {
  const stop = Date.now() + ms;
  while (!check()) { if (Date.now() > stop) throw new Error('timed out waiting'); await new Promise((resolve) => setTimeout(resolve, 10)); }
};

test('① the status line is cut to the terminal width, never wrapped', () => {
  const paint = composeView({ cols: 20, rows: 3, sidebar: null, frame: 'a\nb\n', status: 'ctrl+b c new shell · a chat · s list' });
  expect(paint.split('\r\n').at(-1)).toBe('\u001b[7mctrl+b c new shell ·\u001b[0m\u001b[?25l');
});

test('② a subscribed attach is not polled: no output → no render and no frame; output → one frame; a silent exit still ends', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-fu3-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const state = { screen: 'ready\n', renders: 0, alive: true, out: (_data: string) => {} };
  const pty: ElsPty = {
    id: 'pty_1', isAlive: () => state.alive, write: () => {}, kill: () => {}, onExit: () => {},
    renderScreen: async () => { state.renders++; return state.screen; },
    onOutput: (cb) => { state.out = cb; return { dispose: () => { state.out = () => {}; } }; },
  };
  const started = await startElsServer({ stateRoot: root, spawn: () => pty });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const created = await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: '/work', command: ['sh'] });
  const pane = (JSON.parse(created.message) as { pane: string }).pane;
  const frames: AttachFrame[] = [];
  const ends: [number, string][] = [];
  const attached = attachEls(elsSocketPath(root), pane, { cols: 100, rows: 30 }, { onFrame: (frame) => frames.push(frame), onEnd: (code, reason) => ends.push([code, reason]), onError: () => {} });
  cleanups.push(() => attached.detach());
  await until(() => frames.length === 1);
  const rendersAfterFirst = state.renders;
  await new Promise((resolve) => setTimeout(resolve, 450)); // 출처: #38964 old poll was 100 ms — 4 polls would have rendered
  expect([frames.length, state.renders]).toEqual([1, rendersAfterFirst]);
  state.screen = 'ready\n$ ls\n';
  state.out('$ ls\n');
  await until(() => frames.length === 2);
  expect(frames[1]).toMatchObject({ seq: 2, screen: 'ready\n$ ls\n' });
  state.alive = false; // the pane ends without printing anything
  await until(() => ends.length === 1, 3_000); // 출처: #38964 ATTACH_LIVENESS_MS 1 s liveness check
  expect(ends[0]).toEqual([0, 'pane exited']);
});

test('③ herdr spaces fold into one «herdr» bundle below my spaces; it opens only while one of its spaces is selected', () => {
  const local = parsePaneRows(JSON.stringify({ panes: [{ address: 'ux/t1/p1', workspace: 'ux', pane: 'p1', title: 'eln', state: 'idle' }] }));
  const herdr = parseRemoteRows(JSON.stringify({ panes: [
    { reach: 'up', host: 'herdr', ws: 'w1', address: 'herdr:w1/t0/p0', title: 'OP · claude', state: 'working' },
    { reach: 'up', host: 'herdr', ws: 'w2', address: 'herdr:w2/t0/p0', title: 'TC · codex', state: 'idle' },
  ] }));
  const rows = [...herdr, ...local];
  const trim = (lines: readonly string[]) => lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trimEnd());
  expect(trim(buildSpaceList(rows, 'p1', 30, 4))).toEqual([' spaces', ' ○ UX', ' ⊞ HERDR · 2', ' new · menu']);
  expect(trim(buildSpaceList(rows, 'herdr:w2/t0/p0', 30, 6))).toEqual([' spaces', ' ○ UX', ' ⊟ HERDR · 2', '   ● ⇄HERDR OP', '   ○ ⇄HERDR TC', ' new · menu']);
});

test('④ (OP #101592 · #101606) focus marker: the tab row is padded UPPERCASE «emoji NAME» like herdr (focused blue, others gray, ELS-TAB-STYLE-HERDR), the selected space is reverse video, and the block moves with the focus', () => {
  const LS = JSON.stringify({ panes: [
    { address: 'op/t1/p1', workspace: 'op', pane: 'p1', title: 'OP', state: 'working', command: ['/usr/local/bin/eln'], build: { sha: 'c8db6fc953e4', age: 'current' } },
    { address: 'op/t1/p2', workspace: 'op', pane: 'p2', title: '/bin/zsh', state: 'idle', command: ['/bin/zsh'] },
  ] });
  const rows = withCommands(parsePaneRows(LS), LS);
  expect(buildTabRow(rows, 'p1', 20).line).toBe('\u001b[44;37m 💬 OP \u001b[49;39m \u001b[100;37m ⌨︎  ZSH \u001b[49;39m +  ');
  expect(buildTabRow(rows, 'p2', 20).line).toBe('\u001b[100;37m 💬 OP \u001b[49;39m \u001b[44;37m ⌨︎  ZSH \u001b[49;39m +  ');
  expect(buildSpaceList(rows, 'p2', 12, 3)[1]).toBe('\u001b[7m ● OP       \u001b[27m');
});
