// ── Dashboard state snapshot tests ──

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  captureDashboardState, renderDashboardStateForSystemPrompt,
} from '../src/dashboard/runtime/state-snapshot';
import { resolveTerminalInteractionPolicy } from '../src/dashboard/terminal-exposure';
import {
  setPtyAdapterForTesting, resetForTesting, startPty,
} from '../src/pty-shell/registry';

type FakePty = {
  pid: number;
  write: (s: string) => void;
  kill: (signal?: string) => void;
  onData: (cb: (d: string) => void) => { dispose: () => void };
  onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => { dispose: () => void };
};

function installFakeAdapter(): void {
  setPtyAdapterForTesting(() => {
    let onData: ((d: string) => void) | null = null;
    let onExit: ((e: { exitCode: number; signal?: number }) => void) | null = null;
    const fake: FakePty = {
      pid: Math.floor(Math.random() * 1e6),
      write: () => {},
      kill: () => { onExit?.({ exitCode: 0 }); },
      onData(cb) { onData = cb; return { dispose: () => { onData = null; } }; },
      onExit(cb) { onExit = cb; return { dispose: () => { onExit = null; } }; },
    };
    // unused locals to satisfy tsc:
    void onData; void onExit;
    return fake;
  });
}

describe('captureDashboardState', () => {
  beforeEach(() => {
    resetForTesting();
    installFakeAdapter();
  });
  afterEach(() => {
    resetForTesting();
    setPtyAdapterForTesting(null);
  });

  test('returns empty-lists snapshot when nothing is running', () => {
    const s = captureDashboardState({ cwd: '/tmp/foo' });
    expect(s).not.toHaveProperty('windows');
    expect(s.ptys).toEqual([]);
    expect(s.terminalSessions).toEqual([]);
    expect(s.recentTerminalMouseIntents).toEqual([]);
    expect(s.workspace.cwd).toBe('/tmp/foo');
    expect(s.workspace.platform).toBe(process.platform);
    expect(typeof s.capturedAt).toBe('string');
  });

  test('pty list reflects live + detach flags', () => {
    const h1 = startPty({ cmd: 'sleep 1' });
    const h2 = startPty({ cmd: 'sleep 2', detach: true });
    const s = captureDashboardState({ cwd: '/tmp' });
    expect(s.ptys).toHaveLength(2);
    const ids = s.ptys.map(p => p.id);
    expect(ids).toContain(h1.id);
    expect(ids).toContain(h2.id);
    expect(s.ptys.find(p => p.id === h2.id)?.detach).toBe(true);
    expect(s.ptys.find(p => p.id === h1.id)?.detach).toBe(false);
  });

  test('tool-names + terminal-sessions flow through from deps', () => {
    const s = captureDashboardState({
      cwd: '/tmp',
      terminalSessions: [
        {
          id: 'sess_1',
          title: 'claude-code',
          state: 'foreground',
          exposure: { userExposure: 'user-interactive', agentInteractive: true },
        },
        {
          id: 'sess_2',
          title: 'codex',
          state: 'background',
          exposure: { userExposure: 'hidden', agentInteractive: true },
        },
      ],
      recentTerminalMouseIntents: [
        {
          surfaceId: 'pane:1',
          paneKind: 'terminal',
          mouseType: 'double-click',
          hostInterpretation: 'word-select',
          row: 12,
          col: 34,
          transport: 'host-only',
          exposure: { userExposure: 'user-interactive', agentInteractive: true },
          interactionPolicy: resolveTerminalInteractionPolicy({
            userExposure: 'user-interactive',
            agentInteractive: true,
          }),
        },
      ],
      dashboardToolNames: ['PtyShellList', 'GetDashboardState'],
    });
    expect(s.terminalSessions).toHaveLength(2);
    expect(s.recentTerminalMouseIntents).toHaveLength(1);
    expect(s.tools.dashboardTools).toEqual(['PtyShellList', 'GetDashboardState']);
  });

  test('captures remote workspace label', () => {
    const s = captureDashboardState({ cwd: '/home/me', remoteHost: 'bastion' });
    expect(s.workspace.remoteHost).toBe('bastion');
  });

});

describe('renderDashboardStateForSystemPrompt', () => {
  beforeEach(() => {
    resetForTesting();
    installFakeAdapter();
  });
  afterEach(() => {
    resetForTesting();
    setPtyAdapterForTesting(null);
  });

  test('header + workspace + empty sections when nothing active', () => {
    const s = captureDashboardState({ cwd: '/tmp' });
    const text = renderDashboardStateForSystemPrompt(s);
    expect(text).toContain('# monad-agent state');
    expect(text).toContain('workspace: cwd=/tmp');
    expect(text).not.toContain('virtual windows:');
    expect(text).not.toContain('pty shells:');
    expect(text).not.toContain('terminal sessions:');
  });

  test('includes pty lines when shells are running', () => {
    const h = startPty({ cmd: 'sleep 99' });
    const s = captureDashboardState({ cwd: '/tmp' });
    const text = renderDashboardStateForSystemPrompt(s);
    expect(text).toContain('pty shells: 1');
    expect(text).toContain(h.id);
    expect(text).toContain('running');
    resetForTesting();
  });

  test('includes tool list when supplied', () => {
    const s = captureDashboardState({
      cwd: '/tmp',
      dashboardToolNames: ['PtyShellStart', 'GetDashboardState'],
    });
    const text = renderDashboardStateForSystemPrompt(s);
    expect(text).toContain('tools exposed this turn: PtyShellStart, GetDashboardState');
  });

  test('includes terminal mouse intents when supplied', () => {
    const s = captureDashboardState({
      cwd: '/tmp',
      recentTerminalMouseIntents: [
        {
          surfaceId: 'wd-preview',
          paneKind: 'preview-terminal',
          mouseType: 'double-click',
          hostInterpretation: 'word-select',
          row: 7,
          col: 18,
          transport: 'host-only',
          exposure: { userExposure: 'user-interactive', agentInteractive: true },
          interactionPolicy: resolveTerminalInteractionPolicy({
            userExposure: 'user-interactive',
            agentInteractive: true,
          }),
        },
      ],
    });
    const text = renderDashboardStateForSystemPrompt(s);
    expect(text).toContain('terminal mouse intents: 1');
    expect(text).toContain('preview-terminal double-click @7,18 host-only surface=wd-preview host=word-select user=user-interactive');
  });

  test('includes terminal exposure when supplied', () => {
    const s = captureDashboardState({
      cwd: '/tmp',
      terminalSessions: [
        {
          id: 'sess_1',
          title: 'claude-code',
          state: 'background',
          exposure: { userExposure: 'hidden', agentInteractive: true },
        },
      ],
    });
    const text = renderDashboardStateForSystemPrompt(s);
    expect(text).toContain('sess_1 state=background user=hidden agent=interactive');
  });

  test('truncates long cmds in pty lines', () => {
    const longCmd = 'x'.repeat(200);
    // The test spawns via our fake adapter — the cmd property is
    // preserved verbatim on the handle.
    const h = startPty({ cmd: longCmd });
    const s = captureDashboardState({ cwd: '/tmp' });
    const text = renderDashboardStateForSystemPrompt(s);
    expect(text).toContain('…');
    expect(text).not.toContain(longCmd);
    expect(h.cmd.length).toBe(200);
    resetForTesting();
  });
});
