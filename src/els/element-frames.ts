// ELS-ELEMENT-HOST (대표 11-26 «every element as popup, tab or tile through ONE host») — the pure frame rules the server's
// overlay registry applies. One element = ONE overlay layer whose props live on the server; the frame only says which host
// draws it:
//   · popup — the attach view, the element's own rect (def.rect), z over the work.
//   · tile  — the attach view, a slot of the tile grid on the right side (the work on the left stays uncovered). The canon
//             defers docking into the pane tile grid until after WORKER-UNIFY, so a tile is a docked layer, not a pane.
//   · tab   — hidden from the attach view; ONE generic host pane (`elanous side element host <kind> [key]`,
//             element-host.ts) renders the same layer full-pane.
// Switching frames never copies state: the layer (and its <els>/elements/<kind>/<key>.json) is the same before and after.

import { chooseFrame, type ElementDef, type ElementFrame } from './elements/element.js';
import type { OverlayLayer, OverlayRect } from './overlay-stack.js';

export const ELEMENT_FRAMES: readonly ElementFrame[] = ['popup', 'tile', 'tab'];
export const frameOf = (layer: Pick<OverlayLayer, 'frame'>): ElementFrame => layer.frame ?? 'popup';

/** The frame after `frame` in the switch cycle popup → tile → tab → popup, skipping frames the element does not support. */
export function nextFrame(frame: ElementFrame, supported: readonly ElementFrame[]): ElementFrame {
  const at = ELEMENT_FRAMES.indexOf(frame);
  for (let step = 1; step <= ELEMENT_FRAMES.length; step++) {
    const next = ELEMENT_FRAMES[(at + step) % ELEMENT_FRAMES.length]!;
    if (supported.includes(next)) return next;
  }
  return frame;
}

/** The frame an open asks for: an explicit frame (must be supported) · else the size rule for the caller's view · else popup.
 *  A string = why the open is refused. */
export function openFrame(def: Pick<ElementDef<unknown>, 'frames' | 'kind'>, frame: unknown, view: unknown): ElementFrame | string {
  if (frame !== undefined) {
    if (!ELEMENT_FRAMES.includes(frame as ElementFrame)) return `frame must be ${ELEMENT_FRAMES.join('|')}`;
    return def.frames.includes(frame as ElementFrame) ? frame as ElementFrame : `${def.kind} opens as ${def.frames.join('|')} only`;
  }
  const size = view as { cols?: unknown; rows?: unknown } | undefined;
  if (size && Number.isInteger(size.cols) && Number.isInteger(size.rows) && (size.cols as number) > 0 && (size.rows as number) > 0)
    return chooseFrame(def, { cols: size.cols as number, rows: size.rows as number });
  return def.frames.includes('popup') ? 'popup' : def.frames[0] ?? 'popup';
}

// 출처: README «크기 적응» — a single tile is a side column (40%); a grid of tiles takes a wider region (60%), the rest
// of the view (the side list and the work, e.g. eln) stays uncovered on the left.
export const TILE_COLUMN_PCT = 40;
export const TILE_GRID_PCT = 60;

/** Rects for `count` tiles, slot order = opening order: 1 → right column full height · 2 → right column stacked · 3+ →
 *  two columns in the right region, as many rows as needed (4 = the 2×2 workbench). Each rect is a grid slot (exact edges at
 *  every view size); anchor/w/h are the approximate box for a reader without grid support. */
export function tileRects(count: number): OverlayRect[] {
  if (count <= 0) return [];
  const cols = count <= 2 ? 1 : count <= 16 ? 2 : 4;
  const rows = Math.min(8, Math.ceil(count / cols));
  const region = cols === 1 ? TILE_COLUMN_PCT : TILE_GRID_PCT;
  return Array.from({ length: count }, (_, at) => {
    const slot = at % (cols * rows);
    const col = slot % cols;
    const row = Math.floor(slot / cols);
    return { anchor: 'tr' as const, w: `${Math.round(region / cols)}%` as const, h: `${Math.round(100 / rows)}%` as const, grid: { region, cols, rows, col, row } };
  });
}

/** The ov<counter> number of a layer id (stable opening order; raise changes seq, never the id). */
export const openingOrder = (id: string): number => Number.parseInt(id.replace(/^\D+/, ''), 10) || 0;

// 출처: 대표 11-26 «workbench = viewer + file browser + terminal + sidechat side by side (2x2), plus eln» — eln is the work
// pane on the left, never a layer. Kinds another helper registers later (files · terminal) join without a change here.
export const WORKBENCH_KINDS: readonly string[] = ['obsidian', 'files', 'term', 'sidechat'];   // term = the popup terminal (#40295)
