import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── F6 LLM control · display-control ToolRuntime wrappers ──
//
// ROADMAP-ui-core-separation §4 Phase S1 (post-audit v2).
// PLAN-ui-core-separation-next-arc.md §1.1 / §2 Sub-PR S1.A.
//
// Bridges coordinator's internal surface-mutation API into the
// `ToolRuntime` shape so dashboard / skill-runner / future MCP
// exports can dispatch `MoveSurface` / `ResizeSurface` etc. via the
// shared `dispatchToolByName(name, args)` entry.
//
// S1.A scope (this landing):
//   • module skeleton + DisplayControlDeps interface
//   • MoveSurface / ResizeSurface tool runtimes
//   • registerDisplayControlRuntimes(deps) idempotent
//   • debug.log junctions per CLAUDE.md ("Debug instrumentation")
//
// S1.B / S1.C / S1.D add CloseSurface / DismissModal / SendMouseEvent /
// OpenContextMenu / GetHoverTooltip incrementally on this skeleton.
//
// Pattern reference: src/tool-runtime/surface-ui-runtimes.ts (Phase L
// · GetUIState / DescribeSurface / ObserveSurface). Same shape:
// build*Tool() + dispatch*() + *Runtime() + register*Runtimes(deps).


import type { DisplayMouseEvent, HitTarget, SurfaceId } from '../display/types.js';
import type {
  ContextMenuRegistry,
  Menu,
  MenuResult,
} from '../ui/context-menu-registry.js';
import type { MenuProviderRegistry } from '../ui/context-menu-providers.js';
import { debug } from '../debug/log.js';
import { registerToolRuntime } from './registry.js';
import type { ToolRuntime } from './types.js';

type Args = Record<string, unknown>;
type Out = { output: string };

/** Bounds shape returned/accepted by the coordinator move/resize
 *  surface API. Mirrors `ModalSurface['bounds']` (row/col/width/height
 *  in 1-indexed terminal cells) without importing the whole modal-stack
 *  module — keeps this runtime layer lightweight. */
export interface DisplayControlBounds {
  readonly row: number;
  readonly col: number;
  readonly width: number;
  readonly height: number;
}

/** Minimal coordinator surface used by display-control runtimes. The
 *  real `DisplayCoordinator` satisfies this structurally; tests can
 *  pass a tiny stub matching this shape. */
export interface DisplayControlCoordinator {
  surface(id: SurfaceId): { id: SurfaceId; kind: string; bounds?: DisplayControlBounds } | null;
  updateModalBounds(id: SurfaceId, nextBounds: DisplayControlBounds): boolean;
  /** S1.B — pop a modal off the stack. Modal-only contract:
   *  coordinator's private `closeSurface` handles the actual layer
   *  dispose; popModal is the canonical public entry that also
   *  restores focus to the previous active surface. */
  popModal(id: SurfaceId): void;
}

export interface DisplayControlDeps {
  /** Display coordinator. Optional so partial-deps boot (without an
   *  attached coordinator) doesn't crash; the runtimes return
   *  `ok:false, reason:'coordinator unavailable'` in that case. */
  coordinator?: DisplayControlCoordinator;
  /** S1.C — synthetic mouse-event entry. Wired to
   *  `mouseWiring.handleMouse` at runtime; tests pass a stub. Returns
   *  `true` when the wiring consumed the event (matches the existing
   *  handleMouse contract). */
  mouseDispatch?: (ev: DisplayMouseEvent) => boolean;
  /** S1.C — provider lookup for OpenContextMenu. Resolves a
   *  `HitTarget` to the menu data the dashboard would show on
   *  right-click. Optional because tests can register a stub menu
   *  directly and inject only the registry below. */
  menuProviderRegistry?: MenuProviderRegistry;
  /** S1.C — runtime menu lifecycle (registerMenu / showMenu /
   *  unregisterMenu). At dashboard boot this is the same singleton
   *  the right-click dispatcher uses; tests use an in-memory stub. */
  contextMenuRegistry?: ContextMenuRegistry;
  /** S1.D — tooltip resolver. The dashboard wires this to
   *  a surface resolver so an LLM can ask
   *  "what does the pill say?" without having to first hover. */
  tooltipResolver?: (target: HitTarget) => string | null;
}

let _depsRef: DisplayControlDeps = {};

function stringify(obj: unknown): Out {
  return { output: JSON.stringify(obj) };
}

// ─── MoveSurface ───────────────────────────────────────────────────

interface MoveSurfaceArgs {
  readonly surfaceId: string;
  readonly row: number;
  readonly col: number;
}

interface MoveSurfaceOut {
  readonly ok: boolean;
  readonly surfaceId: string;
  readonly reason?: string;
  readonly prevBounds?: DisplayControlBounds;
  readonly nextBounds?: DisplayControlBounds;
}

export function buildMoveSurfaceTool(): LLMToolSpec {
  return {
    name: 'MoveSurface',
    description:
      'Move a modal surface to a new screen position. Pass the surfaceId '
      + '(from GetUIState) plus the target row+col (1-indexed terminal '
      + 'coordinates, top-left of the modal frame). Width and height are '
      + 'preserved. Bounds are clamped to the current viewport by the '
      + 'coordinator. Returns ok=false with a reason when the surface is '
      + 'missing or not a modal-kind surface.',
    parameters: {
      type: 'object',
      properties: {
        surfaceId: { type: 'string', description: 'Target surface id (from GetUIState).' },
        row: { type: 'number', description: 'New top-left row (1-indexed).' },
        col: { type: 'number', description: 'New top-left col (1-indexed).' },
      },
      required: ['surfaceId', 'row', 'col'],
    },
  };
}

function parseMoveSurfaceArgs(raw: Args): MoveSurfaceArgs | { error: string } {
  const surfaceId = typeof raw.surfaceId === 'string' ? raw.surfaceId : '';
  const row = typeof raw.row === 'number' ? raw.row : Number.NaN;
  const col = typeof raw.col === 'number' ? raw.col : Number.NaN;
  if (!surfaceId) return { error: 'surfaceId required (string)' };
  if (!Number.isFinite(row) || !Number.isFinite(col)) {
    return { error: 'row + col required (numbers)' };
  }
  return { surfaceId, row: Math.floor(row), col: Math.floor(col) };
}

export function dispatchMoveSurface(raw: Args, deps: DisplayControlDeps = {}): MoveSurfaceOut {
  const parsed = parseMoveSurfaceArgs(raw);
  if ('error' in parsed) {
    return { ok: false, surfaceId: '', reason: parsed.error };
  }
  const coord = deps.coordinator;
  if (!coord) {
    return { ok: false, surfaceId: parsed.surfaceId, reason: 'coordinator unavailable' };
  }
  const surface = coord.surface(parsed.surfaceId as SurfaceId);
  if (!surface) {
    return { ok: false, surfaceId: parsed.surfaceId, reason: 'surface not found' };
  }
  if (surface.kind !== 'modal' || !surface.bounds) {
    return {
      ok: false,
      surfaceId: parsed.surfaceId,
      reason: `cannot move surface kind=${surface.kind}`,
    };
  }
  const prevBounds: DisplayControlBounds = {
    row: surface.bounds.row,
    col: surface.bounds.col,
    width: surface.bounds.width,
    height: surface.bounds.height,
  };
  const nextBounds: DisplayControlBounds = {
    row: parsed.row,
    col: parsed.col,
    width: prevBounds.width,
    height: prevBounds.height,
  };
  const ok = coord.updateModalBounds(parsed.surfaceId as SurfaceId, nextBounds);
  if (debug.enabled) {
    debug.log('display-control.MoveSurface', parsed.surfaceId, {
      from: prevBounds,
      to: nextBounds,
      ok,
    });
  }
  if (!ok) {
    return {
      ok: false,
      surfaceId: parsed.surfaceId,
      reason: 'updateModalBounds rejected',
      prevBounds,
      nextBounds,
    };
  }
  // Read back the post-clamp bounds for accurate response.
  const after = coord.surface(parsed.surfaceId as SurfaceId);
  const reportedNext: DisplayControlBounds = after?.bounds
    ? {
        row: after.bounds.row,
        col: after.bounds.col,
        width: after.bounds.width,
        height: after.bounds.height,
      }
    : nextBounds;
  return { ok: true, surfaceId: parsed.surfaceId, prevBounds, nextBounds: reportedNext };
}

export function moveSurfaceRuntime(): ToolRuntime<Args, Out> {
  return {
    id: 'display_move_surface',
    spec: buildMoveSurfaceTool(),
    async run(req) {
      return stringify(dispatchMoveSurface(req, _depsRef));
    },
  };
}

// ─── ResizeSurface ─────────────────────────────────────────────────

interface ResizeSurfaceArgs {
  readonly surfaceId: string;
  readonly width: number;
  readonly height: number;
}

interface ResizeSurfaceOut {
  readonly ok: boolean;
  readonly surfaceId: string;
  readonly reason?: string;
  readonly prevBounds?: DisplayControlBounds;
  readonly nextBounds?: DisplayControlBounds;
}

export function buildResizeSurfaceTool(): LLMToolSpec {
  return {
    name: 'ResizeSurface',
    description:
      'Resize a modal surface to new dimensions. Pass the surfaceId '
      + '(from GetUIState) plus the target width+height in terminal '
      + 'cells. Top-left position is preserved. Width and height must '
      + 'be >=1; the coordinator clamps the final bounds to the '
      + 'viewport. Returns ok=false with a reason when the surface is '
      + 'missing or not a modal-kind surface.',
    parameters: {
      type: 'object',
      properties: {
        surfaceId: { type: 'string', description: 'Target surface id (from GetUIState).' },
        width: { type: 'number', description: 'New width in cells (>=1).' },
        height: { type: 'number', description: 'New height in cells (>=1).' },
      },
      required: ['surfaceId', 'width', 'height'],
    },
  };
}

function parseResizeSurfaceArgs(raw: Args): ResizeSurfaceArgs | { error: string } {
  const surfaceId = typeof raw.surfaceId === 'string' ? raw.surfaceId : '';
  const width = typeof raw.width === 'number' ? raw.width : Number.NaN;
  const height = typeof raw.height === 'number' ? raw.height : Number.NaN;
  if (!surfaceId) return { error: 'surfaceId required (string)' };
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return { error: 'width + height required (numbers)' };
  }
  if (width < 1 || height < 1) {
    return { error: 'width and height must be >=1' };
  }
  return { surfaceId, width: Math.floor(width), height: Math.floor(height) };
}

export function dispatchResizeSurface(raw: Args, deps: DisplayControlDeps = {}): ResizeSurfaceOut {
  const parsed = parseResizeSurfaceArgs(raw);
  if ('error' in parsed) {
    return { ok: false, surfaceId: '', reason: parsed.error };
  }
  const coord = deps.coordinator;
  if (!coord) {
    return { ok: false, surfaceId: parsed.surfaceId, reason: 'coordinator unavailable' };
  }
  const surface = coord.surface(parsed.surfaceId as SurfaceId);
  if (!surface) {
    return { ok: false, surfaceId: parsed.surfaceId, reason: 'surface not found' };
  }
  if (surface.kind !== 'modal' || !surface.bounds) {
    return {
      ok: false,
      surfaceId: parsed.surfaceId,
      reason: `cannot resize surface kind=${surface.kind}`,
    };
  }
  const prevBounds: DisplayControlBounds = {
    row: surface.bounds.row,
    col: surface.bounds.col,
    width: surface.bounds.width,
    height: surface.bounds.height,
  };
  const nextBounds: DisplayControlBounds = {
    row: prevBounds.row,
    col: prevBounds.col,
    width: parsed.width,
    height: parsed.height,
  };
  const ok = coord.updateModalBounds(parsed.surfaceId as SurfaceId, nextBounds);
  if (debug.enabled) {
    debug.log('display-control.ResizeSurface', parsed.surfaceId, {
      from: prevBounds,
      to: nextBounds,
      ok,
    });
  }
  if (!ok) {
    return {
      ok: false,
      surfaceId: parsed.surfaceId,
      reason: 'updateModalBounds rejected',
      prevBounds,
      nextBounds,
    };
  }
  const after = coord.surface(parsed.surfaceId as SurfaceId);
  const reportedNext: DisplayControlBounds = after?.bounds
    ? {
        row: after.bounds.row,
        col: after.bounds.col,
        width: after.bounds.width,
        height: after.bounds.height,
      }
    : nextBounds;
  return { ok: true, surfaceId: parsed.surfaceId, prevBounds, nextBounds: reportedNext };
}

export function resizeSurfaceRuntime(): ToolRuntime<Args, Out> {
  return {
    id: 'display_resize_surface',
    spec: buildResizeSurfaceTool(),
    async run(req) {
      return stringify(dispatchResizeSurface(req, _depsRef));
    },
  };
}

// ─── CloseSurface + DismissModal (S1.B) ────────────────────────────
//
// Two tool entries · single dispatcher. CloseSurface is the general
// name (LLM may call it for any surface kind); DismissModal is the
// modal-explicit name with `modalId` alias. Both route through
// coordinator.popModal — the only public, focus-restoring close path.
// Non-modal kinds return ok=false with explicit reason (the LLM should
// use a different tool to dismiss panes / popovers / etc.).

interface CloseSurfaceArgs {
  readonly surfaceId: string;
}

interface CloseSurfaceOut {
  readonly ok: boolean;
  readonly surfaceId: string;
  readonly reason?: string;
}

export function buildCloseSurfaceTool(): LLMToolSpec {
  return {
    name: 'CloseSurface',
    description:
      'Close a modal surface. Pass the surfaceId (from GetUIState). '
      + 'Routes through coordinator.popModal so the previous active '
      + 'surface regains focus and the underlying frame repaints. '
      + 'Modal-only — for non-modal surfaces returns ok=false with '
      + 'reason. Use DismissModal as a more explicit alias.',
    parameters: {
      type: 'object',
      properties: {
        surfaceId: { type: 'string', description: 'Target surface id (from GetUIState).' },
      },
      required: ['surfaceId'],
    },
  };
}

export function buildDismissModalTool(): LLMToolSpec {
  return {
    name: 'DismissModal',
    description:
      'Dismiss a modal surface explicitly. Accepts either modalId or '
      + 'surfaceId (alias). Behavior matches CloseSurface — routes via '
      + 'coordinator.popModal with focus restoration. Use this when '
      + 'the intent is clearly modal-dismissal (approval / picker / '
      + 'dialog) rather than surface-close in general.',
    parameters: {
      type: 'object',
      properties: {
        modalId: { type: 'string', description: 'Target modal id (from GetUIState).' },
        surfaceId: { type: 'string', description: 'Alias for modalId.' },
      },
    },
  };
}

function parseCloseArgs(raw: Args): CloseSurfaceArgs | { error: string } {
  const surfaceId = typeof raw.surfaceId === 'string' ? raw.surfaceId : '';
  const modalId = typeof raw.modalId === 'string' ? raw.modalId : '';
  const id = surfaceId || modalId;
  if (!id) return { error: 'surfaceId (or modalId) required (string)' };
  return { surfaceId: id };
}

export function dispatchCloseSurface(raw: Args, deps: DisplayControlDeps = {}): CloseSurfaceOut {
  const parsed = parseCloseArgs(raw);
  if ('error' in parsed) {
    return { ok: false, surfaceId: '', reason: parsed.error };
  }
  const coord = deps.coordinator;
  if (!coord) {
    return { ok: false, surfaceId: parsed.surfaceId, reason: 'coordinator unavailable' };
  }
  const surface = coord.surface(parsed.surfaceId as SurfaceId);
  if (!surface) {
    return { ok: false, surfaceId: parsed.surfaceId, reason: 'surface not found' };
  }
  if (surface.kind !== 'modal') {
    return {
      ok: false,
      surfaceId: parsed.surfaceId,
      reason: `cannot close surface kind=${surface.kind} (modal only)`,
    };
  }
  coord.popModal(parsed.surfaceId as SurfaceId);
  if (debug.enabled) {
    debug.log('display-control.close', parsed.surfaceId, { kind: surface.kind });
  }
  return { ok: true, surfaceId: parsed.surfaceId };
}

export function closeSurfaceRuntime(): ToolRuntime<Args, Out> {
  return {
    id: 'display_close_surface',
    spec: buildCloseSurfaceTool(),
    async run(req) {
      return stringify(dispatchCloseSurface(req, _depsRef));
    },
  };
}

export function dismissModalRuntime(): ToolRuntime<Args, Out> {
  return {
    id: 'display_dismiss_modal',
    spec: buildDismissModalTool(),
    async run(req) {
      return stringify(dispatchCloseSurface(req, _depsRef));
    },
  };
}

// ─── SendMouseEvent (S1.C) ─────────────────────────────────────────
//
// Synthesize a DisplayMouseEvent and feed it to the wiring. Lets an
// LLM trigger UI flows that are reachable only via mouse (right-click
// menus, modal-button click, scroll over a pane) without having to
// first hover. The wiring re-runs its full preflight chain (hit
// classification, modal forward, hover tracker) so downstream
// consumers see exactly what they would on a real click.

const ALLOWED_MOUSE_TYPES: readonly DisplayMouseEvent['type'][] = [
  'click',
  'double-click',
  'right-click',
  'scroll-up',
  'scroll-down',
  'drag',
  'release',
  'motion',
];

interface SendMouseEventArgs {
  readonly type: DisplayMouseEvent['type'];
  readonly row: number;
  readonly col: number;
  readonly shift?: boolean;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
}

interface SendMouseEventOut {
  readonly ok: boolean;
  readonly consumed?: boolean;
  readonly type?: DisplayMouseEvent['type'];
  readonly row?: number;
  readonly col?: number;
  readonly reason?: string;
}

export function buildSendMouseEventTool(): LLMToolSpec {
  return {
    name: 'SendMouseEvent',
    description:
      'Synthesize a mouse event at a specific screen cell and feed it '
      + 'through the dashboard mouse wiring. Use this to trigger UI '
      + 'flows that require a click / right-click / scroll (open a '
      + 'context menu, activate a modal button, scroll a pane). row + '
      + 'col are 1-indexed terminal cells. Allowed types: click · '
      + 'double-click · right-click · scroll-up · scroll-down · drag · '
      + 'release · motion. Returns ok=false if the wiring is not '
      + 'attached or the type is unknown.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Mouse event type (click | right-click | …).' },
        row: { type: 'number', description: 'Target row (1-indexed terminal cell).' },
        col: { type: 'number', description: 'Target col (1-indexed terminal cell).' },
        shift: { type: 'boolean', description: 'Shift modifier.' },
        ctrl: { type: 'boolean', description: 'Ctrl modifier.' },
        alt: { type: 'boolean', description: 'Alt modifier.' },
      },
      required: ['type', 'row', 'col'],
    },
  };
}

function parseSendMouseEventArgs(raw: Args): SendMouseEventArgs | { error: string } {
  const type = typeof raw.type === 'string' ? raw.type : '';
  const row = typeof raw.row === 'number' ? raw.row : Number.NaN;
  const col = typeof raw.col === 'number' ? raw.col : Number.NaN;
  if (!type) return { error: 'type required (string)' };
  if (!ALLOWED_MOUSE_TYPES.includes(type as DisplayMouseEvent['type'])) {
    return { error: `unknown mouse type "${type}"` };
  }
  if (!Number.isFinite(row) || !Number.isFinite(col)) {
    return { error: 'row + col required (numbers)' };
  }
  return {
    type: type as DisplayMouseEvent['type'],
    row: Math.floor(row),
    col: Math.floor(col),
    shift: raw.shift === true ? true : undefined,
    ctrl: raw.ctrl === true ? true : undefined,
    alt: raw.alt === true ? true : undefined,
  };
}

export function dispatchSendMouseEvent(
  raw: Args,
  deps: DisplayControlDeps = {},
): SendMouseEventOut {
  const parsed = parseSendMouseEventArgs(raw);
  if ('error' in parsed) {
    return { ok: false, reason: parsed.error };
  }
  const dispatch = deps.mouseDispatch;
  if (!dispatch) {
    return { ok: false, reason: 'mouseDispatch unavailable' };
  }
  const ev: DisplayMouseEvent = {
    type: parsed.type,
    row: parsed.row,
    col: parsed.col,
    ...(parsed.shift ? { shift: true } : {}),
    ...(parsed.ctrl ? { ctrl: true } : {}),
    ...(parsed.alt ? { alt: true } : {}),
  };
  let consumed = false;
  try {
    consumed = dispatch(ev) === true;
  } catch (err) {
    if (debug.enabled) {
      debug.log('display-control.SendMouseEvent.error', parsed.type, {
        row: parsed.row,
        col: parsed.col,
        message: (err as Error)?.message,
      }, { level: 'error' });
    }
    return {
      ok: false,
      type: parsed.type,
      row: parsed.row,
      col: parsed.col,
      reason: `mouseDispatch threw: ${(err as Error)?.message ?? 'unknown'}`,
    };
  }
  if (debug.enabled) {
    debug.log('display-control.SendMouseEvent', parsed.type, {
      row: parsed.row,
      col: parsed.col,
      consumed,
    });
  }
  return { ok: true, consumed, type: parsed.type, row: parsed.row, col: parsed.col };
}

export function sendMouseEventRuntime(): ToolRuntime<Args, Out> {
  return {
    id: 'display_send_mouse_event',
    spec: buildSendMouseEventTool(),
    async run(req) {
      return stringify(dispatchSendMouseEvent(req, _depsRef));
    },
  };
}

// ─── OpenContextMenu (S1.C) ────────────────────────────────────────
//
// Resolve a HitTarget to its registered Menu (via MenuProviderRegistry)
// and open it through the live ContextMenuRegistry. Fire-and-forget:
// the menu's eventual MenuResult is recorded for telemetry but the
// tool returns as soon as the menu is mounted — the LLM is expected
// to follow up with GetUIState / SendMouseEvent to interact with it.
// Returns ok=false with a clear reason for unrouted targets.

interface OpenContextMenuArgs {
  readonly target: HitTarget;
  readonly row: number;
  readonly col: number;
}

interface OpenContextMenuOut {
  readonly ok: boolean;
  readonly opened?: boolean;
  readonly menuId?: string;
  readonly reason?: string;
}

export function buildOpenContextMenuTool(): LLMToolSpec {
  return {
    name: 'OpenContextMenu',
    description:
      'Open the context menu that the dashboard would show on right-'
      + 'click for a given hit target. Pass `target` (a HitTarget — '
      + 'kind plus per-kind detail, e.g. { kind: "pill", name: "model" } '
      + 'or { kind: "pane-title", paneId: "wd" }) and the screen anchor '
      + 'position (row + col, 1-indexed). The tool resolves the menu via '
      + 'the registered MenuProvider, registers it with the live '
      + 'ContextMenuRegistry, and calls showMenu. Returns ok=false when '
      + 'no provider matched the target (the LLM should pick a '
      + 'different target rather than retry).',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'object',
          description:
            'HitTarget descriptor — { kind, ...kindSpecificFields }. See '
            + 'src/display/types.ts::HitTarget for the union.',
        },
        row: { type: 'number', description: 'Anchor row (1-indexed).' },
        col: { type: 'number', description: 'Anchor col (1-indexed).' },
      },
      required: ['target', 'row', 'col'],
    },
  };
}

function parseOpenContextMenuArgs(raw: Args): OpenContextMenuArgs | { error: string } {
  const target = raw.target;
  const row = typeof raw.row === 'number' ? raw.row : Number.NaN;
  const col = typeof raw.col === 'number' ? raw.col : Number.NaN;
  if (!target || typeof target !== 'object') {
    return { error: 'target required (HitTarget object)' };
  }
  const kind = (target as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !kind) {
    return { error: 'target.kind required (string)' };
  }
  if (!Number.isFinite(row) || !Number.isFinite(col)) {
    return { error: 'row + col required (numbers)' };
  }
  return {
    target: target as HitTarget,
    row: Math.floor(row),
    col: Math.floor(col),
  };
}

export function dispatchOpenContextMenu(
  raw: Args,
  deps: DisplayControlDeps = {},
): OpenContextMenuOut {
  const parsed = parseOpenContextMenuArgs(raw);
  if ('error' in parsed) {
    return { ok: false, reason: parsed.error };
  }
  const providers = deps.menuProviderRegistry;
  const registry = deps.contextMenuRegistry;
  if (!providers) {
    return { ok: false, reason: 'menuProviderRegistry unavailable' };
  }
  if (!registry) {
    return { ok: false, reason: 'contextMenuRegistry unavailable' };
  }
  let menu: Menu | null;
  try {
    menu = providers.resolve(parsed.target);
  } catch (err) {
    return {
      ok: false,
      reason: `menuProviderRegistry.resolve threw: ${(err as Error)?.message ?? 'unknown'}`,
    };
  }
  if (!menu) {
    return { ok: false, opened: false, reason: 'no menu provider for target' };
  }
  const handle = registry.registerMenu(menu);
  // Fire-and-forget: showMenu returns a Promise that resolves on the
  // user's pick. We don't await — the LLM follows up with GetUIState.
  // We DO unregister the handle once the promise settles so memory
  // doesn't grow indefinitely if the LLM opens many menus.
  void registry
    .showMenu(handle, { x: parsed.col, y: parsed.row })
    .catch(() => undefined as MenuResult | undefined)
    .finally(() => {
      try { registry.unregisterMenu(handle); } catch { /* idempotent */ }
    });
  if (debug.enabled) {
    debug.log('display-control.OpenContextMenu', parsed.target.kind, {
      row: parsed.row,
      col: parsed.col,
      menuId: handle,
    });
  }
  return { ok: true, opened: true, menuId: handle };
}

export function openContextMenuRuntime(): ToolRuntime<Args, Out> {
  return {
    id: 'display_open_context_menu',
    spec: buildOpenContextMenuTool(),
    async run(req) {
      return stringify(dispatchOpenContextMenu(req, _depsRef));
    },
  };
}

// ─── GetHoverTooltip (S1.D) ────────────────────────────────────────
//
// Look up the tooltip text the dashboard would render on stable-hover
// for a given hit target. Uses the injected resolver (wired to
// a surface resolver at runtime). Returns null when no
// resolver provides a tooltip for the target — distinct from
// `ok:false` which signals a contract problem (missing dep / bad args).

interface GetHoverTooltipArgs {
  readonly target: HitTarget;
}

interface GetHoverTooltipOut {
  readonly ok: boolean;
  readonly tooltip?: string | null;
  readonly target?: HitTarget;
  readonly reason?: string;
}

export function buildGetHoverTooltipTool(): LLMToolSpec {
  return {
    name: 'GetHoverTooltip',
    description:
      'Read the tooltip text the dashboard would show on stable-hover '
      + 'for a HitTarget. Pass `target` (a HitTarget, same shape as '
      + 'OpenContextMenu). Returns tooltip=null when no provider has '
      + 'a tooltip for that target — that is not an error, just "this '
      + 'cell has nothing to say". ok=false is reserved for contract '
      + 'failures (missing resolver, malformed target).',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'object',
          description: 'HitTarget descriptor — { kind, ...kindSpecificFields }.',
        },
      },
      required: ['target'],
    },
  };
}

function parseGetHoverTooltipArgs(raw: Args): GetHoverTooltipArgs | { error: string } {
  const target = raw.target;
  if (!target || typeof target !== 'object') {
    return { error: 'target required (HitTarget object)' };
  }
  const kind = (target as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !kind) {
    return { error: 'target.kind required (string)' };
  }
  return { target: target as HitTarget };
}

export function dispatchGetHoverTooltip(
  raw: Args,
  deps: DisplayControlDeps = {},
): GetHoverTooltipOut {
  const parsed = parseGetHoverTooltipArgs(raw);
  if ('error' in parsed) {
    return { ok: false, reason: parsed.error };
  }
  const resolver = deps.tooltipResolver;
  if (!resolver) {
    return { ok: false, target: parsed.target, reason: 'tooltipResolver unavailable' };
  }
  let tooltip: string | null;
  try {
    tooltip = resolver(parsed.target);
  } catch (err) {
    return {
      ok: false,
      target: parsed.target,
      reason: `tooltipResolver threw: ${(err as Error)?.message ?? 'unknown'}`,
    };
  }
  if (debug.enabled) {
    debug.log('display-control.GetHoverTooltip', parsed.target.kind, {
      hasTooltip: tooltip !== null && tooltip !== undefined,
    });
  }
  return { ok: true, tooltip: tooltip ?? null, target: parsed.target };
}

export function getHoverTooltipRuntime(): ToolRuntime<Args, Out> {
  return {
    id: 'display_get_hover_tooltip',
    spec: buildGetHoverTooltipTool(),
    async run(req) {
      return stringify(dispatchGetHoverTooltip(req, _depsRef));
    },
  };
}

// ─── Registration ──────────────────────────────────────────────────

let registered = false;

/** Idempotent registration — typically called from dashboard boot.
 *  The deps closure is captured by reference so a later call updates
 *  the surface used by in-flight runs (test harness / hot reload). */
export function registerDisplayControlRuntimes(deps: DisplayControlDeps): void {
  _depsRef = { ...deps };
  if (registered) return;
  registerToolRuntime(moveSurfaceRuntime());
  registerToolRuntime(resizeSurfaceRuntime());
  registerToolRuntime(closeSurfaceRuntime());
  registerToolRuntime(dismissModalRuntime());
  registerToolRuntime(sendMouseEventRuntime());
  registerToolRuntime(openContextMenuRuntime());
  registerToolRuntime(getHoverTooltipRuntime());
  registered = true;
  if (debug.enabled) {
    debug.log('display-control.register', 'idempotent', {
      tools: [
        'MoveSurface',
        'ResizeSurface',
        'CloseSurface',
        'DismissModal',
        'SendMouseEvent',
        'OpenContextMenu',
        'GetHoverTooltip',
      ],
    });
  }
}

/** Test-only — reset the global registration + deps. */
export function __resetDisplayControlRuntimesForTest(): void {
  _depsRef = {};
  registered = false;
}
