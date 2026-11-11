import { expect, test } from 'bun:test';
import { renderDashboardStateForSystemPrompt, type DashboardStateSnapshot } from './dashboard-state-snapshot.js';

test('dashboard state prompt preserves the compact current-state summary', () => {
  const snapshot: DashboardStateSnapshot = {
    capturedAt: '2026-11-11T12:00:00.000Z',
    workspace: { cwd: '/work/seat', remoteHost: 'node-b', platform: 'linux' },
    ptys: [{ id: 'pty-1', cmd: 'bun run dev', status: 'running', exitCode: null, ageSec: 61, detach: true }],
    tools: { dashboardTools: ['Read', 'Write'] },
    terminalSessions: [{ id: 'term-1', title: 'shell', state: 'running', exposure: { userExposure: 'observe-only', agentInteractive: false } }],
    recentTerminalMouseIntents: [],
  };

  expect(renderDashboardStateForSystemPrompt(snapshot)).toBe([
    '# monad-agent state (captured 2026-11-11T12:00:00.000Z)',
    'workspace: cwd=/work/seat remote=node-b platform=linux',
    'tools exposed this turn: Read, Write',
    'pty shells: 1',
    '  pty-1 running age=1m1s detach cmd="bun run dev"',
    'terminal sessions: 1',
    '  term-1 state=running user=observe-only agent=off title="shell"',
  ].join('\n'));
});
