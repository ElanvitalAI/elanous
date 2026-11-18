import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminal } from '@xterm/headless';
import { NEXT_TUI_TITLE } from '../core/render.js';
import { agentPtyState, withAgentStates } from './agent-state.js';
import { formatSidetabLines, type SidetabRow } from '../../sidetab-core/model.js';
import { setPtyManifestDbPathForTesting, updatePtyManifestSnapshot, updatePtyManifestTurn, upsertPtyManifest, type PtyManifestRow } from '../../pty-shell/pty-manifest.js';
import { bunSpawnPty, type MinimalPty } from '../../pty-shell/bun-native-pty.js';

const BIN = join(import.meta.dir, '..', '..', '..', 'bin', 'elanous.mjs');
// 출처: src/tui/sidetab/list.test.ts real Next TUI sidetab tests — boot and opening the sidetab fit in 30 s.
const SCREEN_TIMEOUT_MS = 30_000;

// Agent screens as codex / claude paint them (the herdr rules in src/capture/frame-state-detect.ts).
const SCREEN = {
  blocked: 'Allow command: rm -rf build?\n❯ 1. Yes\n  2. No, and tell me what to do\n',
  working: 'Editing src/app.ts\n⠋ Thinking (3s • esc to interrupt)\n',
  idle: 'Done editing.\n\n❯ \n',
  silent: 'some log output\nmore output\n',
} as const;

const manifestRow = (overrides: Partial<PtyManifestRow>): PtyManifestRow => ({
  id: 'pty:agent', kind: 'codex', cmd: 'codex', ownerPid: 101, ptyPid: 101, instance: 'project',
  startedAt: 10, alive: true, exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 10,
  frame: '', frameAt: 0, runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '',
  parentPid: 0, parentKind: '', closedAt: 0, codeSha: '', ...overrides,
});

describe('sidetab agent badge', () => {
  test('the agent state is the pty state verdict: screen rules folded with the written turn', () => {
    expect(agentPtyState(manifestRow({ snapshot: SCREEN.blocked }))).toBe('blocked');
    expect(agentPtyState(manifestRow({ snapshot: SCREEN.working }))).toBe('working');
    expect(agentPtyState(manifestRow({ snapshot: SCREEN.idle }))).toBe('idle');
    // A written busy turn wins over a bare prompt; a blocked screen stays blocked inside a busy turn.
    expect(agentPtyState(manifestRow({ snapshot: SCREEN.idle, turnState: 'busy', turnAt: 5 }))).toBe('working');
    expect(agentPtyState(manifestRow({ snapshot: SCREEN.blocked, turnState: 'busy', turnAt: 5 }))).toBe('blocked');
    // The frame is the fallback screen; no signal and no turn is unknown.
    expect(agentPtyState(manifestRow({ frame: SCREEN.working }))).toBe('working');
    expect(agentPtyState(manifestRow({ snapshot: SCREEN.silent }))).toBe('unknown');
  });

  test('only live agent rows with a known state carry it, and the row shows it in place of the process badge', () => {
    const rows: SidetabRow[] = [
      { id: 'pty:a', label: 'codex-a', kind: 'codex', badge: 'busy' },
      { id: 'pty:shell', label: 'shell', kind: 'shell', badge: 'busy' },
      { id: 'pty:gone', label: 'claude-gone', kind: 'claude', badge: 'exited' },
      { id: 'pty:quiet', label: 'agent-quiet', kind: 'agent', badge: 'idle' },
    ];
    const manifest = new Map([
      ['pty:a', manifestRow({ id: 'pty:a', snapshot: SCREEN.blocked })],
      ['pty:shell', manifestRow({ id: 'pty:shell', kind: 'shell', snapshot: SCREEN.blocked })],
      ['pty:gone', manifestRow({ id: 'pty:gone', snapshot: SCREEN.working, alive: false })],
      ['pty:quiet', manifestRow({ id: 'pty:quiet', snapshot: SCREEN.silent })],
    ]);
    const marked = withAgentStates(rows, manifest);
    expect(marked.map((row) => [row.id, row.agentState ?? null])).toEqual([
      ['pty:a', 'blocked'], ['pty:shell', null], ['pty:gone', null], ['pty:quiet', null]]);
    const lines = formatSidetabLines(marked, 0, 40);
    expect(lines.find((line) => line.includes('codex-a'))).toContain('› blocked codex-a');
    // Rows without an agent state keep the process badge as before.
    expect(lines.find((line) => line.includes('shell'))).toContain('busy shell');
    expect(lines.find((line) => line.includes('claude-gone'))).toContain('exited claude-gone');
    expect(lines.find((line) => line.includes('agent-quiet'))).toContain('idle agent-quiet');
  });

  test('real next TUI sidetab shows each agent PTY child with its state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'next-sidetab-agent-badge-'));
    const terminal = new Terminal({ rows: 24, cols: 100, scrollback: 0, allowProposedApi: true });
    const children: MinimalPty[] = [];
    const envKeys = ['ELANOUS_STATE_DIR', 'ELANOUS_STATE_DIR_SOURCE', 'ELANOUS_SESSION_ROOT'] as const;
    const savedEnv = Object.fromEntries(envKeys.map((name) => [name, process.env[name]]));
    const env = {
      PATH: process.env.PATH ?? '', HOME: root, TERM: 'xterm-256color', LANG: 'C.UTF-8',
      USER: process.env.USER ?? 'sidetab-test', LOGNAME: process.env.LOGNAME ?? 'sidetab-test',
      XDG_CONFIG_HOME: join(root, '.config'), XDG_DATA_HOME: join(root, '.local', 'share'),
      XDG_CACHE_HOME: join(root, '.cache'), ELANOUS_STATE_DIR: root, ELANOUS_STATE_DIR_SOURCE: 'explicit',
      ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_SKIP_LOGIN_ENV: '1',
      ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
    };
    const readScreen = () => Array.from({ length: 24 }, (_, row) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString(true) ?? '').join('\n');
    let app: MinimalPty | undefined;
    let appData: { dispose(): void } | undefined;
    let appExit: { dispose(): void } | undefined;
    let exitCode: number | null = null;
    let outputPending = Promise.resolve();
    let lastScreen = '';
    const waitForScreen = async (predicate: (screen: string) => boolean, label: string, timeoutMs = SCREEN_TIMEOUT_MS) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await outputPending;
        lastScreen = readScreen();
        if (predicate(lastScreen)) return lastScreen;
        if (exitCode !== null) throw new Error(`next TUI exited (${exitCode}) before ${label}\n${lastScreen}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`timed out waiting for ${label}\n${lastScreen}`);
    };
    try {
      process.env.ELANOUS_STATE_DIR = root;
      process.env.ELANOUS_STATE_DIR_SOURCE = 'explicit';
      process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
      writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
      setPtyManifestDbPathForTesting(join(root, 'pty', 'manifest.db'));
      app = bunSpawnPty(process.execPath, [BIN, '--config-dir', root, '--test-state-dir', root, '--tui', 'next'], {
        name: 'xterm-256color', cols: 100, rows: 24, cwd: root, env,
      });
      appData = app.onData((chunk) => {
        outputPending = outputPending.then(() => new Promise<void>((resolve) => terminal.write(chunk, resolve)));
      });
      appExit = app.onExit(({ exitCode: code }) => { exitCode = code; });
      await waitForScreen((screen) => screen.split('\n').includes(NEXT_TUI_TITLE) && screen.includes('❯'), 'next TUI ready');

      // Two agent children of this TUI: one waiting on a permission choice, one mid-turn.
      const now = Date.now();
      for (const [id, label, screen, turn] of [
        ['pty:83001', 'codex-asks', SCREEN.blocked, 'busy'],
        ['pty:83002', 'claude-runs', SCREEN.working, 'busy'],
      ] as const) {
        const child = bunSpawnPty(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          name: 'xterm-256color', cols: 80, rows: 24, cwd: root, env: { PATH: env.PATH, HOME: root, TERM: 'xterm-256color' },
        });
        children.push(child);
        upsertPtyManifest({ id, kind: label.startsWith('codex') ? 'codex' : 'claude', cmd: label, purpose: label,
          startedAt: now, now, ptyPid: child.pid, identity: { parentPtyId: `tui:${app.pid}`, parentPid: app.pid } });
        expect(updatePtyManifestSnapshot(id, () => screen, now)).toBe(true);
        updatePtyManifestTurn(id, turn, now);
      }

      app.write('\x1c');
      const opened = await waitForScreen((screen) => screen.includes('codex-asks') && screen.includes('claude-runs'), 'sidetab with both agents');
      expect(opened.split('\n').find((row) => row.includes('codex-asks'))).toMatch(/blocked codex-asks/u);
      expect(opened.split('\n').find((row) => row.includes('claude-runs'))).toMatch(/working claude-runs/u);

      // The agent answers and goes back to its prompt: the badge follows the screen on the next refresh.
      expect(updatePtyManifestSnapshot('pty:83001', () => SCREEN.idle, now + 2_000)).toBe(true);
      updatePtyManifestTurn('pty:83001', 'idle', now + 2_000);
      await waitForScreen((screen) => /idle codex-asks/u.test(screen), 'badge follows the agent', 15_000);

      app.write('\x11');
      await waitForScreen(() => exitCode !== null, 'next TUI exit', 10_000);
    } finally {
      try { app?.kill(); } catch { /* already exited */ }
      appData?.dispose();
      appExit?.dispose();
      for (const child of children) { try { child.kill(); } catch { /* already exited */ } }
      setPtyManifestDbPathForTesting(null);
      terminal.dispose();
      for (const name of envKeys) {
        const value = savedEnv[name];
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
