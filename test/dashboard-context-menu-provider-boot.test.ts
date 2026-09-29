import { describe, expect, test } from 'bun:test';

import { bootDashboardContextMenuProviders } from '../src/dashboard/context-menu-provider-boot.js';
import { createWorkingDirState } from '../src/working-dir/index.js';

describe('bootDashboardContextMenuProviders', () => {
  test('registers browser, scratch, pane-title, and debug providers without virtual-window menus', () => {
    const workingDirState = createWorkingDirState('/tmp');
    workingDirState.entries = [{
      name: 'notes.md',
      absPath: '/tmp/notes.md',
      isDir: false,
    }] as typeof workingDirState.entries;
    workingDirState.cursor = 0;
    const providers = bootDashboardContextMenuProviders({
      workingDirState,
      resolveBrowserStateCursor: () => 0,
      resolveBrowserActionContext: () => null,
      getScratchLineCount: () => 1,
      getScratchTotalBytes: () => 42,
      isCompanionOpen: () => false,
      hasClosedPanes: () => true,
      getDebugPath: () => '/tmp/debug.log',
      getDebugLevel: () => 2,
    });

    expect(providers.resolve({
      kind: 'pane-body',
      paneId: 'wd-browser',
      widgetInstanceId: 'wd-browser',
      row: 1,
      col: 1,
    } as never)).not.toBeNull();

    expect(providers.resolve({
      kind: 'pane-body',
      paneId: 'wd-working-browser',
      widgetInstanceId: 'wd-working-browser',
      row: 1,
      col: 1,
    } as never)).not.toBeNull();

    expect(providers.resolve({
      kind: 'pane-title',
      paneId: 'wd-preview',
      row: 1,
      col: 1,
    } as never)).not.toBeNull();

    expect(providers.resolve({
      kind: 'pane-body',
      paneId: 'wd-scratch',
      row: 0,
      col: 0,
    } as never)).not.toBeNull();

    expect(providers.resolve({
      kind: 'vw-pane-title',
      windowId: '1',
      paneId: 'editor',
      row: 1,
      col: 1,
    } as never)).toBeNull();

    expect(providers.resolve({
      kind: 'modal-body',
      modalId: 'debug-window',
      row: 1,
      col: 1,
    } as never)).not.toBeNull();
  });
});
