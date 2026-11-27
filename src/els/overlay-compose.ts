// ELS-ZAXIS S2 — compositing the overlay stack in the attach client (ELS-ELN-LAYERS §1 «els attach client» · §3).
// The server owns the stack (S3); the client only draws what was pushed and routes input through it — it never edits its copy.
// Rows are spliced with attach-view's spliceCells (SGR carry-over, wide-glyph edges), the same as the old single dialog.
// No mouse-mode escapes live here (the app's ENTER_VIEW is unchanged).

import { fitAnsi, type DialogBox } from './attach-view.js';
import { focusTop, hitTest, paintOrder, type Hit, type OverlayLayer, type OverlayStack } from './overlay-stack.js';

/** An element renderer: the layer's rows for its box size (exactly `size.h` rows of `size.w` cells is ideal; the splice pads
 *  and clips). Pure — called on every repaint whose (layer, size, focus) changed. */
export type LayerRenderer = (layer: OverlayLayer, size: { readonly w: number; readonly h: number }, focused: boolean) => readonly string[];

/** A plain framed box with the kind as its title — what an unknown element kind draws (never a blank hole). */
export function frameRows(title: string, body: readonly string[], size: { readonly w: number; readonly h: number }): string[] {
  const { w, h } = size;
  if (w < 2 || h < 2) return Array.from({ length: h }, () => fitAnsi(body[0] ?? title, w));
  const label = title ? ` ${title} ` : '';
  const top = `┌${fitAnsi(label, Math.min(w - 2, Bun.stringWidth(label)))}${'─'.repeat(Math.max(0, w - 2 - Math.min(w - 2, Bun.stringWidth(label))))}┐`;
  const rows = [top];
  for (let at = 0; at < h - 2; at++) rows.push(`│${fitAnsi(body[at] ?? '', w - 2)}│`);
  rows.push(`└${'─'.repeat(w - 2)}┘`);
  return rows;
}

const fallback: LayerRenderer = (layer, size) => frameRows(layer.kind, [], size);

/** A renderer registry with a (layer id, props, size, focus) cache — classic's (bounds, generation) paint cache. */
/** `salt` = a value that changes when EVERY layer must repaint (ELS-POPUP-STYLE: the popup style). */
export function createLayerPainter(renderers: Readonly<Record<string, LayerRenderer>>, salt: () => string = () => ''): (layer: OverlayLayer, size: { w: number; h: number }, focused: boolean) => readonly string[] {
  const cache = new Map<string, { key: string; rows: readonly string[] }>();
  return (layer, size, focused) => {
    const key = `${JSON.stringify(layer.props ?? null)}|${size.w}x${size.h}|${focused ? 1 : 0}|${layer.seq}|${salt()}`;
    const hit = cache.get(layer.id);
    if (hit?.key === key) return hit.rows;
    const rows = (renderers[layer.kind] ?? fallback)(layer, size, focused);
    cache.set(layer.id, { key, rows });
    // 출처: #40244 ELS-ELN-LAYERS §2-4 flat memory — closed layers fall out of the paint cache
    if (cache.size > 64) cache.delete(cache.keys().next().value!);
    return rows;
  };
}

/** The boxes to splice over a view (bottom → top), already rendered. `view` is the area the layers cover (the whole
 *  terminal above the status line). */
export function composeLayers(stack: OverlayStack, view: { readonly cols: number; readonly rows: number }, workspace: string | undefined,
  paint: (layer: OverlayLayer, size: { w: number; h: number }, focused: boolean) => readonly string[]): DialogBox[] {
  const top = focusTop(stack, workspace);
  const focusedId = top.kind === 'layer' ? top.layer.id : undefined;
  return paintOrder(stack, view, workspace).map(({ layer, box }) => {
    const rows = paint(layer, { w: box.w, h: box.h }, layer.id === focusedId);
    return { x: box.x, y: box.y, width: box.w, lines: Array.from({ length: box.h }, (_, at) => rows[at] ?? '') };
  });
}

/** What a mouse press at SGR (1-based) x, y means for the overlay: a layer, swallowed by a blocking layer, or «not mine»
 *  (undefined — the app's own routing: tabs, side list, pane). */
export function overlayMouse(stack: OverlayStack, view: { readonly cols: number; readonly rows: number }, x: number, y: number, workspace: string | undefined): Exclude<Hit, { kind: 'base' }> | undefined {
  if (y > view.rows) return undefined;                          // the status line is never covered
  const hit = hitTest(stack, view, x - 1, y - 1, workspace);
  return hit.kind === 'base' ? undefined : hit;
}
