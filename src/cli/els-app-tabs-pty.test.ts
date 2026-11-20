import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Terminal } from '@xterm/headless';
import { requestEls } from '../els/client.js';
import { LEAVE_VIEW, SIDEBAR_COLS } from '../els/attach-view.js';
import { elsSocketPath } from '../els/server.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

// ELS-TAB-STYLE-HERDR: the tab row as a person's terminal draws it — read from the cell attributes of a headless xterm.
// SOCKET_SAFE_TMP: a Unix socket path holds at most 103 bytes (macOS), a long TMPDIR falls back to /tmp.
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const COLS = 100;
const ROWS = 30;
const BLUE = 4;   // SGR 44
const GRAY = 8;   // SGR 100

const LOOKED = { label: 'looked', text: '', until: 'new · menu', timeoutMs: 15_000 }; // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

interface Tab { readonly from: number; readonly to: number; readonly bg: number; readonly text: string }

/** Replays the bytes the app view wrote into a headless terminal of the same size. */
function replayer(): { feed: (chunk: string) => void; settle: () => Promise<void>; terminal: Terminal } {
  const terminal = new Terminal({ rows: ROWS, cols: COLS, scrollback: 0, allowProposedApi: true });
  let pending = Promise.resolve();
  return { terminal, feed: (chunk) => { pending = pending.then(() => new Promise<void>((resolve) => terminal.write(chunk, resolve))); }, settle: () => pending };
}

/** The coloured blocks of the tab row (row 0, right of the side list): runs of cells with the same palette background. */
function tabsOf(terminal: Terminal): Tab[] {
  const line = terminal.buffer.active.getLine(0)!;
  expect(line.isWrapped).toBe(false);
  const tabs: Tab[] = [];
  let open: { from: number; bg: number; text: string } | undefined;
  for (let x = SIDEBAR_COLS + 1; x <= COLS; x++) {
    const cell = x < COLS ? line.getCell(x) : undefined;
    const bg = cell && cell.isBgPalette() ? cell.getBgColor() : -1;
    if (open && bg !== open.bg) { tabs.push({ ...open, to: x }); open = undefined; }
    if (!open && bg !== -1 && cell) open = { from: x, bg, text: '' };
    if (open && cell) open.text += cell.getChars() || ' ';
  }
  return tabs;
}

test('real terminal: bare els with two tabs — names UPPERCASE, the selected tab on a blue background, the other gray, no wrapped row; clicking the gray tab moves the blue', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-tabs-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const env = { SHELL: '/bin/sh', NODE_ENV: 'development' };
  const view = { executable: process.execPath, args: [BIN, '--test-state-dir', '{root}', 'side'], root, rows: ROWS, cols: COLS, env };
  const shellShown = (screen: string): boolean => screen.split('\n').some((line) => line.includes('│') && line.includes('$'));
  const first = await mockSeatPtySequence({ ...view, ready: { label: 'first-screen', timeoutMs: 30_000, until: shellShown }, steps: [LOOKED], quitKeys: '\u0002q' }); // 출처: #37153 live PTY readiness bound
  expect(first.exitCode).toBe(0);
  const socket = elsSocketPath(root);
  const pid = Number((await requestEls(socket, { op: 'ping' })).message.match(/pid (\d+)/)?.[1]);
  cleanups.push(() => { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } });
  const before = process.env.ELANOUS_ELS_OWNER_TOKEN;
  process.env.ELANOUS_ELS_OWNER_TOKEN = readFileSync(join(root, 'els', 'owner-token'), 'utf8').trim();
  try {
    expect((await requestEls(socket, { op: 'seat-set', seat: 'OP' })).exitCode).toBe(0);
    const ws = (JSON.parse((await requestEls(socket, { op: 'ls' })).message) as { panes: { workspace: string }[] }).panes[0]!.workspace;
    expect((await requestEls(socket, { op: 'new', ws, cwd: root, command: ['/bin/sh'], title: 'beta' })).exitCode).toBe(0);
  } finally { if (before === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = before; }

  const twoTabs = (screen: string): boolean => /BETA/.test(screen.split('\n')[0] ?? '');
  const look = async (steps: (replay: Terminal) => Parameters<typeof mockSeatPtySequence>[0]['steps']): Promise<Terminal> => {
    const replay = replayer();
    const run = await mockSeatPtySequence({ ...view, onOutput: (chunk) => replay.feed(chunk.split(LEAVE_VIEW).join('')), ready: { label: 'tabs-shown', timeoutMs: 30_000, until: twoTabs }, steps: steps(replay.terminal), quitKeys: '\u0002q' }); // 출처: #37153 live PTY readiness bound
    expect(run.exitCode).toBe(0);
    await replay.settle();
    return replay.terminal;
  };

  const shown = tabsOf(await look(() => [LOOKED]));
  expect(shown.map((tab) => tab.bg).sort()).toEqual([GRAY, BLUE].sort());   // one blue (selected), one gray
  expect(shown.map((tab) => tab.text.trim()).join(' ')).toMatch(/SH.*BETA|BETA.*SH/);
  for (const tab of shown) expect(tab.text).toBe(tab.text.toUpperCase());
  expect(shown.every((tab) => tab.text.startsWith(' ') && tab.text.endsWith(' '))).toBe(true);

  // click inside the gray tab (SGR press+release, 1-based): the blue moves to it and the other turns gray.
  const gray = shown.find((tab) => tab.bg === GRAY)!;
  expect(gray.text).toContain('BETA');   // the first pane is the selected one
  const x = gray.from + Math.floor((gray.to - gray.from) / 2) + 1;
  const clicked = tabsOf(await look((terminal) => [{ label: 'click-gray-tab', keys: `\u001b[<0;${x};1M\u001b[<0;${x};1m`, until: () => terminal.buffer.active.getLine(0)!.getCell(gray.from)!.getBgColor() === BLUE, timeoutMs: 15_000 }])); // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls
  const blueNow = clicked.find((tab) => tab.bg === BLUE)!;
  expect(blueNow.text).toBe(gray.text);
  expect(clicked.filter((tab) => tab.bg === GRAY).length).toBe(1);
}, 180_000);
