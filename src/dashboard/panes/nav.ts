// MX9b — pane nav bar helpers.
//
// Renders a 1-row horizontal bar of [paneLabel] segments at the
// top of the dashboard, and produces the click-column bounds so
// the raw mouse dispatch can route a click to a focus change.
//
// The former drag-to-swap widget needed layout-
// render cooperation (pane order mutation) and is deferred to a
// later phase. This module delivers the minimal "click pane name
// to focus" so mouse-only users can still steer the dashboard.

import { C, stripAnsi, visibleWidth } from '../../tui.js';
import type { PaneFocus } from '../../workspace-types.js';

export interface PaneNavEntry {
  id: PaneFocus;
  label: string;
}

export interface PaneNavHitArea {
  id: PaneFocus;
  startCol: number;    // 0-indexed, inclusive
  endCol: number;      // 0-indexed, exclusive
}

export interface PaneNavRender {
  text: string;
  hitAreas: PaneNavHitArea[];
}

/** Build the nav-bar line + hit-area map for a given pane set and
 *  current focus. `width` is the target row width in cells; output
 *  is right-padded (or truncated) to exactly `width` to match the
 *  composeVertical expectation. */
export function renderPaneNav(
  entries: readonly PaneNavEntry[],
  focused: PaneFocus,
  width: number,
): PaneNavRender {
  if (entries.length === 0 || width <= 0) return { text: '', hitAreas: [] };

  const segments: string[] = [];
  const hitAreas: PaneNavHitArea[] = [];
  let col = 0;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const isFocus = e.id === focused;
    const label = ` ${e.label} `;                     // inner padding
    const raw = `[${label}]`;
    const segW = visibleWidth(raw);
    const painted = isFocus
      ? C.bold(C.accent(raw))
      : C.muted(raw);

    if (i > 0) {                                      // single-space separator
      segments.push(' ');
      col += 1;
    }
    segments.push(painted);
    hitAreas.push({ id: e.id, startCol: col, endCol: col + segW });
    col += segW;
  }

  let text = segments.join('');
  // Pad / truncate to exactly `width` cells.
  const rendered = visibleWidth(stripAnsi(text));
  if (rendered < width) {
    text += ' '.repeat(width - rendered);
  } else if (rendered > width) {
    // Truncate hit areas that exceeded width; the text output keeps
    // full ANSI since composeVertical slices by visual width downstream.
    for (let j = hitAreas.length - 1; j >= 0; j--) {
      if (hitAreas[j]!.startCol >= width) hitAreas.pop();
      else break;
    }
    // Also trim endCol of the last surviving entry if it crosses width.
    const last = hitAreas[hitAreas.length - 1];
    if (last && last.endCol > width) last.endCol = width;
  }
  return { text, hitAreas };
}

/** Which pane (if any) does a click at `col` land on? */
export function paneAtColumn(
  hits: readonly PaneNavHitArea[],
  col: number,
): PaneFocus | null {
  for (const h of hits) {
    if (col >= h.startCol && col < h.endCol) return h.id;
  }
  return null;
}

/** Friendly names for each pane focus id. Used by the dashboard to
 *  build the label list for renderPaneNav. Isolated here so future
 *  pane additions only need to touch one file. */
export function paneNavLabel(id: PaneFocus): string {
  switch (id) {
    case 'browser':           return 'Browser';
    case 'preview':           return 'Preview';
    case 'scratch':           return 'Scratch';
    case 'log':               return 'Log';
    case 'obsidian':          return 'Obsidian';
    case 'skill-browser':     return 'Skills';
    case 'skill-file':        return 'Skill';
    // Surface-unification v2.2 V2.2-5 Part 2 (2026-05-11) — scheduler-*
    // pane nav labels retired.
    case 'input':             return 'Input';
    case 'sessions-sidebar':  return 'Sessions';
    default:                  return String(id);
  }
}
