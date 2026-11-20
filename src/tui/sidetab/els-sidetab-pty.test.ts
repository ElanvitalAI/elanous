import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
// A Unix socket path holds at most 103 bytes (macOS): the land train's long TMPDIR puts the els server/holder socket
// under <state>/els/ over it, so a state dir under a long TMPDIR falls back to /tmp (each test removes its own dir).
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
import { join } from 'node:path';
import { requestEls } from '../../els/client.js';
import { elsSocketPath, startElsServer } from '../../els/server.js';
import { NEXT_TUI_TITLE } from '../core/render.js';
import { mockSeatPtySequence } from '../../ux-sim/mock-seat-pty-sequence.js';

const BIN = join(import.meta.dir, '..', '..', '..', 'bin', 'elanous.mjs');

// ELS-DESKTOP-SIDETAB-SUBSCRIBE: the real Next TUI opens its side panel against a real els server and shows the
// server's panes in an «Els» section; the panel closing leaves the server running.
test('real Next TUI sidetab lists the els server panes and the server outlives the panel', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-tui-'));
  let started: Awaited<ReturnType<typeof startElsServer>> | undefined;
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    started = await startElsServer({ stateRoot: root, spawn: () => ({ id: 'pty_1', isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} }) });
    if ('exitCode' in started) throw new Error(started.message);
    expect((await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: '/work', command: ['eln'], title: 'ELS_MARK' })).exitCode).toBe(0);
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 24, cols: 80,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ELANOUS_ELS_PANE: 'p-test' }, // ELS-NESTING-RULE ①: an eln in a pane draws its own sidetab (a bare one hands the session to els)
      ready: { label: 'next-ready', timeoutMs: 30_000, until: (screen) => screen.split('\n').includes(NEXT_TUI_TITLE) }, // 출처: #37153 live Next PTY readiness (same bound as list.test.ts)
      steps: [
        { label: 'els-section', keys: '\x1c', until: (screen) => screen.includes('Els · 3') && screen.includes('ELS_MARK'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` TUI 사이드탭 구독 — the panel polls every 1 s, 15 polls
      ],
      quitKeys: '\x11',
    });
    expect(run.exitCode).toBe(0);
    expect(run.frames[1]?.screen).toContain('Els · 3');          // workspace + tab + pane rows
    // The TUI has quit; the owner and its pane are untouched.
    expect((await requestEls(elsSocketPath(root), { op: 'ping' })).exitCode).toBe(0);
    expect((await requestEls(elsSocketPath(root), { op: 'ls' })).message).toContain('ELS_MARK');
  } finally {
    if (started && !('exitCode' in started)) await started.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

// ELS-ONE-SPACE ② ③: in the real Next TUI the els rows are typed into through `els do` (this used to answer «Agent PTY input
// failed»), the herdr panes arrive as ⇄herdr rows of the same Els section, and the old Herdr-portal «snapshot…» line is gone.
test('real Next TUI sidetab: /side send on an els row reaches the pane through els do; herdr panes join the Els list; no old herdr portal line', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-tui2-'));
  let started: Awaited<ReturnType<typeof startElsServer>> | undefined;
  const typed: string[] = [];
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    // A fake `herdr` that answers `api snapshot` in herdr 0.9.1's real shape (result.snapshot.panes) — the shape the old portal could not read.
    const fakeHerdr = join(root, 'herdr');
    const snapshot = { id: 'cli:api:snapshot', result: { snapshot: { workspaces: [{ workspace_id: 'w1', label: 'HERDR_WS' }], tabs: [],
      panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t2', workspace_id: 'w1', agent_status: 'working', display_agent: 'HERDR_PANE', cwd: '/h' }] } } };
    writeFileSync(fakeHerdr, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(snapshot)}\nJSON\n`);
    chmodSync(fakeHerdr, 0o755);
    started = await startElsServer({ stateRoot: root, spawn: () => ({ id: 'pty_1', isAlive: () => true, write: (bytes: string) => { typed.push(bytes); }, renderScreen: async () => '', onExit: () => {}, kill: () => {} }) });
    if ('exitCode' in started) throw new Error(started.message);
    expect((await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: '/work', command: ['eln'], title: 'ELS_MARK' })).exitCode).toBe(0);
    // The person's explicit one-time registration (`els seat set OP`) with the owner credential — the TUI below is that person's terminal.
    expect((await requestEls(elsSocketPath(root), { op: 'seat-set', seat: 'OP' })).exitCode).toBe(0);
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      // Bare terminal (the owner credential needs no pane env): the list starts open, since a toggle there hands the session to els (rule ③).
      args: ['-e', `await import(${JSON.stringify(join(import.meta.dir, '..', 'entry.ts'))}).then(({ showNextTui }) => showNextTui({ sidetabMode: 'open' }));`],
      root, rows: 30, cols: 100,
      env: { ELANOUS_CONFIG_DIR: root, ELANOUS_STATE_DIR: root, ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', HERDR_ENV: '1', HERDR_BIN_PATH: fakeHerdr },
      ready: { label: 'next-ready', timeoutMs: 30_000, until: (screen) => screen.includes('Sessions · ') }, // 출처: #37153 live Next PTY readiness (same bound as list.test.ts)
      steps: [
        { label: 'els-and-herdr-rows', text: '', until: (screen) => screen.includes('Els · 7') && /› working\s+ELS_MARK/.test(screen) && screen.includes('⇄herdr'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` TUI «Els» section — 15 one-second list polls
        { label: 'send', keys: '/side send TYPED_FROM_SIDETAB\r', until: (screen) => screen.includes('Input sent to selected agent'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` TUI «Els» section — 15 one-second list polls
      ],
      quitKeys: '\x11',
    });
    expect(run.exitCode).toBe(0);
    const list = run.frames[1]!.screen;
    expect(list).toContain('Els · 7');                              // this host's ws/tab/pane (3 rows) + the ⇄herdr host/ws/tab/pane (4 rows), one tree
    expect(list).toContain('⇄herdr');                               // the herdr subtree's host header; its pane row carries the herdr workspace label
    expect(list).toContain('HERDR_WS');
    expect(list).not.toContain('snapshot refresh failed');          // the old portal's line for a snapshot it could not read
    expect(list).not.toContain('Herdr · snapshot');
    const sent = run.frames.at(-1)!.screen;
    expect(sent).toContain('Input sent to selected agent');
    expect(sent).not.toContain('Agent PTY input failed');
    expect(typed.join('')).toContain('TYPED_FROM_SIDETAB');           // the line really arrived in the pane, via els do
    expect(typed.join('')).toContain('⇢');                            // marked as coming from someone else
  } finally {
    if (started && !('exitCode' in started)) await started.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

// OP 11-18: the side list is remembered as OPEN across sessions, so a TUI that STARTS with it open is the common case. The els
// rows (this host's panes, ⇄herdr) must be read there too — before this, only a toggle ever fetched them.
test('real Next TUI that starts with the side list already open shows the els and herdr rows without any toggle', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-tui3-'));
  let started: Awaited<ReturnType<typeof startElsServer>> | undefined;
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false }, }));
    const fakeHerdr = join(root, 'herdr');
    const snapshot = { id: 'cli:api:snapshot', result: { snapshot: { workspaces: [{ workspace_id: 'w1', label: 'HERDR_WS' }], tabs: [],
      panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t2', workspace_id: 'w1', agent_status: 'idle', display_agent: 'HERDR_PANE', cwd: '/h' }] } } };
    writeFileSync(fakeHerdr, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(snapshot)}\nJSON\n`);
    chmodSync(fakeHerdr, 0o755);
    started = await startElsServer({ stateRoot: root, spawn: () => ({ id: 'pty_1', isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} }) });
    if ('exitCode' in started) throw new Error(started.message);
    expect((await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: '/work', command: ['eln'], title: 'ELS_MARK' })).exitCode).toBe(0);
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      // The real entry, started the way a remembered-open session starts it: sidetabMode 'open' (the user config's legacy
      // `tui.sidetab` is ignored, the remembered session state is what opens it).
      args: ['-e', `await import(${JSON.stringify(join(import.meta.dir, '..', 'entry.ts'))}).then(({ showNextTui }) => showNextTui({ sidetabMode: 'open' }));`],
      root, rows: 30, cols: 100,
      env: { ELANOUS_CONFIG_DIR: root, ELANOUS_STATE_DIR: root, ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', HERDR_ENV: '1', HERDR_BIN_PATH: fakeHerdr },
      ready: { label: 'next-ready', timeoutMs: 30_000, until: (screen) => screen.includes('Sessions · ') }, // 출처: #37153 live Next PTY readiness (same bound as list.test.ts)
      steps: [
        { label: 'rows-without-toggle', text: '', until: (screen) => screen.includes('Els · 7') && screen.includes('ELS_MARK') && screen.includes('⇄herdr'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` TUI «Els» section — 15 one-second list polls
      ],
      quitKeys: '\x11',
    });
    expect(run.exitCode).toBe(0);
    expect(run.frames[0]!.screen).toContain('Sessions · ');         // the list was open from the first frame: no Ctrl+\ was ever sent
    expect(run.frames.at(-1)!.screen).toContain('Els · 7');
  } finally {
    if (started && !('exitCode' in started)) await started.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

// ELS-DESKTOP-SIDETAB-SUBSCRIBE gap (a): a pane the server gets AFTER the panel is open reaches the real Next TUI's «Els»
// section (the panel follows the server's `subscribe` push; the 1 s timer is only its fallback). That push (not a poll) is
// what delivers it is pinned by subscribe.test.ts and els-subscribe.test.ts; this is the real-TUI wiring check.
test('real Next TUI sidetab shows a pane created on the els server after the panel opened', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-tui4-'));
  let started: Awaited<ReturnType<typeof startElsServer>> | undefined;
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    started = await startElsServer({ stateRoot: root, spawn: () => ({ id: 'pty_1', isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} }) });
    if ('exitCode' in started) throw new Error(started.message);
    expect((await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: '/work', command: ['eln'], title: 'ELS_ONE' })).exitCode).toBe(0);
    let created = false;
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 24, cols: 80,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ELANOUS_ELS_PANE: 'p-test' }, // ELS-NESTING-RULE ①: an eln in a pane draws its own sidetab (a bare one hands the session to els)
      ready: { label: 'next-ready', timeoutMs: 30_000, until: (screen) => screen.split('\n').includes(NEXT_TUI_TITLE) },
      steps: [
        { label: 'els-section', keys: '\x1c', until: (screen) => screen.includes('Els · 3') && screen.includes('ELS_ONE'), timeoutMs: 15_000 },
        { label: 'pane-created-after-open', text: '', timeoutMs: 15_000, until: (screen) => {
          if (!created) { created = true; void requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: '/work', command: ['eln'], title: 'ELS_LATE' }); }
          return screen.includes('Els · 5') && screen.includes('ELS_LATE');
        } },
      ],
      quitKeys: '\x11',
    });
    expect(run.exitCode).toBe(0);
    expect(run.frames.at(-1)!.screen).toContain('ELS_LATE');
    expect((await requestEls(elsSocketPath(root), { op: 'ping' })).exitCode).toBe(0);
  } finally {
    if (started && !('exitCode' in started)) await started.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

// ELS-DESKTOP-SIDETAB-SUBSCRIBE ② «서버 트리»: two workspaces on a real els server, the real Next TUI /side panel draws them as an
// indented workspace → tab → pane tree (the unit chain is pinned by els-tree-render.test.ts).
test('real Next TUI sidetab draws two els workspaces as an indented ws → tab → pane tree', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-tui5-'));
  let started: Awaited<ReturnType<typeof startElsServer>> | undefined;
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    started = await startElsServer({ stateRoot: root, spawn: () => ({ id: 'pty_1', isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} }) });
    if ('exitCode' in started) throw new Error(started.message);
    for (const [ws, title] of [['alpha', 'TREE_A1'], ['beta', 'TREE_B1'], ['alpha', 'TREE_A2']] as const) {
      expect((await requestEls(elsSocketPath(root), { op: 'new', ws, cwd: '/work', command: ['eln'], title })).exitCode).toBe(0);
    }
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 30, cols: 100,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ELANOUS_ELS_PANE: 'p-test' },
      ready: { label: 'next-ready', timeoutMs: 30_000, until: (screen) => screen.split('\n').includes(NEXT_TUI_TITLE) }, // 출처: #37153 live Next PTY readiness (same bound as list.test.ts)
      steps: [
        { label: 'tree', keys: '\x1c', until: (screen) => screen.includes('Els · 8') && screen.includes('TREE_A2'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` TUI «Els» section — 15 one-second list polls
      ],
      quitKeys: '\x11',
    });
    expect(run.exitCode).toBe(0);
    const lines = run.frames[1]!.screen.split('\n');
    const header = lines.findIndex((line) => line.includes('Els · 8'));
    // Status word, then 2 columns per tree level, then the node's first word.
    const tree = lines.slice(header + 1, header + 9).map((line) => /^ [› ] (\S+) ( *)(\S+)/.exec(line)).map((match) => [match![2]!.length / 2, match![3]!]);
    expect(tree.map(([depth]) => depth)).toEqual([0, 1, 2, 1, 2, 0, 1, 2]);
    expect(tree.map(([, text]) => text).filter((_, index) => [0, 2, 4, 5, 7].includes(index))).toEqual(['alpha', 'TREE_A1', 'TREE_A2', 'beta', 'TREE_B1']);
    expect((await requestEls(elsSocketPath(root), { op: 'ping' })).exitCode).toBe(0);
  } finally {
    if (started && !('exitCode' in started)) await started.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
