import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { requestEls } from '../els/client.js';
import { elsSocketPath } from '../els/server.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

// ELS-SIDEBAR-HERDR-CLEAN: the bare els app view in an outer PTY (headless xterm reads the screen) with TWO workspaces — the
// side list reads like herdr's: a «spaces» head, one «● NAME» line per workspace (UPPERCASE, one dot), the selected one's path on
// the line under it, «new · menu» on the last list line; a click on the other space's row switches to it; no row wraps; a Korean
// workspace name keeps the columns. (A `failed` pane state has no producer in the server yet — the failed → ✕ dot is covered by the
// unit tests of the view; an exited pane cannot be selected, so it cannot be the click target here.)
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

test('real terminal: two workspaces read like herdr — head, UPPERCASE names with one dot, the selected one\'s path, «new · menu»; a click switches; no wrapped rows; Korean name aligned', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-look-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const socket = elsSocketPath(root);
  const project = join(root, 'proj');
  mkdirSync(project);
  const COLS = 100, ROWS = 30, SIDE = 28;
  const view = { executable: process.execPath, args: [BIN, '--test-state-dir', '{root}', 'side'], root, rows: ROWS, cols: COLS, env: { SHELL: '/bin/sh', NODE_ENV: 'development' } };
  const shellShown = (screen: string): boolean => screen.split('\n').some((line) => line.includes('│') && line.includes('$'));
  const side = (screen: string): string[] => screen.split('\n').map((line) => line.split('│')[0] ?? '');
  const DOT = /^ [●○◐✓✕] /;
  const first = await mockSeatPtySequence({ ...view, ready: { label: 'first-screen', timeoutMs: 30_000, until: shellShown }, steps: [{ label: 'looked', text: '', until: 'new · menu', timeoutMs: 15_000 }], quitKeys: '\u0002q' }); // 출처: #37153 live PTY readiness bound; 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls
  expect(first.exitCode).toBe(0);
  const pid = Number((await requestEls(socket, { op: 'ping' })).message.match(/pid (\d+)/)?.[1]);
  cleanups.push(() => { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } });
  await registerOpSeat(root);
  const listed = JSON.parse((await requestEls(socket, { op: 'ls' })).message) as { panes: { workspace: string }[] };
  const firstName = listed.panes[0]!.workspace.toLocaleUpperCase();
  expect((await requestEls(socket, { op: 'new', ws: '한글 작업', cwd: project, command: ['/bin/sh'], title: 'ko-tab' })).exitCode).toBe(0);

  const bothListed = (screen: string): boolean => side(screen).some((line) => line.includes('한글 작업')) && screen.includes('new · menu');
  const koreanAt = (screen: string): number => side(screen).findIndex((line) => line.includes('한글 작업'));
  const run = await mockSeatPtySequence({
    ...view,
    ready: { label: 'again', timeoutMs: 30_000, until: (screen) => shellShown(screen) && bothListed(screen) }, // 출처: #37153 live PTY readiness bound
    steps: [
      { label: 'looked', text: '', until: bothListed, timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls
      // Rows (1-based): 1 head · 2 first space · 3 its path · 4 the Korean space → click its name cell; the release follows.
      { label: 'click-second-space', keys: '\u001b[<0;5;4M\u001b[<0;5;4m', until: (screen) => (side(screen)[koreanAt(screen) + 1] ?? '').includes('proj') && (screen.split('\n')[0] ?? '').toUpperCase().includes('KO-TAB'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls
    ],
    quitKeys: '\u0002q',
  });
  expect(run.exitCode).toBe(0);

  const before = run.frames.at(-2)!.screen;
  const left = side(before);
  expect(left[0]!.trimEnd()).toBe(' spaces');
  expect(left[1]).toMatch(DOT);
  expect(left[1]!.trimEnd().slice(3)).toBe(firstName);               // UPPERCASE, no pane count
  expect(left[2]!.startsWith('   ')).toBe(true);                    // the selected (first) space's path is the next line …
  expect(left[2]!.trim()).toMatch(/\//);
  expect(left[3]).toMatch(DOT);                                     // … the other space has none
  expect(left[3]!.trimEnd().slice(3)).toBe('한글 작업');
  expect(left[4]!.trim()).toBe('');
  expect(left[ROWS - 2]!.trimEnd()).toBe(' new · menu');            // pinned to the last list line (the status line is below)
  expect(left.slice(0, ROWS - 1).filter((line) => DOT.test(line))).toHaveLength(2);   // two workspaces, two dots, nothing else cluttering
  // Aligned: every list line, the Korean one included, is exactly the list width in cells; nothing wrapped to an extra row.
  for (const line of left.slice(0, ROWS - 1)) expect(Bun.stringWidth(line)).toBe(SIDE);
  expect(before.split('\n').length).toBe(ROWS);

  const after = side(run.frames.at(-1)!.screen);
  expect(after[1]!.trimEnd().slice(3)).toBe(firstName);             // the path left the first space (its row is now alone) …
  expect(after[2]!.trimEnd().slice(3)).toBe('한글 작업');            // … the Korean space moved up under it …
  expect(after[3]!.trim()).toMatch(/proj$/);                        // … and carries the path (home «~» only when under HOME; this one is under /tmp)
  for (const line of after.slice(0, ROWS - 1)) expect(Bun.stringWidth(line)).toBe(SIDE);
}, 180_000);
