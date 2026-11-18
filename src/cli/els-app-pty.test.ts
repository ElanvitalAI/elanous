import { basename, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, test } from 'bun:test';
import { requestEls } from '../els/client.js';
import { elsSocketPath } from '../els/server.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');

// ELS-ATTACH-VIEW stage 3 done-line (OP 11-18): a bare `els` in a terminal starts the server when there is none and shows the
// whole screen at once — the list on the left, a fresh shell on the right — then ctrl+b q leaves and the shell is still there.
test('real terminal: bare els on an empty state dir → server started, first screen = left list + right shell prompt; keys switch, create, close; ctrl+b q leaves the pane running', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-app-'));
  const folder = basename(root);
  let pid = 0;
  try {
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test-state-dir', '{root}', 'side'],
      root, rows: 24, cols: 100,
      env: { SHELL: '/bin/sh', NODE_ENV: 'development' },
      ready: { label: 'first-screen', timeoutMs: 30_000, until: (screen) => screen.split('\n').some((line) => line.includes('▾') && line.includes(folder) && line.includes('│') && line.includes('$')) }, // 출처: #37153 live PTY readiness bound
      steps: [
        { label: 'typed-into-pane', text: 'echo APP_$((6*7))_OK', until: (screen) => screen.split('\n').some((line) => line.includes('│APP_42_OK')), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls
        { label: 'second-pane', keys: '\u0002c', until: (screen) => screen.split('\n').filter((line) => /^ {4}[●○] /.test(line)).length === 2, timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls
        { label: 'back-to-first', keys: '\u0002k', until: (screen) => screen.split('\n').some((line) => line.includes('│APP_42_OK')), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls
        { label: 'close-asks', keys: '\u0002x', until: (screen) => screen.includes('닫기?'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls
        { label: 'close-yes', keys: 'y', until: (screen) => screen.split('\n').filter((line) => /^ {4}[●○] /.test(line)).length === 1, timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — 15 one-second list polls
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
  const root = mkdtempSync(join(tmpdir(), 'els-one-'));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  let pid = 0;
  const env = { SHELL: '/bin/sh', NODE_ENV: 'development', ELANOUS_CONFIG_DIR: root, ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1' };
  const sideListShown = (screen: string): boolean => screen.split('\n').some((line) => line.includes('▾'));
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
