// Widget routing — pane id ↔ widget id table.
//
// Phase 0 stub. Phase 2+ populates this table as widgets are migrated
// from dashboard-local inline handlers to widget-owned behaviors. A
// widget ids map to pane ids, letting the router delegate key events
// to the widget host through a generic handler
// that the dashboard registers (still in Phase 0 territory — the
// handler body stays in dashboard.ts).
//
// Kept as an empty structure for now so the module surface area is
// stable from Phase 0 onward.

export interface PaneWidgetMapping {
  readonly paneId: string;
  readonly widgetId: string;
}

/** Known mappings. Filled in Phase 2+ as widgets get migrated. */
export const PANE_WIDGET_MAPPINGS: readonly PaneWidgetMapping[] = [];

/** Look up the widget id for a pane id, or null if no mapping. */
export function widgetIdForPane(paneId: string): string | null {
  for (const m of PANE_WIDGET_MAPPINGS) {
    if (m.paneId === paneId) return m.widgetId;
  }
  return null;
}
