// GRAPH-VIEW-TRIGGER (개정 4): where the graph view shows up in the Next TUI.
//   inline       (default) — an inline block in the conversation stream, updated in place, folded when the turn ends
//   inline+hint  — the block plus the old one-line footer hint
//   off          — the footer hint only (the behavior before the graph view)
// The sidetab (Ctrl+G · /graph) is opt-in and belongs to GRAPH-VIEW-DETAIL-SIDETAB, so auto-sidetab is read as inline here.
import { projectGraphLoopViews, type GraphViewEvent } from './model.js';
import { renderGraphViewInlineBlocks } from './render.js';

export type GraphViewSurfaceMode = 'inline' | 'inline+hint' | 'off';

/** `ELANOUS_NEXT_TUI_GRAPH_VIEW` until the `ui.graphView` setting exists; unknown values fall back to the default. */
export function graphViewSurfaceMode(value: string | undefined): GraphViewSurfaceMode {
  if (value === 'off' || value === 'inline+hint') return value;
  return 'inline';
}

export const graphViewShowsBlock = (mode: GraphViewSurfaceMode) => mode !== 'off';
export const graphViewShowsHint = (mode: GraphViewSurfaceMode) => mode !== 'inline';

/** Conversation rows for every loop of a turn: one block per loop, oldest running blocks fold first past `maxRows`. */
export function graphViewTurnLines(events: readonly GraphViewEvent[], columns: number, maxRows: number, nowMs: number, color = false): string[] {
  if (events.length === 0) return [];
  const views = [...projectGraphLoopViews(events).values()];
  return renderGraphViewInlineBlocks(views, columns, maxRows, { nowMs, color }).flat();
}
