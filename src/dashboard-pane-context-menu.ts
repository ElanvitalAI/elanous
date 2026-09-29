import type {
  MenuProviderRegistry,
  MenuProvider,
  MenuBuildContext,
} from './ui/context-menu-providers.js';
import type { Menu } from './ui/context-menu-registry.js';
import type { HitTarget } from './display/types.js';
import type { PaneFocus } from './workspace-types.js';

export interface DashboardPaneTitleMenuPayload {
  readonly pane: PaneFocus;
}

type DashboardPaneCompanionKey = 'clipboard' | 'memo' | 'detail';

export interface DashboardPaneTitleMenuDeps {
  isCompanionOpen?: (key: DashboardPaneCompanionKey) => boolean;
  hasClosedPanes?: () => boolean;
}

function createDashboardPaneTitleMenuProvider(
  pane: PaneFocus,
  deps: DashboardPaneTitleMenuDeps = {},
): MenuProvider {
  return (hit: HitTarget, _ctx: MenuBuildContext): Menu | null => {
    if (hit.kind !== 'pane-title') return null;
    const payload: DashboardPaneTitleMenuPayload = { pane };
    const clipboardOpen = deps.isCompanionOpen?.('clipboard') ?? false;
    const memoOpen = deps.isCompanionOpen?.('memo') ?? false;
    const detailOpen = deps.isCompanionOpen?.('detail') ?? false;
    const hasClosedPanes = deps.hasClosedPanes?.() ?? false;
    const items: Menu['items'] = [
      {
        kind: 'command',
        id: 'dashboard-pane.open-popup',
        label: 'Open as popup',
        payload,
      },
    ];
    if (hasClosedPanes) {
      items.push(
        { kind: 'separator' },
        {
          kind: 'command',
          id: 'dashboard-pane.restore-view-panes',
          label: 'Restore closed starter panes',
          payload,
        },
      );
    }
    items.push(
      { kind: 'separator' },
      {
        kind: 'command',
        id: 'dashboard-pane.clipboard-companion',
        label: clipboardOpen ? 'Hide clipboard companion' : 'Show clipboard companion',
        payload,
      },
      {
        kind: 'command',
        id: 'dashboard-pane.memo-companion',
        label: memoOpen ? 'Hide memo companion' : 'Show memo companion',
        payload,
      },
      {
        kind: 'command',
        id: 'dashboard-pane.detail-companion',
        label: detailOpen ? 'Hide detail companion' : 'Show detail companion',
        payload,
      },
    );
    return {
      id: `dashboard-pane-title:${pane}`,
      title: 'Pane',
      items,
    };
  };
}

export function registerDashboardPaneTitleContextMenus(
  providers: MenuProviderRegistry,
  deps: DashboardPaneTitleMenuDeps = {},
): () => void {
  const registrations: Array<() => void> = [];
  const register = (paneId: string, pane: PaneFocus) => {
    registrations.push(providers.register(
      `pane-title:${paneId}`,
      createDashboardPaneTitleMenuProvider(pane, deps),
    ));
  };
  register('wd-browser', 'browser');
  register('wd-working-browser', 'browser');
  register('wd-preview', 'preview');
  register('wd-scratch', 'scratch');
  register('wd-obsidian', 'obsidian');
  register('wd-skill-browser', 'skill-browser');
  register('wd-skill-file', 'skill-file');
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of registrations) {
      try { dispose(); } catch { /* swallow */ }
    }
  };
}
