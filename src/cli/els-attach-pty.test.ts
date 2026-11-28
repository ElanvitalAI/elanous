import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENTER_PANE_VIEW, ENTER_VIEW, LEAVE_PANE_VIEW, LEAVE_VIEW } from '../els/attach-view.js';
import { requestEls } from '../els/client.js';
import { elsSocketPath, startElsServer } from '../els/server.js';
import { simCli } from '../ux-sim/in-process-cli.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
// A Unix socket path holds at most 103 bytes (macOS): under a long TMPDIR the state dir falls back to /tmp (each test removes its own dir).
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const cleanups: (() => Promise<void> | void)[] = [];
const ORIGINAL_OWNER_TOKEN = process.env.ELANOUS_ELS_OWNER_TOKEN; // saved once; every exit path of every test goes through afterEach below
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { if (ORIGINAL_OWNER_TOKEN === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = ORIGINAL_OWNER_TOKEN; }
});

// `els attach` in a real terminal against a real els server and a real shell pane: the screen shows the shell, typing
// reaches it, ctrl+b q leaves with exit 0, and the pane is still there afterwards.
test('real terminal: els attach shows the pane, types into it, detaches with ctrl+b q and leaves the pane running', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-cliatt-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const started = await startElsServer({ stateRoot: root });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const created = await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: root, command: ['/bin/sh'] });
  const { pane } = JSON.parse(created.message) as { pane: string };
  cleanups.push(async () => { await requestEls(elsSocketPath(root), { op: 'close', pane }); });
  let wire = '';
  const run = await mockSeatPtySequence({
    executable: process.execPath,
    args: [BIN, '--test-state-dir', '{root}', 'side', 'attach', pane],
    root, rows: 20, cols: 80,
    onOutput: (chunk) => { wire += chunk; },
    ready: { label: 'attached', timeoutMs: 30_000, until: (screen) => screen.includes('ctrl+b q 분리') && screen.includes('$') }, // 출처: #37153 live PTY readiness bound
    steps: [
      { label: 'typed', text: 'echo CLI_$((20+22))_OK', until: (screen) => screen.split('\n').some((line) => line.startsWith('CLI_42_OK')), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «attach» — 150 frame polls
    ],
    quitKeys: '\u0002q',
  });
  expect(run.exitCode).toBe(0);
  expect(wire.split(LEAVE_PANE_VIEW).length - 1).toBe(1);       // ELS-MOUSE-RELEASE: the pane view's undo bytes once, not again by the exit guard
  expect(run.frames[0]?.screen).not.toContain('[screen');
  const listed = JSON.parse((await requestEls(elsSocketPath(root), { op: 'ls' })).message) as { panes: { ptyId: string; state: string }[] };
  expect(listed.panes.map((row) => [row.state === 'exited', row.ptyId !== ''])).toEqual([[false, true]]);
}, 90_000);

test('real terminal: a pane that exits under the view ends els attach with exit 1 and says why (a detach is the only 0)', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-cliatt-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const started = await startElsServer({ stateRoot: root });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const created = await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: root, command: ['/bin/sh'] });
  const { pane } = JSON.parse(created.message) as { pane: string };
  const run = await mockSeatPtySequence({
    executable: process.execPath,
    args: [BIN, '--test-state-dir', '{root}', 'side', 'attach', pane],
    root, rows: 20, cols: 80,
    ready: { label: 'attached', timeoutMs: 30_000, until: (screen) => screen.includes('ctrl+b q 분리') && screen.includes('$') }, // 출처: #37153 live PTY readiness bound
    steps: [
      { label: 'marked', text: 'echo LAST_SCREEN_$((3*3))', until: (screen) => screen.split('\n').some((line) => line.startsWith('LAST_SCREEN_9')), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «attach» — 150 frame polls
      { label: 'pane-exits', text: 'exit', until: (screen) => screen.includes('the pane exited'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «attach» — 150 frame polls
    ],
    quitKeys: '',
  });
  expect(run.exitCode).toBe(1);
  // The alternate screen is gone, but the pane's last screen is still on the terminal, above the message.
  const final = run.frames.at(-1)!.screen;
  expect(final).toContain('LAST_SCREEN_9');
  expect(final.indexOf('LAST_SCREEN_9')).toBeLessThan(final.indexOf('the pane exited'));
}, 90_000);

test('els attach without a terminal refuses with exit 2 and a hint for scripts', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-cliatt-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const run = await simCli(['side', 'attach', 'p1'], { mode: 'spawn', allowPaths: [['side']], stateRoot: root, cwd: root, env: { NODE_ENV: 'development' } });
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain('needs a terminal');
});

// ELS-MOUSE-REPORT: in a real terminal the bytes on the wire carry the mouse-reporting switch on enter and its undo on leave.
test('real terminal: bare els writes ENTER_VIEW (alt screen + mouse 1000/1006) on entry and LEAVE_VIEW on ctrl+b q exit', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-mouse-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  let wire = '';
  const run = await mockSeatPtySequence({
    executable: process.execPath,
    args: [BIN, '--test-state-dir', '{root}', 'side'],
    root, rows: 24, cols: 120,
    env: { SHELL: '/bin/sh', NODE_ENV: 'development' },
    ready: { label: 'shell-attached', timeoutMs: 30_000, until: (screen) => screen.split('\n').some((line) => line.includes('│') && line.includes('$')) }, // 출처: #37153 live PTY readiness bound
    steps: [{ label: 'hint-line', text: '', until: 'ctrl+b ? shortcuts · c new shell', timeoutMs: 5_000 }], // 출처: #37153 live PTY step bound — static hint line, no round trip
    quitKeys: '\u0002q',
    onOutput: (chunk) => { wire += chunk; },
  });
  const pid = Number((await requestEls(elsSocketPath(root), { op: 'ping' })).message.match(/pid (\d+)/)?.[1]);
  if (pid > 0) cleanups.push(() => { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } });
  expect(run.exitCode).toBe(0);
  expect(wire).toContain(ENTER_VIEW);
  expect(wire).toContain('\u001b[?1000h\u001b[?1006h');
  expect(wire).toContain(LEAVE_VIEW);
  expect(wire.indexOf(LEAVE_VIEW)).toBeGreaterThan(wire.indexOf(ENTER_VIEW));
  expect(wire.split(LEAVE_VIEW).length - 1).toBe(1);            // ELS-MOUSE-RELEASE: written once, not again by the exit guard
}, 120_000);

// ELS-ATTACH-VIEW-E2E (JUD-B #112395): ONE nested real-PTY flow. Outer real PTY = the bare `els` app view (real renderer) on
// pane A; inside pane A's real shell the real CLI `els attach <B>` runs with the pane's own token env; typing reaches pane B and
// its answer shows on the outer screen; the detach key goes through the app to the nested attach (ctrl+b ctrl+b = one literal
// ctrl+b for the pane, then q) and the SAME app's pane A screen comes back. Real startElsServer, real PTYs (mockSeatPtySequence
// only names the harness: it spawns a real PTY and reads it with a headless xterm — nothing is mocked), no socket/PTY fakes.
test('real terminal: inside the els app on pane A, `els attach <B>` shows B and types into it; detach returns to the same app pane A screen', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-nest-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const started = await startElsServer({ stateRoot: root });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const socket = elsSocketPath(root);
  // The person's terminal registers the OP seat first (the explicit owner act, with the server's owner-token file; this process's env is put back
  // after) and then opens the panes, so both are OP-parented panes like the ones the app makes for the person.
  process.env.ELANOUS_ELS_OWNER_TOKEN = readFileSync(join(root, 'els', 'owner-token'), 'utf8').trim();
  expect(await requestEls(socket, { op: 'seat-set', seat: 'OP' })).toMatchObject({ exitCode: 0, message: 'els seat: OP registered', transport: { outcome: 'answered' } });
  const makePane = async (): Promise<string> => {
    const created = await requestEls(socket, { op: 'new', ws: 'OP', cwd: root, command: ['/bin/sh'] });
    const { pane } = JSON.parse(created.message) as { pane: string };
    cleanups.push(async () => { await requestEls(socket, { op: 'close', pane }); });
    return pane;
  };
  const paneA = await makePane();
  const paneB = await makePane();
  const line = (screen: string, text: string): boolean => screen.split('\n').some((row) => row.includes(text));
  const attachCommand = `'${process.execPath}' '${BIN}' --test-state-dir '${root}' side attach ${paneB}`;
  let wire = '';
  const run = await mockSeatPtySequence({
    executable: process.execPath,
    args: [BIN, '--test-state-dir', '{root}', 'side'],
    root, rows: 24, cols: 120,
    env: { SHELL: '/bin/sh', NODE_ENV: 'development' },
    onOutput: (chunk) => { wire += chunk; },
    ready: { label: 'app-on-pane-A', timeoutMs: 30_000, until: (screen) => screen.includes('new · menu') && line(screen, '│') && screen.includes('$') }, // 출처: #37153 live PTY readiness bound
    steps: [
      { label: 'A-marker', text: 'echo A_SCREEN_$((7*6))_MARK', until: (screen) => line(screen, '│A_SCREEN_42_MARK'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls
      { label: 'real-cli-attach-B', text: attachCommand, until: (screen) => screen.split('\n').some((row) => row.includes(paneB) && row.includes('ctrl+b q 분리')), timeoutMs: 30_000 }, // 출처: #37153 live PTY readiness bound (a real CLI start inside a pane)
      { label: 'typed-into-B', text: 'echo B_NEST_$((20+22))_OK', until: (screen) => line(screen, 'B_NEST_42_OK') && !line(screen, '│A_SCREEN_42_MARK'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «attach» — 150 frame polls
      { label: 'detach-through-app', keys: '\u0002\u0002q', until: (screen) => line(screen, '│A_SCREEN_42_MARK') && !screen.includes('ctrl+b q 분리') && !line(screen, 'B_NEST_42_OK'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «attach» — 150 frame polls
      { label: 'app-still-answers', text: 'echo AFTER_$((8*8))_OK', until: (screen) => line(screen, '│AFTER_64_OK') && line(screen, '│A_SCREEN_42_MARK'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls
      { label: 'app-second-pane', keys: '\u0002c\r', until: (screen) => (((screen.split('\n')[0] ?? '').split('│').slice(1).join('│').match(/ SH /g) ?? []).length) === 3, timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls
    ],
    quitKeys: '\u0002q',
  });
  const pid = Number((await requestEls(socket, { op: 'ping' })).message.match(/pid (\d+)/)?.[1]);
  expect(Number.isNaN(pid)).toBe(false);
  expect(run.exitCode).toBe(0);
  // B really got the typed line (read straight from the server, not from the outer screen); A is not where it went.
  expect((await requestEls(socket, { op: 'read', pane: paneB })).message).toContain('B_NEST_42_OK');
  expect((await requestEls(socket, { op: 'read', pane: paneA })).message).not.toContain('B_NEST_42_OK');
  // Wire sanity: the outer terminal got the app's alt screen + mouse reporting once, the nested attach's own alt-screen bytes
  // stayed inside pane A, and the mouse/alt-screen undo came once at the very end.
  expect(wire.split(ENTER_VIEW).length - 1).toBe(1);
  expect(wire).not.toContain(ENTER_PANE_VIEW);
  expect(wire.split('\u001b[?1000l').length - 1).toBe(1);
  expect(wire.split(LEAVE_VIEW).length - 1).toBe(1);
  // After the app is left the server and all three panes are still running.
  const listed = JSON.parse((await requestEls(socket, { op: 'ls' })).message) as { panes: { state: string }[] };
  expect(listed.panes.map((row) => row.state === 'exited')).toEqual([false, false, false]);
}, 120_000);
