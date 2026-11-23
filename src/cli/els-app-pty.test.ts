import { basename, join } from 'node:path';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
// A Unix socket path holds at most 103 bytes (macOS): the land train's long TMPDIR puts the els server/holder socket
// under <state>/els/ over it, so a state dir under a long TMPDIR falls back to /tmp (each test removes its own dir).
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
import { expect, test } from 'bun:test';
import { requestEls } from '../els/client.js';
import { elsSocketPath } from '../els/server.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');

/** `seat-set OP` as the person's terminal sends it: the credential is the server's owner-token file; this process's env is put back after. */
async function registerOpSeat(root: string): Promise<{ exitCode: number; message: string }> {
  const before = process.env.ELANOUS_ELS_OWNER_TOKEN;
  process.env.ELANOUS_ELS_OWNER_TOKEN = readFileSync(join(root, 'els', 'owner-token'), 'utf8').trim();
  try { return await requestEls(elsSocketPath(root), { op: 'seat-set', seat: 'OP' }); }
  finally { if (before === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = before; }
}

// ELS-ATTACH-VIEW stage 3 done-line (OP 11-18): a bare `els` in a terminal starts the server when there is none and shows the
// whole screen at once — the list on the left, a fresh shell on the right — then ctrl+b q leaves and the shell is still there.
test('real terminal: bare els on an empty state dir → server started, first screen = left list + right shell prompt; keys switch, create, close; ctrl+b q leaves the pane running', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-app-'));
  const folder = basename(root).toUpperCase();                      // ELS-SIDEBAR-HERDR-CLEAN: the space list shows names UPPERCASE and no pane count
  const tabCount = (screen: string): number => ((screen.split('\n')[0] ?? '').split('│').slice(1).join('│').match(/ SH /g) ?? []).length; // «SH» shell tabs in the tab row (no runtime emoji since OP 11-23)
  let pid = 0;
  try {
    const view = { executable: process.execPath, args: [BIN, '--test-state-dir', '{root}', 'side'], root, rows: 24, cols: 100, env: { SHELL: '/bin/sh', NODE_ENV: 'development' } };
    // Step 1 — the done-line start: nothing is running, bare els starts the server and shows list + shell; the person looks and leaves.
    const first = await mockSeatPtySequence({
      ...view,
      ready: { label: 'first-screen', timeoutMs: 30_000, until: (screen) => screen.includes(folder) && screen.includes('new · menu') && screen.split('\n').some((line) => line.includes('│') && line.includes('$')) }, // 출처: #37153 live PTY readiness bound
      steps: [{ label: 'looked', text: '', until: (screen) => screen.includes(folder), timeoutMs: 15_000 }], // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls
      quitKeys: '\u0002q',
    });
    expect(first.exitCode).toBe(0);
    // Step 2 — the person registers the OP seat once for this server (the explicit owner act `seat-set OP`, presented with the
    // server's 0600 owner-token file). Without it the door lets the owner terminal type but not create or close panes (#39143).
    expect(await registerOpSeat(root)).toEqual({ exitCode: 0, message: 'els seat: OP registered' });
    // Step 3 — the same server, the pane that was left running, and now the person's keys reach it.
    const run = await mockSeatPtySequence({
      ...view,
      ready: { label: 'first-screen-again', timeoutMs: 30_000, until: (screen) => screen.includes(folder) && screen.includes('new · menu') && screen.split('\n').some((line) => line.includes('│') && line.includes('$')) }, // 출처: #37153 live PTY readiness bound
      steps: [
        { label: 'typed-into-pane', text: 'echo APP_$((6*7))_OK', until: (screen) => screen.split('\n').some((line) => line.includes('│APP_42_OK')), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls
        { label: 'second-pane', keys: '\u0002c\r', until: (screen) => tabCount(screen) === 2, timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls
        { label: 'back-to-first', keys: '\u0002k', until: (screen) => screen.split('\n').some((line) => line.includes('│APP_42_OK')), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls
        { label: 'close-asks', keys: '\u0002x', until: (screen) => screen.includes('닫기?'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls
        { label: 'close-yes', keys: 'y', until: (screen) => tabCount(screen) === 1, timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls
      ],
      quitKeys: '\u0002q',
    });
    expect(run.exitCode).toBe(0);
    expect(run.frames[0]?.screen).not.toContain('[screen');
    // After the screen is left the server and the remaining pane are still there.
    const socket = elsSocketPath(root);
    const ping = await requestEls(socket, { op: 'ping' });
    pid = Number(ping.message.match(/pid (\d+)/)?.[1]);
    expect(Number.isNaN(pid)).toBe(false);
    const listed = JSON.parse((await requestEls(socket, { op: 'ls' })).message) as { panes: { ptyId: string; state: string }[] };
    expect(listed.panes.map((pane) => [pane.state === 'exited', pane.ptyId !== ''])).toEqual([[false, true]]);
  } finally {
    if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

// ELS-ONE-SPACE done-line (OP 11-18): chat → toggle the side list → the same conversation → toggle → restart → the same
// conversation. The chat is an elanous (the real Next TUI, fake LLM) running as a pane the els server owns.
test('real terminal: an elanous chat pane survives the side-list toggle and a full restart of the els client — same conversation, same pane', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-one-'));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  let pid = 0;
  const env = { SHELL: '/bin/sh', NODE_ENV: 'development', ELANOUS_CONFIG_DIR: root, ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1' };
  // ELS-ONE-SPACE: the open list is the folded space list, which always ends with «new · menu».
  const sideListShown = (screen: string): boolean => screen.includes('new · menu');
  try {
    const first = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test-state-dir', '{root}', 'side'],
      root, rows: 30, cols: 120, env,
      ready: { label: 'shell-pane', timeoutMs: 30_000, until: (screen) => sideListShown(screen) && screen.includes('$') }, // 출처: #37153 live PTY readiness bound
      steps: [
        { label: 'chat-pane', keys: '\u0002a', until: (screen) => screen.includes('Chat — ask for anything in plain language') && screen.includes('Enter send · Esc cancel · Ctrl+Q quit'), timeoutMs: 40_000 }, // 출처: #37153 live PTY readiness bound
        { label: 'said', text: 'ONE_SPACE_MSG', until: (screen) => screen.includes('ONE_SPACE_MSG') && !screen.includes('❯ ONE_SPACE_MSG'), timeoutMs: 20_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — a fake-LLM turn well inside 20 s
        { label: 'hide-list', keys: '\u0002s', until: (screen) => !sideListShown(screen) && screen.includes('ONE_SPACE_MSG'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second polls
        { label: 'show-list', keys: '\u0002s', until: (screen) => sideListShown(screen) && screen.includes('ONE_SPACE_MSG'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second polls
      ],
      quitKeys: '\u0002q',
    });
    expect(first.exitCode).toBe(0);
    const socket = elsSocketPath(root);
    pid = Number((await requestEls(socket, { op: 'ping' })).message.match(/pid (\d+)/)?.[1]);
    expect(Number.isNaN(pid)).toBe(false);
    // The terminal is gone; the server, the shell pane and the chat pane are not.
    const alive = JSON.parse((await requestEls(socket, { op: 'ls' })).message) as { panes: { title: string; ptyId: string }[] };
    expect(alive.panes.map((pane) => [pane.title, pane.ptyId !== ''])).toEqual([['/bin/sh', true], ['elanous', true]]);
    // A new els: the right side is the pane it was left on — the chat, with the conversation in it.
    const second = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test-state-dir', '{root}', 'side'],
      root, rows: 30, cols: 120, env,
      ready: { label: 'same-conversation', timeoutMs: 40_000, until: (screen) => sideListShown(screen) && screen.includes('ONE_SPACE_MSG') }, // 출처: #37153 live PTY readiness bound
      steps: [
        { label: 'still-there', keys: '\u0002s', until: (screen) => !sideListShown(screen) && screen.includes('ONE_SPACE_MSG'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second polls
      ],
      quitKeys: '\u0002q',
    });
    expect(second.exitCode).toBe(0);
  } finally {
    if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
    rmSync(root, { recursive: true, force: true });
  }
}, 240_000);

// ELS-ONE-SPACE ① (OP 11-18 live measure): the herdr panes are in the full-screen list too — «⇄herdr <workspace>» under this host's
// own — and a selected one shows its screen read-only; typing into it is refused with the way in (`els do`).
test('real terminal: bare els lists the herdr panes under ⇄herdr, shows a selected one read-only and refuses typing into it', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-fed-'));
  let pid = 0;
  try {
    // A fake `herdr`: `api snapshot` answers in herdr 0.9.1's real shape, `pane read` prints a marker screen.
    const fakeHerdr = join(root, 'herdr');
    const snapshot = { id: 'cli:api:snapshot', result: { snapshot: { workspaces: [{ workspace_id: 'w1', label: 'HERDR_WS' }], tabs: [],
      panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t2', workspace_id: 'w1', agent_status: 'idle', display_agent: 'HERDR_PANE', cwd: '/h' }] } } };
    writeFileSync(fakeHerdr, `#!/bin/sh\nif [ "$1" = "api" ]; then cat <<'JSON'\n${JSON.stringify(snapshot)}\nJSON\nelse echo HERDR_READ_SCREEN; fi\n`);
    chmodSync(fakeHerdr, 0o755);
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test-state-dir', '{root}', 'side'],
      root, rows: 24, cols: 100,
      env: { SHELL: '/bin/sh', NODE_ENV: 'development', HERDR_ENV: '1', HERDR_BIN_PATH: fakeHerdr },
      ready: { label: 'first-screen', timeoutMs: 30_000, until: (screen) => screen.split('\n').some((line) => line.includes('│') && line.includes('$')) }, // 출처: #37153 live PTY readiness bound
      steps: [
        { label: 'herdr-in-list', text: '', until: (screen) => screen.includes('⊞ HERDR · 1'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls
        { label: 'select-herdr', keys: '\u0002w', until: (screen) => screen.includes('HERDR_READ_SCREEN') && screen.includes('읽기 전용'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls
        { label: 'typing-refused', keys: 'rm -rf x', until: (screen) => screen.includes('pane 은 읽기 전용 — 입력은 els do'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls (the status line is clipped to 100 columns: the way in is shown up to «els do»)
      ],
      quitKeys: '\u0002q',
    });
    expect(run.exitCode).toBe(0);
    const list = run.frames[1]!.screen;
    expect(list).toContain('⊞ HERDR · 1');                           // herdr's panes are one folded bundle under a «herdr» head (FIRST-RUN-FU3)
    expect(list).not.toContain('HERDR_WS');                          // folded: its workspace is not a left line yet
    expect(list).not.toContain('HERDR_PANE');                        // nor is its pane (spaces only)
    expect(run.frames.at(-1)!.screen).toContain('⊟ HERDR · 1');      // selecting one of them opens the bundle …
    expect(run.frames.at(-1)!.screen).toContain('⇄HERDR HERDR_WS'); // … and its workspace is a space under the head
    expect(run.frames.at(-1)!.screen).toContain('HERDR_READ_SCREEN');
    expect(run.frames.at(-1)!.screen).toContain('  ⇄herdr HERDR_PANE');    // once selected, the pane is the tab (#39322: the ⇄host prefix; its name stays uppercase)
    pid = Number((await requestEls(elsSocketPath(root), { op: 'ping' })).message.match(/pid (\d+)/)?.[1]);
  } finally {
    if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
