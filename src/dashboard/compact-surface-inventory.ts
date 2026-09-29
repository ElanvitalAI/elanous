import type { PaneFocus } from '../workspace-types.js';
import {
  orderDashboardViewsForCompactMode,
  orderSurfaceCatalogForCompactMode,
  pruneDashboardViewsForCompactMode,
  pruneSurfaceCatalogForCompactMode,
  type ProductCompactMode,
} from '../views/product-compact-mode.js';

export interface DashboardSurfaceCatalogTarget {
  id: string;
  label: string;
  description: string;
  group: 'Current View' | 'Panes' | 'Companions' | 'Virtual Windows';
}

export interface ClosedStarterPaneEntry {
  pane: PaneFocus;
  label: string;
}

export interface DashboardViewPickerEntry {
  id: string;
  label: string;
  active: boolean;
}

export function buildDashboardSurfaceCatalogTargets(args: {
  closedPanes: readonly ClosedStarterPaneEntry[];
  activeViewLabel: string;
  compactMode: ProductCompactMode;
}): DashboardSurfaceCatalogTarget[] {
  const closedPaneTargets: DashboardSurfaceCatalogTarget[] = args.closedPanes.map((pane) => ({
    id: `reopen:${pane.pane}`,
    label: `Reopen ${pane.label}`,
    description: `Restore ${pane.label} to the current ${args.activeViewLabel} starter view`,
    group: 'Current View',
  }));
  return orderSurfaceCatalogForCompactMode(
    pruneSurfaceCatalogForCompactMode([
      ...closedPaneTargets,
      { id: 'pane:browser', label: 'Browser popup', description: 'Open Browser as a popup', group: 'Panes' },
      { id: 'pane:preview', label: 'Preview popup', description: 'Open Preview as a popup', group: 'Panes' },
      { id: 'pane:browser-preview', label: 'Browser + Preview popup', description: 'Open the combined browser/preview modal', group: 'Panes' },
      { id: 'pane:scratch', label: 'Scratch popup', description: 'Open Scratch as a popup canvas', group: 'Panes' },
      { id: 'pane:obsidian', label: 'Obsidian popup', description: 'Open Obsidian as a popup', group: 'Panes' },
      { id: 'pane:skill-browser', label: 'Skill browser popup', description: 'Open the skill browser popup', group: 'Panes' },
      { id: 'pane:skill-file', label: 'Skill file popup', description: 'Open the skill file popup', group: 'Panes' },
      { id: 'pane:agent-roster', label: 'Agents popup', description: 'Open the agent roster popup', group: 'Panes' },
      { id: 'companion:clipboard', label: 'Clipboard companion', description: 'Attach clipboard history to the dashboard', group: 'Companions' },
      { id: 'companion:memo', label: 'Memo companion', description: 'Attach the memo companion to the dashboard', group: 'Companions' },
      { id: 'companion:detail', label: 'Detail companion', description: 'Attach the detail viewer to the dashboard', group: 'Companions' },
    ], args.compactMode),
    args.compactMode,
  );
}

export function buildDashboardViewPickerEntries(args: {
  views: readonly DashboardViewPickerEntry[];
  includeRestoreAction: boolean;
  compactMode: ProductCompactMode;
}): DashboardViewPickerEntry[] {
  return orderDashboardViewsForCompactMode(
    pruneDashboardViewsForCompactMode([
      ...args.views,
      ...(args.includeRestoreAction
        ? [{
          id: 'action:view-restore',
          label: 'Restore starter panes',
          active: false,
        }]
        : []),
      {
        id: 'action:view-reset',
        label: 'Reset view config',
        active: false,
      },
    ], args.compactMode),
    args.compactMode,
  );
}
