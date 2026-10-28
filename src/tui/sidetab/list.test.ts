import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as listCompatibility from './list.js';
import { applySidetabKey, createSidetabState, formatSidetabLines, loadSidetabRows, sidetabRowIndexAtTerminalRow, sidetabRowsFromManifest, sidetabWidthForTerminal, type SidetabRow } from '../../sidetab-core/model.js';
import { setPtyManifestDbPathForTesting, updatePtyManifestSession, upsertPtyManifest, type PtyManifestRow } from '../../pty-shell/pty-manifest.js';
import { mockSeatPtySequence } from '../../ux-sim/mock-seat-pty-sequence.js';
import { appendMessage, createSession } from '../../session/index.js';

const BIN = join(import.meta.dir, '..', '..', '..', 'bin', 'elanous.mjs');

const manifestRow = (overrides: Partial<PtyManifestRow>): PtyManifestRow => ({
  id: 'tui:101', kind: 'tui', cmd: 'elanous', ownerPid: 101, ptyPid: 101, instance: 'project',
  startedAt: 10, alive: true, exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 10,
  frame: '', frameAt: 0, runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '',
  parentPid: 0, parentKind: '', closedAt: 0, codeSha: '', ...overrides,
});

describe('next TUI sidetab', () => {
  test('legacy list entry point re-exports the shared model', () => {
    expect(listCompatibility.applySidetabKey).toBe(applySidetabKey);
    expect(listCompatibility.loadSidetabRows).toBe(loadSidetabRows);
    expect(listCompatibility.formatSidetabLines).toBe(formatSidetabLines);
  });

  test('toggle opens and closes without changing selection', () => {
    const closed = createSidetabState();
    const opened = applySidetabKey(closed, 'toggle', 2);
    expect(opened).toEqual({ open: true, selected: 0 });
    expect(applySidetabKey(opened, 'toggle', 2)).toEqual(closed);
  });

  test('up/down selection wraps and is inert while closed or empty', () => {
    const open = { open: true, selected: 0 };
    expect(applySidetabKey(open, 'up', 3).selected).toBe(2);
    expect(applySidetabKey(open, 'down', 3).selected).toBe(1);
    expect(applySidetabKey(createSidetabState(), 'down', 3)).toEqual(createSidetabState());
    expect(applySidetabKey(open, 'down', 0)).toEqual(open);
  });

  test('keeps at least 20 columns for chat beside the panel', () => {
    expect(sidetabWidthForTerminal(33)).toBe(0);
    expect(sidetabWidthForTerminal(34)).toBe(12);
    expect(sidetabWidthForTerminal(80)).toBe(26);
    expect(sidetabWidthForTerminal(120)).toBe(28);
  });

  test('maps mouse row coordinates through the same viewport scroll as the rendered list', () => {
    expect(sidetabRowIndexAtTerminalRow(4, 0, 23, 2)).toBeNull();
    expect(sidetabRowIndexAtTerminalRow(4, 0, 23, 3)).toBe(0);
    expect(sidetabRowIndexAtTerminalRow(4, 0, 23, 6)).toBe(3);
    expect(sidetabRowIndexAtTerminalRow(10, 8, 7, 5)).toBe(7);
    expect(sidetabRowIndexAtTerminalRow(0, 0, 23, 3)).toBeNull();
  });

  test('lists this instance TUI sessions with state badges and omits rows without a session', () => {
    const rows = sidetabRowsFromManifest([
      manifestRow({ id: 'tui:101', sessionId: 'session-101', build: { version: '1', sha: 'abc', source: 'installed' }, turnState: 'busy' }),
      manifestRow({ id: 'tui:102', sessionId: '', kind: 'tui', cmd: 'elanous', turnState: 'idle' }),
      manifestRow({ id: 'tui:201', sessionId: 'session-201', instance: 'other', build: { version: '1', sha: 'abc', source: 'installed' } }),
      manifestRow({ id: 'pty:202', kind: 'shell', cmd: 'unrelated', parentPtyId: '', instance: 'project' }),
    ], 'project', (row) => ({ turn: row.id === 'tui:101' ? 'busy' : 'idle', stale: row.id === 'tui:101' }));

    expect(rows.map(({ id, sessionId, badge }) => [id, sessionId, badge])).toEqual([
      ['tui:101', 'session-101', 'stale'],
    ]);
  });

  test('marks the current TUI process row so sidetab kill can refuse it', () => {
    const rows = sidetabRowsFromManifest([
      manifestRow({ id: `tui:${process.pid}`, kind: 'tui', ownerPid: process.pid, ptyPid: process.pid, sessionId: 'current-session' }),
    ], 'project');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.currentProcess).toBe(true);
  });

  test('defaults to the current TUI and its live PTY descendants; all includes other and exited rows', () => {
    const rows = [
      manifestRow({ id: 'tui:500', ownerPid: 500, ptyPid: 501, sessionId: 'current-session' }),
      manifestRow({ id: 'tui:400', ownerPid: 400, ptyPid: 401, sessionId: 'exited-session', alive: false }),
      manifestRow({ id: 'tui:600', ownerPid: 600, ptyPid: 601, sessionId: 'other-session' }),
      manifestRow({ id: 'pty:child', kind: 'shell', ownerPid: 700, ptyPid: 701, parentPtyId: 'tui:500', parentPid: 500 }),
      manifestRow({ id: 'pty:grandchild', kind: 'agent', ownerPid: 800, ptyPid: 801, parentPtyId: 'pty:child', parentPid: 700 }),
      manifestRow({ id: 'pty:other', kind: 'shell', ownerPid: 900, ptyPid: 901, parentPtyId: 'tui:600', parentPid: 600 }),
      manifestRow({ id: 'pty:exited', kind: 'shell', ownerPid: 910, ptyPid: 911, parentPtyId: 'tui:500', parentPid: 500, alive: false }),
    ];
    const defaultRows = sidetabRowsFromManifest(rows, 'project', undefined, { currentPtyId: 'tui:500', currentPid: 500 });
    expect(defaultRows.map(({ id }) => id)).toEqual(['tui:500', 'pty:child', 'pty:grandchild']);
    const allRows = sidetabRowsFromManifest(rows, 'project', undefined, { all: true, currentPtyId: 'tui:500', currentPid: 500 });
    expect(allRows.map(({ id }) => id)).toEqual(rows.map(({ id }) => id));
    expect(allRows.find(({ id }) => id === 'pty:exited')?.badge).toBe('exited');
  });

  test('includes only the classic shell bound to the current session and parent process', () => {
    const rows = sidetabRowsFromManifest([
      manifestRow({ id: 'shell:own', kind: 'shell', ownerPid: 700, ptyPid: 701, parentPid: 500, purpose: 'tui-shell:unknown:session:session-a:terminal:term-one' }),
      manifestRow({ id: 'shell:other-session', kind: 'shell', ownerPid: 710, ptyPid: 711, parentPid: 500, purpose: 'tui-shell:unknown:session:session-b:terminal:term-two' }),
      manifestRow({ id: 'shell:other-parent', kind: 'shell', ownerPid: 720, ptyPid: 721, parentPid: 600, purpose: 'tui-shell:unknown:session:session-a:terminal:term-three' }),
    ], 'project', undefined, { currentPid: 500, currentSessionId: 'session-a' });

    expect(rows.map(({ id, sessionId }) => [id, sessionId])).toEqual([['shell:own', 'term-one']]);
  });

  test('formats selected row and keeps labels inside the panel width', () => {
    const rows: SidetabRow[] = [{ id: 'tui:1', sessionId: 'session-1', label: 'very long agent label', kind: 'tui', badge: 'stale' }];
    const lines = formatSidetabLines(rows, 0, 12);
    expect(lines[2]).toBe(' › stale ve…');
    expect(lines.every((line) => Bun.stringWidth(line) === 12)).toBe(true);
  });

  test('scrolls a selected row into the available panel height', () => {
    const rows: SidetabRow[] = Array.from({ length: 8 }, (_, index) => ({
      id: `pty:${index}`, label: `agent-${index}`, kind: 'agent', badge: 'idle',
    }));
    const lines = formatSidetabLines(rows, 7, 16, 5);
    expect(lines).toHaveLength(5);
    expect(lines.at(-2)).toContain('› idle agent-7');
    expect(lines.at(-1)).toContain('+ new');
    expect(lines.every((line) => Bun.stringWidth(line) === 16)).toBe(true);
  });

  test('shows the four new PTY character choices without overflowing', () => {
    const lines = formatSidetabLines([], 0, 16, 4, 'new');
    expect(lines).toEqual([' 새 PTY         ', ' s shell · e el…', ' c codex · l cl…']);
  });

  test('real next TUI shows two isolated PTY children and restores the closed chat frame', async () => {
    const root = mkdtempSync(join(tmpdir(), 'next-sidetab-'));
    const envKeys = ['ELANOUS_STATE_DIR', 'ELANOUS_STATE_DIR_SOURCE', 'ELANOUS_SESSION_ROOT'] as const;
    const savedEnv = Object.fromEntries(envKeys.map((name) => [name, process.env[name]]));
    try {
      process.env.ELANOUS_STATE_DIR = root;
      process.env.ELANOUS_STATE_DIR_SOURCE = 'explicit';
      process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
      setPtyManifestDbPathForTesting(join(root, 'pty', 'manifest.db'));
      writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
      const now = Date.now();
      const otherSession = createSession({ source: 'tui' });
      appendMessage(otherSession.id, { role: 'user', content: 'SIDETAB_TARGET_SESSION_MARKER', ts: new Date(now).toISOString() });
      upsertPtyManifest({ id: 'tui:81000', kind: 'tui', cmd: 'elanous', purpose: 'other-session', startedAt: now - 1_000, now });
      expect(updatePtyManifestSession('tui:81000', otherSession.id, now)).toBe(true);
      const secondSession = createSession({ source: 'tui' });
      appendMessage(secondSession.id, { role: 'user', content: 'SIDETAB_SECOND_SESSION_MARKER', ts: new Date(now).toISOString() });
      upsertPtyManifest({ id: 'tui:81001', kind: 'tui', cmd: 'elanous', purpose: 'second-session', startedAt: now - 500, now });
      expect(updatePtyManifestSession('tui:81001', secondSession.id, now)).toBe(true);

      const run = await mockSeatPtySequence({
        executable: process.execPath,
        args: [BIN, '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
        root,
        rows: 24,
        cols: 80,
        env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1' },
        ready: { label: 'chat-before-toggle', timeoutMs: 30_000, until: (screen) => {
          const ready = screen.includes('elanous next ·') && screen.includes('Ctrl+Q 종료');
          return ready;
        } },
        steps: [
          { label: 'sidetab-open-ctrl-backslash-default-scope', keys: '\x1c', until: (screen) => screen.includes('+ new') },
          { label: 'sidetab-toggle-all-sessions', text: '/side all\r', until: (screen) => screen.includes('other-session') },
          { label: 'sidetab-focus-list', keys: '\x1cs', until: (screen) => screen.includes('사이드탭 포커스') },
          { label: 'sidetab-focus-escape-to-input', keys: '\x1b', until: (screen) => screen.includes('입력 포커스') },
          { label: 'sidetab-prefix-return-parent', keys: '\x1cp', until: (screen) => screen.includes('부모 채팅') },
          { label: 'sidetab-prefix-ordinal-two', keys: '\x1c2', until: (screen) => screen.includes('SIDETAB_SECOND_SESSION_MARKER') },
          { label: 'sidetab-click-session-row', keys: '\x1b[<0;5;3M', until: (screen) => screen.includes('SIDETAB_TARGET_SESSION_MARKER') },
          { label: 'sidetab-closed-ctrl-backslash', keys: '\x1c', until: (screen) => screen.includes('SIDETAB_TARGET_SESSION_MARKER') && !screen.includes('│') },
          { label: 'sidetab-open-slash-alias', text: '/side', until: (screen) => screen.includes('other-session') },
          { label: 'sidetab-closed-slash-alias', text: '/side', until: (screen) => screen.includes('SIDETAB_TARGET_SESSION_MARKER') && !screen.includes('│') },
        ],
        quitKeys: '\x11',
      });
      expect(run.frames[1]?.screen).not.toContain('other-session');
      expect(run.frames[1]?.screen.split('\n')).not.toContain('──');
      expect(run.frames[2]?.screen).toContain('other-session');
      expect(run.frames[3]?.screen).toContain('사이드탭 포커스');
      expect(run.frames[4]?.screen).toContain('입력 포커스');
      expect(run.frames[5]?.screen).toContain('부모 채팅');
      expect(run.frames[6]?.screen).toContain('SIDETAB_SECOND_SESSION_MARKER');
      expect(run.frames[7]?.screen).toContain('SIDETAB_TARGET_SESSION_MARKER');
      expect(run.frames[8]?.screen).toContain('SIDETAB_TARGET_SESSION_MARKER');
      expect(run.frames[9]?.screen).toContain('other-session');
      expect(run.frames[10]?.screen).toContain('SIDETAB_TARGET_SESSION_MARKER');
      expect(run.exitCode).toBe(0);
    } finally {
      setPtyManifestDbPathForTesting(null);
      for (const name of envKeys) {
        const value = savedEnv[name];
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test('next TUI creates, detaches, reattaches, and kills a sidebar shell session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'next-sidetab-attach-'));
    try {
      writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
      const run = await mockSeatPtySequence({
        executable: process.execPath,
        args: [BIN, '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
        root,
        rows: 24,
        cols: 80,
        env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1' },
        ready: { label: 'chat-ready', timeoutMs: 30_000, until: (screen) => screen.includes('elanous next ·') },
        steps: [
          { label: 'open-sidetab', keys: '\x1c', timeoutMs: 15_000, until: (screen) => screen.includes('↑↓ 전환') && screen.includes('+ new') },
          { label: 'shortcut-letters-remain-prompt-text', keys: 'nx', timeoutMs: 15_000, until: (screen) => screen.includes('❯ nx') },
          { label: 'clear-prompt', keys: '\x15', timeoutMs: 15_000, until: (screen) => screen.includes('❯ ') && !screen.includes('❯ nx') },
          { label: 'open-new-menu', keys: '/side new\r', timeoutMs: 15_000, until: (screen) => screen.includes('새 PTY') },
          { label: 'spawn-shell', keys: 's', timeoutMs: 15_000, until: (screen) => screen.includes('shell ─') },
          { label: 'detach-shell', keys: '\x1cd', timeoutMs: 15_000, until: (screen) => screen.includes('PTY 분리됨') && screen.includes('shell · Next T') },
          { label: 'attach-shell', keys: '\x1b[B\r', timeoutMs: 15_000, until: (screen) => screen.includes('shell ─') },
          { label: 'detach-shell-again', keys: '\x1cd', timeoutMs: 15_000, until: (screen) => screen.includes('PTY 분리됨') && screen.includes('shell · Next T') && !screen.includes('╭') },
          { label: 'kill-shell', keys: '/side kill\r', timeoutMs: 15_000, until: (screen) => screen.includes('종료 요청 완료') },
        ],
        quitKeys: '\x11',
      });
      expect(run.frames.some((frame) => frame.label === 'spawn-shell' && frame.screen.includes('shell'))).toBe(true);
      expect(run.frames.some((frame) => frame.label === 'detach-shell' && frame.screen.includes('shell · Next T'))).toBe(true);
      expect(run.frames.some((frame) => frame.label === 'attach-shell' && frame.screen.includes('shell'))).toBe(true);
      expect(run.frames.some((frame) => frame.label === 'kill-shell' && frame.screen.includes('종료 요청 완료'))).toBe(true);
      expect(run.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
