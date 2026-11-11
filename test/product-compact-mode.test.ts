import { describe, expect, test } from 'bun:test';
import {
  autoTabletModeForViewport,
  buildDockLauncherItemsForCompactMode,
  effectiveChatOnlyModeForViewport,
  orderDashboardViewsForCompactMode,
  orderSurfaceCatalogForCompactMode,
  pruneDashboardViewsForCompactMode,
  pruneSurfaceCatalogForCompactMode,
  productCompactModeForViewport,
} from '../src/views/product-compact-mode.js';

describe('productCompactModeForViewport', () => {
  test('classifies >132 cols as wide', () => {
    expect(productCompactModeForViewport({ cols: 133, rows: 30 })).toBe('wide');
  });

  test('classifies 111..132 cols as compact', () => {
    expect(productCompactModeForViewport({ cols: 132, rows: 30 })).toBe('compact');
    expect(productCompactModeForViewport({ cols: 111, rows: 30 })).toBe('compact');
  });

  test('classifies <=110 cols as compact-tight', () => {
    expect(productCompactModeForViewport({ cols: 110, rows: 30 })).toBe('compact-tight');
    expect(productCompactModeForViewport({ cols: 80, rows: 30 })).toBe('compact-tight');
  });
});

describe('autoTabletModeForViewport', () => {
  test('auto tablet mode only fires for compact-tight', () => {
    expect(autoTabletModeForViewport({ cols: 132, rows: 30 })).toBe(false);
    expect(autoTabletModeForViewport({ cols: 111, rows: 30 })).toBe(false);
    expect(autoTabletModeForViewport({ cols: 110, rows: 30 })).toBe(true);
  });
});

describe('effectiveChatOnlyModeForViewport', () => {
  test('forces chat-only on compact-tight even when manual mode is off', () => {
    expect(effectiveChatOnlyModeForViewport({ cols: 110, rows: 30 }, false)).toBe(true);
  });

  test('keeps wide/compact off unless manual mode is on', () => {
    expect(effectiveChatOnlyModeForViewport({ cols: 132, rows: 30 }, false)).toBe(false);
    expect(effectiveChatOnlyModeForViewport({ cols: 140, rows: 30 }, false)).toBe(false);
    expect(effectiveChatOnlyModeForViewport({ cols: 140, rows: 30 }, true)).toBe(true);
  });
});

describe('pruneSurfaceCatalogForCompactMode', () => {
  const catalog = [
    { id: 'pane:browser' },
    { id: 'reopen:preview' },
    { id: 'pane:obsidian' },
    { id: 'pane:skill-browser' },
    { id: 'companion:clipboard' },
    { id: 'vw:sim' },
    { id: 'vw-companion:detail' },
  ];

  test('keeps the full catalog for wide and compact', () => {
    expect(pruneSurfaceCatalogForCompactMode(catalog, 'wide')).toEqual(catalog);
    expect(pruneSurfaceCatalogForCompactMode(catalog, 'compact')).toEqual(catalog);
  });

  test('reduces compact-tight to the tablet-safe shortlist', () => {
    expect(pruneSurfaceCatalogForCompactMode(catalog, 'compact-tight')).toEqual([
      { id: 'pane:browser' },
      { id: 'reopen:preview' },
      { id: 'pane:obsidian' },
      { id: 'companion:clipboard' },
      { id: 'vw:sim' },
    ]);
  });
});

describe('orderSurfaceCatalogForCompactMode', () => {
  const catalog = [
    { id: 'reopen:preview', group: 'Current View' },
    { id: 'pane:preview', group: 'Panes' },
    { id: 'pane:browser', group: 'Panes' },
    { id: 'companion:detail', group: 'Companions' },
    { id: 'companion:clipboard', group: 'Companions' },
    { id: 'vw:preview', group: 'Virtual Windows' },
    { id: 'vw:sim', group: 'Virtual Windows' },
  ];

  test('promotes current-view restore actions in wide too', () => {
    expect(orderSurfaceCatalogForCompactMode(catalog, 'wide').map((item) => item.id)).toEqual([
      'reopen:preview',
      'pane:preview',
      'pane:browser',
      'companion:detail',
      'companion:clipboard',
      'vw:preview',
      'vw:sim',
    ]);
  });

  test('promotes core popup and companion actions in compact', () => {
    expect(orderSurfaceCatalogForCompactMode(catalog, 'compact').map((item) => item.id)).toEqual([
      'reopen:preview',
      'pane:browser',
      'pane:preview',
      'companion:clipboard',
      'companion:detail',
      'vw:sim',
      'vw:preview',
    ]);
  });
});

describe('pruneDashboardViewsForCompactMode', () => {
  const views = [
    { id: '1', active: false },
    { id: '2', active: false },
    { id: '3', active: false },
    { id: '4', active: false },
    { id: 'agents', active: true },
    { id: 'action:view-restore', active: false },
    { id: 'action:view-reset', active: false },
  ];

  test('keeps all rows in wide', () => {
    expect(pruneDashboardViewsForCompactMode(views, 'wide')).toEqual(views);
  });

  test('compact keeps starter subset, active view, and actions', () => {
    expect(pruneDashboardViewsForCompactMode(views, 'compact').map((item) => item.id)).toEqual([
      '1',
      '2',
      '3',
      'agents',
      'action:view-restore',
      'action:view-reset',
    ]);
  });

  test('compact-tight keeps only the active view and actions', () => {
    expect(pruneDashboardViewsForCompactMode(views, 'compact-tight').map((item) => item.id)).toEqual([
      'agents',
      'action:view-restore',
      'action:view-reset',
    ]);
  });
});

describe('orderDashboardViewsForCompactMode', () => {
  const views = [
    { id: '1', active: false },
    { id: 'agents', active: true },
    { id: '2', active: false },
    { id: 'action:view-restore', active: false },
    { id: 'action:view-reset', active: false },
  ];

  test('wide keeps ordering stable', () => {
    expect(orderDashboardViewsForCompactMode(views, 'wide')).toEqual(views);
  });

  test('compact moves the active view ahead of other starter rows and keeps actions last', () => {
    expect(orderDashboardViewsForCompactMode(views, 'compact').map((item) => item.id)).toEqual([
      'agents',
      '1',
      '2',
      'action:view-restore',
      'action:view-reset',
    ]);
  });
});

describe('buildDockLauncherItemsForCompactMode', () => {
  test('wide keeps window-first ordering', () => {
    expect(buildDockLauncherItemsForCompactMode('wide').map((item) => item.value)).toEqual([
      'add-window',
      'add-surface',
      'chat-only',
    ]);
  });

  test('compact promotes surfaces and keeps chat-only available', () => {
    expect(buildDockLauncherItemsForCompactMode('compact').map((item) => item.value)).toEqual([
      'add-surface',
      'add-window',
      'chat-only',
    ]);
  });

  test('compact-tight omits chat-only and stays surface-first', () => {
    expect(buildDockLauncherItemsForCompactMode('compact-tight').map((item) => item.value)).toEqual([
      'add-surface',
      'add-window',
    ]);
  });
});
