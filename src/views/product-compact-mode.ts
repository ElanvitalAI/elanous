import type { PaneViewport } from './pane-policy.js';

export type ProductCompactMode =
  | 'wide'
  | 'compact'
  | 'compact-tight';

export interface DockLauncherCatalogItem {
  value: 'add-window' | 'add-surface' | 'chat-only';
  label: string;
  description: string;
}
const COMPACT_STARTER_VIEW_IDS = new Set<string>([
  '1',
  '2',
  '3',
]);

export function productCompactModeForViewport(
  viewport: PaneViewport,
): ProductCompactMode {
  const cols = Math.max(0, viewport.cols);
  if (cols <= 110) return 'compact-tight';
  if (cols <= 132) return 'compact';
  return 'wide';
}

export function autoTabletModeForViewport(
  viewport: PaneViewport,
): boolean {
  return productCompactModeForViewport(viewport) === 'compact-tight';
}

export function effectiveChatOnlyModeForViewport(
  viewport: PaneViewport,
  manualChatOnly: boolean,
): boolean {
  return manualChatOnly || productCompactModeForViewport(viewport) === 'compact-tight';
}

const COMPACT_TIGHT_SURFACE_CATALOG_IDS = new Set<string>([
  'pane:browser',
  'pane:preview',
  'pane:obsidian',
  'companion:clipboard',
  'companion:memo',
  'companion:detail',
  'vw:browser',
  'vw:preview',
  'vw:sim',
]);

const SURFACE_GROUP_PRIORITY: Record<ProductCompactMode, Record<string, number>> = {
  wide: {
    'Current View': 0,
    Panes: 1,
    Companions: 2,
    'Virtual Windows': 3,
  },
  compact: {
    'Current View': 0,
    Panes: 1,
    Companions: 2,
    'Virtual Windows': 3,
  },
  'compact-tight': {
    'Current View': 0,
    Panes: 1,
    Companions: 2,
    'Virtual Windows': 3,
  },
};

const SURFACE_ITEM_PRIORITY: Record<ProductCompactMode, Record<string, number>> = {
  wide: {},
  compact: {
    'pane:browser': 1,
    'pane:preview': 2,
    'companion:clipboard': 0,
    'companion:memo': 1,
    'companion:detail': 2,
    'vw:sim': 1,
    'vw:browser': 2,
    'vw:preview': 3,
  },
  'compact-tight': {
    'pane:browser': 1,
    'pane:preview': 2,
    'pane:obsidian': 3,
    'companion:clipboard': 0,
    'companion:memo': 1,
    'companion:detail': 2,
    'vw:sim': 1,
    'vw:browser': 2,
    'vw:preview': 3,
  },
};

export function pruneSurfaceCatalogForCompactMode<T extends { id: string }>(
  items: readonly T[],
  mode: ProductCompactMode,
): T[] {
  if (mode !== 'compact-tight') return [...items];
  return items.filter((item) => item.id.startsWith('reopen:') || COMPACT_TIGHT_SURFACE_CATALOG_IDS.has(item.id));
}

export function orderSurfaceCatalogForCompactMode<T extends { id: string; group?: string }>(
  items: readonly T[],
  mode: ProductCompactMode,
): T[] {
  const groupPriority = SURFACE_GROUP_PRIORITY[mode];
  const itemPriority = SURFACE_ITEM_PRIORITY[mode];
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aGroup = groupPriority[a.item.group ?? ''] ?? Number.MAX_SAFE_INTEGER;
      const bGroup = groupPriority[b.item.group ?? ''] ?? Number.MAX_SAFE_INTEGER;
      if (aGroup !== bGroup) return aGroup - bGroup;
      const aItem = itemPriority[a.item.id] ?? Number.MAX_SAFE_INTEGER;
      const bItem = itemPriority[b.item.id] ?? Number.MAX_SAFE_INTEGER;
      if (aItem !== bItem) return aItem - bItem;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

export function pruneDashboardViewsForCompactMode<T extends { id: string; active?: boolean }>(
  items: readonly T[],
  mode: ProductCompactMode,
): T[] {
  if (mode === 'wide') return [...items];
  if (mode === 'compact') {
    return items.filter((item) => item.id.startsWith('action:view-') || item.active || COMPACT_STARTER_VIEW_IDS.has(item.id));
  }
  return items.filter((item) => item.id.startsWith('action:view-') || !!item.active);
}

export function orderDashboardViewsForCompactMode<T extends { id: string; active?: boolean }>(
  items: readonly T[],
  mode: ProductCompactMode,
): T[] {
  if (mode === 'wide') return [...items];
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aAction = a.item.id.startsWith('action:view-') ? 1 : 0;
      const bAction = b.item.id.startsWith('action:view-') ? 1 : 0;
      if (aAction !== bAction) return aAction - bAction;
      if (!!a.item.active !== !!b.item.active) return a.item.active ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

const WIDE_DOCK_LAUNCHER_ITEMS: DockLauncherCatalogItem[] = [
  {
    value: 'add-window',
    label: 'Add Window',
    description: 'Pop out a dashboard pane as a floating window',
  },
  {
    value: 'add-surface',
    label: 'Add Surface',
    description: 'Open a pane, companion, or VW surface from one catalog',
  },
  {
    value: 'chat-only',
    label: 'Chat Only',
    description: 'Hide the top panes and focus on the log + input',
  },
];

const COMPACT_DOCK_LAUNCHER_ITEMS: DockLauncherCatalogItem[] = [
  {
    value: 'add-surface',
    label: 'Add Surface',
    description: 'Open a pane, companion, or VW surface from one catalog',
  },
  {
    value: 'add-window',
    label: 'Add Window',
    description: 'Pop out a dashboard pane as a floating window',
  },
  {
    value: 'chat-only',
    label: 'Chat Only',
    description: 'Hide the top panes and focus on the log + input',
  },
];

const COMPACT_TIGHT_DOCK_LAUNCHER_ITEMS: DockLauncherCatalogItem[] = [
  {
    value: 'add-surface',
    label: 'Add Surface',
    description: 'Open a pane, companion, or VW surface from one catalog',
  },
  {
    value: 'add-window',
    label: 'Add Window',
    description: 'Pop out a dashboard pane as a floating window',
  },
];

export function buildDockLauncherItemsForCompactMode(
  mode: ProductCompactMode,
): DockLauncherCatalogItem[] {
  switch (mode) {
    case 'wide':
      return [...WIDE_DOCK_LAUNCHER_ITEMS];
    case 'compact':
      return [...COMPACT_DOCK_LAUNCHER_ITEMS];
    case 'compact-tight':
      return [...COMPACT_TIGHT_DOCK_LAUNCHER_ITEMS];
  }
}
