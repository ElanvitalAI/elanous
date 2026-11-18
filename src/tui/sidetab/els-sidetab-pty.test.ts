import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestEls } from '../../els/client.js';
import { elsSocketPath, startElsServer } from '../../els/server.js';
import { NEXT_TUI_TITLE } from '../core/render.js';
import { mockSeatPtySequence } from '../../ux-sim/mock-seat-pty-sequence.js';

const BIN = join(import.meta.dir, '..', '..', '..', 'bin', 'elanous.mjs');

// ELS-DESKTOP-SIDETAB-SUBSCRIBE: the real Next TUI opens its side panel against a real els server and shows the
// server's panes in an «Els» section; the panel closing leaves the server running.
test('real Next TUI sidetab lists the els server panes and the server outlives the panel', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-tui-'));
  let started: Awaited<ReturnType<typeof startElsServer>> | undefined;
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    started = await startElsServer({ stateRoot: root, spawn: () => ({ id: 'pty_1', isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} }) });
    if ('exitCode' in started) throw new Error(started.message);
    expect((await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: '/work', command: ['eln'], title: 'ELS_PANE_MARKER' })).exitCode).toBe(0);
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 24, cols: 80,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1' },
      ready: { label: 'next-ready', timeoutMs: 30_000, until: (screen) => screen.split('\n').includes(NEXT_TUI_TITLE) }, // 출처: #37153 live Next PTY readiness (same bound as list.test.ts)
      steps: [
        { label: 'els-section', keys: '\x1c', until: (screen) => screen.includes('Els · 1') && screen.includes('ELS_PANE_MARKER'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` TUI 사이드탭 구독 — the panel polls every 1 s, 15 polls
      ],
      quitKeys: '\x11',
    });
    expect(run.exitCode).toBe(0);
    expect(run.frames[1]?.screen).toContain('Els · 1');
    // The TUI has quit; the owner and its pane are untouched.
    expect((await requestEls(elsSocketPath(root), { op: 'ping' })).exitCode).toBe(0);
    expect((await requestEls(elsSocketPath(root), { op: 'ls' })).message).toContain('ELS_PANE_MARKER');
  } finally {
    if (started && !('exitCode' in started)) await started.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

// ELS-ONE-SPACE ② ③: in the real Next TUI the els rows are typed into through `els do` (this used to answer «Agent PTY input
// failed»), the herdr panes arrive as ⇄herdr rows of the same Els section, and the old Herdr-portal «snapshot…» line is gone.
test('real Next TUI sidetab: /side send on an els row reaches the pane through els do; herdr panes join the Els list; no old herdr portal line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-tui2-'));
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
    expect((await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: '/work', command: ['eln'], title: 'ELS_PANE_MARKER' })).exitCode).toBe(0);
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 30, cols: 100,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', HERDR_ENV: '1', HERDR_BIN_PATH: fakeHerdr },
      ready: { label: 'next-ready', timeoutMs: 30_000, until: (screen) => screen.split('\n').includes(NEXT_TUI_TITLE) }, // 출처: #37153 live Next PTY readiness (same bound as list.test.ts)
      steps: [
        { label: 'els-and-herdr-rows', keys: '\x1c', until: (screen) => screen.includes('Els · 2') && screen.includes('› working ELS_PANE_MARKER') && screen.includes('⇄herdr HERDR_WS'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` TUI «Els» section — 15 one-second list polls
        { label: 'send', keys: '/side send TYPED_FROM_SIDETAB\r', until: (screen) => screen.includes('Input sent to selected agent'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` TUI «Els» section — 15 one-second list polls
      ],
      quitKeys: '\x11',
    });
    expect(run.exitCode).toBe(0);
    const list = run.frames[1]!.screen;
    expect(list).toContain('Els · 2');                              // this host's pane + the herdr pane, one list
    expect(list).toContain('⇄herdr HERDR_WS');                      // the herdr pane, grouped by its herdr workspace label
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
  const root = mkdtempSync(join(tmpdir(), 'els-tui3-'));
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
    expect((await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: '/work', command: ['eln'], title: 'ELS_PANE_MARKER' })).exitCode).toBe(0);
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      // The real entry, started the way a remembered-open session starts it: sidetabMode 'open' (the user config's legacy
      // `tui.sidetab` is ignored, the remembered session state is what opens it).
      args: ['-e', `await import(${JSON.stringify(join(import.meta.dir, '..', 'entry.ts'))}).then(({ showNextTui }) => showNextTui({ sidetabMode: 'open' }));`],
      root, rows: 30, cols: 100,
      env: { ELANOUS_CONFIG_DIR: root, ELANOUS_STATE_DIR: root, ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', HERDR_ENV: '1', HERDR_BIN_PATH: fakeHerdr },
      ready: { label: 'next-ready', timeoutMs: 30_000, until: (screen) => screen.includes('Sessions · ') }, // 출처: #37153 live Next PTY readiness (same bound as list.test.ts)
      steps: [
        { label: 'rows-without-toggle', text: '', until: (screen) => screen.includes('Els · 2') && screen.includes('ELS_PANE_MARKER') && screen.includes('⇄herdr HERDR_WS'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` TUI «Els» section — 15 one-second list polls
      ],
      quitKeys: '\x11',
    });
    expect(run.exitCode).toBe(0);
    expect(run.frames[0]!.screen).toContain('Sessions · ');         // the list was open from the first frame: no Ctrl+\ was ever sent
    expect(run.frames.at(-1)!.screen).toContain('Els · 2');
  } finally {
    if (started && !('exitCode' in started)) await started.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
