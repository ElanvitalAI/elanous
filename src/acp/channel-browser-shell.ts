import { debug } from '../debug/log.js';
import { SidebarTabSurface, type SidebarTabItem } from '../ui/widgets/sidebar-tab-surface.js';
import { resolveAcpSidebarShellPresentation } from '../ui/chrome/sidebar-shell-presentation.js';
import { globalDualRoleManager, type DualRoleManager } from './dual-role-manager.js';
import {
  backgroundToStub,
  globalBackgroundManager,
  type BackgroundManager,
} from './background-manager.js';
import type { AcpSessionStub } from '../session/card.js';
import { buildAcpChannelSidebarItems } from './channel-browser-catalog.js';
import { ACP_CHANNEL_BROWSER_COPY } from './channel-browser-copy.js';
import { globalAcpEventRouter, type AcpEventRouter } from './event-router.js';
import {
  globalAcpSessionPersistence,
  type AcpSessionPersistence,
  type PersistedAcpSession,
} from './session-persistence.js';

export interface AcpChannelBrowserViewOptions {
  title?: string;
  footerHint?: string;
  initialActiveId?: string;
  scope?: 'all' | 'browser' | 'history';
  onActivateItem?: (active: SidebarTabItem, index: number, via: 'double-click') => void;
  onReorderItem?: (fromIndex: number, toIndex: number, active: SidebarTabItem) => void;
  orderedIds?: readonly string[];
}

export interface AcpChannelBrowserDeps {
  dualRoleManager: Pick<DualRoleManager, 'listAsSidebarStubs' | 'onChange'>;
  backgroundManager: Pick<BackgroundManager, 'list' | 'status' | 'onCreate' | 'onStateChange'>;
  eventRouter: Pick<AcpEventRouter, 'getStream'>;
  persistence: Pick<AcpSessionPersistence, 'list' | 'load' | 'onChange'>;
  actionStatus?: (id: string) => string | null;
}

const DEFAULT_DEPS: AcpChannelBrowserDeps = {
  dualRoleManager: globalDualRoleManager(),
  backgroundManager: globalBackgroundManager(),
  eventRouter: globalAcpEventRouter(),
  persistence: globalAcpSessionPersistence(),
};

export function createAcpChannelBrowserView(
  opts: AcpChannelBrowserViewOptions = {},
  deps: AcpChannelBrowserDeps = DEFAULT_DEPS,
): SidebarTabSurface {
  const chrome = resolveAcpSidebarShellPresentation();
  const stubs = applyAcpChannelOrder(listAcpChannelStubs(deps, opts.scope ?? 'all'), opts.orderedIds);
  if (debug.enabled) {
    debug.log('acp.shell', 'view-build', {
      title: opts.title ?? chrome.title,
      channels: stubs.length,
      initialActiveId: opts.initialActiveId ?? null,
    });
  }
  return new SidebarTabSurface({
    title: opts.title ?? chrome.title,
    compactTitle: chrome.compactTitle,
    railTitle: chrome.railTitle,
    footerHint: opts.footerHint ?? chrome.footerHint,
    compactFooterHint: chrome.compactFooterHint,
    emptyState: ACP_CHANNEL_BROWSER_COPY.emptyResidentState,
    debugCategory: 'acp.shell',
    badgeMaxWidth: chrome.badgeMaxWidth,
    initialActiveId: opts.initialActiveId,
    onActivateItem: opts.onActivateItem,
    items: buildAcpChannelSidebarItems(stubs, {
      status: (id) => deps.backgroundManager.status(id),
      getBlocks: (id) => deps.eventRouter.getStream(id).snapshot(),
      loadPersisted: (id) => deps.persistence.load(id),
      actionStatus: (id) => deps.actionStatus?.(id) ?? null,
    }, { preserveOrder: true }),
    onReorderItem: opts.onReorderItem,
  });
}

function listAcpChannelStubs(
  deps: AcpChannelBrowserDeps,
  scope: 'all' | 'browser' | 'history' = 'all',
): AcpSessionStub[] {
  const live = [
    ...deps.dualRoleManager.listAsSidebarStubs(),
    ...deps.backgroundManager.list().map(backgroundToStub),
  ];
  const existing = new Set(live.map((stub) => stub.id));
  const persisted = deps.persistence
    .list()
    .filter((record) => !existing.has(record.sessionId))
    .map(persistedToStub);
  if (scope === 'browser') return live;
  if (scope === 'history') return persisted;
  return [...live, ...persisted];
}

function applyAcpChannelOrder(
  stubs: readonly AcpSessionStub[],
  orderedIds: readonly string[] | undefined,
): AcpSessionStub[] {
  const sorted = [...stubs];
  if (!orderedIds || orderedIds.length === 0) return sorted;
  const order = new Map<string, number>();
  orderedIds.forEach((id, idx) => order.set(id, idx));
  return sorted.sort((a, b) => {
    const aIdx = order.get(a.id);
    const bIdx = order.get(b.id);
    if (aIdx !== undefined && bIdx !== undefined) return aIdx - bIdx;
    if (aIdx !== undefined) return -1;
    if (bIdx !== undefined) return 1;
    return 0;
  });
}

function persistedToStub(record: PersistedAcpSession): AcpSessionStub {
  return {
    id: record.sessionId,
    title: `History · ${record.backendId} · ${historyLeaf(record.cwd)}`,
    agentKind: 'background',
    isAlive: false,
    createdAt: record.createdAt,
    lastActivityAt: record.lastSeenAt,
    meta: {
      namespace: 'acp-hist',
      backendId: record.backendId,
      backendSessionId: record.backendSessionId,
      origin: record.origin,
      protocolVersion: record.protocolVersion,
      persisted: true,
    },
  };
}

function historyLeaf(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : cwd || 'session';
}
