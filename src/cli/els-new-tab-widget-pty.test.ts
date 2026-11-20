import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { requestEls } from '../els/client.js';
import { elsSocketPath } from '../els/server.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

// ELS-NEW-TAB-NAME-WIDGET: the bare els app view in an outer PTY (headless xterm reads the screen): clicking «+» opens the
// «new tab [name] ↵ save ^c clear esc cancel» row; typed text edits the row and never reaches the pane; Ctrl+C clears, Esc cancels,
// Enter creates a tab titled with the typed name (read back from the server, not only from the screen).
// SOCKET_SAFE_TMP: a Unix socket path holds at most 103 bytes (macOS), a long TMPDIR falls back to /tmp.
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function registerOpSeat(root: string): Promise<void> {
  const before = process.env.ELANOUS_ELS_OWNER_TOKEN;
  process.env.ELANOUS_ELS_OWNER_TOKEN = readFileSync(join(root, 'els', 'owner-token'), 'utf8').trim();
  try { expect((await requestEls(elsSocketPath(root), { op: 'seat-set', seat: 'OP' })).exitCode).toBe(0); }
  finally { if (before === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = before; }
}

test('real terminal: «+» opens the new-tab name row; typing never reaches the pane; Ctrl+C clears, Esc cancels (tab count unchanged), Enter makes a tab with that title', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-newtab-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const socket = elsSocketPath(root);
  const view = { executable: process.execPath, args: [BIN, '--test-state-dir', '{root}', 'side'], root, rows: 30, cols: 100, env: { SHELL: '/bin/sh', NODE_ENV: 'development' } };
  const shellShown = (screen: string): boolean => screen.split('\n').some((line) => line.includes('│') && line.includes('$'));
  const tabRow = (screen: string): string => screen.split('\n')[0] ?? '';
  const promptRow = (screen: string): string => screen.split('\n')[1] ?? '';
  const titles = async (): Promise<string[]> => (JSON.parse((await requestEls(socket, { op: 'ls' })).message) as { panes: { title: string }[] }).panes.map((pane) => pane.title);
  // The first view starts the server and shows where the «+» is (1-based cell column: wide glyphs count two).
  const first = await mockSeatPtySequence({ ...view, ready: { label: 'first-screen', timeoutMs: 30_000, until: shellShown }, steps: [{ label: 'looked', text: '', until: 'new · menu', timeoutMs: 15_000 }], quitKeys: '\u0002q' }); // 출처: #37153 live PTY readiness bound; 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls
  expect(first.exitCode).toBe(0);
  const pid = Number((await requestEls(socket, { op: 'ping' })).message.match(/pid (\d+)/)?.[1]);
  cleanups.push(() => { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } });
  await registerOpSeat(root);
  const top = tabRow(first.frames.at(-1)!.screen);
  const x = Bun.stringWidth(top.slice(0, top.lastIndexOf('+'))) + 1;
  const click = `\u001b[<0;${x};1M\u001b[<0;${x};1m`;
  const opened = (screen: string): boolean => promptRow(screen).includes('new tab [') && promptRow(screen).includes('↵ save  ^c clear  esc cancel');

  // Cancel flow: type, see it in the row, Ctrl+C clears it, type again, Esc closes. No tab is made.
  const cancel = await mockSeatPtySequence({
    ...view,
    ready: { label: 'again', timeoutMs: 30_000, until: shellShown },
    steps: [
      { label: 'click-plus', keys: click, until: opened, timeoutMs: 15_000 },
      { label: 'typed', text: 'NOTINPANE', enter: false, until: (screen) => promptRow(screen).includes('new tab [NOTINPANE'), timeoutMs: 15_000 },
      { label: 'ctrl-c-clears', keys: '\u0003', until: (screen) => opened(screen) && !screen.includes('NOTINPANE'), timeoutMs: 15_000 },
      { label: 'typed-again', text: 'GONE', enter: false, until: (screen) => promptRow(screen).includes('new tab [GONE'), timeoutMs: 15_000 },
      { label: 'esc-cancels', keys: '\u001b', until: (screen) => !screen.includes('new tab [') && !screen.includes('GONE'), timeoutMs: 15_000 },
    ],
    quitKeys: '\u0002q',
  });
  expect(cancel.exitCode).toBe(0);
  expect((await titles()).length).toBe(1);
  const pane = (JSON.parse((await requestEls(socket, { op: 'ls' })).message) as { panes: { pane: string }[] }).panes[0]!.pane;
  const shown = (await requestEls(socket, { op: 'read', pane })).message;
  expect(shown).not.toContain('NOTINPANE');
  expect(shown).not.toContain('GONE');

  // Save flow: a Korean name, Enter → a second tab whose title is that name.
  const save = await mockSeatPtySequence({
    ...view,
    ready: { label: 'again-2', timeoutMs: 30_000, until: shellShown },
    steps: [
      { label: 'click-plus', keys: click, until: opened, timeoutMs: 15_000 },
      { label: 'typed-and-saved', text: '새탭A', until: (screen) => tabRow(screen).includes('새탭A') && !screen.includes('new tab ['), timeoutMs: 15_000 },
    ],
    quitKeys: '\u0002q',
  });
  expect(save.exitCode).toBe(0);
  expect(await titles()).toContain('새탭A');
  expect((await titles()).length).toBe(2);
}, 180_000);
