import { describe, expect, test } from 'bun:test';

import { bootDashboardContextWindowRuntime } from '../src/dashboard/context-window-runtime-boot.js';

describe('bootDashboardContextWindowRuntime', () => {
  test('wires workspace and sessions without a virtual-window registry', () => {
    let installed: {
      cwd?: string;
      getTerminalSessions?: () => Array<{ id: string; title: string; state: string }>;
    } | undefined;
    bootDashboardContextWindowRuntime({
      setContextRuntimeDeps: (deps) => { installed = deps; },
      cwd: '/repo',
      getTerminalSessions: () => [{ id: 's1', title: 'Term', state: 'running' }],
    });

    expect(installed).toBeDefined();
    expect(installed).not.toHaveProperty('getWindowRegistry');
    expect(installed?.cwd).toBe('/repo');
    expect(installed?.getTerminalSessions?.()).toEqual([{ id: 's1', title: 'Term', state: 'running' }]);
  });
});
