import { describe, expect, test } from 'bun:test';
import { createCompactSurfaceRuntime } from '../src/dashboard/compact-surface-runtime.js';

describe('createCompactSurfaceRuntime', () => {
  test('builds compact-aware catalog targets', () => {
    const runtime = createCompactSurfaceRuntime({
      getClosedPanes: () => [{ pane: 'browser', label: 'Browser' }],
      getActiveViewLabel: () => 'Normal',
      getCompactMode: () => 'compact-tight',
      openDashboardPane: () => true,
      focusPane: () => {},
      openBrowserPreviewModal: () => {},
      openDashboardPaneModal: () => {},
      openCompanionPopup: () => {},
    });

    expect(runtime.buildTargets().map((item) => item.id)).toEqual([
      'reopen:browser',
      'pane:browser-preview',
      'pane:browser',
      'pane:preview',
      'pane:obsidian',
      'companion:clipboard',
      'companion:memo',
      'companion:detail',
    ]);
  });

  test('routes surface ids through the shared dispatch contract', () => {
    const calls: string[] = [];
    const runtime = createCompactSurfaceRuntime({
      getClosedPanes: () => [],
      getActiveViewLabel: () => 'Normal',
      getCompactMode: () => 'wide',
      openDashboardPane: (pane) => {
        calls.push(`reopen:${pane}`);
        return true;
      },
      focusPane: (pane) => calls.push(`focus:${pane}`),
      openBrowserPreviewModal: () => calls.push('pane:browser-preview'),
      openDashboardPaneModal: (pane) => calls.push(`pane:${pane}`),
      openCompanionPopup: (key) => calls.push(`companion:${key}`),
      onWarning: (message) => calls.push(`warn:${message}`),
    });

    runtime.openTarget('reopen:browser');
    runtime.openTarget('companion:memo');
    runtime.openTarget('vw-companion:detail');
    runtime.openTarget('vw:sim');
    runtime.openTarget('vw:preview');

    expect(calls).toEqual([
      'reopen:browser',
      'focus:browser',
      'companion:memo',
      'warn:unsupported dashboard surface: vw-companion:detail',
      'warn:unsupported dashboard surface: vw:sim',
      'warn:unsupported dashboard surface: vw:preview',
    ]);
  });
});
