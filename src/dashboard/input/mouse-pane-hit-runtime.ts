import { applyPaneIdToRefinement } from '../../display/hit-target.js';
import type { DashboardMouseWiringDeps } from './mouse-wiring-types.js';

interface LayoutCellHit {
  widgetInstanceId: string;
  localRow: number;
  localCol: number;
}

export interface MousePaneHitRuntimeDeps {
  getPaneNavRow: () => number | null;
  paneAtColumn: (col0: number) => string | null;
  getCurrentFocusPaneId: () => string;
  getGridMetrics: () => {
    hasLayout: boolean;
    gridZoneStart: number | null;
    gridZoneHeight: number | null;
    termCols: number;
  };
  hitTestLayoutCell: (row: number, col: number) => LayoutCellHit | null;
  describeHitFor: (
    widgetInstanceId: string,
    localRow: number,
    localCol: number,
  ) => import('../../display/types.js').WidgetHitDescriptor | null;
}

export interface MousePaneHitRuntime
  extends Pick<DashboardMouseWiringDeps, 'getPaneRegionKind' | 'getPaneHitTarget'> {}

export function createMousePaneHitRuntime(
  deps: MousePaneHitRuntimeDeps,
): MousePaneHitRuntime {
  return {
    getPaneRegionKind: (row, col) => {
      const paneNavRow = deps.getPaneNavRow();
      if (paneNavRow !== null && row === paneNavRow) return 'pane-nav';
      const grid = deps.getGridMetrics();
      if (
        !grid.hasLayout
        || grid.gridZoneStart === null
        || grid.gridZoneHeight === null
        || row < grid.gridZoneStart
        || row >= grid.gridZoneStart + grid.gridZoneHeight
      ) {
        return null;
      }
      const hit = deps.hitTestLayoutCell(row, col);
      if (!hit) return null;
      return hit.localRow === 0 ? 'pane-title' : 'pane-body';
    },
    getPaneHitTarget: (row, col) => {
      const paneNavRow = deps.getPaneNavRow();
      if (paneNavRow !== null && row === paneNavRow) {
        const target = deps.paneAtColumn(col - 1);
        const paneId = target ?? deps.getCurrentFocusPaneId();
        return { kind: 'pane-nav-tab', paneId };
      }
      const grid = deps.getGridMetrics();
      if (
        !grid.hasLayout
        || grid.gridZoneStart === null
        || grid.gridZoneHeight === null
        || row < grid.gridZoneStart
        || row >= grid.gridZoneStart + grid.gridZoneHeight
      ) {
        return null;
      }
      const hit = deps.hitTestLayoutCell(row, col);
      if (!hit) return null;
      const paneId = hit.widgetInstanceId;
      const widgetInstanceId = hit.widgetInstanceId;
      if (hit.localRow === 0) {
        return { kind: 'pane-title', paneId, widgetInstanceId };
      }
      const refinement = deps.describeHitFor(
        widgetInstanceId,
        hit.localRow,
        hit.localCol,
      );
      return applyPaneIdToRefinement(
        paneId,
        widgetInstanceId,
        hit.localRow,
        hit.localCol,
        refinement,
      );
    },
  };
}
