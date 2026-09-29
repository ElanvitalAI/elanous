import { describe, expect, test } from 'bun:test';
import { createMenuProviderRegistry } from '../src/ui/context-menu-providers.js';
import { registerDashboardPaneTitleContextMenus } from '../src/dashboard-pane-context-menu.js';
import type { HitTarget } from '../src/display/types.js';

describe('registerDashboardPaneTitleContextMenus', () => {
  test('browser pane title offers popup without a VW action', () => {
    const providers = createMenuProviderRegistry();
    registerDashboardPaneTitleContextMenus(providers);
    const hit: HitTarget = { kind: 'pane-title', paneId: 'wd-browser' };
    const menu = providers.resolve(hit);
    expect(menu).not.toBeNull();
    const ids = menu!.items
      .filter((i) => i.kind === 'command')
      .map((i) => (i.kind === 'command' ? i.id : ''));
    expect(ids).toEqual([
      'dashboard-pane.open-popup',
      'dashboard-pane.clipboard-companion',
      'dashboard-pane.memo-companion',
      'dashboard-pane.detail-companion',
    ]);
  });

  test('obsidian pane title offers popup plus companion toggles', () => {
    const providers = createMenuProviderRegistry();
    registerDashboardPaneTitleContextMenus(providers);
    const hit: HitTarget = { kind: 'pane-title', paneId: 'wd-obsidian' };
    const menu = providers.resolve(hit);
    expect(menu).not.toBeNull();
    const ids = menu!.items
      .filter((i) => i.kind === 'command')
      .map((i) => (i.kind === 'command' ? i.id : ''));
    expect(ids).toEqual([
      'dashboard-pane.open-popup',
      'dashboard-pane.clipboard-companion',
      'dashboard-pane.memo-companion',
      'dashboard-pane.detail-companion',
    ]);
  });

  test('pane title offers restore action when current view has closed panes', () => {
    const providers = createMenuProviderRegistry();
    registerDashboardPaneTitleContextMenus(providers, {
      hasClosedPanes: () => true,
    });
    const hit: HitTarget = { kind: 'pane-title', paneId: 'wd-browser' };
    const menu = providers.resolve(hit);
    const ids = menu!.items
      .filter((i) => i.kind === 'command')
      .map((i) => (i.kind === 'command' ? i.id : ''));
    expect(ids).toEqual([
      'dashboard-pane.open-popup',
      'dashboard-pane.restore-view-panes',
      'dashboard-pane.clipboard-companion',
      'dashboard-pane.memo-companion',
      'dashboard-pane.detail-companion',
    ]);
  });

  test('companion labels reflect open state', () => {
    const providers = createMenuProviderRegistry();
    registerDashboardPaneTitleContextMenus(providers, {
      isCompanionOpen: (key) => key !== 'detail',
    });
    const hit: HitTarget = { kind: 'pane-title', paneId: 'wd-browser' };
    const menu = providers.resolve(hit);
    const clipboard = menu?.items.find(
      (item) => item.kind === 'command' && item.id === 'dashboard-pane.clipboard-companion',
    );
    const memo = menu?.items.find(
      (item) => item.kind === 'command' && item.id === 'dashboard-pane.memo-companion',
    );
    const detail = menu?.items.find(
      (item) => item.kind === 'command' && item.id === 'dashboard-pane.detail-companion',
    );
    expect(clipboard).toMatchObject({ kind: 'command', label: 'Hide clipboard companion' });
    expect(memo).toMatchObject({ kind: 'command', label: 'Hide memo companion' });
    expect(detail).toMatchObject({ kind: 'command', label: 'Show detail companion' });
  });
});
