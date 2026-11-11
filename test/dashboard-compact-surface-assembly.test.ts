import { describe, expect, mock, test } from 'bun:test';

import { createDashboardCompactSurfaceAssembly } from '../src/dashboard/compact-surface-assembly.js';

describe('createDashboardCompactSurfaceAssembly', () => {
  test('wires chat-only toggle through host and effects', () => {
    let chatOnly = false;
    let hudEnabled = false;
    const debugLines: string[] = [];
    const assembly = createDashboardCompactSurfaceAssembly({
      setChatModeHud: (enabled) => { hudEnabled = enabled; },
      pushDebugLine: (line) => { debugLines.push(line); },
      resetChatScroll: () => {},
      restoreStarterPanes: () => {},
      resetDashboardViewsConfig: () => {},
      muted: (text) => text,
      success: (text) => text,
      getClosedPanes: () => [],
      getActiveViewLabel: () => 'Default',
      getCompactMode: () => 'compact',
      openDashboardPane: () => true,
      focusPane: () => {},
      openDashboardPaneModal: () => {},
      openCompanionPopup: () => {},
      spawnBrowserVirtualWindow: () => {},
      spawnPreviewVirtualWindow: () => {},
      spawnScratchVirtualWindow: () => {},
      currentVirtualWindowId: () => null,
      openVwCompanion: () => {},
      onWarning: () => {},
      setChatOnlyMode: (next) => { chatOnly = next; },
      getChatOnlyMode: () => chatOnly,
      describeViewStarterPackage: () => 'starter',
      getViews: () => [],
      getActiveViewId: () => '1',
      getClosedStarterCount: () => 0,
      activateView: () => {},
    });

    assembly.host.toggleChatOnly();
    expect(chatOnly).toBe(true);
    expect(hudEnabled).toBe(true);
    expect(debugLines.at(-1)).toContain('chat-only layout enabled');

    assembly.host.toggleChatOnly();
    expect(chatOnly).toBe(false);
    expect(hudEnabled).toBe(false);
    expect(debugLines.at(-1)).toContain('chat-only layout disabled');
  });

  test('wires dock surface opens through runtime dispatch', () => {
    const openDashboardPane = mock((_pane: string) => true);
    const focusPane = mock((_pane: string) => {});
    const assembly = createDashboardCompactSurfaceAssembly({
      setChatModeHud: () => {},
      pushDebugLine: () => {},
      resetChatScroll: () => {},
      restoreStarterPanes: () => {},
      resetDashboardViewsConfig: () => {},
      muted: (text) => text,
      success: (text) => text,
      getClosedPanes: () => [{ pane: 'preview', label: 'Preview' }],
      getActiveViewLabel: () => 'Default',
      getCompactMode: () => 'compact',
      openDashboardPane,
      focusPane,
      openDashboardPaneModal: () => {},
      openCompanionPopup: () => {},
      spawnBrowserVirtualWindow: () => {},
      spawnPreviewVirtualWindow: () => {},
      spawnScratchVirtualWindow: () => {},
      currentVirtualWindowId: () => null,
      openVwCompanion: () => {},
      onWarning: () => {},
      setChatOnlyMode: () => {},
      getChatOnlyMode: () => false,
      describeViewStarterPackage: () => 'starter',
      getViews: () => [],
      getActiveViewId: () => '1',
      getClosedStarterCount: () => 1,
      activateView: () => {},
    });

    assembly.host.openDockSurface('reopen:preview');

    expect(openDashboardPane).toHaveBeenCalledWith('preview');
    expect(focusPane).toHaveBeenCalledWith('preview');
  });
});
