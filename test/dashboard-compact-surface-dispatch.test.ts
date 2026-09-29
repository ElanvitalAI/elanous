import { describe, expect, test } from 'bun:test';

import { dispatchDashboardSurfaceCatalogAction } from '../src/dashboard/compact-surface-dispatch.js';

function mkDeps() {
  const events: string[] = [];
  const warnings: string[] = [];
  return {
    events,
    warnings,
    deps: {
      openDashboardPane: (pane: string) => {
        events.push(`reopen:${pane}`);
        return pane !== 'log';
      },
      focusPane: (pane: string) => { events.push(`focus:${pane}`); },
      openBrowserPreviewModal: () => { events.push('browser-preview'); },
      openDashboardPaneModal: (pane: string) => { events.push(`pane:${pane}`); },
      openCompanionPopup: (key: 'clipboard' | 'memo' | 'detail') => { events.push(`companion:${key}`); },
      onWarning: (message: string) => { warnings.push(message); },
    },
  };
}

describe('dispatchDashboardSurfaceCatalogAction', () => {
  test('reopens and focuses a closed pane', () => {
    const h = mkDeps();
    dispatchDashboardSurfaceCatalogAction('reopen:preview', h.deps);
    expect(h.events).toEqual(['reopen:preview', 'focus:preview']);
  });

  test('warns when reopen fails', () => {
    const h = mkDeps();
    dispatchDashboardSurfaceCatalogAction('reopen:log', h.deps);
    expect(h.warnings).toEqual(['could not reopen pane: log']);
  });

  test('routes pane and companion actions', () => {
    const h = mkDeps();
    dispatchDashboardSurfaceCatalogAction('pane:obsidian', h.deps);
    dispatchDashboardSurfaceCatalogAction('companion:memo', h.deps);
    dispatchDashboardSurfaceCatalogAction('pane:browser-preview', h.deps);
    expect(h.events).toEqual(['pane:obsidian', 'companion:memo', 'browser-preview']);
  });

  test('routes virtual window actions and vw companion actions', () => {
    const h = mkDeps();
    dispatchDashboardSurfaceCatalogAction('vw:preview', h.deps);
    dispatchDashboardSurfaceCatalogAction('vw:sim', h.deps);
    dispatchDashboardSurfaceCatalogAction('vw-companion:detail', h.deps);
    expect(h.events).toEqual([]);
    expect(h.warnings).toEqual([
      'unsupported dashboard surface: vw:preview',
      'unsupported dashboard surface: vw:sim',
      'unsupported dashboard surface: vw-companion:detail',
    ]);
  });

  test('warns when vw companion has no foreground window', () => {
    const h = mkDeps();
    dispatchDashboardSurfaceCatalogAction('vw-companion:clipboard', h.deps);
    expect(h.warnings).toEqual(['unsupported dashboard surface: vw-companion:clipboard']);
  });
});
