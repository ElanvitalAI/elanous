// ELS-ZAXIS S1 — the els overlay stack: ONE layer list (bottom → top) and ONE focus stack, pure and immutable.
// 🔗 design — 내부 문서 `ELS-ELN-LAYERS` §2-2 · §3 (z model) · REPORT classic-popup-port §3 · §4-3.
//
// Ideas copied from classic (8/31 export, ~/elanous-hq/ref/elanous-classic-20260831): surface/z-tier.ts band vocabulary and
// compareByZSemantics (band → in-band index → insertion), display/modal-stack.ts focus levels owns · participates · none and
// backgroundInteractionPolicy 'block', conv-dash/popup-host.ts zSeq (raise = a fresh in-band seq) and cascade placement,
// ownerWorkspaceId cascade close. src/dashboard is NOT imported (retired) — this file is a fresh, pure re-write.
//
// Classic flaws fixed here (REPORT §3 «버릴 것»):
//   1. LayerTree drift — there is no shadow copy: the stack IS the sorted array; server and client import the same compareLayers.
//   2. top-only hit test — hitTest walks every visible layer top-down, `focus:'none'` layers are clicked through.
//   3. focus jumped a layer above its band — focusing never changes z; raise/lower only move a layer inside its own band.
//   4. one-slot `previous` restore — closing pops a focus STACK, so focus returns to whatever was below, however deep.
//
// No timers and no I/O: the server keeps one stack in memory and pushes it on change (events, never polling); expiry is
// computed (nextExpiry) so the owner can arm ONE timeout for the next due layer.

/** Six z-tiers, bottom → top. `layout` is z = 0 (panes, tiles, the stage band) and is never a layer: it is the focus base.
 *  classic Z_TIER_ORDER bg·inline·vw·modal·popover·overlay → els layout · float · popup · modal · toast · system. */
export const OVERLAY_BANDS = ['layout', 'float', 'popup', 'modal', 'toast', 'system'] as const;
export type OverlayBand = (typeof OVERLAY_BANDS)[number];
/** The bands a layer may live in (z > 0). */
export type LayerBand = Exclude<OverlayBand, 'layout'>;
export const LAYER_BANDS: readonly LayerBand[] = ['float', 'popup', 'modal', 'toast', 'system'];

/** classic DisplaySurface.focus: `owns` takes keys and clicks · `participates` takes keys only (clicks pass) · `none` takes
 *  neither — a click or key goes straight through it (toasts, HUD). */
export type FocusLevel = 'owns' | 'participates' | 'none';
export const FOCUS_LEVELS: readonly FocusLevel[] = ['owns', 'participates', 'none'];

export type Anchor = 'center' | 'top' | 'bottom' | 'tl' | 'tr' | 'bl' | 'br';
export const ANCHORS: readonly Anchor[] = ['center', 'top', 'bottom', 'tl', 'tr', 'bl', 'br'];
/** A length in cells, or a percentage of the view (`'50%'`). */
export type Length = number | `${number}%`;
/** ELS-ELEMENT-HOST tile slot: cell (col,row) of a cols×rows grid filling the right `region`% of the view, edges cut by
 *  cumulative rounding so neighbouring tiles share no cell and leave no gap, at every view size. */
export interface GridSlot { readonly region: number; readonly cols: number; readonly rows: number; readonly col: number; readonly row: number }
/** Relative placement: re-resolved for every view size (each attach view may be a different size — ELS-ELN-LAYERS §3-3).
 *  `grid` (a tile slot) wins over anchor/w/h/dx/dy, which stay as the approximate box for a reader without grid support. */
export interface OverlayRect { readonly anchor: Anchor; readonly w: Length; readonly h: Length; readonly dx?: number; readonly dy?: number; readonly grid?: GridSlot }
export interface Box { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

export interface OverlayLayer {
  readonly id: string;
  /** Element kind ('toast' · 'memo' · 'obsidian' …) — which renderer draws it. */
  readonly kind: string;
  /** Same kind + key opens once (open again = raise). */
  readonly key: string;
  readonly band: LayerBand;
  /** In-band order (classic zSeq): bigger = higher inside the band. */
  readonly seq: number;
  readonly rect: OverlayRect;
  readonly focus: FocusLevel;
  /** classic backgroundInteractionPolicy 'block': clicks outside it and keys never reach anything below. */
  readonly blocking?: boolean;
  /** 'space' (default): shown only in its owner workspace and closed with it · 'all': shown in every space. */
  readonly pin?: 'space' | 'all';
  readonly ownerWorkspace?: string;
  readonly minimized?: boolean;
  /** ELS-ELEMENT-HOST: which host draws it — absent = popup (this view, def.rect) · 'tile' (this view, a tile grid slot) ·
   *  'tab' (not drawn here: a host pane renders it full-pane, so it is hidden from the overlay view). */
  readonly frame?: 'tile' | 'tab';
  /** Paints every cell of its rect (layers fully under it are not rendered). Default true. */
  readonly opaque?: boolean;
  /** Epoch ms after which the layer is removed (toasts). */
  readonly expiresAt?: number;
  /** Element props (serializable). */
  readonly props?: unknown;
}

/** One base entry per z = 0 target: `pane:<id>` or `tile:<id>` — tabs, tiles and popups share ONE focus stack. */
export type BaseTarget = `pane:${string}` | `tile:${string}` | '';

export interface OverlayStack {
  /** Bumped by every change — clients apply a pushed stack only when its rev is newer (idempotent replay). */
  readonly rev: number;
  /** Monotonic counter for seq and ids. */
  readonly counter: number;
  /** Sorted bottom → top by compareLayers — the single source of z truth. */
  readonly layers: readonly OverlayLayer[];
  /** Focus stack bottom → top: [base, …layer ids]. focus[0] is always the base (may be ''). */
  readonly focus: readonly string[];
}

export const bandRank = (band: OverlayBand): number => OVERLAY_BANDS.indexOf(band);

/** classic compareByZSemantics: band, then in-band seq, then id (stable for equal seq). */
export function compareLayers(a: Pick<OverlayLayer, 'band' | 'seq' | 'id'>, b: Pick<OverlayLayer, 'band' | 'seq' | 'id'>): number {
  return bandRank(a.band) - bandRank(b.band) || a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function emptyStack(base: BaseTarget = ''): OverlayStack {
  return { rev: 0, counter: 0, layers: [], focus: [base] };
}

const sorted = (layers: readonly OverlayLayer[]): OverlayLayer[] => [...layers].sort(compareLayers);
const bump = (stack: OverlayStack, patch: Partial<OverlayStack>): OverlayStack => ({ ...stack, ...patch, rev: stack.rev + 1 });

export interface OpenSpec {
  readonly kind: string;
  readonly key?: string;
  readonly band?: LayerBand;
  readonly rect?: OverlayRect;
  readonly focus?: FocusLevel;
  readonly blocking?: boolean;
  readonly pin?: 'space' | 'all';
  readonly ownerWorkspace?: string;
  readonly opaque?: boolean;
  readonly expiresAt?: number;
  readonly props?: unknown;
}

const DEFAULT_RECT: OverlayRect = { anchor: 'center', w: '60%', h: '50%' };

/** Open a layer on top of its band. Idempotent: the same kind+key raises the existing layer (and refreshes its props and
 *  expiry) instead of opening a second. A focusable layer is pushed on the focus stack. */
export function openLayer(stack: OverlayStack, spec: OpenSpec): { stack: OverlayStack; id: string; raised: boolean } {
  const key = spec.key ?? 'default';
  const existing = stack.layers.find((layer) => layer.kind === spec.kind && layer.key === key);
  if (existing) {
    const counter = stack.counter + 1;
    const layer: OverlayLayer = { ...existing, seq: counter, minimized: false,
      ...(spec.props !== undefined ? { props: spec.props } : {}), ...(spec.expiresAt !== undefined ? { expiresAt: spec.expiresAt } : {}) };
    const layers = sorted(stack.layers.map((one) => one.id === existing.id ? layer : one));
    const focus = layer.focus === 'none' ? stack.focus : [...stack.focus.filter((id) => id !== layer.id), layer.id];
    return { stack: bump(stack, { counter, layers, focus }), id: existing.id, raised: true };
  }
  const counter = stack.counter + 1;
  const band = spec.band ?? 'float';
  const id = `ov${counter}`;
  // popup-host cascade: each new float steps 2 cells right and 1 down from the last, so two never sit exactly on top.
  const cascade = band === 'float' && spec.rect === undefined ? stack.layers.filter((layer) => layer.band === 'float').length : 0;
  const rect = spec.rect ?? (cascade ? { ...DEFAULT_RECT, dx: cascade * 2, dy: cascade } : DEFAULT_RECT);
  const layer: OverlayLayer = {
    id, kind: spec.kind, key, band, seq: counter, rect, focus: spec.focus ?? 'owns',
    ...(spec.blocking ? { blocking: true } : {}), ...(spec.pin ? { pin: spec.pin } : {}),
    ...(spec.ownerWorkspace ? { ownerWorkspace: spec.ownerWorkspace } : {}), ...(spec.opaque === false ? { opaque: false } : {}),
    ...(spec.expiresAt !== undefined ? { expiresAt: spec.expiresAt } : {}), ...(spec.props !== undefined ? { props: spec.props } : {}),
  };
  const focus = layer.focus === 'none' ? stack.focus : [...stack.focus, id];
  return { stack: bump(stack, { counter, layers: sorted([...stack.layers, layer]), focus }), id, raised: false };
}

/** Close one layer. Wherever it sat in the focus stack it leaves, so focus falls back to what was below (a stack, not one
 *  `previous` slot). Unknown id = unchanged stack (same rev). */
export function closeLayer(stack: OverlayStack, id: string): OverlayStack {
  if (!stack.layers.some((layer) => layer.id === id)) return stack;
  return bump(stack, { layers: stack.layers.filter((layer) => layer.id !== id), focus: stack.focus.filter((one, at) => at === 0 || one !== id) });
}

/** Close every layer of one kind (e.g. «close the toasts»). */
export function closeKind(stack: OverlayStack, kind: string): OverlayStack {
  return stack.layers.filter((layer) => layer.kind === kind).reduce((next, layer) => closeLayer(next, layer.id), stack);
}

/** Raise inside its own band only (a float never climbs over a modal). Focus is untouched. */
export function raiseLayer(stack: OverlayStack, id: string): OverlayStack {
  const layer = stack.layers.find((one) => one.id === id);
  if (!layer) return stack;
  const top = stack.layers.filter((one) => one.band === layer.band).at(-1);
  if (top?.id === id) return stack;
  const counter = stack.counter + 1;
  return bump(stack, { counter, layers: sorted(stack.layers.map((one) => one.id === id ? { ...one, seq: counter } : one)) });
}

/** Lower to the bottom of its own band. Focus is untouched. */
export function lowerLayer(stack: OverlayStack, id: string): OverlayStack {
  const layer = stack.layers.find((one) => one.id === id);
  if (!layer) return stack;
  const inBand = stack.layers.filter((one) => one.band === layer.band);
  if (inBand[0]?.id === id) return stack;
  const seq = Math.min(...inBand.map((one) => one.seq)) - 1;
  return bump(stack, { layers: sorted(stack.layers.map((one) => one.id === id ? { ...one, seq } : one)) });
}

/** Give a focusable layer the keys: it moves to the top of the focus STACK — its z does not change (classic bug 3). */
export function focusLayer(stack: OverlayStack, id: string): OverlayStack {
  const layer = stack.layers.find((one) => one.id === id);
  if (!layer || layer.focus === 'none' || stack.focus.at(-1) === id) return stack;
  return bump(stack, { focus: [...stack.focus.filter((one, at) => at === 0 || one !== id), id] });
}

/** Tab switch / tile focus: replace the z = 0 base. Layers above keep their place in the focus stack. */
export function setBase(stack: OverlayStack, base: BaseTarget): OverlayStack {
  if (stack.focus[0] === base) return stack;
  return bump(stack, { focus: [base, ...stack.focus.slice(1)] });
}

export function updateLayer(stack: OverlayStack, id: string, patch: { props?: unknown; rect?: OverlayRect; minimized?: boolean; pin?: 'space' | 'all'; expiresAt?: number; frame?: 'popup' | 'tile' | 'tab' }): OverlayStack {
  if (!stack.layers.some((one) => one.id === id)) return stack;
  const { frame, ...rest } = patch;
  const framed = (layer: OverlayLayer): OverlayLayer => {
    if (frame === undefined) return layer;
    const { frame: _old, ...plain } = layer;
    return frame === 'popup' ? plain : { ...plain, frame };
  };
  return bump(stack, { layers: stack.layers.map((one) => one.id === id ? framed({ ...one, ...rest }) : one) });
}

/** A workspace closed: its `pin:'space'` layers close with it (classic ownerWorkspaceId cascade); `pin:'all'` stays. */
export function closeWorkspace(stack: OverlayStack, ws: string): OverlayStack {
  return stack.layers.filter((layer) => layer.ownerWorkspace === ws && layer.pin !== 'all').reduce((next, layer) => closeLayer(next, layer.id), stack);
}

/** The earliest expiry among layers (undefined = none) — the owner arms ONE timeout for it, never a poll. */
export function nextExpiry(stack: OverlayStack): number | undefined {
  const due = stack.layers.flatMap((layer) => layer.expiresAt !== undefined ? [layer.expiresAt] : []);
  return due.length ? Math.min(...due) : undefined;
}

/** Remove every layer whose expiry has come. */
export function expireLayers(stack: OverlayStack, now: number): OverlayStack {
  return stack.layers.filter((layer) => layer.expiresAt !== undefined && layer.expiresAt <= now).reduce((next, layer) => closeLayer(next, layer.id), stack);
}

/** Is the layer shown in this workspace? `pin:'all'` everywhere; otherwise its owner workspace (or no owner = everywhere). */
export function shownIn(layer: OverlayLayer, workspace: string | undefined): boolean {
  if (layer.minimized || layer.frame === 'tab') return false;
  if (layer.pin === 'all' || layer.ownerWorkspace === undefined) return true;
  return workspace !== undefined && layer.ownerWorkspace === workspace;
}

export function visibleLayers(stack: OverlayStack, workspace: string | undefined): OverlayLayer[] {
  return stack.layers.filter((layer) => shownIn(layer, workspace));
}

const lengthOf = (length: Length, total: number): number => typeof length === 'number' ? Math.round(length) : Math.round(total * Number.parseFloat(length) / 100);

/** A rect for one view size, clamped inside the view (at least 1×1 when the view has room). */
export function resolveRect(rect: OverlayRect, view: { readonly cols: number; readonly rows: number }): Box {
  if (rect.grid) {
    const { region, cols, rows, col, row } = rect.grid;
    const regionW = Math.max(1, Math.min(view.cols, Math.round(view.cols * region / 100)));
    const cut = (at: number, parts: number, total: number): number => Math.round(at * total / parts);
    const x = view.cols - regionW + cut(col, cols, regionW);
    const y = cut(row, rows, view.rows);
    return { x, y, w: Math.max(1, cut(col + 1, cols, regionW) - cut(col, cols, regionW)), h: Math.max(1, cut(row + 1, rows, view.rows) - cut(row, rows, view.rows)) };
  }
  const w = Math.max(1, Math.min(view.cols, lengthOf(rect.w, view.cols)));
  const h = Math.max(1, Math.min(view.rows, lengthOf(rect.h, view.rows)));
  const left = rect.anchor === 'tl' || rect.anchor === 'bl' ? 0 : rect.anchor === 'tr' || rect.anchor === 'br' ? view.cols - w : Math.floor((view.cols - w) / 2);
  const top = rect.anchor === 'tl' || rect.anchor === 'tr' || rect.anchor === 'top' ? 0 : rect.anchor === 'bl' || rect.anchor === 'br' || rect.anchor === 'bottom' ? view.rows - h : Math.floor((view.rows - h) / 2);
  const x = Math.max(0, Math.min(view.cols - w, left + (rect.dx ?? 0)));
  const y = Math.max(0, Math.min(view.rows - h, top + (rect.dy ?? 0)));
  return { x, y, w, h };
}

// 출처: 대표 11-26 B2 — a popup is never resized below a frame, a title and two body rows.
export const MIN_LAYER_W = 12;
export const MIN_LAYER_H = 4;
const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

/** ELS-POPUP-MOVE: the rect moved by (dx, dy) cells in this view, kept inside it. The anchor stays (the rect stays relative);
 *  the stored offset is the EFFECTIVE one, so pushing against an edge never builds up an offset you must undo first. */
export function moveRect(rect: OverlayRect, view: { readonly cols: number; readonly rows: number }, dx: number, dy: number): OverlayRect {
  const now = resolveRect(rect, view);
  const base = resolveRect({ ...rect, dx: 0, dy: 0 }, view);
  const x = clamp(now.x + dx, 0, Math.max(0, view.cols - now.w));
  const y = clamp(now.y + dy, 0, Math.max(0, view.rows - now.h));
  const { dx: _dx, dy: _dy, ...rest } = rect;
  return { ...rest, ...(x - base.x ? { dx: x - base.x } : {}), ...(y - base.y ? { dy: y - base.y } : {}) };
}

/** ELS-POPUP-RESIZE: the box grown/shrunk by (dw, dh) cells with its top-left corner fixed (the bottom-right corner moves),
 *  at least MIN_LAYER_W×MIN_LAYER_H and inside the view. The result is in cells, anchored top-left. */
export function resizeRect(rect: OverlayRect, view: { readonly cols: number; readonly rows: number }, dw: number, dh: number): OverlayRect {
  const now = resolveRect(rect, view);
  const w = clamp(now.w + dw, Math.min(MIN_LAYER_W, view.cols - now.x), view.cols - now.x);
  const h = clamp(now.h + dh, Math.min(MIN_LAYER_H, view.rows - now.y), view.rows - now.y);
  return { anchor: 'tl', w, h, ...(now.x ? { dx: now.x } : {}), ...(now.y ? { dy: now.y } : {}) };
}

const inside = (box: Box, x: number, y: number): boolean => x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
const covers = (outer: Box, inner: Box): boolean => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

/** The layers to paint, bottom → top, with their boxes; a layer fully covered by an opaque layer above is skipped
 *  (classic `occluding`). */
export function paintOrder(stack: OverlayStack, view: { readonly cols: number; readonly rows: number }, workspace: string | undefined): { layer: OverlayLayer; box: Box }[] {
  const shown = visibleLayers(stack, workspace).map((layer) => ({ layer, box: resolveRect(layer.rect, view) }));
  return shown.filter((one, at) => !shown.slice(at + 1).some((above) => above.layer.opaque !== false && covers(above.box, one.box)));
}

export type Hit =
  | { readonly kind: 'layer'; readonly layer: OverlayLayer; readonly box: Box; readonly local: { readonly x: number; readonly y: number } }
  | { readonly kind: 'blocked'; readonly layer: OverlayLayer }
  | { readonly kind: 'base' };

/** z-order hit test, top → down (0-based view cells): `none` and `participates` layers are clicked through; inside a
 *  layer's box = that layer; outside a blocking layer = swallowed; otherwise keep going down; the bottom is the base. */
export function hitTest(stack: OverlayStack, view: { readonly cols: number; readonly rows: number }, x: number, y: number, workspace: string | undefined): Hit {
  const shown = visibleLayers(stack, workspace);
  for (let at = shown.length - 1; at >= 0; at--) {
    const layer = shown[at]!;
    const box = resolveRect(layer.rect, view);
    if (layer.focus === 'owns' && inside(box, x, y)) return { kind: 'layer', layer, box, local: { x: x - box.x, y: y - box.y } };
    if (layer.blocking) return { kind: 'blocked', layer };
  }
  return { kind: 'base' };
}

/** Key routing order for this workspace: focus stack top → down over visible key-takers, ending at the base. A blocking
 *  layer ends the chain (nothing below it, the base included, gets keys). Each target answers «pass» to hand the key on. */
export function keyRoute(stack: OverlayStack, workspace: string | undefined): readonly ({ kind: 'layer'; layer: OverlayLayer } | { kind: 'base'; target: string })[] {
  const byId = new Map(stack.layers.map((layer) => [layer.id, layer]));
  const route: ({ kind: 'layer'; layer: OverlayLayer } | { kind: 'base'; target: string })[] = [];
  // A blocking layer that is shown always heads the route even if focus moved elsewhere — it owns the input while open.
  const blocking = visibleLayers(stack, workspace).filter((layer) => layer.blocking && layer.focus !== 'none').at(-1);
  if (blocking) return [{ kind: 'layer', layer: blocking }];
  for (let at = stack.focus.length - 1; at >= 1; at--) {
    const layer = byId.get(stack.focus[at]!);
    if (layer && layer.focus !== 'none' && shownIn(layer, workspace)) route.push({ kind: 'layer', layer });
  }
  route.push({ kind: 'base', target: stack.focus[0] ?? '' });
  return route;
}

/** The focus owner for this workspace (keyRoute's head). */
export function focusTop(stack: OverlayStack, workspace: string | undefined): { kind: 'layer'; layer: OverlayLayer } | { kind: 'base'; target: string } {
  return keyRoute(stack, workspace)[0]!;
}

/** Esc: close the topmost focused layer of this workspace; at the base nothing changes (the caller keeps its own Esc). */
export function escape(stack: OverlayStack, workspace: string | undefined): { stack: OverlayStack; closed?: string } {
  const top = focusTop(stack, workspace);
  return top.kind === 'layer' ? { stack: closeLayer(stack, top.layer.id), closed: top.layer.id } : { stack };
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isLength = (value: unknown): value is Length => (typeof value === 'number' && Number.isFinite(value) && value >= 0)
  || (typeof value === 'string' && /^\d{1,3}(?:\.\d+)?%$/.test(value) && Number.parseFloat(value) <= 100);
const optInt = (value: unknown): boolean => value === undefined || (typeof value === 'number' && Number.isInteger(value));

// 출처: ELS-ELEMENT-HOST — a tile grid is at most 4×8 slots (more is not a workbench, it is noise).
const GRID_MAX_COLS = 4;
const GRID_MAX_ROWS = 8;
const smallInt = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
function parseGrid(value: unknown): GridSlot | undefined {
  if (!isRecord(value)) return undefined;
  const { region, cols, rows, col, row } = value;
  if (typeof region !== 'number' || !Number.isFinite(region) || region <= 0 || region > 100) return undefined;
  if (!smallInt(cols, GRID_MAX_COLS) || !smallInt(rows, GRID_MAX_ROWS) || cols < 1 || rows < 1 || !smallInt(col, cols - 1) || !smallInt(row, rows - 1)) return undefined;
  return { region, cols, rows, col, row };
}

export function parseRect(value: unknown): OverlayRect | undefined {
  if (!isRecord(value) || !ANCHORS.includes(value.anchor as Anchor) || !isLength(value.w) || !isLength(value.h) || !optInt(value.dx) || !optInt(value.dy)) return undefined;
  const grid = parseGrid(value.grid);
  if (value.grid !== undefined && !grid) return undefined;
  return { anchor: value.anchor as Anchor, w: value.w, h: value.h, ...(value.dx !== undefined ? { dx: value.dx as number } : {}), ...(value.dy !== undefined ? { dy: value.dy as number } : {}), ...(grid ? { grid } : {}) };
}

/** One layer from untrusted JSON (file restore, a pushed event) — anything malformed is dropped, never half-trusted. */
export function parseLayer(value: unknown): OverlayLayer | undefined {
  if (!isRecord(value)) return undefined;
  const { id, kind, key, band, seq, focus } = value;
  const rect = parseRect(value.rect);
  if (typeof id !== 'string' || !id || typeof kind !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(kind) || typeof key !== 'string' || key.length > 128
    || !LAYER_BANDS.includes(band as LayerBand) || typeof seq !== 'number' || !Number.isInteger(seq) || !FOCUS_LEVELS.includes(focus as FocusLevel) || !rect) return undefined;
  if (value.pin !== undefined && value.pin !== 'space' && value.pin !== 'all') return undefined;
  if (value.ownerWorkspace !== undefined && typeof value.ownerWorkspace !== 'string') return undefined;
  if (value.expiresAt !== undefined && (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt))) return undefined;
  return { id, kind, key, band: band as LayerBand, seq, rect, focus: focus as FocusLevel,
    ...(value.blocking === true ? { blocking: true } : {}), ...(value.pin ? { pin: value.pin as 'space' | 'all' } : {}),
    ...(typeof value.ownerWorkspace === 'string' ? { ownerWorkspace: value.ownerWorkspace } : {}),
    ...(value.minimized === true ? { minimized: true } : {}), ...(value.frame === 'tile' || value.frame === 'tab' ? { frame: value.frame } : {}), ...(value.opaque === false ? { opaque: false } : {}),
    ...(typeof value.expiresAt === 'number' ? { expiresAt: value.expiresAt } : {}), ...(value.props !== undefined ? { props: value.props } : {}) };
}

/** A whole stack from untrusted JSON: layers re-sorted, duplicate ids dropped, the focus stack kept only for ids that exist. */
export function parseStack(value: unknown): OverlayStack | undefined {
  if (!isRecord(value) || !Array.isArray(value.layers) || !Number.isInteger(value.rev) || !Number.isInteger(value.counter)) return undefined;
  const seen = new Set<string>();
  const layers = value.layers.flatMap((raw) => { const layer = parseLayer(raw); if (!layer || seen.has(layer.id)) return []; seen.add(layer.id); return [layer]; });
  const focusRaw = Array.isArray(value.focus) ? value.focus : [];
  const base = typeof focusRaw[0] === 'string' && /^(?:(?:pane|tile):.+)?$/.test(focusRaw[0]) ? focusRaw[0] : '';
  const focus = [base, ...focusRaw.slice(1).filter((id): id is string => typeof id === 'string' && seen.has(id) && layers.find((l) => l.id === id)!.focus !== 'none')];
  return { rev: value.rev as number, counter: Math.max(value.counter as number, ...layers.map((layer) => layer.seq), 0), layers: sorted(layers), focus: [...new Set(focus)] };
}
