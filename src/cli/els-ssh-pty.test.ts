import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
// A Unix socket path holds at most 103 bytes (macOS): the land train's long TMPDIR puts the els server/holder socket
// under <state>/els/ over it, so a state dir under a long TMPDIR falls back to /tmp (each test removes its own dir).
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { requestEls } from '../els/client.js';
import { elsSocketPath } from '../els/server.js';
import { SPACE_LIST_END } from '../els/space-tabs-view.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';
import { privateSshdAvailable, startPrivateSshd, type PrivateSshd } from '../ux-sim/private-sshd.js';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const sh = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

// ELS-SSH-ATTACH-ANYWHERE: a REAL ssh login (a real PTY over a real ssh channel to a private loopback sshd) runs a bare `els`
// and lands on the resident els server: the whole screen at once, detach (ctrl+b q) leaves everything running, a second ssh
// login finds the same pane, and two logins at the same time see each other's typing.
// The remote command is the development checkout's `bin/elanous.mjs side` — the same entry the installed `els` shim runs
// (`exec elanous side`); the installed shim itself is proven on the rail by the installed-version measurement (ELS2 MEASURE).
// Where the private sshd cannot run (not macOS/Linux, no /usr/sbin/sshd) this test is SKIPPED, not green.
const run = privateSshdAvailable() ? test : test.skip;

run('real ssh: bare els attaches to the resident server; detach keeps the pane; a second ssh sees the same pane; two ssh logins at once share one screen', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-ssh-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const sshd: PrivateSshd = await startPrivateSshd();
  cleanups.push(() => sshd.stop());
  const remote = `exec env SHELL=/bin/sh NODE_ENV=development ELANOUS_STATE_DIR=${sh(root)} ${sh(process.execPath)} ${sh(BIN)} --test-state-dir ${sh(root)} side`;
  const login = (steps: Parameters<typeof mockSeatPtySequence>[0]['steps'], ready: { label: string; until: (screen: string) => boolean }) => mockSeatPtySequence({
    executable: '/usr/bin/ssh', args: ['-tt', ...sshd.sshArgs, `${userInfo().username}@127.0.0.1`, remote],
    root, rows: 20, cols: 100, ready: { ...ready, timeoutMs: 60_000 }, steps, quitKeys: '\u0002q', // 출처: #37153 live PTY readiness bound
  });
  // ELS-ONE-SPACE (출처: JUD must #38640 · OP 89950 · 2026-11-18): the first screen shows the folded space list
  // (ending with SPACE_LIST_END), not the old «▾» tree — the shell paints right of «│» on the same screen row.
  const listsShell = (screen: string): boolean =>
    screen.includes(SPACE_LIST_END) && screen.split('\n').some((line) => line.includes('│') && line.includes('$'));
  // Registered BEFORE any login can fail: whatever server answers on this state dir at the end is stopped (its panes closed first).
  cleanups.push(async () => {
    const listed = await requestEls(elsSocketPath(root), { op: 'ls' });
    if (listed.exitCode === 0) for (const row of (JSON.parse(listed.message) as { panes: { pane: string }[] }).panes) await requestEls(elsSocketPath(root), { op: 'close', pane: row.pane });
    const ping = await requestEls(elsSocketPath(root), { op: 'ping' });
    const alive = Number(ping.message.match(/pid (\d+)/)?.[1]);
    if (ping.exitCode === 0 && alive > 0) { try { process.kill(alive, 'SIGTERM'); } catch { /* already gone */ } }
  });

  // 1. first login: the server is started by it (isolated state), the whole screen appears, typing works.
  const first = await login([
    { label: 'typed', text: 'echo SSH_$((6*7))_OK', until: (screen) => screen.split('\n').some((line) => line.includes('│SSH_42_OK')), timeoutMs: 30_000 }, // 출처: 내부 문서 `SIDETAB-ONE-SPACE` «ssh 로 어디서든 붙기» — 30 one-second list polls
  ], { label: 'first-screen', until: listsShell });
  expect(first.exitCode).toBe(0);

  // 2. the ssh session is gone; the server and the pane are not.
  const ping = await requestEls(elsSocketPath(root), { op: 'ping' });
  expect([ping.exitCode, /^els server pid \d+$/.test(ping.message)]).toEqual([0, true]);
  const left = JSON.parse((await requestEls(elsSocketPath(root), { op: 'ls' })).message) as { panes: { ptyId: string }[] };
  expect(left.panes).toHaveLength(1);
  expect(left.panes[0]!.ptyId).toMatch(/^h:p[0-9a-f]{8}$/);                    // a live PTY id: the holder adapter id h:<paneId> since D1a #39122 (an exited pane has an empty one)

  // 2b. two more workspaces, one with two tabs, made through the socket while nobody is attached.
  for (const [ws, title] of [['alpha', 'alpha-one'], ['alpha', 'alpha-two'], ['beta', 'beta-one']] as const) {
    expect((await requestEls(elsSocketPath(root), { op: 'new', ws, cwd: root, command: ['/bin/sh'], title })).exitCode).toBe(0);
  }
  // ELS-ONE-SPACE (출처: JUD must #38640 · OP 89950 · 2026-11-18): every space is listed («ALPHA»), but only the
  // SELECTED space's tabs are drawn — the other spaces' tab titles must stay absent from the screen.
  const everything = (screen: string): boolean =>
    ['ALPHA', 'BETA'].every((name) => screen.includes(name)) &&
    ['alpha-one', 'alpha-two', 'beta-one'].every((name) => !screen.includes(name));

  // 3. two more logins AT THE SAME TIME: each first screen lists every space (only the selected space's tabs), each shows the earlier output, and
  //    what one types appears on the other's screen.
  const [second, third] = await Promise.all([
    login([
      { label: 'sees-history', keys: '', until: (screen) => screen.includes('SSH_42_OK'), timeoutMs: 30_000 }, // 출처: 내부 문서 `SIDETAB-ONE-SPACE` «ssh 로 어디서든 붙기» — 30 one-second list polls
      { label: 'types-A', text: 'echo FROM_$((1+1))_A', until: (screen) => screen.includes('FROM_2_A'), timeoutMs: 30_000 }, // 출처: 내부 문서 `SIDETAB-ONE-SPACE` «ssh 로 어디서든 붙기» — 30 one-second list polls
      { label: 'sees-B', keys: '', until: (screen) => screen.includes('FROM_3_B'), timeoutMs: 30_000 }, // 출처: 내부 문서 `SIDETAB-ONE-SPACE` «ssh 로 어디서든 붙기» — 30 one-second list polls
    ], { label: 'second-screen', until: (screen) => listsShell(screen) && everything(screen) }),
    login([
      { label: 'sees-history', keys: '', until: (screen) => screen.includes('SSH_42_OK'), timeoutMs: 30_000 }, // 출처: 내부 문서 `SIDETAB-ONE-SPACE` «ssh 로 어디서든 붙기» — 30 one-second list polls
      { label: 'sees-A', keys: '', until: (screen) => screen.includes('FROM_2_A'), timeoutMs: 60_000 }, // 출처: 내부 문서 `SIDETAB-ONE-SPACE` «ssh 로 어디서든 붙기» — A types within its own 30 s waits
      { label: 'types-B', text: 'echo FROM_$((1+2))_B', until: (screen) => screen.includes('FROM_3_B'), timeoutMs: 30_000 }, // 출처: 내부 문서 `SIDETAB-ONE-SPACE` «ssh 로 어디서든 붙기» — 30 one-second list polls
    ], { label: 'third-screen', until: (screen) => listsShell(screen) && everything(screen) }),
  ]);
  expect([second.exitCode, third.exitCode]).toEqual([0, 0]);
  const after = JSON.parse((await requestEls(elsSocketPath(root), { op: 'ls' })).message) as { panes: unknown[] };
  expect(after.panes).toHaveLength(4);       // three logins, still the four panes made above — none was added or lost by attaching
}, 300_000);
