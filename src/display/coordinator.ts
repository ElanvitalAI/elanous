import type {
  Action,
  DisplayCommand,
  DisplayDisposable,
  DisplayHandle,
  DisplayHooks,
  DisplayKeyBinding,
  DisplayKeyRouteResult,
  DisplayRenderRequest,
  DisplaySnapshot,
  DisplayMouseEvent,
  DisplaySurface,
  FocusNode,
  FocusScope,
  KeyEvent,
  ModalTier,
  ScratchSurfaceState,
  SurfaceId,
  SurfaceOwner,
} from './types.js';
import { TIER_ORDER, tierRank, tiersCompatible } from './types.js';
import { resolveKeyAlias } from '../input-core/key-alias-table.js';
import type { DisplayEventBus } from './events.js';
import { paintCursor, type CursorState } from './cursor-state.js';
import { deriveCursor, type CursorDecision } from './cursor-owner.js';
import {
  createVirtualCursorRegistry,
  type VirtualCursorRegistry,
} from './virtual-cursor-registry.js';
import {
  createWorkspaceHost,
  type WorkspaceHost,
} from './workspace-host.js';
import {
  clampModalBoundsToViewport,
  isModalSurface,
  renderModalStack,
  shiftModalBounds,
  type ModalSurface,
  type PaintCacheEntry,
} from './modal-stack.js';
import { DefaultRegionMap, type RegionMap, type RowRange, type TermSize } from './region-map.js';
import { rectContains } from './rect.js';
import { debug } from '../debug/log.js';
import {
  createModalLifecycle,
  type ModalHandle,
  type ModalLifecycle,
} from '../primitives/modal-lifecycle/index.js';
import {
  createFocusManager,
  type FocusManager,
  type FocusScope as PrimFocusScope,
} from '../primitives/focus-manager/index.js';
import {
  createDragManager,
  type DragManager,
} from '../primitives/drag-session/index.js';
import {
  createLayerTree,
  type LayerTree,
  type LayerHandle,
  type LayerId,
  type LayerTreeEventKind,
  type LayerTreeEventListener,
  type Rect as LayerRect,
} from '../primitives/layer-tree/index.js';
import {
  createRenderCoordinator,
  type RenderCoordinator,
} from '../primitives/render-coordinator/index.js';
import { modalTierToZTier } from '../surface/z-tier.js';
import { registerAppModalTypes } from './modal-types-registry.js';
import {
  isBlockingModalInteractionSurface,
  isWorkspaceInteractionSurface,
} from './surface-interaction-policy.js';

type Timer = ReturnType<typeof setTimeout>;

export function shouldDirtyHostChromeForFocusChange(
  _priorSurface: DisplaySurface | null | undefined,
  nextSurface: DisplaySurface | null | undefined,
): boolean {
  // 2026-05-03 fix — host chrome (status + dock) is hidden under any
  // blocking modal. Repainting it during internal focus shuffles
  // (e.g., navigating cursor inside a popup browser) was the
  // observed "popup browser navigation makes top/bottom keep
  // updating" symptom. Rule: if the surface that WILL hold focus
  // covers host chrome, don't dirty host chrome at all. The opposite
  // direction (modal closes, host chrome reappears) still dirties
  // because next is non-modal. priorSurface is intentionally unused
  // — the previous "skip only on first transition into blocking
  // modal" rule missed the inner-modal navigation case.
  const nextIsBlockingModal = !!nextSurface && isBlockingModalInteractionSurface(nextSurface);
  if (nextIsBlockingModal) return false;
  return true;
}

export function shouldDirtyPriorSurfaceForFocusChange(
  _priorSurface: DisplaySurface | null | undefined,
  nextSurface: DisplaySurface | null | undefined,
): boolean {
  // Same rule applies to the prior surface — if we're moving INTO a
  // blocking modal that will fully cover the prior surface anyway,
  // there's no point repainting the prior to remove a focus indicator
  // it's about to lose. Symmetric with the host-chrome rule above.
  const nextIsBlockingModal = !!nextSurface && isBlockingModalInteractionSurface(nextSurface);
  if (nextIsBlockingModal) return false;
  return true;
}

function logFocusDirtyDecision(
  kind: 'host-chrome' | 'prior-surface',
  priorSurface: DisplaySurface | null | undefined,
  nextSurface: DisplaySurface | null | undefined,
  allowed: boolean,
): void {
  if (!debug.isKeyTraceEnabled()) return;
  debug.log('window.focus-dirty', kind, {
    allowed,
    priorId: priorSurface?.id ?? null,
    priorInteractionClass: priorSurface?.interactionClass ?? null,
    nextId: nextSurface?.id ?? null,
    nextInteractionClass: nextSurface?.interactionClass ?? null,
    nextTier: nextSurface?.tier ?? null,
  });
}

/** H1.3 helper — ModalBounds → LayerTree Rect. Types are
 *  structurally identical (row · col · width · height) but distinct
 *  TS types live in different modules; this cast makes the intent
 *  explicit at the mirror call site. */
function toLayerRect(bounds: { row: number; col: number; width: number; height: number }): LayerRect {
  return { row: bounds.row, col: bounds.col, width: bounds.width, height: bounds.height };
}

function applyModalBoundsUpdate(
  surface: ModalSurface,
  previous: ModalSurface['bounds'],
  next: ModalSurface['bounds'],
): void {
  const ownsBackdrop =
    !!surface.visualBounds
    && (
      surface.bounds.row !== surface.visualBounds.row
      || surface.bounds.col !== surface.visualBounds.col
      || surface.bounds.width !== surface.visualBounds.width
      || surface.bounds.height !== surface.visualBounds.height
    );
  if (ownsBackdrop) {
    if (surface.interactiveBounds) surface.interactiveBounds = { ...next };
    if (surface.visualBounds) surface.visualBounds = { ...next };
    return;
  }
  surface.bounds = { ...next };
  if (surface.interactiveBounds) {
    surface.interactiveBounds = { ...next };
  }
  if (surface.visualBounds) {
    surface.visualBounds = { ...next };
  }
  if (surface.backdropBounds) {
    surface.backdropBounds = { ...next };
  }
}

function keyRouteLabel(ev: KeyEvent): string {
  const mods: string[] = [];
  if (ev.ctrl) mods.push('C');
  if (ev.shift) mods.push('S');
  if (ev.alt) mods.push('A');
  return `${mods.length > 0 ? mods.join('-') + '-' : ''}${ev.name || '(empty)'}`;
}

/** Unconditional key-binding route decisions. Category `display.key`.
 *  Distinct events: no-match · when-false · chord-armed · selected.
 *  Not gated on `debug.enabled` — a silent gate would look like "did not happen". */
type KeyBindingRouteEvent = 'no-match' | 'when-false' | 'chord-armed' | 'selected';

function logKeyBindingRoute(
  event: KeyBindingRouteEvent,
  ev: KeyEvent,
  extra?: { id?: string; prefix?: string },
): void {
  debug.log('display.key', event, extra
    ? { key: keyRouteLabel(ev), ...extra }
    : { key: keyRouteLabel(ev) });
}

export interface DisplayCoordinatorOptions {
  frameMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, delayMs: number) => Timer;
  onRender?: (request: DisplayRenderRequest, snapshot: DisplaySnapshot) => void;
  hooks?: DisplayHooks;
  eventBus?: DisplayEventBus;
  /** P2.2.b — emit ANSI cursor escapes (move + show, or hide). Called
   *  by flush() AFTER onRender + afterRender so cursor lands on top
   *  of any painted output. When omitted, the coordinator just
   *  tracks state — useful for tests and for the dual-write phase
   *  where chat.ts is still emitting directly. */
  writeCursor?: (ansi: string) => void;
  /** P2.3.a — emit ANSI for the modal stack overlay. Called BEFORE
   *  writeCursor so the cursor lands on top of the modal pixels.
   *  When omitted, modal paints are silently dropped — useful for
   *  tests where you only want to assert the surface registry +
   *  topModalCursor() resolution without touching stdout. */
  writeOverlay?: (ansi: string) => void;
  /** V2 — maps a surface to the terminal row range it occupies, so
   *  the coordinator can tell the frame cache to forget those rows
   *  on mount / unmount. Defaults to DefaultRegionMap (modal bounds
   *  only). */
  regionMap?: RegionMap;
  /** V2 — current terminal size. Used to clamp modal regions. When
   *  omitted, defaults to a 24x80 shape which is only meaningful for
   *  tests — the dashboard wires the real tui.ts::termSize. */
  termSize?: () => TermSize;
  /** V2 — invalidate a single row in the frame cache. 0-indexed. The
   *  dashboard wires tui.ts::invalidateRenderCacheRow; tests supply a
   *  capture fn. When omitted the coordinator records forceNext but
   *  does not poke any external cache — safe default. */
  invalidateRow?: (row0: number) => void;
}

export class DisplayCoordinator {
  /** Phase 5 (substrate Occam · L5 lesson · 2026-05-03) — bounded
   *  per-surface mount-event ring. 32 entries comfortably covers a
   *  1-second window even in a sustained 30 Hz mount/unmount loop
   *  (would generate 60 events/s, but the warning fires before the
   *  ring fills). */
  private static readonly MOUNT_CHURN_RING_SIZE = 32;
  /** Threshold for the runtime warning: ≥ this many push+pop events
   *  for a single surface within MOUNT_CHURN_WARN_WINDOW_MS triggers
   *  a `window.mountChurn.warn` debug log. Tuned to fire on the
   *  picker-flicker pattern (30 Hz loop = 60 events/s = trips
   *  immediately) but stay quiet for legitimate rapid flows
   *  (typing-driven picker filter rebuilds re-mount at most ~5
   *  times/s in normal use). */
  private static readonly MOUNT_CHURN_WARN_THRESHOLD = 10;
  /** Window in ms for the warning threshold. */
  private static readonly MOUNT_CHURN_WARN_WINDOW_MS = 1000;

  private readonly frameMs: number;
  private readonly now: () => number;
  private readonly scheduleFn: (fn: () => void, delayMs: number) => Timer;
  private readonly onRender?: (request: DisplayRenderRequest, snapshot: DisplaySnapshot) => void;
  private readonly hooks: DisplayHooks;
  private readonly eventBus?: DisplayEventBus;
  private readonly writeCursor?: (ansi: string) => void;
  private readonly writeOverlay?: (ansi: string) => void;
  private readonly regionMap: RegionMap;
  private readonly termSize: () => TermSize;
  private readonly invalidateRow: (row0: number) => void;
  /** TUI-SLASH-FLICKER — true when the host wired a real row
   *  invalidator, so a region move can be repaired by a plain diff
   *  frame instead of a forced full-screen repaint. */
  private readonly hasRowInvalidator: boolean;
  /** TUI-SLASH-FLICKER — the previous flush invalidated overlay rows
   *  (region moved / vanished); the next flush must re-emit the overlay
   *  even when its bytes are unchanged, because the base rows under it
   *  were just repainted. Replaces the old forceNext follow-up. */
  private overlayRowsInvalidated = false;

  private surfaces = new Map<SurfaceId, DisplaySurface>();
  private focusNodes = new Map<SurfaceId, FocusNode>();
  private keyBindings = new Map<string, DisplayKeyBinding>();
  private keyBindingRegistrationOrders = new Map<string, number>();
  private nextKeyBindingRegistrationOrder = 0;
  /** Q5 (Phase 3 full, 2026-05-03) — visual modal paint stack
   *  (focusable + non-focusable surfaces in z order). Replaces
   *  the legacy `this.paintStack` field. Pure paint/iteration
   *  ordering — does NOT carry focus semantics. The single source
   *  for focus state is the FocusManager primitive (`active`,
   *  `previous`, `history`); see snapshot() for the derived
   *  DisplaySnapshot.focus shape consumed by external callers.
   *  The public `modalStack(): SurfaceId[]` method filters this for
   *  modal-kind surfaces only. */
  private paintStack: SurfaceId[] = [];
  /** FU-1 — multi-key chord state. When a registered binding's
   *  `chordPrefix` matches, we park the prefix until the next
   *  routeKey call; that second key must match the body of the same
   *  armed prefix within the timeout. */
  private chordArmed: { prefix: string; armedAt: number } | null = null;
  private scratch: ScratchSurfaceState | null = null;
  private pendingWidgetPatches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  private pendingLogLines: string[] = [];
  private dirty = new Set<SurfaceId | 'all' | 'status' | 'dock'>();
  private forceNext = false;
  private scheduled: Timer | null = null;
  // P2.2.b — cursor state. Last-writer-wins. cursorVersion bumps on
  // every setCursor; lastEmittedCursorVersion tracks what's been
  // written so flushCursor only emits on change.
  private cursor: CursorState | null = null;
  private cursorVersion = 0;
  private lastEmittedCursorVersion = 0;
  // U4 Bundle A (2026-04-22) — Virtual cursor registry attached as a
  // shadow substrate for "1 physical cursor + N virtual descriptors".
  //
  // Scope:
  //   - The existing physical cursor owner flow stays unchanged:
  //     `deriveCursor()` still decides the single ANSI caret emitted
  //     by flushCursor().
  //   - This registry is the parallel projection for inactive carets,
  //     selection anchors, message cursors, and future workspace-owned
  //     range selections. It is intentionally paint-agnostic for this
  //     first checkpoint — no ANSI overlay emission yet.
  //   - Authority matches the other Phase β shadow primitives:
  //     external callers may read / subscribe directly, but writes
  //     should flow through the returned registry instance so the
  //     coordinator can later bridge paint/layout without widening
  //     the API shape again.
  private readonly virtualCursorRegistry: VirtualCursorRegistry = createVirtualCursorRegistry();
  // U4 Bundle B (2026-04-22) — WorkspaceHost primitive attached as a
  // shadow substrate for grouped popup/window sets. This is the
  // first-class replacement vocabulary for the old singleton-popup
  // mental model: a workspace owns N members + focus cycle + layout
  // mode even before drag/minimize/dock are fully interactive.
  //
  // Scope for this checkpoint:
  //   - pure host contract only (workspace metadata + member/focus
  //     bookkeeping)
  //   - no direct mount/paint authority yet
  //   - future interactive chrome/workspace shell features build on
  //     this handle rather than inventing a parallel set registry
  private readonly workspaceHost: WorkspaceHost = createWorkspaceHost();
  // V4 — regions painted by the modal stack on the previous flush.
  // Used to detect "gone" or "moved" modal regions so the rows they
  // covered can be invalidated even when closeSurface wasn't the
  // caller (e.g. focus stack filtered out a surface that's still in
  // the surfaces map, or pushModal was re-called with changed bounds).
  private lastOverlayRegions = new Map<SurfaceId, RowRange>();
  // Phase 4 (substrate Occam · §4-pre.8 · 2026-05-03) — per-surface
  // paint cache. Threaded into renderModalStack each frame; entries
  // keyed internally by `(bounds, generation)`. Hits skip paint().
  // Cleared per-surface in closeSurface() so unmount invalidates.
  // Pattern A (dirty-tracking mismatch) and Pattern D (reference-
  // identity churn) structural defense — same numeric bounds + same
  // generation re-uses prior ANSI even if the object identity churned.
  private readonly paintCache = new Map<SurfaceId, PaintCacheEntry>();
  // Test/instrumentation seam: recent paint-cache hit/miss tally.
  // Bounded ring for debug introspection only — no allocation when
  // disabled. Read via `paintCacheStats()`.
  private paintCacheHits = 0;
  private paintCacheMisses = 0;
  // Phase 4.5b (substrate Occam · §4-pre.10 partial · 2026-05-03) —
  // overlay byte-equality cache. flushOverlay compares the rendered
  // ANSI to this and skips writeOverlay when they match (unless
  // request.force overrides). Cleared on overlay vanish so a future
  // re-emit of the same bytes is still correct after the gap.
  private prevOverlayAnsi: string | null = null;
  private overlayWritesEmitted = 0;
  private overlayWritesSkipped = 0;
  // Phase 5 (substrate Occam · L5 lesson · 2026-05-03) — per-surface
  // mount-event ring for runtime churn detection. Each pushModal +
  // closeSurface entry records a timestamp. surfaceMountChurn(id, ms)
  // returns count within the trailing window. When a single surface
  // accumulates >= MOUNT_CHURN_WARN_THRESHOLD events within
  // MOUNT_CHURN_WARN_WINDOW_MS, a `window.mountChurn.warn` debug log
  // fires — first-line warning system for the 30 Hz mount/unmount
  // feedback loop class (origin: picker-flicker incident #1401).
  // Bounded ring (32 entries per surface) so memory stays trivial.
  private readonly surfaceMountEvents = new Map<SurfaceId, number[]>();
  // Phase 5 (substrate Occam · F8 telemetry · 2026-05-03) — per-
  // surface generation-bump tracking. Each `bumpGeneration(id)` call
  // (the F8 contract path: data arrival → bump → cache miss → paint
  // re-runs) increments the per-surface counter and updates the
  // last-bump timestamp. Exposed via `generationStats()` for
  // operator observability — surfaces that opt into the paint cache
  // (declare `generation` field) but never bump are visible as
  // potential stale-paint risks.
  private readonly surfaceGenerationBumps = new Map<SurfaceId, { bumps: number; lastBumpAt: number }>();
  // Phase 5 (substrate Occam · F8 shadow mode · 2026-05-03) — env-
  // gated runtime check that complements the F8 telemetry. When
  // `ELANOUS_F8_SHADOW=1`, every paint cache HIT also re-runs paint()
  // and compares the fresh string against the cached `prior.ansi`.
  // A divergence means the surface mutated state without bumping
  // generation (= F8 violation: data ↔ paint seam broken). Cached
  // value is still used for the actual frame; the shadow check is
  // observability-only — divergences accumulate into
  // `f8ShadowStats()` and emit `window.f8.shadowDivergence` debug
  // logs so operators can grep for the offending surface id.
  //
  // Off-state (env unset · default) is zero-cost — `shadowMode`
  // false propagates into renderModalStack which short-circuits
  // before any extra paint() call.
  private readonly f8ShadowMode: boolean = process.env.ELANOUS_F8_SHADOW === '1';
  private f8ShadowDivergences = 0;

  // Phase B-2 (2026-04-21) — ModalLifecycle primitive attached to
  // the coordinator as a shadow-tracker. The primitive is the
  // source of truth coordinator aims toward in Phase B-3 (caller
  // migration); for now it mirrors every pushModal / popModal so
  // (a) we can validate the primitive behaves identically to the
  // current coordinator stack in production traffic, and (b) Phase
  // B-3 consumers who opt into typed handles via
  // `modalLifecycleAPI()` see a live, up-to-date view of the
  // modal population.
  //
  // Mirror rules:
  //   - Every pushModal(surface) triggers a primitive `push` with
  //     `idempotencyKey: surface.id` and the ModalSurface forwarded
  //     via `state`. Primitive policy `duplicateBehavior: 'replace'`
  //     matches coordinator.upsertSurface semantics — a second push
  //     with the same id auto-disposes the prior primitive handle.
  //   - Every popModal(id) disposes the tracked primitive handle.
  //   - The primitive `invalidate` event is observed purely for
  //     debug instrumentation (primitive's atomic dispose+invalidate
  //     contract is validated against coordinator's V4 cascade).
  //   - No behaviour depends on primitive state yet — coordinator
  //     state is still authoritative. Phase B-3 will flip this.
  private readonly modalLifecycle: ModalLifecycle = createModalLifecycle();
  private readonly mirrorHandles = new Map<SurfaceId, ModalHandle>();

  // Phase F-2 (2026-04-21) — FocusManager primitive attached to the
  // coordinator as a shadow-tracker. Same discipline as B-2
  // ModalLifecycle: coordinator remains the source of truth, the
  // primitive mirrors every `registerFocusNode` / `setFocus` /
  // `cycleFocus` / `clearFocus` so F-3 consumers who opt into
  // `focusManagerAPI()` see a live, up-to-date view of the focus
  // population without touching the 37 existing caller sites.
  //
  // Mirror rules:
  //   - Every coordinator `registerFocusNode(node)` and every implicit
  //     focusNodes.set inside `upsertSurface` re-registers the node
  //     on the primitive. The primitive's `register` throws on
  //     duplicate; we unregister-before-reregister to support upsert
  //     semantics (same pattern as coordinator's focusNodes.set).
  //   - Every `setFocus(target, reason)` mirrors via
  //     `focusManager.setFocus(target, reason)`. The primitive emits
  //     `focused` / `blurred` events that downstream observers (F-3
  //     routeInputEvent, state bridges) can subscribe to.
  //   - `cycleFocus` piggybacks on the setFocus mirror — it calls
  //     `setFocus(next.id, 'cycle')` internally so the primitive gets
  //     the update without a dedicated cycle wiring.
  //   - `clearFocus(id)` and `closeSurface(id)` unregister the node
  //     on the primitive. `focusManager.unregister` prunes
  //     active/previous/history atomically.
  //   - ModalLifecycle `mounted` event triggers a defensive
  //     register+setFocus for callers using `modalLifecycleAPI()`
  //     directly (bypassing coordinator.pushModal). The handler is
  //     idempotent via `isRegistered` so the typical pushModal path
  //     (which already mirrored via setFocus) becomes a no-op.
  //   - `focused` events emit a `primitive.focus.focused` debug.log
  //     junction per CLAUDE.md — focus is a routing boundary.
  private readonly focusManager: FocusManager = createFocusManager({
    policy: 'priority',
    passiveRenderFocus: true,
  });

  // Phase DS-2b (2026-04-21) — DragSession primitive attached to
  // the coordinator per PR #319 joint split. DS-2a landed the
  // `drag-dispatch.ts` adapter (PLAN author); this field + getter
  // are the Session B half.
  //
  // Role: DragManager is a **side primitive** (unlike B-2/F-2 which
  // use shadow-tracker mirroring). Coord owns no drag state. The
  // getter exposes the singleton to (a) `dashboard-mouse-wiring.ts`
  // for the dragDispatch hook and (b) Session A's dispatcher (A-8)
  // for the ESC-cancel entry.
  //
  // Wiring
  //   - `hitTest` is a no-op fallback: `dashboard-mouse-wiring`
  //     attaches `ev.hitTarget` before dragDispatch runs, so the
  //     primitive's injected hitTest is never called in practice.
  //     Providing it satisfies the contract.
  //   - ModalLifecycle `mounted` subscription (below) cancels any
  //     active drag when a new modal pushes. Matches PR #319 PLAN
  //     §R8 "modal push cancels session" invariant.
  private readonly dragManager: DragManager = createDragManager({
    hitTest: () => null,
  });

  // Phase H1.3 (2026-04-21 · compositor primitive track) —
  // LayerTree primitive attached to the coordinator as a shadow-
  // tracker. Same discipline as B-2 ModalLifecycle and F-2
  // FocusManager: the coordinator's own modal stack + focus.stack
  // remain authoritative; the primitive mirrors every pushModal /
  // popModal / closeSurface / bounds change so Phase β consumers
  // (W2 RenderCoordinator · I1 Focus bridge · future hit-test) see
  // a live, up-to-date view of the layer population without
  // touching the 30+ existing caller sites of pushModal.
  //
  // Mirror rules:
  //   - Every pushModal(surface) calls layerTree.addLayer with the
  //     surface id + bounds + ZTier (derived via modalTierToZTier).
  //     Duplicate id re-push disposes the stale handle first — same
  //     upsert semantics as coordinator.upsertSurface.
  //   - upsertSurface bounds change fires layerTree.setBounds so
  //     the shadow tracks geometry moves (e.g. tablet mode resize).
  //   - closeSurface(id) disposes the LayerHandle alongside the
  //     ModalLifecycle mirror. popModal routes through closeSurface
  //     so it inherits the cleanup.
  //   - LayerTree events are observed by external consumers via
  //     `layerTreeAPI()`; the coord itself does not react yet.
  //   - Non-modal surfaces (kind='pane' etc.) are NOT mirrored —
  //     LayerTree today is a compositor for modals. Pane / status /
  //     dock-area surfaces render through the dashboard's own pipeline
  //     and will migrate in Phase γ (W2 RenderCoordinator integration).
  private readonly layerTree: LayerTree = createLayerTree();
  private readonly publicLayerTree: LayerTree = {
    ...this.layerTree,
    on: (kind: LayerTreeEventKind, cb: LayerTreeEventListener) => this.layerTree.on(kind, (ev) => {
      if ((kind === 'added' || kind === 'removed') && String(ev.layerId).startsWith('__damage:')) return;
      cb(ev);
    }),
  };
  private readonly layerHandles = new Map<SurfaceId, LayerHandle>();
  private readonly damageLayerHandles = new Map<LayerId, LayerHandle>();
  private damageLayerCounter = 0;
  private clearingDamageLayers = false;

  // Phase H1.6 (2026-04-21 · compositor primitive track) —
  // W2 RenderCoordinator primitive attached as a shadow-tracker
  // alongside W1 LayerTree. Same discipline as B-2 ModalLifecycle
  // / F-2 FocusManager / H1.3 W1 attach: coord stays authoritative,
  // the primitive mirrors dirty tracking + emits commit-boundary
  // events so external consumers (future widgets · plugins · tests)
  // observe live frame state without touching 30+ markDirty sites.
  //
  // Mirror rules:
  //   - markDirty(id) forwards to rc.markNeedsPaint when id is a real
  //     SurfaceId (not 'all' / 'status' / 'dock' pseudo-ids).
  //   - flush() invokes rc.flush() INSIDE the DECSET 2026 boundary
  //     so any before-flush/after-flush subscribers' paint lands
  //     inside the atomic-frame wrap for free (no separate wiring).
  //   - W1 LayerTree `on('dirty')` bridges to rc.markNeedsPaint so
  //     a layer bounds/opacity change propagates into the dirty
  //     queue without callers knowing about both primitives.
  //   - The primitive receives NO schedule (sync mode) — coord.flush
  //     drives the tick explicitly; W2's requestFrame isn't wired.
  //     This matches Phase β "coord authoritative" discipline; Phase
  //     γ may flip authority and let rc schedule itself.
  private readonly renderCoordinator: RenderCoordinator = createRenderCoordinator();

  constructor(opts: DisplayCoordinatorOptions = {}) {
    this.frameMs = opts.frameMs ?? 16;
    this.now = opts.now ?? (() => Date.now());
    this.scheduleFn = opts.schedule ?? ((fn, delayMs) => setTimeout(fn, delayMs));
    this.onRender = opts.onRender;
    this.hooks = opts.hooks ?? {};
    this.eventBus = opts.eventBus;
    this.writeCursor = opts.writeCursor;
    this.writeOverlay = opts.writeOverlay;
    this.regionMap = opts.regionMap ?? new DefaultRegionMap();
    this.termSize = opts.termSize ?? (() => ({ rows: 24, cols: 80 }));
    this.invalidateRow = opts.invalidateRow ?? (() => { /* no-op default */ });
    this.hasRowInvalidator = typeof opts.invalidateRow === 'function';

    // H1.6 · W1 → W2 bridge. Whenever LayerTree announces a layer
    // state change (bounds / opacity / parent / zIndex), inform the
    // RenderCoordinator so its dirty queue reflects the invalidation
    // without requiring caller to mark both primitives. Matches
    // Flutter's RenderObject.markNeedsPaint → PipelineOwner
    // scheduling bridge.
    this.layerTree.on('dirty', (ev) => {
      try {
        if (ev.reason === 'bounds' && ev.previousBounds && ev.currentBounds) {
          if (ev.previousBounds.width > 0 && ev.previousBounds.height > 0) {
            this.addDamageLayer(ev.previousBounds);
            this.renderCoordinator.markNeedsPaint(ev.layerId, ev.previousBounds);
          }
          if (ev.currentBounds.width > 0 && ev.currentBounds.height > 0) {
            this.renderCoordinator.markNeedsPaint(ev.layerId, ev.currentBounds);
          }
        } else {
          this.renderCoordinator.markNeedsPaint(ev.layerId);
        }
      }
      catch (err) {
        if (debug.enabled) {
          debug.log('primitive.layerTree.dirtyBridgeFailed', ev.layerId, {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });
    this.layerTree.on('removed', (ev) => {
      try {
        if (!this.clearingDamageLayers
          && ev.previousBounds && ev.previousBounds.width > 0 && ev.previousBounds.height > 0) {
          this.addDamageLayer(ev.previousBounds);
          this.renderCoordinator.markNeedsPaint(ev.layerId, ev.previousBounds);
        }
      }
      catch (err) {
        if (debug.enabled) {
          debug.log('primitive.layerTree.removedBridgeFailed', ev.layerId, {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });

    // B-2: register a mirror ModalType per tier. `factory` receives
    // the surface as `state` (second arg to `push`) and returns it
    // unchanged — the primitive wraps it in a ModalHandle with a
    // fresh generation counter. TIER_ORDER is the canonical tier
    // enum so every legal tier gets a registered mirror entry.
    for (const tier of TIER_ORDER) {
      this.modalLifecycle.registerType({
        name: `__coord-mirror:${tier}`,
        tier,
        factory: (_ctx, state) => state as ModalSurface,
      });
    }
    // B-3a (2026-04-21) — register app-level modal type names
    // alongside the mirror types so Phase B-3b/c caller migrations
    // can push with stable names (`'attachment-popup'`, etc.) instead
    // of routing through the generic mirror path. All factories are
    // passthrough; coordinator.pushModal(surface) still uses the
    // mirror types so this is purely additive. See
    // src/display/modal-types-registry.ts for the canonical list.
    registerAppModalTypes(this.modalLifecycle);
    // B-2 instrumentation: log every primitive invalidate event
    // alongside coordinator state so drift (if any) is visible in
    // log/debug-*.log. Required by CLAUDE.md debug junction rules —
    // modal lifecycle is a critical routing boundary.
    this.modalLifecycle.on('invalidate', (ev) => {
      if (debug.enabled) {
        debug.log('primitive.invalidate', ev.handle.id, {
          generation: ev.handle.generation,
          tier: ev.handle.tier,
          typeName: ev.handle.typeName,
          key: ev.handle.key,
          coordinatorStackSize: this.paintStack.length,
          coordinatorHasSurface: this.surfaces.has(ev.handle.id as SurfaceId),
        });
      }
    });

    // F-2 — wire ModalLifecycle mounted/disposed events into
    // FocusManager so plugin-side callers using `modalLifecycleAPI()`
    // directly (bypassing coordinator.pushModal) still get a
    // consistent focus view. The typical pushModal path already
    // mirrored via setFocus by the time the mounted event fires, so
    // the register() call here is a no-op via the isRegistered guard.
    //
    // Note: ModalHandle.id is the *synthetic* primitive id
    // (`typeName#g<gen>`), not the coordinator-facing surface id.
    // Focus state is keyed on `surface.id` throughout the coordinator,
    // so we read it from `ev.handle.surface.id` here.
    this.modalLifecycle.on('mounted', (ev) => {
      const surfaceId = ev.handle.surface.id;
      const isMirror = ev.handle.typeName.startsWith('__coord-mirror:');

      // B-3b (2026-04-21) — reverse-wiring for typed (non-mirror)
      // pushes. A caller using `modalLifecycleAPI().push('<type>',
      // opts, surface)` bypasses `coord.pushModal(surface)`, so the
      // coord-side side effects (surface registry / paint markDirty
      // / focus setup / frame request) that pushModal used to trigger
      // synchronously must now be driven by the primitive event.
      //
      // For mirror pushes (`__coord-mirror:<tier>`), coord.pushModal
      // already did upsertSurface + markDirty + setFocus BEFORE
      // firing mirrorPushToPrimitive, so this branch would double-
      // register — skip it and fall through to the F-2 focus block.
      if (!isMirror && !this.surfaces.has(surfaceId)) {
        this.upsertSurface(ev.handle.surface);
        this.markDirty(surfaceId);
        const node = this.focusNodes.get(surfaceId);
        if (node && !node.focusable) {
          // Paint-only modal — add to stack so renderModalStack
          // iterates it, but don't shift focus (mirrors the
          // pushModal branch for non-focusable modals).
          if (!this.paintStack.includes(surfaceId)) {
            this.paintStack = [...this.paintStack, surfaceId];
          }
        } else {
          // Focusable typed push — run coord's setFocus so the
          // prev/stack/dirty machinery stays consistent. This also
          // mirrors to the primitive focus manager via the existing
          // F-2 wiring inside setFocus.
          this.setFocus(surfaceId, 'modal:mount');
        }
        this.requestFrame();
        if (debug.enabled) {
          debug.log('primitive.mounted.reverse', surfaceId, {
            typeName: ev.handle.typeName,
            tier: ev.handle.tier,
            key: ev.handle.key,
          });
        }
      }

      // F-2 — ensure focus manager has the node (idempotent via
      // isRegistered). Runs for both mirror and typed paths so an
      // eventual primitive-only future still has consistent focus
      // state even if the B-3b block short-circuited.
      if (!this.focusManager.isRegistered(surfaceId)) {
        const coordNode = this.focusNodes.get(surfaceId);
        if (coordNode) {
          this.mirrorFocusNodeRegister(coordNode);
        } else {
          // Caller pushed via primitive API without going through
          // coordinator.upsertSurface — synthesize a minimal entry
          // so downstream `setFocus` has something to target.
          try {
            this.focusManager.register({
              id: surfaceId,
              scope: 'modal',
              focusable: (ev.handle.surface.focus ?? 'owns') === 'owns',
              priority: ev.handle.surface.priority ?? 250,
              owner: ev.handle.surface.owner ?? 'dashboard',
            });
          } catch (err) {
            if (debug.enabled) {
              debug.log('primitive.focus.mountRegisterFailed', surfaceId, {
                err: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      }
      if ((ev.handle.surface.focus ?? 'owns') === 'owns') {
        this.focusManager.setFocus(surfaceId, 'modal:mount');
      }
    });
    // DS-2b (2026-04-21) — safety: modal push cancels any active
    // drag session. Matches PR #306 PLAN §R8 ("Mounted modal steals
    // pointer focus; in-flight drag session is no longer valid").
    // The mounted event fires for both legacy pushModal path and
    // typed primitive push, so drag sessions get cancelled uniformly
    // regardless of caller style. Skip for `__coord-mirror:*` mounts
    // that originate from coord.pushModal inside a drag-active path
    // would be redundant — the outer handler for those is dashboard-
    // mouse-wiring which ran dragDispatch already; this listener
    // protects paths that bypass dragDispatch (e.g. ExitPlanMode
    // tool invocation pushing a dialog while a drag is live).
    this.modalLifecycle.on('mounted', (ev) => {
      if (this.dragManager.isActive()) {
        if (debug.enabled) {
          debug.log('primitive.drag.cancelOnModalMount', ev.handle.surface.id, {
            typeName: ev.handle.typeName,
            tier: ev.handle.tier,
          });
        }
        this.dragManager.cancelAll('modal-mounted');
      }
    });
    this.modalLifecycle.on('disposed', (ev) => {
      const surfaceId = ev.handle.surface.id;
      const isMirror = ev.handle.typeName.startsWith('__coord-mirror:');

      // B-3b — reverse-wiring for typed dispose. closeSurface handles
      // surfaces/focusNodes/focusManager cleanup + region invalidation
      // internally (see coordinator.closeSurface). For mirror paths
      // the coord.popModal/closeSurface sequence already ran before
      // this event fired, so coord.surfaces no longer has the entry;
      // the guard prevents re-entry.
      if (!isMirror && this.surfaces.has(surfaceId)) {
        this.closeSurface(surfaceId);
        this.markDirty('all');
        this.forceNext = true;
        this.requestFrame();
        if (debug.enabled) {
          debug.log('primitive.disposed.reverse', surfaceId, {
            typeName: ev.handle.typeName,
            tier: ev.handle.tier,
            key: ev.handle.key,
          });
        }
      }

      // Always unregister focus-manager entry — closeSurface does it
      // for the typed path, but the mirror path skipped closeSurface
      // re-entry and focus manager may still hold the stale node.
      this.focusManager.unregister(surfaceId);
      if (debug.enabled) {
        debug.log('primitive.focus.disposed', surfaceId, {
          reason: 'modal.disposed',
          generation: ev.handle.generation,
          handleId: ev.handle.id,
          isMirror,
        });
      }
    });
    // F-2 debug junction — every primitive focus transition is the
    // equivalent of coordinator `window.setFocus` for F-3 consumers.
    // Pair the two logs so drift between coord state and primitive
    // state is visible in log/debug-*.log.
    //
    // F-3a (2026-04-21) — this listener applies the coord-side effects
    // (state update, markDirty, hooks, eventBus) of a primitive focus
    // event. With the inverse mirror, `primitive.setFocus(...)` alone
    // drives the full coord focus transition; coord.setFocus / clearFocus
    // bodies are thin primitive delegators. Q5 partial (Phase 3,
    // 2026-05-03): the ELANOUS_LEGACY_FOCUS rollback flag is gone — the
    // primitive path is the only path.
    this.focusManager.on('focused', (ev) => {
      if (debug.enabled) {
        debug.log('primitive.focus.focused', ev.node?.id ?? '(null)', {
          reason: ev.reason,
          prior: ev.prior?.id ?? null,
        });
      }
      this.applyPrimitiveFocusedEvent(ev.node?.id ?? null, ev.prior?.id ?? null, ev.reason);
    });
    this.focusManager.on('blurred', (ev) => {
      // Blurred fires when the active node lost focus (either
      // setFocus to different node emitted blurred then focused, or
      // `clear()` emitted blurred only). The focused listener above
      // already handles the setFocus case (via its prior/node pair).
      // Here we handle the clear-only case: primitive emitted blurred
      // without a subsequent focused (i.e. this.focusManager.active()
      // is now null) → paintStack and dirty regions need to update.
      if (this.focusManager.active() !== null) return;   // setFocus path
      this.applyPrimitiveClearedEvent(ev.prior?.id ?? null, ev.reason);
    });
  }

  /** Q5 (Phase 3 full, 2026-05-03) — applies the coord-side side
   *  effects of a primitive 'focused' event: paintStack reorder,
   *  markDirty, hooks, eventBus. Focus state itself lives in the
   *  primitive (single source); this method only manages the
   *  derived paint ordering and dirty signalling. */
  private applyPrimitiveFocusedEvent(
    nextId: SurfaceId | null,
    priorId: SurfaceId | null,
    reason: string,
  ): void {
    if (nextId === null) return;           // 'focused' with null node — defensive
    // Move-to-top in paintStack so renderModalStack picks the focused
    // surface up at the top of the z order.
    this.paintStack = [...this.paintStack.filter(x => x !== nextId), nextId];
    const priorSurface = priorId ? this.surfaces.get(priorId) : null;
    const nextSurface = this.surfaces.get(nextId);
    const dirtyPrior = shouldDirtyPriorSurfaceForFocusChange(priorSurface, nextSurface);
    logFocusDirtyDecision('prior-surface', priorSurface, nextSurface, dirtyPrior);
    if (priorId && dirtyPrior) {
      this.markDirty(priorId);
    }
    this.markDirty(nextId);
    const dirtyHostChrome = shouldDirtyHostChromeForFocusChange(priorSurface, nextSurface);
    logFocusDirtyDecision('host-chrome', priorSurface, nextSurface, dirtyHostChrome);
    if (dirtyHostChrome) {
      this.markDirty('status');
      this.markDirty('dock');
    }
    this.hooks.onFocusChanged?.(priorId, nextId, reason);
    this.eventBus?.emit({ type: 'focus:change', previous: priorId, next: nextId, reason });
  }

  /** Q5 (Phase 3 full, 2026-05-03) — clear-event side effects: drop
   *  the cleared id from paintStack so the now-blurred surface stops
   *  being iterated for paint. */
  private applyPrimitiveClearedEvent(priorId: SurfaceId | null, _reason: string): void {
    if (priorId === null) return;
    this.paintStack = this.paintStack.filter(x => x !== priorId);
    this.markDirty(priorId);
    this.markDirty('status');
    this.markDirty('dock');
  }

  /** Phase B-2 — expose the ModalLifecycle primitive to external
   *  callers. Phase B-3 will migrate individual call sites (e.g. the
   *  attachment popup in dashboard.ts) to use `push(typeName, opts)`
   *  with an explicit `idempotencyKey`, replacing the dashboard-level
   *  handle tracking landed in PR #256. For now the primitive is a
   *  shadow tracker — reading its state is safe but writes flow
   *  through the coordinator's pushModal/popModal wrappers. */
  modalLifecycleAPI(): ModalLifecycle {
    return this.modalLifecycle;
  }

  /** Phase F-2 — expose the FocusManager primitive to external
   *  callers. Phase F-3 will migrate the ~37 `setFocus` call sites to
   *  read/write through this API directly (and the `focus: FocusState`
   *  field will disappear from the coordinator). For now the primitive
   *  is a shadow tracker: reading its state is safe but writes still
   *  flow through the coordinator's `setFocus` / `registerFocusNode`
   *  / `clearFocus` / `cycleFocus` wrappers so coord state stays
   *  authoritative. Consumers that want to observe focus transitions
   *  without polling can subscribe via `focusManagerAPI().on('focused',
   *  ...)`. */
  focusManagerAPI(): FocusManager {
    return this.focusManager;
  }

  /** Phase DS-2b — expose the DragSession primitive to external
   *  callers. `dashboard-mouse-wiring.ts` uses this to wire the
   *  `dragDispatch(ev, coord.dragManagerAPI())` hook; `input-core
   *  /dispatcher.ts` (Session A A-8) uses `cancelAll('escape')` on
   *  the returned instance to handle ESC during an active drag.
   *  DropTarget consumers (DS-3 browser→attachment etc.) call
   *  `registerTarget(target)` here.
   *
   *  Unlike `modalLifecycleAPI()` and `focusManagerAPI()`, there is
   *  NO coord-side mirror — DragManager owns the state directly.
   *  Per PR #306 PLAN §3.2 and Session B direction review on PR
   *  #306: drag is ephemeral (hundreds of ms from begin to end) so
   *  no shadow tracker is maintained. */
  dragManagerAPI(): DragManager {
    return this.dragManager;
  }

  /** Phase H1.3 (compositor track · W1) — expose the LayerTree primitive
   *  to external callers. Shadow tracker during Phase β: reading state
   *  (sortedByZ / getLayer / pathTo / on) is safe and up-to-date;
   *  direct writes (addLayer / removeLayer / moveLayer / setBounds)
   *  should flow through coord's pushModal / popModal / upsertSurface
   *  so the coord-side state stays authoritative. Phase γ (W2
   *  RenderCoordinator integration) will flip the authority and
   *  consumers will drive the tree directly. */
  layerTreeAPI(): LayerTree {
    return this.publicLayerTree;
  }

  /** Phase H1.6 (compositor track · W2) — expose the RenderCoordinator
   *  primitive to external callers. Shadow tracker during Phase β:
   *  reading state (isDirty / getDirtyRegions / debug) and subscribing
   *  to events ('dirty-added' / 'before-flush' / 'after-flush') is
   *  safe. Direct writes (markNeedsPaint / requestFrame / flush) are
   *  driven by coord itself — consumer calls would race against the
   *  coord-authoritative flush loop. Phase γ flips the authority.
   *
   *  Common consumer pattern:
   *
   *  ```ts
   *  display.renderCoordinatorAPI().on('before-flush', (ev) => {
   *    // Paint pre-DECSET-ESU · atomic-frame wrap is free.
   *    for (const entry of ev.entries) paintLayer(entry.layerId);
   *  });
   *  ``` */
  renderCoordinatorAPI(): RenderCoordinator {
    return this.renderCoordinator;
  }

  /** U4 Bundle A — expose the virtual cursor registry to external
   *  callers. Phase β shadow substrate: reading/subscribing is safe
   *  and current; no paint path depends on this registry yet.
   *
   *  This keeps the ownership model explicit:
   *    - `deriveCursor()` / `flushCursor()` own the one physical ANSI
   *      cursor that the terminal can actually show.
   *    - `virtualCursorRegistryAPI()` owns every non-physical cursor
   *      affordance that future popup/workspace chrome will project as
   *      overlays (inactive caret, selection anchor, range highlight,
   *      message cursor).
   */
  virtualCursorRegistryAPI(): VirtualCursorRegistry {
    return this.virtualCursorRegistry;
  }

  /** U4 Bundle B — expose the workspace/meta-host substrate.
   *  Phase β shadow substrate: callers may define workspace groups,
   *  members, layout mode, and focus cycle here even though modal
   *  paint/routing still flows through the coordinator stack.
   */
  workspaceHostAPI(): WorkspaceHost {
    return this.workspaceHost;
  }

  /** F-E2 — direct request-render entry for callers holding the
   *  coordinator instance (e.g. chat.ts's ModalSink consumer). The
   *  per-owner DisplayHandle also exposes this via
   *  `handle(owner).requestRender`; this wrapper covers the case
   *  where no owner scope is needed. Force-true marks the overlay
   *  region for invalidation so modal paint closures re-evaluate
   *  (picker filtering on every keystroke). */
  requestRender(opts?: { region?: SurfaceId | 'all'; force?: boolean }): void {
    this.publish({
      type: 'requestRender',
      region: opts?.region,
      force: opts?.force,
    }, 'dashboard');
  }

  handle(owner: SurfaceOwner): DisplayHandle {
    return {
      owner,
      publish: (command) => this.publish(command, owner),
      requestRender: (opts) => this.publish({
        type: 'requestRender',
        region: opts?.region,
        force: opts?.force,
      }, owner),
      focus: (target) => this.publish({ type: 'setFocus', target }, owner),
      currentFocus: () => this.currentFocus(),
      cycleFocus: (scope, dir) => this.cycleFocus(scope, dir),
      registerFocus: (node) => this.registerFocusNode({
        ...node,
        owner: node.owner ?? owner,
      }),
      registerKey: (binding) => this.registerKeyBinding({
        ...binding,
        id: binding.id ?? `${owner}:${binding.scope}:${binding.key}:${binding.command}`,
      }),
    };
  }

  publish(command: DisplayCommand, _owner: SurfaceOwner = 'dashboard'): void {
    switch (command.type) {
      case 'upsertSurface':
        this.upsertSurface(command.surface);
        this.markDirty(command.surface.id);
        break;
      case 'closeSurface':
        this.closeSurface(command.id);
        this.markDirty(command.id);
        break;
      case 'setFocus':
        this.setFocus(command.target, command.reason);
        break;
      case 'setScratch':
        this.scratch = {
          source: command.source,
          mode: command.mode,
          title: command.title,
          lines: [...command.lines],
          pinned: command.pinned,
          ttlMs: command.ttlMs,
          updatedAt: this.now(),
        };
        this.markDirty('pane:scratch');
        break;
      case 'patchWidget':
        this.pendingWidgetPatches.push({ id: command.id, patch: { ...command.patch } });
        this.markDirty(command.id);
        break;
      case 'appendLog':
        this.pendingLogLines.push(command.line);
        this.markDirty('pane:log');
        break;
      case 'requestRender':
        this.markDirty(command.region ?? 'all');
        if (command.force) this.forceNext = true;
        break;
    }
    this.requestFrame();
  }

  snapshot(): DisplaySnapshot {
    // Q5 (Phase 3 full, 2026-05-03) — focus shape derived from the
    // FocusManager primitive (single source) merged with the
    // coord-owned paintStack (z order including non-focusable
    // pickers). External consumers continue to read snapshot.focus
    // unchanged; the underlying storage is now non-shadowed.
    const primFocus = this.focusManager.state();
    return {
      surfaces: new Map(this.surfaces),
      focusNodes: new Map(this.focusNodes),
      focus: {
        active: primFocus.active,
        previous: primFocus.previous ?? undefined,
        stack: [...this.paintStack],
      },
      scratch: this.scratch ? { ...this.scratch, lines: [...this.scratch.lines] } : null,
      keyBindings: [...this.keyBindings.values()],
      pendingWidgetPatches: this.pendingWidgetPatches.map(p => ({ id: p.id, patch: { ...p.patch } })),
      pendingLogLines: [...this.pendingLogLines],
      cursor: this.cursor ? { ...this.cursor } : null,
    };
  }

  /** P2.2.b — declare desired cursor state for the next frame. Null
   *  hides the cursor. The frame-end pipeline emits a single ANSI
   *  sequence via the writeCursor option. Cursor-only changes (no
   *  other dirty regions, no pending frame) bypass the 16ms batch
   *  for sub-frame typing responsiveness. */
  setCursor(state: CursorState | null): void {
    const next = state ? { row: state.row, col: state.col, visible: state.visible } : null;
    if (cursorEqual(this.cursor, next)) return;
    this.cursor = next;
    this.cursorVersion++;
    if (debug.enabled) {
      debug.log('cursor.coordinator.set', 'setCursor', {
        next,
        scheduled: this.scheduled !== null,
        dirtySize: this.dirty.size,
        forceNext: this.forceNext,
      });
    }
    // Bypass the 16ms batch when nothing else is pending — typing
    // shouldn't feel laggy. If paint work is already dirty but no
    // frame is currently scheduled, schedule one so the first cursor
    // claim doesn't get stranded behind stale dirty state.
    if (this.scheduled === null) {
      if (this.dirty.size === 0 && !this.forceNext) {
        this.flushCursor();
      } else {
        this.requestFrame();
      }
    }
  }

  /** P2.2.b — current cursor state (read-only). */
  getCursor(): CursorState | null {
    return this.cursor ? { ...this.cursor } : null;
  }

  /** Read the same modal-aware physical-cursor decision used by frame flush. */
  cursorDecision(): CursorDecision {
    return deriveCursor({
      surfaces: this.surfaces,
      focusStack: this.paintStack,
      coordinatorCursor: this.cursor,
    });
  }

  /** P2.3.a — push a modal onto the stack. The surface is
   *  registered + given focus in the 'modal' scope (which the
   *  existing routeKey treats with highest precedence). Returns
   *  the surface id and a dispose function that pops + closes. */
  pushModal(surface: ModalSurface): { id: SurfaceId; dispose: () => void } {
    this.recordMountEvent(surface.id);
    if (debug.enabled) {
      debug.log('window.pushModal', surface.id, {
        id: surface.id,
        kind: surface.kind,
        owner: surface.owner,
        bounds: { ...surface.bounds },
        priority: surface.priority,
        focus: surface.focus,
        tier: surface.tier ?? null,
        hasPaint: typeof surface.paint === 'function',
        hasCursor: typeof surface.cursor === 'function',
        stackBefore: [...this.paintStack],
        alreadyRegistered: this.surfaces.has(surface.id),
        caller: callerFrames(),
      });
    }
    // IDX-F4 — ELANOUS_BOUNDARY_CHECK=1 turns on dev-time assertions
    // for modal tier hygiene. Violations are logged (not thrown) so
    // production never crashes; the env gate keeps the check out of
    // the hot path when absent. Two rules:
    //   1. tier must be declared for every modal-kind surface
    //   2. the new tier must not sit below the current top tier in
    //      TIER_ORDER (i.e. tiersCompatible(top, next) must hold)
    if (process.env.ELANOUS_BOUNDARY_CHECK === '1') {
      if (!surface.tier) {
        debug.log('window.boundaryCheck.missingTier', surface.id, {
          id: surface.id, kind: surface.kind, owner: surface.owner,
          caller: callerFrames(),
        });
      } else {
        const topId = this.paintStack.at(-1);
        const topSurface = topId ? this.surfaces.get(topId) : undefined;
        const topTier = topSurface?.tier;
        if (!tiersCompatible(topTier, surface.tier)) {
          debug.log('window.boundaryCheck.tierViolation', surface.id, {
            id: surface.id, nextTier: surface.tier,
            topId: topId ?? null, topTier: topTier ?? null,
            stack: [...this.paintStack],
            caller: callerFrames(),
          });
        }
      }
    }
    this.upsertSurface(surface);
    this.markDirty(surface.id);
    // Focusable modals go through setFocus (stack + active). Paint-only
    // modals (pickers / tooltips with focus !== 'owns') are short-
    // circuited by setFocus, so we still append them to the stack here
    // — renderModalStack iterates focus.stack and would otherwise skip
    // them entirely.
    const node = this.focusNodes.get(surface.id);
    if (node && !node.focusable) {
      if (!this.paintStack.includes(surface.id)) {
        this.paintStack = [...this.paintStack, surface.id];
      }
    } else {
      this.setFocus(surface.id, 'modal:push');
    }
    // Phase B-2 mirror — push onto the primitive so its state tracks
    // the coordinator's. The primitive's `replace` duplicateBehavior
    // handles the case where coordinator.pushModal is called twice
    // with the same surface id (upsert semantics). Mirror failures
    // are swallowed + logged; coordinator stays authoritative.
    this.mirrorPushToPrimitive(surface);
    // Phase H1.3 mirror — LayerTree shadow tracker. Same swallow-on-
    // error policy as the ModalLifecycle mirror above; coord remains
    // authoritative whether the tree mirror succeeded or not.
    this.mirrorPushToLayerTree(surface);
    this.requestFrame();
    return {
      id: surface.id,
      dispose: () => this.popModal(surface.id),
    };
  }

  /** F-3a-2 (2026-04-22) — shared registration-guard used by the
   *  F-3 primitive-first write path (`setFocus`, `syncExternalFocus`).
   *  Preserves the legacy semantic that both methods accepted
   *  unregistered targets by synthesizing a minimal focus node when
   *  coord.focusNodes lacks the entry. Same pattern the F-2 `mounted`
   *  listener uses when a typed primitive push arrives without a
   *  coord-side upsert. Idempotent: short-circuits when the primitive
   *  already has the entry. */
  private _ensureRegistered(target: SurfaceId): void {
    if (this.focusManager.isRegistered(target)) return;
    const coordNode = this.focusNodes.get(target);
    if (coordNode) {
      this.mirrorFocusNodeRegister(coordNode);
      return;
    }
    try {
      this.focusManager.register({
        id: target,
        scope: 'dashboard',
        focusable: true,
        priority: 0,
        owner: 'dashboard',
      });
      // Also mirror to coord.focusNodes so reads (topFocusedSurface,
      // cycleFocus, nextFocusableAfter) see it.
      this.focusNodes.set(target, {
        id: target,
        owner: 'dashboard',
        focusable: true,
        scope: 'dashboard',
        order: 0,
      });
    } catch (err) {
      if (debug.enabled) {
        debug.log('primitive.focus.ensureRegisteredFailed', target, {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** F-2: mirror a coordinator FocusNode into the FocusManager
   *  primitive. Unregister-before-reregister so upsert semantics
   *  (`focusNodes.set(id, ...)` replaces the prior entry) hold on
   *  the primitive side. Coord `FocusScope` (`'global' | 'dashboard'
   *  | 'plugin' | 'modal' | 'execution'`) is a superset of the
   *  primitive's scope strings — the primitive compares scopes
   *  structurally (===), so the cast is safe at runtime; the type
   *  mismatch is bridged here instead of in every caller. */
  private mirrorFocusNodeRegister(node: FocusNode): void {
    try {
      if (this.focusManager.isRegistered(node.id)) {
        this.focusManager.unregister(node.id);
      }
      this.focusManager.register({
        id: node.id,
        scope: node.scope as unknown as PrimFocusScope,
        focusable: node.focusable,
        priority: node.order,
        owner: node.owner,
        parent: node.parent ?? null,
      });
    } catch (err) {
      if (debug.enabled) {
        debug.log('primitive.focus.registerFailed', node.id, {
          scope: node.scope,
          focusable: node.focusable,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** H1.3: mirror a pushModal into the LayerTree primitive. Upsert
   *  semantics — a second push with the same id disposes the stale
   *  handle first so the LayerTree doesn't throw on duplicate id.
   *  ZTier is derived from the ModalTier rollup; bounds forward
   *  verbatim. Mirror failures are swallowed + logged. */
  private mirrorPushToLayerTree(surface: ModalSurface): void {
    // Dispose any stale handle for this id (upsert semantics).
    const stale = this.layerHandles.get(surface.id);
    if (stale && !stale.isDisposed()) stale.dispose();
    this.layerHandles.delete(surface.id);
    try {
      const handle = this.layerTree.addLayer({
        id: surface.id as LayerId,
        bounds: toLayerRect(surface.bounds),
        zTier: modalTierToZTier(surface.tier),
      });
      this.layerHandles.set(surface.id, handle);
    } catch (err) {
      if (debug.enabled) {
        debug.log('primitive.layerTree.pushFailed', surface.id, {
          tier: surface.tier ?? null,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** B-2: mirror a pushModal into the ModalLifecycle primitive.
   *  Isolated so the main pushModal stays readable. */
  private mirrorPushToPrimitive(surface: ModalSurface): void {
    const tier = surface.tier ?? 'dialog';
    const typeName = `__coord-mirror:${tier}`;
    try {
      const handle = this.modalLifecycle.push(
        typeName,
        { idempotencyKey: surface.id },
        surface,
      );
      if (handle) {
        this.mirrorHandles.set(surface.id, handle);
      }
    } catch (err) {
      if (debug.enabled) {
        debug.log('primitive.mirror.pushFailed', surface.id, {
          tier,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** P2.3.a — pop a modal off the stack. Closes the surface (which
   *  pops focus to the previous active surface) and re-renders. */
  popModal(id: SurfaceId): void {
    if (!this.surfaces.has(id)) {
      if (debug.enabled) debug.log('window.popModal.miss', id, { id, caller: callerFrames() });
      // Still dispose the mirror handle if one exists — prevents a
      // silent primitive-state leak when coordinator.surfaces already
      // lost the entry via a prior closeSurface.
      const strayHandle = this.mirrorHandles.get(id);
      if (strayHandle && !strayHandle.isDisposed()) strayHandle.dispose();
      this.mirrorHandles.delete(id);
      return;
    }
    if (debug.enabled) debug.log('window.popModal', id, {
      id,
      stackBefore: [...this.paintStack],
      caller: callerFrames(),
    });
    this.closeSurface(id);
    // Q7 B+ (substrate Occam, 2026-05-03) — modal pop unconditionally
    // triggers a full-frame redraw on the next tick. This is the
    // "cheap blanket fix" for the stale-pixel risk class: an occluder
    // that hid covered surfaces while open would otherwise leave its
    // own old pixels on the buffer when popped, since covered surfaces
    // never repainted while occluded. Per Q7 decision, full repaint is
    // sub-frame on modern terminals — cheaper than per-bounds
    // intersection compute and immune to partial-occlusion edge cases.
    // Federation invariant F9 (REQUIREMENTS §5) spells out this seam.
    this.markDirty('all');
    this.forceNext = true;       // ensure underlying rows repaint
    // B-2 mirror — dispose the primitive handle (synchronously
    // emits disposed + invalidate events). Best-effort; coordinator
    // still ran its own cleanup.
    const handle = this.mirrorHandles.get(id);
    if (handle && !handle.isDisposed()) handle.dispose();
    this.mirrorHandles.delete(id);
    this.requestFrame();
  }

  /** P2.3.a — list modal surface ids in focus-stack order
   *  (bottom→top). Useful for debug + tests. */
  modalStack(): SurfaceId[] {
    return this.paintStack.filter(id => {
      const s = this.surfaces.get(id);
      return !!s && s.kind === 'modal';
    });
  }

  /** Q6 (Phase 4 partial · drag-to-front, 2026-05-03) — raise the
   *  surface to the top of its OWN tier in paintStack order. Tier
   *  ordering invariant preserved (F6) — surfaces in higher tiers
   *  remain above the raised surface; lower-tier surfaces remain
   *  below. Focus is NOT changed (F10) — clicking-to-raise is a
   *  pure z-order intent; transferring focus is a separate
   *  setFocus() call the caller may chain.
   *
   *  Returns true when paintStack changed; false when target was
   *  not on the stack, lacked a tier, or already at top of its
   *  tier (idempotent no-op).
   *
   *  REQUIREMENTS ref: §4.3 (Q6) · §5 F10 (focus separation invariant) */
  raiseInTier(id: SurfaceId): boolean {
    const surface = this.surfaces.get(id);
    if (!surface || !isModalSurface(surface)) return false;
    const targetTier = surface.tier;
    if (!targetTier) return false;
    const targetRank = tierRank(targetTier);
    if (targetRank < 0) return false;

    const currentIdx = this.paintStack.indexOf(id);
    if (currentIdx < 0) return false;

    // Find insertion position by scanning top-down: skip surfaces in
    // higher tiers (they stay above), stop at the first same-or-lower
    // tier surface and insert just after it. When no higher-tier
    // surfaces exist, target lands at the very top of paintStack.
    const stripped = this.paintStack.filter(x => x !== id);
    let insertAt = stripped.length;
    for (let i = stripped.length - 1; i >= 0; i--) {
      const otherSurface = this.surfaces.get(stripped[i]!);
      const otherTier = otherSurface && isModalSurface(otherSurface) ? otherSurface.tier : undefined;
      if (otherTier === undefined) continue;
      const otherRank = tierRank(otherTier);
      if (otherRank < 0) continue;
      if (otherRank > targetRank) {
        insertAt = i; // place target before this higher-tier surface
        continue;
      }
      // Same-or-lower tier — insertion point is just after this index;
      // since insertAt was already lowered to point at the topmost
      // higher-tier index when applicable, leave it.
      break;
    }

    const next = [...stripped.slice(0, insertAt), id, ...stripped.slice(insertAt)];

    // Idempotent: skip frame churn when stack ordering did not change.
    let changed = next.length !== this.paintStack.length;
    if (!changed) {
      for (let i = 0; i < next.length; i++) {
        if (next[i] !== this.paintStack[i]) { changed = true; break; }
      }
    }
    if (!changed) {
      if (debug.enabled) {
        debug.log('window.raiseInTier.noop', id, { tier: targetTier, currentIdx });
      }
      return false;
    }

    this.paintStack = next;
    this.markDirty(id);
    this.requestFrame();

    if (debug.enabled) {
      debug.log('window.raiseInTier', id, {
        tier: targetTier,
        from: currentIdx,
        to: insertAt,
        stackAfter: [...this.paintStack],
      });
    }
    return true;
  }

  /** Q6 mouse-wiring integration (Phase 4 · 2026-05-03) — drag-to-
   *  front on click. When a click at `(row, col)` lands on a
   *  backgrounded popup-tier modal (i.e. one that's NOT at the top
   *  of its tier), raise it within tier AND transfer focus.
   *
   *  Per Q6 + F10 invariants:
   *    - Within-tier raise only (cross-tier z preserved · §4.4)
   *    - Focus transfers (per A1 default — most natural UX, matches
   *      macOS Finder window-click pattern)
   *
   *  Tier policy (this iteration):
   *    - popup tier ONLY participates in click-to-raise.
   *    - dialog / picker / menu / terminal / vw / etc. unchanged
   *      (different UX expectations per tier — pickers select rows,
   *      dialogs are typically singleton modal).
   *    - Per-surface opt-out NOT supported yet (no signal that any
   *      popup wants to disable raise; add `noRaiseOnClick?: boolean`
   *      field if/when one surface opts out).
   *
   *  Walks paintStack TOP→BOTTOM (visual top first). The first
   *  modal whose `interactiveBounds` (or `bounds` fallback) contains
   *  the click point is the "hit" surface. If hit.tier !== 'popup',
   *  no action (returns null) — raise doesn't reach UNDER higher-
   *  tier surfaces. If hit IS popup but already at top of its tier,
   *  no-op (returns null). Otherwise raises + focuses + returns id.
   *
   *  Caller (mouseWiring) typically invokes this on left-click
   *  before normal dispatch — the now-raised popup then receives
   *  the same click via standard `getTopModalSurface()` routing in
   *  the same tick.
   *
   *  REQUIREMENTS ref: §4.3 (Q6) · §5 F10 (focus separation invariant). */
  tryRaiseModalAtPoint(row: number, col: number): SurfaceId | null {
    for (let i = this.paintStack.length - 1; i >= 0; i--) {
      const id = this.paintStack[i]!;
      const s = this.surfaces.get(id);
      if (!s || !isModalSurface(s)) continue;
      const bounds = s.interactiveBounds ?? s.bounds;
      if (!rectContains(bounds, row, col)) continue;
      // First surface containing the point is the hit.
      if (s.tier !== 'popup') return null;
      const raised = this.raiseInTier(id);
      if (!raised) return null;   // already at top of tier
      if (this.focusManager.isRegistered(id)) {
        this.focusManager.setFocus(id, 'mouse-raise-on-click');
      }
      if (debug.enabled) {
        debug.log('window.raiseOnClick', id, {
          id, row, col, tier: s.tier,
        });
      }
      return id;
    }
    return null;
  }

  /** Phase 4 (substrate Occam · §4-pre.8 · 2026-05-03) — invalidate
   *  the paint cache for `id` so the next renderModalStack call
   *  re-runs paint() instead of reusing the cached ANSI.
   *
   *  Two equivalent ways to invalidate:
   *    1. Surface mutates its own `generation` counter (preferred for
   *       stateful surfaces with internal mutation hooks). Cache key
   *       changes automatically; this method becomes optional.
   *    2. Surface declares no `generation` field (or never mutates it)
   *       and the caller invokes `coord.bumpGeneration(id)` from the
   *       state-change site. The coordinator records a side-channel
   *       counter that participates in the cache key.
   *
   *  This API takes path (2): increments a coord-owned per-surface
   *  generation counter and forces the next paint to be a cache miss
   *  by deleting the cached entry. Cheaper than markDirty(id) — it
   *  doesn't trigger a redraw, only invalidates the cache so when a
   *  redraw IS triggered, paint() runs.
   *
   *  Returns true when the cache had an entry; false when the surface
   *  was never painted yet (no-op). */
  bumpGeneration(id: SurfaceId): boolean {
    const had = this.paintCache.delete(id);
    // Phase 5 F8 telemetry — track bump frequency per surface for
    // observability. Operators can use `generationStats()` to spot
    // surfaces that participate in the paint cache (`generation`
    // field declared) but never bump — strong stale-paint risk
    // signal under the F8 invariant ("data arrival → bump → cache
    // miss → paint").
    const entry = this.surfaceGenerationBumps.get(id);
    const now = this.now();
    if (entry) {
      entry.bumps += 1;
      entry.lastBumpAt = now;
    } else {
      this.surfaceGenerationBumps.set(id, { bumps: 1, lastBumpAt: now });
    }
    if (debug.enabled) {
      debug.log('window.bumpGeneration', id, { id, had });
    }
    return had;
  }

  /** Test/debug introspection — returns the running tally of paint
   *  cache hits + misses since coord construction (or last reset).
   *  Coord increments these inside the renderModalStack onPaintCache
   *  hook on every flushOverlay. */
  paintCacheStats(): { hits: number; misses: number; size: number } {
    return {
      hits: this.paintCacheHits,
      misses: this.paintCacheMisses,
      size: this.paintCache.size,
    };
  }

  /** Test-only — drop all paint cache entries + reset hit/miss
   *  counters. Production code never needs this; coord clears entries
   *  per-surface in closeSurface. */
  _resetPaintCacheForTests(): void {
    this.paintCache.clear();
    this.paintCacheHits = 0;
    this.paintCacheMisses = 0;
  }

  /** Phase 4.5b (substrate Occam · §4-pre.10 partial · 2026-05-03) —
   *  overlay write stats. `skipped` counts flushOverlay calls where
   *  the rendered ANSI was byte-identical to the prior frame and the
   *  writeOverlay call was suppressed; `written` counts the calls
   *  that did emit. Useful for production telemetry — a high skipped
   *  ratio confirms the optimization is winning. */
  overlayWriteStats(): { skipped: number; written: number } {
    return { skipped: this.overlayWritesSkipped, written: this.overlayWritesEmitted };
  }

  /** Test-only — drop the prev-overlay cache + reset write counters. */
  _resetOverlayWriteCacheForTests(): void {
    this.prevOverlayAnsi = null;
    this.overlayWritesSkipped = 0;
    this.overlayWritesEmitted = 0;
  }

  /** Phase 5 F8 shadow stats (2026-05-03 · ELANOUS_F8_SHADOW=1). When
   *  shadow mode is enabled, reports the count of cache hits whose
   *  fresh paint() output diverged from the cached `prior.ansi` —
   *  divergence = surface mutated state without bumping generation
   *  (= F8 violation: data ↔ paint seam broken). When shadow mode
   *  is off, divergences stays at 0 (no extra paint() calls).
   *
   *  Total cache hits checked while shadow is on equals
   *  `paintCacheStats().hits` (the per-frame onPaintCache callback
   *  is the same path that drives shadow check). */
  f8ShadowStats(): { mode: boolean; divergences: number } {
    return {
      mode: this.f8ShadowMode,
      divergences: this.f8ShadowDivergences,
    };
  }

  /** Test-only — reset F8 shadow counters. */
  _resetF8ShadowStatsForTests(): void {
    this.f8ShadowDivergences = 0;
  }

  /** Phase 5 (substrate Occam · L5 lesson · 2026-05-03) — runtime
   *  mount-churn counter. Returns the number of push+pop events
   *  recorded for `id` within the trailing `windowMs` window.
   *  Combines pushes and pops into a single count — a 30 Hz mount/
   *  unmount loop produces ~60 events/s, so any window <= 1000ms
   *  cleanly distinguishes pathological churn from normal lifecycle.
   *
   *  Returns 0 when the surface has no recorded events (never
   *  mounted, or all events aged out beyond the bounded ring of
   *  MOUNT_CHURN_RING_SIZE entries).
   *
   *  Use cases:
   *    - HUD/diagnostic widget displaying top-N churning surfaces
   *    - Test assertions on mount lifecycle correctness
   *    - On-demand RCA of "why is this surface flickering" without
   *      needing to re-instrument from scratch
   *
   *  The warning log `window.mountChurn.warn` fires automatically
   *  when a single surface crosses MOUNT_CHURN_WARN_THRESHOLD events
   *  within MOUNT_CHURN_WARN_WINDOW_MS — first-line warning for the
   *  picker-flicker class of bug (origin: incident #1401). */
  surfaceMountChurn(id: SurfaceId, windowMs: number): number {
    const ring = this.surfaceMountEvents.get(id);
    if (!ring || ring.length === 0) return 0;
    const cutoff = this.now() - windowMs;
    let count = 0;
    for (let i = ring.length - 1; i >= 0; i--) {
      if (ring[i]! < cutoff) break;
      count++;
    }
    return count;
  }

  /** Test-only — clear all mount event rings + reset for fresh state. */
  _resetMountChurnForTests(): void {
    this.surfaceMountEvents.clear();
  }

  /** Phase 5 (substrate Occam · F8 telemetry · 2026-05-03) —
   *  per-surface generation-bump statistics. Returns one entry per
   *  surface whose `bumpGeneration(id)` has been called at least
   *  once. Each entry includes total bumps and ms-timestamp of the
   *  most recent bump.
   *
   *  F8 invariant ("data arrival → bump → cache miss → paint")
   *  observability use:
   *    - Surface declares `generation` (opted into paint cache)
   *      AND has bumps == 0 / lastBumpAt very old → potential
   *      stale-paint risk (cache hits but data may have changed).
   *    - Surface bump rate spikes → may indicate runaway state
   *      churn (separate bug class from §4.5b cell-diff scope).
   *
   *  Returns sorted by lastBumpAt DESC (most recently bumped first).
   *  Useful for HUD widgets and operator inspection (slash command). */
  generationStats(): Array<{ id: SurfaceId; bumps: number; lastBumpAt: number }> {
    const out: Array<{ id: SurfaceId; bumps: number; lastBumpAt: number }> = [];
    for (const [id, entry] of this.surfaceGenerationBumps) {
      out.push({ id, bumps: entry.bumps, lastBumpAt: entry.lastBumpAt });
    }
    out.sort((a, b) => b.lastBumpAt - a.lastBumpAt);
    return out;
  }

  /** Test-only — clear generation bump tracking for fresh state. */
  _resetGenerationStatsForTests(): void {
    this.surfaceGenerationBumps.clear();
  }

  /** Internal — record a mount event (push or pop) for surface id.
   *  Bounded ring keeps memory trivial; warning fires when threshold
   *  exceeded within the warn window. */
  private recordMountEvent(id: SurfaceId): void {
    let ring = this.surfaceMountEvents.get(id);
    if (!ring) {
      ring = [];
      this.surfaceMountEvents.set(id, ring);
    }
    const now = this.now();
    ring.push(now);
    if (ring.length > DisplayCoordinator.MOUNT_CHURN_RING_SIZE) {
      ring.shift();
    }
    if (ring.length >= DisplayCoordinator.MOUNT_CHURN_WARN_THRESHOLD) {
      const cutoff = now - DisplayCoordinator.MOUNT_CHURN_WARN_WINDOW_MS;
      let recentCount = 0;
      for (let i = ring.length - 1; i >= 0; i--) {
        if (ring[i]! < cutoff) break;
        recentCount++;
      }
      if (recentCount >= DisplayCoordinator.MOUNT_CHURN_WARN_THRESHOLD) {
        if (debug.enabled) {
          debug.log('window.mountChurn.warn', id, {
            id,
            recentEventCount: recentCount,
            windowMs: DisplayCoordinator.MOUNT_CHURN_WARN_WINDOW_MS,
            threshold: DisplayCoordinator.MOUNT_CHURN_WARN_THRESHOLD,
            ringSize: ring.length,
          }, { level: 'warn' });
        }
      }
    }
  }

  /** IDX-F1 — find the top-most surface matching a given tier, or
   *  null when no surface of that tier is on the stack. Replaces
   *  per-tier singleton caches like `mouseWiring.activePopup` and
   *  `terminalModalRouter.current()` with a single source of truth.
   *
   *  Searches `focus.stack` top-down (visual top first) and returns
   *  the first surface whose `tier` label matches. Ignores legacy
   *  surfaces that haven't declared a tier yet — during the IDX-F
   *  migration, untagged surfaces are invisible to tier lookup.
   *
   *  Instrumented: every lookup call emits a gated debug.log so
   *  routing decisions can be traced end-to-end. Per CLAUDE.md. */
  topOfTier(tier: ModalTier): DisplaySurface | null {
    for (let i = this.paintStack.length - 1; i >= 0; i--) {
      const id = this.paintStack[i]!;
      const surface = this.surfaces.get(id);
      if (!surface) continue;
      if (surface.tier === tier) {
        if (debug.enabled) {
          debug.log('window.topOfTier.hit', tier, { id, stackSize: this.paintStack.length });
        }
        return surface;
      }
    }
    if (debug.enabled) debug.log('window.topOfTier.miss', tier, { stackSize: this.paintStack.length });
    return null;
  }

  surface(id: SurfaceId): DisplaySurface | null {
    return this.surfaces.get(id) ?? null;
  }

  updateModalBounds(id: SurfaceId, nextBounds: ModalSurface['bounds']): boolean {
    const surface = this.surfaces.get(id);
    if (!surface || !isModalSurface(surface)) return false;
    const prevBounds = { ...surface.bounds };
    const clamped = clampModalBoundsToViewport(nextBounds, this.termSize());
    if (
      prevBounds.row === clamped.row
      && prevBounds.col === clamped.col
      && prevBounds.width === clamped.width
      && prevBounds.height === clamped.height
    ) {
      return true;
    }
    applyModalBoundsUpdate(surface, prevBounds, clamped);
    try {
      this.layerTree.setBounds(surface.id as LayerId, toLayerRect(surface.bounds));
    } catch (err) {
      if (debug.enabled) {
        debug.log('primitive.layerTree.setBoundsFailed', surface.id, {
          err: err instanceof Error ? err.message : String(err),
        });
      }
      this.renderCoordinator.markNeedsPaint(surface.id as LayerId, prevBounds);
      this.renderCoordinator.markNeedsPaint(surface.id as LayerId, surface.bounds);
    }
    this.upsertSurface(surface);
    this.markDirty(surface.id);
    this.forceNext = true;
    this.requestFrame();
    return true;
  }

  moveModalBy(id: SurfaceId, delta: { row: number; col: number }): boolean {
    const surface = this.surfaces.get(id);
    if (!surface || !isModalSurface(surface)) return false;
    return this.updateModalBounds(id, shiftModalBounds(surface.bounds, delta));
  }

  currentFocus(): SurfaceId | null {
    return (this.focusManager.active()?.id ?? null);
  }

  /** Project focus owned by a legacy subsystem into the coordinator
   *  without scheduling another frame. This lets dashboard-local
   *  state such as `workingDir.focus` stay authoritative during the
   *  migration while key routing can still read one focus model.
   *
   *  F-3a-2 (2026-04-22) — thinned to direct primitive delegation
   *  under the default (non-legacy) path. Legacy path routes via
   *  `setFocus` / `clearFocus` wrappers as before. The primitive
   *  write triggers the inverse-mirror listener which syncs coord
   *  state. For unregistered targets, the same synthesis path that
   *  `setFocus` uses applies (see `_ensureRegistered`). */
  syncExternalFocus(target: SurfaceId | null, reason = 'external'): void {
    // F-3a-2 / Q5 (Phase 3) — primitive-direct, no legacy fallback.
    if (target === null) {
      this.focusManager.clear(reason);
      return;
    }
    this._ensureRegistered(target);
    this.focusManager.setFocus(target, reason);
  }

  scratchState(): ScratchSurfaceState | null {
    return this.scratch ? { ...this.scratch, lines: [...this.scratch.lines] } : null;
  }

  registerFocusNode(node: FocusNode): DisplayDisposable {
    this.focusNodes.set(node.id, node);
    // F-2 mirror — keep the primitive's node registry in sync.
    this.mirrorFocusNodeRegister(node);
    this.markDirty('status');
    this.markDirty('dock');
    this.requestFrame();
    return {
      dispose: () => {
        this.focusNodes.delete(node.id);
        // Q5 (Phase 3 full, 2026-05-03) — capture state BEFORE
        // primitive.unregister, since that silently prunes
        // active/previous/history (no 'blurred' or 'cleared' emit
        // — see focus-manager.ts:217-237).
        const wasActive = this.focusManager.active()?.id === node.id;
        const wasOnStack = this.paintStack.includes(node.id);
        const previousIdBeforePrune = this.focusManager.previous()?.id ?? null;

        this.focusManager.unregister(node.id);

        if (wasActive) {
          // Try to restore focus to the next focusable, falling back
          // to the captured `previous`. setFocus routes through the
          // primitive; the inverse-mirror moves the new id to the
          // top of paintStack.
          const next = this.nextFocusableAfter(node.id) ?? previousIdBeforePrune;
          if (next && this.focusManager.isRegistered(next)) {
            this.setFocus(next, 'dispose');
          }
        }

        // Always scrub the disposed id from paintStack so paint
        // iteration / snapshot readers don't see stale ids.
        if (wasActive || wasOnStack) {
          this.paintStack = this.paintStack.filter(x => x !== node.id);
        }

        this.markDirty('status');
        this.markDirty('dock');
        this.requestFrame();
      },
    };
  }

  registerKeyBinding(binding: DisplayKeyBinding): DisplayDisposable {
    this.warnKeyBindingDiagnostics(binding);
    this.keyBindings.set(binding.id, {
      ...binding,
      priority: binding.priority ?? 0,
    });
    this.keyBindingRegistrationOrders.set(binding.id, ++this.nextKeyBindingRegistrationOrder);
    return {
      dispose: () => {
        this.keyBindings.delete(binding.id);
        this.keyBindingRegistrationOrders.delete(binding.id);
      },
    };
  }

  private warnKeyBindingDiagnostics(binding: DisplayKeyBinding): void {
    const effectiveChord = effectiveChordKey(binding);
    const unreachablePart = [binding.chordPrefix, binding.key]
      .filter((spec): spec is string => !!spec)
      .find(isCtrlShiftCharacterChord);
    if (unreachablePart) {
      this.warnKeyBinding(
        `key binding ${binding.id} uses unreachable Ctrl+Shift character chord ${unreachablePart}`,
        { bindingId: binding.id, effectiveChord, key: unreachablePart },
      );
    }

    const firstRegistrant = this.firstActiveRegistrant(effectiveChord);
    if (firstRegistrant) {
      this.warnKeyBinding(
        `key binding ${binding.id} duplicates ${effectiveChord}, first registered by ${firstRegistrant.id}`,
        { bindingId: binding.id, effectiveChord, firstRegistrantId: firstRegistrant.id },
      );
    }
  }

  private firstActiveRegistrant(effectiveChord: string): DisplayKeyBinding | undefined {
    let first: DisplayKeyBinding | undefined;
    let firstOrder = Number.POSITIVE_INFINITY;
    for (const existing of this.keyBindings.values()) {
      if (effectiveChordKey(existing) !== effectiveChord) continue;
      const order = this.keyBindingRegistrationOrders.get(existing.id) ?? Number.POSITIVE_INFINITY;
      if (order < firstOrder) {
        first = existing;
        firstOrder = order;
      }
    }
    return first;
  }

  private warnKeyBinding(message: string, data: Record<string, string>): void {
    console.warn(`[display.keybinding] ${message}`);
    debug.log('display.keybinding', 'warn', data);
  }

  cycleFocus(scope?: FocusScope | SurfaceOwner, dir: 1 | -1 = 1): SurfaceId | null {
    // F-3a-2 (2026-04-22) — read the active id from the primitive
    // (source of truth after F-3a-init). Scope matching + sort order
    // semantics are preserved via coord.focusNodes iteration because
    // primitive's `focusableInScope(scope)` uses strict scope equality
    // and `priority desc` sort — coord historically matched `scope ||
    // owner` (both) and sorted by `order asc` which is an opposite
    // direction from primitive's priority policy. A direct
    // `focusManager.cycle(...)` call would flip the traversal order
    // for every existing caller. Q5 (Phase 3): legacy fallback removed —
    // primitive is the only source of truth.
    const activeId = this.focusManager.active()?.id ?? null;
    const nodes = [...this.focusNodes.values()]
      .filter(n => n.focusable)
      .filter(n => !scope || n.scope === scope || n.owner === scope)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    if (nodes.length === 0) return null;
    const idx = nodes.findIndex(n => n.id === activeId);
    const next = idx < 0
      ? nodes[0]!
      : nodes[(idx + dir + nodes.length) % nodes.length]!;
    this.setFocus(next.id, 'cycle');
    this.requestFrame();
    return next.id;
  }

  /** Input-mode bridge — chat.ts's textInput owns its own readKey loop
   *  and doesn't call the full `routeKey`. But when a focusable modal
   *  (model-pill popup, ask-user modal, approval dialog) is on the
   *  stack, its keys have to go somewhere; otherwise textInput's
   *  typing/submit logic swallows them. This routes ONLY to the top
   *  focus:'owns' modal — no execution, no active surface, no
   *  keybinding dispatch — so typing in input mode still works when
   *  no modal is up, and global shortcuts don't fire spuriously from
   *  inside the input buffer. Returns 'consumed' when the modal took
   *  the key, 'passthrough' otherwise.
   *
   *  IDX-F1.5 — async-only since the sync variant was dropped (zero
   *  src/ callers). Awaits surface.onKey when it returns a Promise so
   *  the chat picker (F2.5+) can call `picker.dispatch` directly from
   *  onKey. */
  async tryRouteKeyToTopModalAsync(ev: KeyEvent): Promise<'consumed' | 'passthrough'> {
    const modal = this.topFocusedSurface('modal');
    if (debug.enabled) {
      debug.log('key.route.input-modal', 'enter', {
        key: keyRouteLabel(ev),
        modalId: modal?.id ?? null,
        active: (this.focusManager.active()?.id ?? null),
      });
    }
    if (!modal) {
      if (debug.enabled) {
        debug.log('key.route.input-modal', 'passthrough', {
          key: keyRouteLabel(ev),
          reason: 'no-modal',
        });
      }
      return 'passthrough';
    }
    const res = await this.routeSurfaceKeyAsync(modal, ev);
    if (!res) {
      if (debug.enabled) {
        debug.log('key.route.input-modal', 'passthrough', {
          key: keyRouteLabel(ev),
          modalId: modal.id,
          reason: 'surface-passthrough',
        });
      }
      return 'passthrough';
    }
    if (debug.enabled) {
      debug.log('key.route.input-modal', 'consumed', {
        key: keyRouteLabel(ev),
        modalId: modal.id,
        routeType: res.type,
      });
    }
    if (res.type === 'consumed' || res.type === 'action') return 'consumed';
    return 'passthrough';
  }

  routeKey(ev: KeyEvent): DisplayKeyRouteResult {
    const snapshot = this.snapshot();
    if (debug.enabled) {
      debug.log('key.route', 'enter', {
        key: keyRouteLabel(ev),
        active: snapshot.focus.active,
        stackDepth: snapshot.focus.stack.length,
      });
    }
    const modal = this.topFocusedSurface('modal');
    const modalAction = modal ? this.routeSurfaceKey(modal, ev) : null;
    if (modalAction) {
      if (debug.enabled) {
        debug.log('key.route', 'hit', {
          key: keyRouteLabel(ev),
          branch: 'modal',
          target: modal?.id ?? null,
          routeType: modalAction.type,
        });
      }
      return modalAction;
    }

    const execution = this.activeSurfaceInScope('execution');
    const executionAction = execution ? this.routeSurfaceKey(execution, ev) : null;
    if (executionAction) {
      if (debug.enabled) {
        debug.log('key.route', 'hit', {
          key: keyRouteLabel(ev),
          branch: 'execution',
          target: execution?.id ?? null,
          routeType: executionAction.type,
        });
      }
      return executionAction;
    }

    const activeId = this.focusManager.active()?.id ?? null;
    const active = activeId !== null ? this.surfaces.get(activeId) : undefined;
    const activeAction = active ? this.routeSurfaceKey(active, ev) : null;
    if (activeAction) {
      if (debug.enabled) {
        debug.log('key.route', 'hit', {
          key: keyRouteLabel(ev),
          branch: 'active',
          target: active?.id ?? null,
          routeType: activeAction.type,
        });
      }
      return activeAction;
    }

    // FU-1 — chord handling runs before single-key matching. If a
    // prefix was armed on the previous keystroke and hasn't expired,
    // we look for chord bindings whose body matches. On a miss the
    // arm state clears and the current key falls through to regular
    // matching (so e.g. `Ctrl+M` then `q` just types `q`).
    const chordAction = this.resolveChordKey(ev, snapshot);
    if (chordAction) {
      if (debug.enabled) {
        debug.log('key.route', 'hit', {
          key: keyRouteLabel(ev),
          branch: chordAction.type === 'chord-armed' ? 'chord-arm' : 'chord-body',
          routeType: chordAction.type,
        });
      }
      return chordAction;
    }

    const bindingResult = this.matchSingleKeyBinding(ev, snapshot);
    if (debug.enabled) {
      if (bindingResult.type === 'passthrough') {
        debug.log('key.route', 'passthrough', {
          key: keyRouteLabel(ev),
          active: snapshot.focus.active,
        });
      } else if (bindingResult.type === 'handler' || bindingResult.type === 'command') {
        debug.log('key.route', 'hit', {
          key: keyRouteLabel(ev),
          branch: 'binding',
          bindingId: bindingResult.binding.id,
          routeType: bindingResult.type,
        });
      }
    }
    return bindingResult;
  }

  /** IDX-F1.5 — async variant of `routeKey`. Honours Promise returns
   *  from surface.onKey. Non-onKey paths (chord, keybinding) resolve
   *  synchronously but are wrapped in a Promise to keep the return
   *  type uniform. Caller awaits; the dashboard key loop on the async
   *  path is `await display.routeKeyAsync(key)`. */
  async routeKeyAsync(ev: KeyEvent): Promise<DisplayKeyRouteResult> {
    const snapshot = this.snapshot();
    const modal = this.topFocusedSurface('modal');
    const modalAction = modal ? await this.routeSurfaceKeyAsync(modal, ev) : null;
    if (modalAction) return modalAction;

    const execution = this.activeSurfaceInScope('execution');
    const executionAction = execution ? await this.routeSurfaceKeyAsync(execution, ev) : null;
    if (executionAction) return executionAction;

    const activeId = this.focusManager.active()?.id ?? null;
    const active = activeId !== null ? this.surfaces.get(activeId) : undefined;
    const activeAction = active ? await this.routeSurfaceKeyAsync(active, ev) : null;
    if (activeAction) return activeAction;

    const chordAction = this.resolveChordKey(ev, snapshot);
    if (chordAction) return chordAction;

    return this.matchSingleKeyBinding(ev, snapshot);
  }

  routeMouseToSurface(surface: DisplaySurface, ev: DisplayMouseEvent): boolean {
    if (debug.enabled) {
      debug.log('mouse.route.surface', 'enter', {
        surfaceId: surface.id,
        kind: surface.kind,
        type: ev.type,
        row: ev.row,
        col: ev.col,
      });
    }
    if (!surface.onMouse) {
      if (debug.enabled) {
        debug.log('mouse.route.surface', 'skip-no-handler', {
          surfaceId: surface.id,
          kind: surface.kind,
        });
      }
      return false;
    }
    let res: Action | null = null;
    try {
      res = surface.onMouse(ev);
    } catch {
      if (debug.enabled) {
        debug.log('mouse.route.surface', 'handler-error', {
          surfaceId: surface.id,
          kind: surface.kind,
          type: ev.type,
        }, { level: 'error' });
      }
      return false;
    }
    if (debug.enabled) {
      debug.log('mouse.route.surface', 'result', {
        surfaceId: surface.id,
        kind: surface.kind,
        type: ev.type,
        result: res?.type ?? null,
      });
    }
    if (!res || res.type === 'none') return false;
    // Phase 4 (substrate Occam · §4-pre.8) — onMouse returning a non-
    // none Action signals the surface mutated state. Invalidate the
    // paint cache so the next renderModalStack call re-runs paint().
    // Surfaces that intentionally don't mutate visible state on click
    // can still avoid the bump by returning {type:'none'} or false.
    this.paintCache.delete(surface.id);
    this.markDirty(surface.id);
    this.requestFrame();
    return true;
  }

  routeKeyToSurface(surface: DisplaySurface, ev: KeyEvent): DisplayKeyRouteResult {
    const res = this.routeSurfaceKey(surface, ev);
    return res ?? { type: 'passthrough' };
  }

  /** FU-1 — chord dispatch. Two-phase:
   *   (1) if any chord binding's prefix matches this key → arm + return
   *       'chord-armed' (caller should swallow the key);
   *   (2) if we were already armed (and the arm hasn't timed out),
   *       find a chord binding whose body matches this key → disarm +
   *       invoke. Mismatch disarms without dispatching.
   *  Returns null when no chord logic applies so the caller falls
   *  through to regular single-key matching. */
  private resolveChordKey(ev: KeyEvent, snapshot: DisplaySnapshot): DisplayKeyRouteResult | null {
    const chordBindings = [...this.keyBindings.values()].filter(b => !!b.chordPrefix);
    if (chordBindings.length === 0) {
      this.chordArmed = null;
      return null;
    }

    // Expire stale arming first.
    if (this.chordArmed) {
      const binding0 = chordBindings[0]!;
      const timeout = binding0.chordTimeoutMs ?? 1000;
      if (this.now() - this.chordArmed.armedAt > timeout) {
        this.chordArmed = null;
      }
    }

    // Armed path — look for body match against the armed prefix.
    if (this.chordArmed) {
      const armedPrefix = this.chordArmed.prefix;
      this.chordArmed = null; // disarm regardless of outcome
      const hit = chordBindings
        .filter(b => b.chordPrefix === armedPrefix
                  && matchesKey(b.key, ev)
                  && (!b.when || b.when(snapshot))
                  && this.scopeMatches(b, snapshot))
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id))[0];
      if (hit && hit.handler) {
        logKeyBindingRoute('selected', ev, { id: hit.id });
        return { type: 'handler', binding: hit, invoke: hit.handler };
      }
      if (hit && hit.command !== undefined) {
        logKeyBindingRoute('selected', ev, { id: hit.id });
        return { type: 'command', binding: hit, command: hit.command };
      }
      // Body mismatch — fall through so the key can be handled normally.
      return null;
    }

    // Idle path — look for a prefix match to arm.
    const armCandidate = chordBindings.find(b => {
      if (!b.chordPrefix) return false;
      if (!matchesKey(b.chordPrefix, ev)) return false;
      if (b.when && !b.when(snapshot)) return false;
      return this.scopeMatches(b, snapshot);
    });
    if (armCandidate) {
      this.chordArmed = { prefix: armCandidate.chordPrefix!, armedAt: this.now() };
      logKeyBindingRoute('chord-armed', ev, {
        id: armCandidate.id,
        prefix: armCandidate.chordPrefix,
      });
      return { type: 'chord-armed', prefix: armCandidate.chordPrefix! };
    }
    return null;
  }

  /** Single-key binding pick shared by routeKey / routeKeyAsync.
   *  Logs the binding decision unconditionally; return values stay the
   *  existing handler / command / passthrough meanings. */
  private matchSingleKeyBinding(ev: KeyEvent, snapshot: DisplaySnapshot): DisplayKeyRouteResult {
    const applicable: DisplayKeyBinding[] = [];
    let blockedByWhen: DisplayKeyBinding | undefined;
    for (const binding of this.keyBindings.values()) {
      if (binding.chordPrefix) continue;
      if (!matchesKey(binding.key, ev)) continue;
      // Scope first: a binding that cannot be selected in this focus
      // must not be reported as when-false.
      if (!this.scopeMatches(binding, snapshot)) continue;
      if (binding.when && !binding.when(snapshot)) {
        blockedByWhen ??= binding;
        continue;
      }
      applicable.push(binding);
    }
    applicable.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
    const binding = applicable[0];
    if (binding) {
      if (binding.handler) {
        logKeyBindingRoute('selected', ev, { id: binding.id });
        return { type: 'handler', binding, invoke: binding.handler };
      }
      if (binding.command !== undefined) {
        logKeyBindingRoute('selected', ev, { id: binding.id });
        return { type: 'command', binding, command: binding.command };
      }
    }
    if (blockedByWhen) {
      logKeyBindingRoute('when-false', ev, { id: blockedByWhen.id });
    } else {
      logKeyBindingRoute('no-match', ev);
    }
    return { type: 'passthrough' };
  }

  /** Test hook — inspect / clear chord arm state. */
  _chordState(): { prefix: string; armedAt: number } | null {
    return this.chordArmed ? { ...this.chordArmed } : null;
  }
  _resetChord(): void { this.chordArmed = null; }

  flushNow(): void {
    if (this.dirty.size === 0 && !this.forceNext) return;
    this.flush();
  }

  private upsertSurface(surface: DisplaySurface): void {
    const existed = this.surfaces.has(surface.id);
    const previous = existed ? this.surfaces.get(surface.id) : null;
    const previousModalBounds = previous && isModalSurface(previous)
      ? { ...previous.bounds }
      : null;
    if (debug.enabled) {
      debug.log(existed ? 'window.upsertSurface.update' : 'window.upsertSurface.mount', surface.id, {
        id: surface.id,
        kind: surface.kind,
        owner: surface.owner,
        priority: surface.priority,
        focus: surface.focus,
      });
    }
    this.surfaces.set(surface.id, surface);
    if (
      existed
      && previous
      && previousModalBounds
      && isModalSurface(previous)
      && isModalSurface(surface)
      && (
        previousModalBounds.row !== surface.bounds.row
        || previousModalBounds.col !== surface.bounds.col
        || previousModalBounds.width !== surface.bounds.width
        || previousModalBounds.height !== surface.bounds.height
      )
    ) {
      try {
        this.layerTree.setBounds(surface.id as LayerId, toLayerRect(surface.bounds));
      } catch (err) {
        if (debug.enabled) {
          debug.log('primitive.layerTree.setBoundsFailed', surface.id, {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    if (!this.focusNodes.has(surface.id)) {
      const autoNode: FocusNode = {
        id: surface.id,
        owner: surface.owner,
        focusable: surface.focus === 'owns',
        scope: scopeForSurface(surface),
        order: surface.priority,
      };
      this.focusNodes.set(surface.id, autoNode);
      // F-2 mirror — auto-registered nodes must flow to the primitive
      // as well so downstream setFocus via the primitive API can
      // target them. Mirrors the explicit `registerFocusNode` path.
      this.mirrorFocusNodeRegister(autoNode);
    }
    // Mount-time invalidation is intentionally NOT done here. pushModal
    // already calls markDirty(surface.id) + requestFrame(); the overlay
    // paints on absolute coords and doesn't need the main-render cache
    // forgotten. Invalidating + forceNext on every upsert turned out to
    // cascade poorly with the toast / transient-modal path (observed:
    // Ctrl+Shift+T path stopped producing a visible modal). Close-time
    // invalidation remains in closeSurface — that's where the residual
    // bug actually lives.
    if (!existed) {
      this.hooks.onSurfaceMounted?.(surface);
      this.eventBus?.emit({ type: 'surface:mounted', surface });
    }
  }

  private closeSurface(id: SurfaceId, opts?: { invalidateRegion?: boolean }): void {
    const surface = this.surfaces.get(id);
    if (!surface) {
      if (debug.enabled) debug.log('window.closeSurface.miss', id, { id, caller: callerFrames() });
      return;
    }
    // Phase 5 (substrate Occam · L5 · 2026-05-03) — record the
    // unmount event for surfaceMountChurn() telemetry. Recorded
    // inside the existence guard so true no-op calls (close on a
    // surface that's already gone) don't pollute the ring.
    this.recordMountEvent(id);
    const wasOnStack = this.paintStack.includes(id);
    if (debug.enabled) {
      debug.log('window.closeSurface', id, {
        id,
        kind: surface.kind,
        wasActive: (this.focusManager.active()?.id ?? null) === id,
        wasOnStack,
        stackBefore: [...this.paintStack],
        caller: callerFrames(),
      });
    }
    const dependentWorkspaceOwnedSurfaceIds =
      surface.kind === 'modal'
        ? [...this.surfaces.values()]
          .filter((candidate) =>
            candidate.kind === 'modal'
            && candidate.id !== id
            && candidate.ownerWorkspaceId === id)
          .map((candidate) => candidate.id)
        : [];
    for (const dependentId of dependentWorkspaceOwnedSurfaceIds) {
      this.closeSurface(dependentId);
    }
    // V2 — compute + invalidate the region BEFORE dispose, while
    // bounds are still readable. Fixes the modal-close residual bug:
    // the pixels the modal painted would otherwise stay on screen
    // because the main line buffer under them is unchanged, and the
    // row-diff path in tui.ts::render would skip them.
    if (opts?.invalidateRegion !== false) {
      this.invalidateSurfaceRegion(surface);
    }
    try { surface.dispose?.(); } finally {
      // Phase 4 (substrate Occam · §4-pre.8) — drop the paint cache
      // entry for the unmounted surface so a future surface re-using
      // the same id starts from a fresh paint() (no stale ANSI).
      this.paintCache.delete(id);
      // Phase 5 F8 telemetry — drop generation bump tracking too,
      // so a future surface re-using the same id starts with a
      // clean count (otherwise stale stats accumulate forever).
      this.surfaceGenerationBumps.delete(id);
      this.surfaces.delete(id);
      this.focusNodes.delete(id);
      // Q5 (Phase 3 full, 2026-05-03) — capture state BEFORE
      // primitive.unregister; that call silently prunes
      // active/previous/history (no event emit).
      const wasActive = this.focusManager.active()?.id === id;
      const previousIdBeforePrune = wasActive
        ? (this.focusManager.previous()?.id ?? null)
        : null;
      this.focusManager.unregister(id);
      if (wasActive) {
        // Restore focus to the captured `previous` when it's still
        // a valid focusable target. Otherwise active stays null
        // (primitive already pruned).
        if (
          previousIdBeforePrune !== null
          && previousIdBeforePrune !== id
          && this.focusManager.isRegistered(previousIdBeforePrune)
        ) {
          this.focusManager.setFocus(previousIdBeforePrune, 'closeSurface:restore');
        }
        this.paintStack = this.paintStack.filter(x => x !== id);
        this.markDirty('status');
        this.markDirty('dock');
      } else if (wasOnStack) {
        // Non-focusable modals (pickers) sit on the stack for paint
        // but never become active — the active-only branch above
        // wouldn't filter them out, leaving stale ids that trigger
        // renderModalStack lookups against a deleted surface AND
        // V4 vanished-cascade on every frame. Always scrub.
        this.paintStack = this.paintStack.filter(x => x !== id);
      }
      this.hooks.onSurfaceDisposed?.(surface);
      this.eventBus?.emit({ type: 'surface:disposed', surface });
      // B-2 mirror — dispose the primitive handle even when the
      // caller routed through closeSurface directly (vs popModal).
      // Non-focusable modals (pickers) frequently take this path.
      const mirror = this.mirrorHandles.get(id);
      if (mirror && !mirror.isDisposed()) mirror.dispose();
      this.mirrorHandles.delete(id);
      // H1.3 mirror — dispose the LayerTree handle alongside the
      // ModalLifecycle one. popModal routes through closeSurface so
      // both paths hit this dispose.
      const layerHandle = this.layerHandles.get(id);
      if (layerHandle && !layerHandle.isDisposed()) layerHandle.dispose();
      this.layerHandles.delete(id);
    }
  }

  /** Workspace surfaces are long-lived foreground owners, not
   *  ephemeral blocking popups. Detaching one during a VW switch
   *  should not trigger modal-close repaint semantics like
   *  force-clearing underlying rows. */
  detachWorkspaceSurface(id: SurfaceId): void {
    const surface = this.surfaces.get(id);
    if (!surface) return;
    if (debug.enabled) {
      debug.log('window.detachWorkspaceSurface', id, {
        id,
        kind: surface.kind,
        stackBefore: [...this.paintStack],
      });
    }
    // Workspace→workspace switch is a same-frame ownership handoff.
    // Do not let the old workspace surface participate in the
    // modal-stack "vanished overlay" follow-up frame, or the switch
    // shows an extra flash even though the new workspace repaints the
    // full base frame immediately.
    this.lastOverlayRegions.delete(id);
    this.closeSurface(id, { invalidateRegion: false });
    const mirror = this.mirrorHandles.get(id);
    if (mirror && !mirror.isDisposed()) mirror.dispose();
    this.mirrorHandles.delete(id);
    this.markDirty('all');
  }

  /** V2 — resolve `surface` → RowRange via regionMap, forget each row
   *  in the frame cache, and set forceNext so the next flush repaints
   *  regardless of what differential logic decides. No-op when the
   *  surface has no mapped region (panes / status / dock today). */
  private invalidateSurfaceRegion(surface: DisplaySurface): void {
    const range = this.regionMap.resolve(surface, this.termSize());
    if (!range) return;
    for (let r = range.startRow; r <= range.endRow; r++) {
      this.invalidateRow(r - 1); // RowRange is 1-indexed, cache is 0-indexed
    }
    this.forceNext = true;
  }

  private setFocus(target: SurfaceId, reason?: string): void {
    // F-3a — when legacy mode is not set, delegate to the primitive
    // which is now source of truth. Coord state updates happen via
    // the inverse-mirror listener (see `applyPrimitiveFocusedEvent`).
    // Keep the debug.log at entry so the routing boundary stays
    // observable regardless of path.
    if (debug.enabled) {
      debug.log('window.setFocus', `${(this.focusManager.active()?.id ?? null) ?? '—'} → ${target}`, {
        prev: (this.focusManager.active()?.id ?? null),
        next: target,
        reason,
      });
    }
    // Q5 (Phase 3, 2026-05-03) — primitive-direct only; legacy mode
    // (ELANOUS_LEGACY_FOCUS) removed.
    const coordNode = this.focusNodes.get(target);
    if (coordNode && !coordNode.focusable) return;
    this._ensureRegistered(target);
    this.focusManager.setFocus(target, reason ?? 'setFocus');
  }

  private markDirty(region: SurfaceId | 'all' | 'status' | 'dock'): void {
    this.dirty.add(region);
    // H1.6 · W2 shadow mirror — forward concrete layer ids into the
    // RenderCoordinator dirty queue. Pseudo-ids ('all' · 'status' ·
    // 'dock') are coord-local painting regions without a LayerTree
    // counterpart; they're excluded to keep the W2 queue layer-scoped.
    if (region !== 'all' && region !== 'status' && region !== 'dock') {
      try {
        this.renderCoordinator.markNeedsPaint(region as LayerId);
      } catch (err) {
        if (debug.enabled) {
          debug.log('primitive.renderCoordinator.markFailed', region, {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  private nextFocusableAfter(id: SurfaceId): SurfaceId | null {
    const nodes = [...this.focusNodes.values()]
      .filter(n => n.focusable && n.id !== id)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    return nodes[0]?.id ?? null;
  }

  private topFocusedSurface(scope: FocusScope): DisplaySurface | null {
    for (let i = this.paintStack.length - 1; i >= 0; i--) {
      const id = this.paintStack[i]!;
      const node = this.focusNodes.get(id);
      if (node?.scope !== scope) continue;
      // IDX-F2 — skip surfaces that neither hold focus nor opt into
      // key routing. `surface.focus === 'owns'` (focused) and
      // `surface.focus === 'participates'` (paint-only chat slash/arg/@
      // pickers) both receive onKey routing. Surfaces with
      // `focus: 'none'` (legacy paint-only overlays) are transparent
      // to routing.
      if (node?.focusable === false) {
        const surface = this.surfaces.get(id);
        if (!surface || surface.focus === 'none') continue;
      }
      return this.surfaces.get(id) ?? null;
    }
    return null;
  }

  private activeSurfaceInScope(scope: FocusScope): DisplaySurface | null {
    const activeId = this.focusManager.active()?.id ?? null;
    if (activeId === null) return null;
    const node = this.focusNodes.get(activeId);
    if (node?.scope !== scope) return null;
    return this.surfaces.get(activeId) ?? null;
  }

  private routeSurfaceKey(surface: DisplaySurface, ev: KeyEvent): DisplayKeyRouteResult | null {
    if (!surface.onKey) return null;
    const res = surface.onKey(ev);
    // IDX-F1.5 — surface.onKey may now return a Promise. The sync
    // routing path treats that as a fall-through: returning null here
    // lets routeKey try the next priority, and the Promise resolves
    // unawaited (fire-and-forget). Callers that need to honour async
    // onKey must use routeSurfaceKeyAsync. Debug-log the drop so a
    // mis-wired async surface surfaces in triage instead of silently
    // skipping routing decisions.
    if (res instanceof Promise) {
      if (debug.enabled) {
        debug.log('window.routeSurfaceKey.asyncDropped', surface.id, {
          id: surface.id,
          hint: 'sync routeKey cannot await onKey; use routeKeyAsync',
        });
      }
      return null;
    }
    if (res === 'passthrough') return null;
    if (res === 'consumed') {
      // Phase 4 (substrate Occam · §4-pre.8) — `consumed` signals
      // surface state mutated. Invalidate paint cache so paint()
      // re-runs on the next flushOverlay.
      this.paintCache.delete(surface.id);
      this.markDirty(surface.id);
      this.requestFrame();
      return { type: 'consumed', surfaceId: surface.id };
    }
    if (!res || res.type === 'none') return null;
    this.paintCache.delete(surface.id);
    this.markDirty(surface.id);
    this.requestFrame();
    return { type: 'action', surfaceId: surface.id, action: res };
  }

  /** IDX-F1.5 — async variant. Awaits surface.onKey if it returns a
   *  Promise (picker.dispatch path hits the filesystem). Callers on
   *  the async key path (chat.ts onPreKey in F2.5+) use this instead
   *  of routeSurfaceKey. Sync onKey returns resolve immediately. */
  private async routeSurfaceKeyAsync(
    surface: DisplaySurface,
    ev: KeyEvent,
  ): Promise<DisplayKeyRouteResult | null> {
    if (!surface.onKey) return null;
    const res = await Promise.resolve(surface.onKey(ev));
    if (res === 'passthrough') return null;
    if (res === 'consumed') {
      this.paintCache.delete(surface.id);
      this.markDirty(surface.id);
      this.requestFrame();
      return { type: 'consumed', surfaceId: surface.id };
    }
    if (!res || res.type === 'none') return null;
    this.paintCache.delete(surface.id);
    this.markDirty(surface.id);
    this.requestFrame();
    return { type: 'action', surfaceId: surface.id, action: res };
  }

  private scopeMatches(binding: DisplayKeyBinding, snapshot: DisplaySnapshot): boolean {
    if (binding.scope === 'global') return true;
    if (binding.scope === snapshot.focus.active) return true;
    const activeNode = snapshot.focus.active ? snapshot.focusNodes.get(snapshot.focus.active) : undefined;
    return activeNode?.owner === binding.scope;
  }

  private addDamageLayer(bounds: LayerRect): void {
    const id = this.nextDamageLayerId();
    const handle = this.layerTree.addLayer({ id, bounds, zTier: 'overlay' });
    this.damageLayerHandles.set(id, handle);
    this.renderCoordinator.markNeedsPaint(id, bounds);
  }

  private nextDamageLayerId(): LayerId {
    let id: LayerId;
    do {
      id = `__damage:${this.damageLayerCounter++}` as LayerId;
    } while (this.damageLayerHandles.has(id) || this.layerTree.getLayer(id));
    return id;
  }

  private clearDamageLayers(): void {
    this.clearingDamageLayers = true;
    try {
      for (const handle of this.damageLayerHandles.values()) handle.dispose();
      this.damageLayerHandles.clear();
    } finally {
      this.clearingDamageLayers = false;
    }
  }

  private requestFrame(): void {
    if (this.scheduled !== null) return;
    this.scheduled = this.scheduleFn(() => {
      this.scheduled = null;
      this.flush();
    }, this.frameMs);
  }

  private flush(): void {
    const request: DisplayRenderRequest = {
      dirty: new Set(this.dirty),
      force: this.forceNext,
    };
    this.dirty.clear();
    this.forceNext = false;
    const snapshot = this.snapshot();
    if (debug.enabled) {
      debug.log('window.flush.begin', 'flush', {
        dirty: [...request.dirty],
        force: request.force,
        stack: [...snapshot.focus.stack],
        active: snapshot.focus.active,
      });
    }
    // DECSET 2026 — Synchronized Output. Modern terminals (iTerm2,
    // WezTerm, Kitty, Ghostty, Alacritty, Windows Terminal, Contour)
    // buffer everything between BSU (`?2026h`) and ESU (`?2026l`) and
    // flip the display atomically at ESU, eliminating the mid-frame
    // flicker that appears when dashboard onRender → afterRender →
    // modal overlay paint in sequence. Terminals that don't
    // understand the sequence ignore it (no-op). Env escape hatch:
    // `ELANOUS_SYNC_OUTPUT=off` for buggy terminals (none observed in
    // practice, 2026-04-21). Pattern matches Textual (synchronized
    // output since v0.47) + Ratatui backend buffer-swap semantics.
    const syncOutput = this.syncOutputEnabled;
    if (syncOutput) this.writeOverlay?.('\x1b[?2026h');
    try {
      // H1.6 · W2 shadow flush. Fires rc.on('before-flush') +
      // rc.on('after-flush') synchronously. Subscriber paints (if any
      // are wired in Phase γ) land INSIDE the DECSET 2026 atomic-frame
      // wrap for free — no separate sync sequence required. The call
      // is a no-op when rc has no pending dirty work, so it costs
      // nothing when rc hasn't been used.
      try { this.renderCoordinator.flush(); }
      catch (err) {
        if (debug.enabled) {
          debug.log('primitive.renderCoordinator.flushFailed', 'flush', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        this.clearDamageLayers();
      }
      this.hooks.beforeRender?.(request, snapshot);
      this.eventBus?.emit({ type: 'render:before', request, snapshot });
      this.onRender?.(request, snapshot);
      // P2.2.b / P2.3.a — render order at frame end:
      //   1. afterRender hook (e.g. promptCtl repaint) — paints rows
      //      that may overwrite earlier modal pixels. Runs FIRST.
      //   2. modal-stack overlay — paints registered modals on top.
      //   3. cursor — lands LAST so it sits on top of everything.
      // Modals always emit fresh on every flush (they own their own
      // bounds — easier than tracking modal-version delta).
      this.hooks.afterRender?.(request, snapshot);
      this.flushOverlay(request, snapshot);
      // forceFrame=true: a real flush (with row paints) just happened,
      // so the prior cursor position may have been overwritten. Always
      // re-assert. The bypass-batch path calls flushCursor(false).
      this.flushCursor(true);
    } finally {
      // Always close the sync block — a throw inside render hooks
      // must not leave the terminal stuck in "buffering" mode.
      if (syncOutput) this.writeOverlay?.('\x1b[?2026l');
    }
    this.eventBus?.emit({ type: 'render:after', request, snapshot });
    this.pendingWidgetPatches = [];
    this.pendingLogLines = [];
  }

  /** DECSET 2026 env gate — evaluated lazily so tests can override
   *  by mutating process.env before instantiating. `off` / `0` /
   *  `false` disables the wrap; anything else (including unset)
   *  keeps it on. Tests also see it as off when process.stdout is
   *  not a TTY (unit-test + CI environment) so overlay assertions
   *  don't have to strip the ?2026h / ?2026l pair. */
  private get syncOutputEnabled(): boolean {
    const v = (process.env.ELANOUS_SYNC_OUTPUT ?? 'on').toLowerCase();
    if (v === 'off' || v === '0' || v === 'false') return false;
    // Non-TTY environments (tests, piped output) gain nothing from
    // atomic frame wrapping and the sequences would pollute assertions.
    if (typeof process !== 'undefined' && process.stdout && process.stdout.isTTY !== true) {
      return false;
    }
    return true;
  }

  /** Emit modal-stack overlay (bottom→top). When writeOverlay is
   *  unset, no-op.
   *
   *  V4 — safety-net region tracking: compare the regions about to
   *  paint against `lastOverlayRegions`. Any ID that vanished or whose
   *  bounds moved has its previous region rows invalidated in the
   *  frame cache and a follow-up frame scheduled (forceNext=true). This
   *  covers two gaps closeSurface alone does NOT:
   *    (a) pushModal re-called with the same id but changed bounds —
   *        upsertSurface keeps the old surface's pixels on rows no
   *        longer owned.
   *    (b) Focus-stack desync with the surfaces map — a surface still
   *        registered but removed from focus.stack stops rendering but
   *        leaves its pixels on screen.
   *  Single-modal open/close already works via closeSurface's region
   *  invalidation (landed in V2); V4 is the superset safety net. */
  private flushOverlay(request: DisplayRenderRequest, snapshot: DisplaySnapshot): void {
    if (!this.writeOverlay) {
      this.lastOverlayRegions.clear();
      return;
    }
    const termSize = this.termSize();
    const currentRegions = new Map<SurfaceId, RowRange>();
    const overlayFocusStack = snapshot.focus.stack.filter((id) => {
      const surface = snapshot.surfaces.get(id);
      return !!surface && !isWorkspaceInteractionSurface(surface);
    });
    // Phase 4.5a (substrate Occam · §4-pre.7 · 2026-05-03) — settle
    // dynamic bounds via the optional getBounds() lifecycle hook
    // BEFORE regionMap.resolve takes its snapshot. This eliminates
    // the snapshot/paint race that produced the picker `잔상` artifact:
    // pre-Phase-4.5a, the picker's paint() reassigned surface.bounds
    // when the filter shrank the height, but coord had already snapshot
    // the OLD bounds for region tracking — so the rows that fell
    // outside the new bounds went one frame without invalidation.
    // Now coord owns the assignment (with the §1.5 numeric-equality
    // short-circuit) and regionMap.resolve sees stable bounds. Surfaces
    // without getBounds() are unchanged.
    for (const id of overlayFocusStack) {
      const s = snapshot.surfaces.get(id);
      if (!s || !isModalSurface(s) || !s.getBounds) continue;
      const desired = s.getBounds();
      if (!desired) continue;
      const cur = s.bounds;
      if (
        cur.row === desired.row
        && cur.col === desired.col
        && cur.width === desired.width
        && cur.height === desired.height
      ) continue;
      // Bounds change → assign + drop paint cache entry. Region
      // delta is detected below by the existing prior-vs-current
      // comparison and triggers row invalidation in this same tick.
      s.bounds = desired;
      this.paintCache.delete(id);
      if (debug.enabled) {
        debug.log('window.getBounds.settle', id, {
          id,
          prev: { row: cur.row, col: cur.col, width: cur.width, height: cur.height },
          next: desired,
        });
      }
    }
    for (const id of overlayFocusStack) {
      const s = snapshot.surfaces.get(id);
      if (!s || !isModalSurface(s)) continue;
      const range = this.regionMap.resolve(s, termSize);
      if (range) currentRegions.set(id, range);
    }
    let vanished = false;
    const vanishedIds: string[] = [];
    const movedIds: string[] = [];
    for (const [id, prior] of this.lastOverlayRegions) {
      const curr = currentRegions.get(id);
      if (!curr) {
        for (let r = prior.startRow; r <= prior.endRow; r++) {
          this.invalidateRow(r - 1);
        }
        vanished = true;
        vanishedIds.push(id);
        continue;
      }
      if (curr.startRow !== prior.startRow || curr.endRow !== prior.endRow) {
        for (let r = prior.startRow; r <= prior.endRow; r++) {
          this.invalidateRow(r - 1);
        }
        vanished = true;
        movedIds.push(id);
      }
    }
    const ansi = renderModalStack({
      surfaces: snapshot.surfaces,
      focusStack: overlayFocusStack,
      paintCache: this.paintCache,
      onPaintCache: debug.enabled
        ? (ev) => {
          if (ev.hit) this.paintCacheHits++;
          else this.paintCacheMisses++;
          debug.log('window.paintCache', ev.id, ev);
        }
        : (ev) => {
          if (ev.hit) this.paintCacheHits++;
          else this.paintCacheMisses++;
        },
      // Phase 5 F8 shadow mode — env-gated by ELANOUS_F8_SHADOW=1.
      // The callback fires ONLY on divergence (renderModalStack
      // checks fresh !== prior.ansi before invoking). Counter + log
      // so operators can grep `window.f8.shadowDivergence` for the
      // offending surface id.
      shadowMode: this.f8ShadowMode,
      onShadowDivergence: this.f8ShadowMode
        ? (ev) => {
          this.f8ShadowDivergences++;
          debug.log('window.f8.shadowDivergence', ev.id, ev);
        }
        : undefined,
    });
    // Phase 4.5b (substrate Occam · §4-pre.10 partial · 2026-05-03)
    // — overlay byte-equality skip. When the rendered ANSI is byte-
    // identical to the prior frame's, skip the writeOverlay call
    // entirely (zero bytes to terminal, no work). Saves the common
    // case where cross-cutting dirty marks ('all' / 'status' / 'dock')
    // trigger a flush but the overlay output didn't actually change.
    //
    // `request.force === true` overrides — never optimize away a
    // force-flushed frame (callers use force when terminal state
    // confidence is required, e.g. after sync-output sequence end or
    // viewport resize).
    //
    // Vanish path (ansi.length === 0): clear prevOverlayAnsi so a
    // future identical render still writes (the overlay went away
    // and a re-emit of the same bytes is correct). The coord-side
    // region invalidation (V4 cascade above) handles the actual
    // erase by marking rows dirty in the main frame buffer.
    let overlaySkippedThisFlush = false;
    const overlayRowsInvalidated = this.overlayRowsInvalidated;
    this.overlayRowsInvalidated = false;
    if (ansi.length > 0) {
      if (request.force || overlayRowsInvalidated || ansi !== this.prevOverlayAnsi) {
        this.writeOverlay(ansi);
        this.prevOverlayAnsi = ansi;
        this.overlayWritesEmitted++;
      } else {
        overlaySkippedThisFlush = true;
        this.overlayWritesSkipped++;
      }
    } else {
      this.prevOverlayAnsi = null;
    }
    if (debug.enabled) {
      debug.log('window.flushOverlay', 'overlay', {
        stack: [...overlayFocusStack],
        currentModals: [...currentRegions.keys()],
        currentRegions: [...currentRegions.entries()].map(([id, r]) => ({ id, ...r })),
        vanishedIds,
        movedIds,
        vanishedCascade: vanished,
        ansiLen: ansi.length,
        ansiHead: ansi.length > 0 ? ansi.slice(0, 120) : '',
        overlaySkipped: overlaySkippedThisFlush,
      });
    }
    this.lastOverlayRegions = currentRegions;
    if (vanished && !request.force) {
      // TUI-SLASH-FLICKER (2026-10-09) — the prior region rows were
      // invalidated above, so the follow-up frame's row diff already
      // repaints exactly those rows. Forcing it reached tui.ts::render
      // as a full-screen erase (`\x1b[1;1H\x1b[J`) every time the slash
      // picker's height changed while typing — whole-screen flicker.
      // Keep the blanket force only when no row invalidator is wired.
      if (this.hasRowInvalidator) {
        this.markDirty('all');
        this.overlayRowsInvalidated = true;
      } else {
        this.forceNext = true;
      }
      this.requestFrame();
    }
  }

  /** Emit the current cursor state if it has changed since the last
   *  emit. Called by flush() and by setCursor() (bypass-batch path).
   *  When writeCursor isn't configured, this is a no-op.
   *
   *  P2.3.a — top modal's cursor() (when present) overrides the
   *  coordinator's own setCursor value. Iterates focus stack
   *  top→bottom; first non-null wins.
   *
   *  `forceFrame`: when true (called from flush()), always emit the
   *  cursor — the screen was just repainted, so the previous cursor
   *  position may have been overwritten. When false (called from
   *  setCursor's bypass-batch path), only emit on actual change. */
  private flushCursor(forceFrame = false): void {
    // IDX-F5d — deriveCursor centralises the tier-aware ownership
    // rules (terminal modal = PTY owns, picker / focus !== 'owns'
    // skip, dialog/popup/menu first non-null cursor() wins, fall
    // back to coordinator.setCursor value). Owner === 'terminal'
    // means we should suppress emission entirely so the PTY retains
    // its own caret position.
    const decision = deriveCursor({
      surfaces: this.surfaces,
      focusStack: this.paintStack,
      coordinatorCursor: this.cursor,
    });
    if (debug.enabled) {
      debug.log('cursor.coordinator.flush', 'flushCursor', {
        forceFrame,
        decisionOwner: decision.owner,
        modalId: decision.modalId,
        cursor: decision.cursor,
        focusStack: [...this.paintStack],
        cursorVersion: this.cursorVersion,
        lastEmittedCursorVersion: this.lastEmittedCursorVersion,
      });
    }
    if (!forceFrame && this.cursorVersion === this.lastEmittedCursorVersion) return;
    this.cursorVersion++;
    this.lastEmittedCursorVersion = this.cursorVersion;
    if (decision.owner === 'terminal') {
      // PTY emulator is painting its own caret — any ANSI we emit
      // would fight with it. Bail without touching writeCursor.
      return;
    }
    if (this.writeCursor) this.writeCursor(paintCursor(decision.cursor));
  }
}

function cursorEqual(a: CursorState | null, b: CursorState | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.row === b.row && a.col === b.col && a.visible === b.visible;
}

/** Extract a condensed call stack (skipping this helper + its caller)
 *  for debug.log payloads. Only evaluated when `debug.enabled` is
 *  already true, so the Error allocation cost stays opt-in. */
function callerFrames(depth = 4): string {
  const stack = new Error().stack;
  if (!stack) return '';
  return stack
    .split('\n')
    .slice(2, 2 + depth)
    .map(s => s.trim().replace(/^at\s+/, ''))
    .join(' | ');
}

function scopeForSurface(surface: DisplaySurface): FocusScope {
  if (surface.kind === 'modal' || surface.kind === 'overlay') return 'modal';
  if (surface.kind === 'execution') return 'execution';
  if (surface.owner.startsWith('plugin:')) return 'plugin';
  return 'dashboard';
}

function parseKey(spec: string): { name: string; ctrl: boolean; shift: boolean; alt: boolean } {
  const parts = spec.split('-');
  const name = parts.pop() ?? '';
  const mods = new Set(parts);
  return { name: name.toLowerCase(), ctrl: mods.has('C'), shift: mods.has('S'), alt: mods.has('A') };
}

function normalizedKey(spec: string): string {
  const { name, ctrl, shift, alt } = parseKey(spec);
  const canonicalName = resolveKeyAlias(name).toLowerCase();
  return `${ctrl ? 'C-' : ''}${shift ? 'S-' : ''}${alt ? 'A-' : ''}${canonicalName}`;
}

function effectiveChordKey(binding: DisplayKeyBinding): string {
  return binding.chordPrefix
    ? `${normalizedKey(binding.chordPrefix)} ${normalizedKey(binding.key)}`
    : normalizedKey(binding.key);
}

function isCtrlShiftCharacterChord(spec: string): boolean {
  const { name, ctrl, shift } = parseKey(spec);
  return ctrl && shift && Array.from(name).length === 1;
}

/** Q4 (substrate Occam, 2026-05-03) — bindings declare a single
 *  canonical (latin) form. The incoming KeyEvent.name is normalized
 *  through the central `KEY_ALIAS_TABLE` (Korean 2-set jamo built-in,
 *  user-config extensible) at lookup time so a binding registered as
 *  `'C-k'` matches both `Ctrl+k` and `Ctrl+ㅏ` events without per-
 *  binding pipe syntax.
 *
 *  Replaces the legacy FU-1/FU-2 pipe-separated alias spec
 *  (`'C-k|C-ㅏ'`) — the `|` parser is gone; binding registrations
 *  drop their `|C-<jamo>` suffixes (see PLAN §3 + dashboard/index.ts
 *  cleanup). */
function matchesKey(spec: string, ev: KeyEvent): boolean {
  const p = parseKey(spec);
  const evName = resolveKeyAlias(ev.name).toLowerCase();
  if (evName !== p.name) return false;
  if (!!ev.ctrl !== p.ctrl) return false;
  if (!!ev.shift !== p.shift) return false;
  if (!!ev.alt !== p.alt) return false;
  return true;
}
