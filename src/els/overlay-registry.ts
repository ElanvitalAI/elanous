// ELS-ZAXIS S3 — the els server's overlay registry (ELS-ELN-LAYERS §1 «els server» · §2-2 · §2-4): the ONE overlay stack in
// memory, written to <els>/overlays.json only when it changes (restart restore — no DB, nothing on the hot path), pushed
// to watchers on change, and toasts expired by ONE timer armed for the next due layer (never a poll). Element props are
// validated by the element registry before anything opens, and each element's state lives in a server-side file
// <els>/elements/<kind>/<key>.json (the client is volatile).

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import type { ElsResult } from './core.js';
import { elementOf } from './elements/index.js';
import type { ElementContext, ElementDef, ElementFrame } from './elements/element.js';
import { ELEMENT_FRAMES, frameOf, nextFrame, openFrame, openingOrder, tileRects, WORKBENCH_KINDS } from './element-frames.js';
import {
  closeLayer, closeWorkspace, emptyStack, expireLayers, focusLayer, lowerLayer, nextExpiry, openLayer, parseStack, raiseLayer, updateLayer,
  moveRect, resizeRect, type OverlayLayer, type OverlayStack,
} from './overlay-stack.js';

export const OVERLAY_ACTIONS = ['open', 'close', 'raise', 'lower', 'focus', 'update', 'list', 'frame', 'workbench', 'move', 'resize'] as const;
export type OverlayAction = (typeof OVERLAY_ACTIONS)[number];

export interface OverlayRequest {
  readonly action: OverlayAction;
  readonly kind?: string;
  readonly key?: string;
  readonly id?: string;
  readonly props?: unknown;
  /** Owner workspace id (the attach view shows pin:'space' layers only in it). */
  readonly ws?: string;
  readonly pin?: 'space' | 'all';
  readonly ttlMs?: number;
  /** ELS-ELEMENT-HOST: open → the frame (popup · tile · tab; omitted = the size rule for `view`, else popup);
   *  frame → the new frame or 'next' (popup → tile → tab → popup). */
  readonly frame?: string;
  /** The caller's view size, for the size rule when `frame` is omitted. */
  /** ELS-POPUP-MOVE/RESIZE (move · resize): the change in cells (the asking view's size is `view`; the rect is relative). */
  readonly dx?: number;
  readonly dy?: number;
  readonly view?: { readonly cols: number; readonly rows: number };
}

// 출처: #40244 ELS-ELN-LAYERS §2-4 — a toast lives seconds; an hour is the ceiling for anything with a ttl.
export const MAX_TTL_MS = 3_600_000;
const KEY = /^[A-Za-z0-9._-]{1,64}$/;

export interface OverlayRegistry {
  readonly stack: () => OverlayStack;
  readonly apply: (request: OverlayRequest) => ElsResult;
  /** The owner workspace of a layer (by id), for the door's own-workspace check. */
  readonly workspaceOfLayer: (id: string) => string | undefined;
  /** The workspace a request acts on: open → its `ws`; any other act → the owner workspace of the layer it targets
   *  (by id, or the top layer of `kind`[+`key`]) — the door's own-workspace check. */
  readonly workspaceOfRequest: (request: OverlayRequest) => string | undefined;
  readonly closeWorkspace: (ws: string) => void;
  readonly onChange: (listener: (stack: OverlayStack) => void) => { readonly dispose: () => void };
  readonly dispose: () => void;
}

export interface OverlayRegistryOptions {
  readonly dir: string;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Server-side element context (the Obsidian vault from config obsidian.vault), read at each hydrate. */
  readonly context?: () => ElementContext;
  /** ELS-ELEMENT-HOST: layers that entered the tab frame (a host pane must draw them) and layers that left it (frame
   *  change or close — their host pane goes). Called after the stack is committed; the server spawns/closes panes. */
  readonly onTabHosts?: (change: { readonly entered: readonly OverlayLayer[]; readonly left: readonly OverlayLayer[] }) => ReadonlyMap<string, string> | void;
}

const writeAtomic = (file: string, text: string): void => {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, file);
};

export function createOverlayRegistry(options: OverlayRegistryOptions): OverlayRegistry {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; });
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const file = join(options.dir, 'overlays.json');
  const elementsDir = join(options.dir, 'elements');
  let current: OverlayStack;
  try { current = expireLayers(parseStack(JSON.parse(readFileSync(file, 'utf8'))) ?? emptyStack(), now()); } catch { current = emptyStack(); }
  const listeners = new Set<(stack: OverlayStack) => void>();
  let timer: unknown;
  let unique = 0;
  /** ELS-ELEMENT-HOST-FU ①: the host panes the last commit spawned (layer id → pane), so a `frame` answer can name the tab. */
  let lastHosts: ReadonlyMap<string, string> | undefined;
  const hostOf = (id: string): string | undefined => lastHosts?.get(id);   // read after a commit (a closure: no stale narrowing)

  const stateFile = (kind: string, key: string): string => join(elementsDir, kind, `${key}.json`);
  const saveElement = (kind: string, key: string, props: unknown): void => {
    try { mkdirSync(join(elementsDir, kind), { recursive: true, mode: 0o700 }); writeAtomic(stateFile(kind, key), `${JSON.stringify({ kind, key, props, at: now() })}\n`); }
    catch { /* the layer still shows; its state file is a restart convenience */ }
  };
  const arm = (): void => {
    if (timer !== undefined) { clearTimer(timer); timer = undefined; }
    const due = nextExpiry(current);
    if (due === undefined) return;
    timer = setTimer(() => { timer = undefined; commit(expireLayers(current, now())); }, Math.max(0, due - now()));
  };
  const commit = (next: OverlayStack): void => {
    if (next === current) { arm(); return; }
    const gone = current.layers.filter((layer) => !next.layers.some((one) => one.id === layer.id));
    const tabbed = (stack: OverlayStack): Map<string, OverlayLayer> => new Map(stack.layers.filter((layer) => layer.frame === 'tab').map((layer) => [layer.id, layer]));
    const before = tabbed(current);
    const after = tabbed(next);
    current = next;
    for (const layer of gone) if (elementOf(layer.kind)?.defaults.ttlMs !== undefined) rmSync(stateFile(layer.kind, layer.key), { force: true });
    try { mkdirSync(options.dir, { recursive: true, mode: 0o700 }); writeAtomic(file, `${JSON.stringify(current)}\n`); } catch { /* memory stays the truth */ }
    arm();
    for (const listener of listeners) { try { listener(current); } catch { /* one watcher must not break the others */ } }
    const entered = [...after.values()].filter((layer) => !before.has(layer.id));
    const left = [...before.values()].filter((layer) => !after.has(layer.id));
    lastHosts = undefined;
    if (entered.length || left.length) { try { lastHosts = options.onTabHosts?.({ entered, left }) ?? undefined; } catch { /* the layer stays; the host is a view */ } }
  };
  /** ELS-ELEMENT-HOST: every tile-frame layer gets its slot of the tile grid (opening order), re-run after any tile change. */
  const layoutTiles = (stack: OverlayStack): OverlayStack => {
    const tiles = stack.layers.filter((layer) => layer.frame === 'tile').sort((a, b) => openingOrder(a.id) - openingOrder(b.id));
    const rects = tileRects(tiles.length);
    return tiles.reduce((next, layer, slot) => JSON.stringify(layer.rect) === JSON.stringify(rects[slot]) ? next : updateLayer(next, layer.id, { rect: rects[slot]! }), stack);
  };
  /** Put a layer in `frame`: popup gets the element's own rect back, tab keeps its rect (hidden here), tiles re-layout. */
  const setFrame = (stack: OverlayStack, layer: OverlayLayer, def: ElementDef<unknown>, frame: ElementFrame): OverlayStack => {
    if (frameOf(layer) === frame) return stack;
    const others = stack.layers.filter((one) => one.kind === layer.kind && one.key !== layer.key).length;
    const rect = frame === 'popup' ? def.rect(def.props(layer.props) ?? layer.props, others) : undefined;
    return layoutTiles(updateLayer(stack, layer.id, { frame, ...(rect ? { rect } : {}) }));
  };
  arm();

  const hydrate = <P>(def: { hydrate?: (props: P, context: ElementContext) => P }, props: P): P => {
    if (!def.hydrate) return props;
    let context: ElementContext = {};
    try { context = options.context?.() ?? {}; } catch { /* no context: the element says what is missing */ }
    return def.hydrate(props, context);
  };
  const ok = (value: unknown): ElsResult => ({ exitCode: 0, message: JSON.stringify(value) });
  const bad = (message: string): ElsResult => ({ exitCode: 2, message: `els overlay: ${message}` });
  const target = (request: OverlayRequest) => request.id ? current.layers.find((layer) => layer.id === request.id)
    : request.kind ? current.layers.filter((layer) => layer.kind === request.kind && (request.key === undefined || layer.key === request.key)).at(-1) : undefined;

  const registry: OverlayRegistry = {
    stack: () => current,
    workspaceOfLayer: (id) => current.layers.find((layer) => layer.id === id)?.ownerWorkspace,
    workspaceOfRequest: (request) => request.action === 'open' || request.action === 'workbench' ? request.ws : target(request)?.ownerWorkspace,
    closeWorkspace: (ws) => commit(layoutTiles(closeWorkspace(current, ws))),
    onChange: (listener) => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    dispose: () => { if (timer !== undefined) clearTimer(timer); timer = undefined; listeners.clear(); },
    apply(request) {
      if (!(OVERLAY_ACTIONS as readonly string[]).includes(request.action)) return bad(`unknown action ${JSON.stringify(request.action)} — ${OVERLAY_ACTIONS.join(' · ')}`);
      if (request.action === 'list') return ok(current);
      if (request.action === 'open') {
        const def = typeof request.kind === 'string' ? elementOf(request.kind) : undefined;
        if (!def) return bad(`unknown element kind ${JSON.stringify(request.kind)}`);
        if (request.key !== undefined && !KEY.test(request.key)) return bad('key must be 1-64 of A-Z a-z 0-9 . _ -');
        const checked = def.props(request.props);
        if (checked === undefined) return bad(`${def.kind}: props refused`);
        const frame = openFrame(def, request.frame, request.view);
        if (!(ELEMENT_FRAMES as readonly string[]).includes(frame)) return bad(frame);
        const props = hydrate(def, checked);
        if (request.ttlMs !== undefined && (!Number.isInteger(request.ttlMs) || request.ttlMs < 1 || request.ttlMs > MAX_TTL_MS)) return bad(`ttlMs must be 1..${MAX_TTL_MS}`);
        if (request.pin !== undefined && request.pin !== 'space' && request.pin !== 'all') return bad('pin must be space|all');
        const key = request.key ?? (def.defaults.multi ? `${def.kind}-${now().toString(36)}-${++unique}` : 'default');
        const others = current.layers.filter((layer) => layer.kind === def.kind && layer.key !== key).length;
        const ttl = request.ttlMs ?? def.defaults.ttlMs;
        const pin = request.pin ?? def.pinFor?.(props) ?? def.defaults.pin;
        const opened = openLayer(current, { kind: def.kind, key, band: def.defaults.band, focus: def.defaults.focus, rect: def.rect(props, others), props,
          ...(def.defaults.blocking ? { blocking: true } : {}), ...(pin ? { pin } : {}), ...(request.ws ? { ownerWorkspace: request.ws } : {}),
          ...(ttl !== undefined ? { expiresAt: now() + ttl } : {}) });
        saveElement(def.kind, key, props);
        const placed = opened.stack.layers.find((one) => one.id === opened.id)!;
        lastHosts = undefined;
        commit(setFrame(opened.stack, placed, def, frame as ElementFrame));
        const pane = frame === 'tab' ? hostOf(opened.id) : undefined;
        return ok({ id: opened.id, kind: def.kind, key, raised: opened.raised, frame, ...(pane ? { pane } : {}) });
      }
      if (request.action === 'workbench') {
        // 대표 11-26 workbench preset: each registered kind opens (or is raised) as a tile; eln stays the work pane on the left.
        const opened: string[] = [];
        const skipped: string[] = [];
        for (const kind of WORKBENCH_KINDS) {
          const def = elementOf(kind);
          if (!def || !def.frames.includes('tile')) { skipped.push(kind); continue; }
          // An element already open keeps its state: it only moves into the grid (open again would refresh its props).
          const open = current.layers.find((one) => one.kind === kind && one.key === 'default');
          const answer = open ? registry.apply({ action: 'frame', id: open.id, frame: 'tile' })
            : registry.apply({ action: 'open', kind, frame: 'tile', ...(request.ws ? { ws: request.ws } : {}) });
          if (answer.exitCode === 0) opened.push(kind); else skipped.push(kind);
        }
        return ok({ opened, skipped, note: skipped.length ? `not registered (or no tile frame): ${skipped.join(', ')}` : '' });
      }
      const layer = target(request);
      if (!layer) return { exitCode: 1, message: `els overlay ${request.action}: no such layer` };
      if (request.action === 'frame') {
        const def = elementOf(layer.kind);
        if (!def) return bad(`${layer.kind}: unknown element kind`);
        const frame = request.frame === 'next' ? nextFrame(frameOf(layer), def.frames) : request.frame;
        if (!(ELEMENT_FRAMES as readonly (string | undefined)[]).includes(frame)) return bad(`frame must be ${ELEMENT_FRAMES.join('|')}|next`);
        if (!def.frames.includes(frame as ElementFrame)) return bad(`${def.kind} opens as ${def.frames.join('|')} only`);
        lastHosts = undefined;
        commit(setFrame(current, layer, def, frame as ElementFrame));
        const pane = frame === 'tab' ? hostOf(layer.id) : undefined;
        return ok({ id: layer.id, kind: layer.kind, key: layer.key, frame, ...(pane ? { pane } : {}) });
      }
      if (request.action === 'close') { commit(layer.frame === 'tile' ? layoutTiles(closeLayer(current, layer.id)) : closeLayer(current, layer.id)); return ok({ id: layer.id, closed: true }); }
      if (request.action === 'raise') { commit(raiseLayer(current, layer.id)); return ok({ id: layer.id }); }
      if (request.action === 'lower') { commit(lowerLayer(current, layer.id)); return ok({ id: layer.id }); }
      if (request.action === 'focus') { commit(focusLayer(current, layer.id)); return ok({ id: layer.id }); }
      if (request.action === 'move' || request.action === 'resize') {
        // 대표 11-26 B2: a person drags or nudges a layer — the delta is applied in the asking view, the rect stays in the stack.
        const step = (value: unknown): number | undefined => value === undefined ? 0 : Number.isInteger(value) && Math.abs(value as number) <= 1000 ? value as number : undefined;
        const dx = step(request.dx);
        const dy = step(request.dy);
        const view = request.view;
        if (dx === undefined || dy === undefined) return bad(`${request.action}: dx/dy must be whole cells (|n| ≤ 1000)`);
        if (layer.frame) return bad(`${request.action}: a ${layer.frame} is placed by els — switch it to a popup first (ctrl+t)`);
        if (!view || !Number.isInteger(view.cols) || !Number.isInteger(view.rows) || view.cols < 1 || view.rows < 1 || view.cols > 10_000 || view.rows > 10_000) return bad(`${request.action}: view {cols, rows} required`);
        const rect = request.action === 'move' ? moveRect(layer.rect, view, dx, dy) : resizeRect(layer.rect, view, dx, dy);
        if (JSON.stringify(rect) !== JSON.stringify(layer.rect)) commit(updateLayer(current, layer.id, { rect }));
        return ok({ id: layer.id, rect });
      }
      const def = elementOf(layer.kind);
      const checked = def?.props(request.props);
      if (!def || checked === undefined) return bad(`${layer.kind}: props refused`);
      const props = hydrate(def, checked);
      saveElement(layer.kind, layer.key, props);
      const pin = def.pinFor?.(props);
      commit(updateLayer(current, layer.id, { props, ...(pin && pin !== layer.pin ? { pin } : {}) }));
      return ok({ id: layer.id });
    },
  };
  return registry;
}

// 출처: same bound as subscribe — a watcher that does not read stops getting events once this much is queued.
const WATCH_MAX_QUEUED_BYTES = 1_048_576;

/** `overlay-watch`: one long connection — the stack at once, then every changed stack. Read-only; closing it unsubscribes. */
export function serveOverlayWatch(registry: OverlayRegistry, socket: Socket): void {
  if (socket.destroyed) return;
  const send = (stack: OverlayStack): void => {
    if (socket.destroyed || socket.writableLength > WATCH_MAX_QUEUED_BYTES) return;
    socket.write(`${JSON.stringify({ type: 'overlay', stack })}\n`);
  };
  const sub = registry.onChange(send);
  const stop = (): void => sub.dispose();
  socket.on('close', stop);
  socket.on('error', stop);
  send(registry.stack());
}
