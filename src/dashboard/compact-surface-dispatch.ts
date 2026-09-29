import type { PaneFocus } from '../workspace-types.js';

export type DashboardCompanionSurfaceKey = 'clipboard' | 'memo' | 'detail';

export interface DispatchDashboardSurfaceCatalogActionDeps {
  openDashboardPane: (pane: PaneFocus) => boolean;
  focusPane: (pane: PaneFocus) => void;
  openBrowserPreviewModal: () => void;
  openDashboardPaneModal: (pane: PaneFocus) => void;
  openCompanionPopup: (key: DashboardCompanionSurfaceKey) => void;
  onWarning?: (message: string) => void;
}

export function dispatchDashboardSurfaceCatalogAction(
  surfaceId: string,
  deps: DispatchDashboardSurfaceCatalogActionDeps,
): void {
  if (surfaceId.startsWith('reopen:')) {
    const pane = surfaceId.slice('reopen:'.length) as PaneFocus;
    if (deps.openDashboardPane(pane)) {
      deps.focusPane(pane);
    } else {
      deps.onWarning?.(`could not reopen pane: ${surfaceId.slice('reopen:'.length)}`);
    }
    return;
  }
  if (surfaceId === 'pane:browser-preview') {
    deps.openBrowserPreviewModal();
    return;
  }
  if (surfaceId.startsWith('pane:')) {
    deps.openDashboardPaneModal(surfaceId.slice('pane:'.length) as PaneFocus);
    return;
  }
  if (surfaceId.startsWith('companion:')) {
    const key = surfaceId.slice('companion:'.length);
    if (key === 'clipboard' || key === 'memo' || key === 'detail') {
      deps.openCompanionPopup(key);
    }
    return;
  }
  deps.onWarning?.(`unsupported dashboard surface: ${surfaceId}`);
}
