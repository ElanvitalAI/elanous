import { describe, expect, test } from 'bun:test';

import { buildDashboardOptionalToolSpecs } from '../src/dashboard/optional-tool-spec-runtime.js';

describe('buildDashboardOptionalToolSpecs', () => {
  test('builds enabled dashboard tool specs and wires terminal modal deps', () => {
    const events: string[] = [];
    const specs = buildDashboardOptionalToolSpecs({
      userConfig: {
        shell: {
          allowDashboardPty: true,
          allowDashboardBash: true,
          allowDashboardTerminalInject: true,
          allowDashboardApiCall: true,
          allowDashboardRunShell: true,
        },
      } as any,
      ptyAvailable: true,
      termSize: () => ({ cols: 120, rows: 40 }),
      registerAllDefaultToolRuntimes: () => { events.push('register'); },
      setTerminalModalRuntimeDeps: (deps) => {
        const size = deps.termSize();
        events.push(`term:${size.cols}x${size.rows}`);
      },
      buildBashTool: () => ({ name: 'bash' } as any),
      buildTerminalInjectTool: () => ({ name: 'inject' } as any),
      buildApiCallTool: () => ({ name: 'api' } as any),
      buildRunShellTool: () => ({ name: 'run-shell' } as any),
      buildDashboardStateTool: () => ({ name: 'state' } as any),
      buildTerminalModalTools: () => [{ name: 'tm-list' } as any, { name: 'tm-kill' } as any],
    });

    expect(events).toEqual(['register', 'term:120x40']);
    expect(specs.map((spec: any) => spec.name)).toEqual([
      'bash',
      'inject',
      'api',
      'run-shell',
      'state',
      'tm-list',
      'tm-kill',
    ]);
  });

  test('skips gated specs when features are disabled (DashboardState is always on)', () => {
    const specs = buildDashboardOptionalToolSpecs({
      userConfig: {
        shell: {
          allowDashboardPty: false,
          allowDashboardBash: false,
          allowDashboardTerminalInject: false,
          allowDashboardApiCall: false,
          allowDashboardRunShell: false,
        },
      } as any,
      ptyAvailable: false,
      termSize: () => ({ cols: 80, rows: 24 }),
      registerAllDefaultToolRuntimes: () => {},
      setTerminalModalRuntimeDeps: () => {},
      buildBashTool: () => ({ name: 'bash' } as any),
      buildTerminalInjectTool: () => ({ name: 'inject' } as any),
      buildApiCallTool: () => ({ name: 'api' } as any),
      buildRunShellTool: () => ({ name: 'run-shell' } as any),
      buildDashboardStateTool: () => ({ name: 'state' } as any),
      buildTerminalModalTools: () => [{ name: 'tm-list' } as any],
    });

    expect(specs.map((spec: any) => spec.name)).toEqual(['state', 'tm-list']);
  });
});
