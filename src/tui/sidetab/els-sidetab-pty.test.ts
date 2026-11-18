import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
