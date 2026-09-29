import type { PaneFocus } from '../workspace-types.js';
import type { DashboardViewDef } from '../views/config.js';
import type { ProductCompactMode } from '../views/product-compact-mode.js';
import type { DashboardCompanionSurfaceKey } from './compact-surface-dispatch.js';
import {
  createCompactSurfaceEffects,
  type CompactSurfaceEffects,
} from './compact-surface-effects.js';
import {
  createCompactSurfaceHost,
  type CompactSurfaceHost,
} from './compact-surface-host.js';
import {
  createCompactSurfaceRuntime,
  type CompactSurfaceRuntime,
} from './compact-surface-runtime.js';

export interface DashboardCompactSurfaceAssembly {
  effects: CompactSurfaceEffects;
  runtime: CompactSurfaceRuntime;
  host: CompactSurfaceHost;
}

export interface CreateDashboardCompactSurfaceAssemblyDeps {
  setChatModeHud: (enabled: boolean) => void;
  pushDebugLine: (line: string) => void;
  resetChatScroll: () => void;
  restoreStarterPanes: () => void;
  resetDashboardViewsConfig: () => void;
  muted: (text: string) => string;
  success: (text: string) => string;
  getClosedPanes: () => Array<{ pane: PaneFocus; label: string }>;
  getActiveViewLabel: () => string;
  getCompactMode: () => ProductCompactMode;
  openDashboardPane: (pane: PaneFocus) => boolean;
  focusPane: (pane: PaneFocus) => void;
  openBrowserPreviewModal: () => void;
  openDashboardPaneModal: (pane: PaneFocus) => void;
  openCompanionPopup: (key: DashboardCompanionSurfaceKey) => void;
  onWarning: (message: string) => void;
  setChatOnlyMode: (next: boolean) => void;
  getChatOnlyMode: () => boolean;
  describeViewStarterPackage: (view: DashboardViewDef) => string;
  getViews: () => DashboardViewDef[];
  getActiveViewId: () => string;
  getClosedStarterCount: () => number;
  activateView: (view: DashboardViewDef) => void;
}

export function createDashboardCompactSurfaceAssembly(
  deps: CreateDashboardCompactSurfaceAssemblyDeps,
): DashboardCompactSurfaceAssembly {
  const effects = createCompactSurfaceEffects({
    setChatModeHud: deps.setChatModeHud,
    pushDebugLine: deps.pushDebugLine,
    resetChatScroll: deps.resetChatScroll,
    restoreStarterPanes: deps.restoreStarterPanes,
    resetDashboardViewsConfig: deps.resetDashboardViewsConfig,
    muted: deps.muted,
    success: deps.success,
  });
  const runtime = createCompactSurfaceRuntime({
    getClosedPanes: deps.getClosedPanes,
    getActiveViewLabel: deps.getActiveViewLabel,
    getCompactMode: deps.getCompactMode,
    openDashboardPane: deps.openDashboardPane,
    focusPane: deps.focusPane,
    openBrowserPreviewModal: deps.openBrowserPreviewModal,
    openDashboardPaneModal: deps.openDashboardPaneModal,
    openCompanionPopup: deps.openCompanionPopup,
    onWarning: deps.onWarning,
  });
  const host = createCompactSurfaceHost({
    buildDockSurfaceCatalogTargets: () => runtime.buildTargets(),
    openCatalogSurfaceById: (surfaceId) => runtime.openTarget(surfaceId),
    setChatOnlyMode: deps.setChatOnlyMode,
    getChatOnlyMode: deps.getChatOnlyMode,
    onChatOnlyEnabled: effects.onChatOnlyEnabled,
    onChatOnlyDisabled: effects.onChatOnlyDisabled,
    describeViewStarterPackage: deps.describeViewStarterPackage,
    getViews: deps.getViews,
    getActiveViewId: deps.getActiveViewId,
    getClosedStarterCount: deps.getClosedStarterCount,
    getCompactMode: deps.getCompactMode,
    restoreStarterPanes: effects.restoreStarterPanes,
    resetDashboardViewsConfig: effects.resetDashboardViewsConfig,
    activateView: deps.activateView,
  });
  return { effects, runtime, host };
}
