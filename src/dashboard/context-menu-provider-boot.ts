import { createMenuProviderRegistry, type MenuProviderRegistry } from '../ui/context-menu-providers.js';
import {
  registerBrowserContextMenus,
} from '../browser-context-menu.js';
import type { HitTarget } from '../display/types.js';
import type { BrowserActionContext } from '../browser-pane/actions.js';
import {
  registerScratchContextMenus,
} from '../scratch-context-menu.js';
import {
  registerDashboardPaneTitleContextMenus,
} from '../dashboard-pane-context-menu.js';
import { registerDebugContextMenus } from '../debug-context-menu.js';

export interface DashboardContextMenuProviderBootDeps {
  workingDirState: unknown;
  resolveBrowserStateCursor: (browserId: string | null | undefined) => number;
  resolveBrowserActionContext: (hit: HitTarget) => BrowserActionContext | null;
  getScratchLineCount: () => number;
  getScratchTotalBytes: () => number;
  isCompanionOpen: (key: string) => boolean;
  hasClosedPanes: () => boolean;
  getDebugPath: () => string;
  getDebugLevel: () => string;
  createRegistry?: typeof createMenuProviderRegistry;
}

export function bootDashboardContextMenuProviders(
  deps: DashboardContextMenuProviderBootDeps,
): MenuProviderRegistry {
  const providers = (deps.createRegistry ?? createMenuProviderRegistry)();
  registerBrowserContextMenus(providers, {
    workingDirState: deps.workingDirState as never,
    getCursorIndex: (browserId) => deps.resolveBrowserStateCursor(browserId),
    resolveActionContext: (hit) => deps.resolveBrowserActionContext(hit),
  });
  registerBrowserContextMenus(providers, {
    workingDirState: deps.workingDirState as never,
    paneId: 'wd-working-browser',
    getCursorIndex: (browserId) => deps.resolveBrowserStateCursor(browserId ?? 'wd-working-browser'),
    resolveActionContext: (hit) => deps.resolveBrowserActionContext(hit),
  });
  registerScratchContextMenus(providers, {
    getLineCount: deps.getScratchLineCount,
    getTotalBytes: deps.getScratchTotalBytes,
  });
  registerDashboardPaneTitleContextMenus(providers, {
    isCompanionOpen: (key) => deps.isCompanionOpen(key),
    hasClosedPanes: deps.hasClosedPanes,
  });
  registerDebugContextMenus(providers, {
    getPath: deps.getDebugPath,
    getLevel: deps.getDebugLevel,
  });
  return providers;
}
