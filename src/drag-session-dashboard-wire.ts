// ─────────────────────────────────────────────────────────────────
// Drag session dashboard wiring — DS-3a (PLAN-drag-session-ds3 §3.1).
//
// R1.3 policy lock: drag ghost / highlight / banner belong to the
// `drag-overlay` family, whose allowed authority path is the shared
// transient overlay host (`overlay-host`).
//
// Role
// ────
//   Single entry point that composes DS-3a's 3 standalone modules
//   (working-dir-mouse · chat-input-drop-target · drop-zone-popover)
//   into one object dashboard.ts can mount / dispose. Keeps
//   dashboard.ts's touch small (~10 LOC) while the composition
//   logic + unit-testable seams live here.
//
// Wiring recipe
// ─────────────
//   1. Register the chat-input DropTarget with DragManager. Bounds
//      callback reads live dashboard geometry (terminal size + input
//      row).
//   2. Bind the working-dir browser pane as a drag source.
//   3. Spin up the drop-zone-popover observer for highlight / ghost
//      state.
//   4. Register the composite drag overlay painter with the shared
//      transient-overlay host (when provided).
//   5. Expose:
//       - `onMouse(ev)`       · call from dashboard's mouse route
//                               site AFTER mouseWiring.handleMouse
//                               (hit already attached).
//       - `getPopoverState()` · dashboard's draw() reads this to
//                               paint highlight + ghost overlay.
//       - `getInputHitTarget` · dashboard passes this into
//                               mouseWiring deps so chat-input row
//                               clicks classify correctly.
//       - `dispose()`         · unregister target, stop observers.
//
// Non-goals
// ─────────
//   • Owning the final overlay flush — dashboard's transient-overlay
//     host does that after the main frame.
//   • Capturing keyboard events (ESC cancel is A-8's scope).
//   • Cross-process DnD (future).

import type { DragManager, DropTarget } from './primitives/drag-session/index.js';
import type {
  TransientOverlayHandle,
  TransientOverlayHost,
} from './display/transient-overlay-host.js';
import type { SurfaceId, DisplayMouseEvent } from './display/types.js';
import type { WorkingDirState } from './working-dir/index.js';
import { surfaceKey } from './surface/address.js';
import {
  bindWorkingDirDragSource,
  type WorkingDirDragSource,
} from './working-dir/mouse.js';
import {
  createChatInputDropTarget,
} from './chat/input/drop-target.js';
import {
  createScratchDropTarget,
} from './scratch-drop-target.js';
import {
  createLlmContextDropTarget,
} from './llm-context-drop-target.js';
import {
  registerDropZones,
} from './drag-session-drop-zones.js';
import {
  createDropZonePopover,
  type DropZoneState,
  type DropZonePopover,
} from './drop-zone-popover.js';
import {
  DEFAULT_LLM_CONTEXT_BANNER_LABEL,
  paintLlmContextBannerCells,
  type LlmContextBannerState,
} from './llm-context-drop-banner.js';
import {
  createOverlaySprite,
  type OverlaySpriteHandle,
  type Rect,
} from './primitives/overlay-sprite/index.js';
import type { LayerId } from './primitives/layer-tree/index.js';

export interface DragSessionDashboardWireOpts {
  readonly manager: DragManager;
  readonly workingDirState: WorkingDirState;
  /** LayerTree for the drop-zone overlay sprites (highlight + ghost).
   *  Typically `display.layerTreeAPI()`. */
  readonly tree: import('./primitives/layer-tree/index.js').LayerTree;
  /** RenderCoordinator the drop-zone sprites mark dirty against.
   *  Typically `display.renderCoordinatorAPI()`. */
  readonly rc: import('./primitives/render-coordinator/index.js').RenderCoordinator;
  /** R1.1 — shared post-frame host for non-modal transient overlay
   *  painters. Consumers register a paint callback here instead of
   *  asking dashboard to flush one-off overlay ANSI directly. */
  readonly overlayHost?: TransientOverlayHost;
  /** Called when dashboard should repaint (popover state changed). */
  readonly requestDraw: () => void;
  /** Called in `chat-input-drop-target.onAttachPaths`. Dashboard
   *  typically wires this to its `attachFilePathToken` loop. Returns
   *  whenever each path has been tokenized (return value is ignored
   *  by the target — fire-and-forget). */
  readonly attachFilePath: (absPath: string) => Promise<unknown>;
  /** Live getter for the row index of the chat input prompt. Used
   *  both for the `getInputHitTarget` callback and for the
   *  chat-input DropTarget's `getBounds`. */
  readonly getInputPromptRow: () => number;
  /** Live terminal size. */
  readonly getTermSize: () => { readonly rows: number; readonly cols: number };
  /** Override for the working-dir drag source threshold (cells).
   *  Default 2. */
  readonly threshold?: number;
  /** DS-4a (2026-04-21) — optional scratch pane DropTarget. Both
   *  opts must be present for registration; absent → scratch drop
   *  disabled (DS-3a MVP behavior preserved). Future DS-4c may
   *  array-ify `dropZones: DropTarget[]` · this is the minimal
   *  diff for the second consumer. */
  readonly getScratchBounds?: () => {
    row: number; col: number; width: number; height: number;
  } | null;
  readonly appendToScratch?: (paths: readonly string[]) => void;
  /** DS-4c (2026-04-21) — optional LLM context drop zone. When
   *  `onIngestLlmContext` is present, a drag-reactive banner appears
   *  above the chat composer on every drag and vanishes on
   *  end/cancel. Drops on the banner forward absolute paths to the
   *  callback (typically `attachFilePathToken` loop).
   *
   *  `getLlmContextBannerRow` controls where the banner paints;
   *  defaults to `inputPromptRow - 1`. `llmContextBannerLabel`
   *  overrides the default chip text. */
  readonly onIngestLlmContext?: (paths: readonly string[]) => void | Promise<void>;
  readonly getLlmContextBannerRow?: () => number;
  readonly llmContextBannerLabel?: string;
}

export interface DragSessionDashboardWire {
  /** Dashboard calls this AFTER mouseWiring.handleMouse so
   *  `ev.hitTarget` is already populated. No-op when no drag source
   *  is relevant to the event. */
  onMouse(ev: DisplayMouseEvent): void;
  /** Snapshot — safe to call on every draw frame. Return shape is
   *  stable (ref-equal when nothing changed). Kept for introspection
   *  (telemetry, tests); rendering goes through `paintOverlay()`. */
  getPopoverState(): DropZoneState;
  /** Compose the ANSI overlay string for this frame — concatenates
   *  highlight + ghost + DS-4c banner sprite paints. Dashboard writes
   *  the returned string to stdout AFTER the main frame. Empty string
   *  when nothing to paint or erase. */
  paintOverlay(): string;
  /** Compose the pre-frame cleanup string for this frame. Dashboard
   *  writes this before render() so stale overlay cells are repainted
   *  by the main frame. */
  prepareOverlayFrame(): string;
  /** Pass this into `createDashboardMouseWiring`'s deps so chat-
   *  input row clicks classify as `{kind:'input', inputId:'chat-main'}`. */
  getInputHitTarget(row: number, col: number): { kind: 'input'; inputId: string } | null;
  /** DS-4c — drag-reactive banner state snapshot. `null` when the
   *  banner is disabled (no `onIngestLlmContext` opt) OR when no drag
   *  is active. Kept for introspection + test assertions; the actual
   *  rendering path flows through `paintOverlay()` (overlay-sprite).
   *  Safe to call on every frame. */
  getLlmContextBannerState(): LlmContextBannerState | null;
  /** Release all subscriptions + unregister the DropTarget. */
  dispose(): void;
}

const CHAT_INPUT_ID = 'chat-main';
// DS-3a-follow (Session B · D2 · 2026-04-21) — `surfaceKey` 헬퍼
// 사용으로 convention 일치. F-series 계열 (`'input::chat-main'` ·
// double-colon) 와 동일 표기. DS-4c (2026-04-21 · Phase A) 에서
// DS-1 `hitMatchesSurface` 이 'input' kind 에 대해 strict match
// 로 업그레이드됨 — 이제 convention 이 기능상 필수.
const CHAT_INPUT_SURFACE_ID = surfaceKey({ kind: 'input', inputId: CHAT_INPUT_ID }) as SurfaceId;
const BROWSER_PANE_SURFACE_ID = 'pane:browser' as SurfaceId;
// DS-4c (2026-04-21) — llm-context drop banner surface id + input id.
// Convention: `input::${inputId}` via surfaceKey so primitive's
// hitMatchesSurface input-case routes the synthesized banner hit
// (inputId = LLM_CONTEXT_INPUT_ID) exclusively to this target.
const LLM_CONTEXT_INPUT_ID = 'llm-context-drop';
const LLM_CONTEXT_SURFACE_ID = surfaceKey({ kind: 'input', inputId: LLM_CONTEXT_INPUT_ID }) as SurfaceId;

export function wireDragSessionToDashboard(
  opts: DragSessionDashboardWireOpts,
): DragSessionDashboardWire {
  // ── Drop targets ─────────────────────────────────────────────
  const dropZones: DropTarget[] = [];

  const chatInputTarget = createChatInputDropTarget({
    surfaceId: CHAT_INPUT_SURFACE_ID,
    inputId: CHAT_INPUT_ID,
    getBounds: () => {
      const { rows, cols } = opts.getTermSize();
      // Bounds snapshot — input row + the line directly below (where
      // the prompt may wrap). Fallback: last 2 rows of the terminal
      // if the inputPromptRow getter returns a sentinel (-1).
      const row = opts.getInputPromptRow();
      const resolvedRow = row > 0 ? row : Math.max(1, rows - 2);
      return { row: resolvedRow, col: 1, width: Math.max(1, cols - 2), height: 1 };
    },
    onAttachPaths: async (paths) => {
      for (const p of paths) {
        try {
          await opts.attachFilePath(p);
        } catch {
          /* attachFilePath handles its own error logging via
             dashboard's chat log lines. */
        }
      }
    },
  });
  dropZones.push(chatInputTarget);

  // ── Drop target — scratch pane (DS-4a · optional) ─────────────
  // Registration gated on `appendToScratch` alone — bounds getter is
  // optional · absent → 1×1 fallback rect (minimal-visibility highlight
  // until a future refinement supplies real scratch pane geometry).
  // DropTarget's paneId match still works regardless of rect precision.
  if (opts.appendToScratch !== undefined) {
    const scratchTarget = createScratchDropTarget({
      surfaceId: 'wd-scratch' as SurfaceId,
      paneId: 'wd-scratch',
      getBounds: () => {
        const b = opts.getScratchBounds?.() ?? null;
        return b ?? { row: 1, col: 1, width: 1, height: 1 };
      },
      onAppendPaths: opts.appendToScratch,
    });
    dropZones.push(scratchTarget);
  }

  // ── Drop target — LLM context banner (DS-4c · optional) ───────
  // Registration gated on `onIngestLlmContext`. When present, a
  // drag-reactive banner appears above the composer on every drag
  // session (begin → active, end/cancel → hidden). Drops on the
  // banner hit (synthesized by getInputHitTarget below) forward
  // absolute paths to the callback.
  //
  // Rendering (2026-04-23 · W6-migration): a dedicated overlay-sprite
  // (`ds4c:banner` layer) owns the banner cells. On begin, we update
  // the sprite's bounds to the banner row + width and paint a fresh
  // stamp; on end/cancel we collapse bounds to 0×0 so the next paint()
  // emits an erase for the prior cells. This is the same structural
  // fix PR #416 applied to the drop-zone ghost + highlight — eliminates
  // both the trail bug (state change leaves stale cells) AND the
  // cancel-residue bug (banner visible after drag ends).
  let unsubBegin: (() => void) | null = null;
  let unsubEnd: (() => void) | null = null;
  let unsubCancel: (() => void) | null = null;
  let unsubPull: (() => void) | null = null;
  let bannerSprite: OverlaySpriteHandle | null = null;
  let overlayHandle: TransientOverlayHandle | null = null;
  let dragActive = false;
  let hoveredLlmBanner = false;

  const resolveBannerRow = (): number => {
    if (opts.getLlmContextBannerRow !== undefined) {
      return opts.getLlmContextBannerRow();
    }
    const ipr = opts.getInputPromptRow();
    return ipr > 1 ? ipr - 1 : 0;
  };

  const ZERO_BANNER_RECT: Rect = Object.freeze({ row: 1, col: 1, width: 0, height: 0 });
  const prepareOverlayFrame = (): string => {
    if (disposed) return '';
    try {
      const pop = popover.prepareFrame();
      const banner = bannerSprite !== null ? bannerSprite.prepareFrame() : '';
      return pop + banner;
    }
    catch { return ''; }
  };
  const paintOverlay = (): string => {
    if (disposed) return '';
    try {
      const pop = popover.paint();
      const banner = bannerSprite !== null ? bannerSprite.paint() : '';
      return pop + banner;
    }
    catch { return ''; }   // overlay must never crash main draw
  };

  /** Recompute banner sprite bounds + painter from the current
   *  (dragActive, hoveredLlmBanner) state. Called from begin / pull /
   *  end / cancel — idempotent, safe on every transition. */
  const applyBanner = (): void => {
    if (bannerSprite === null) return;
    if (!dragActive) {
      bannerSprite.update({ bounds: ZERO_BANNER_RECT, paint: () => '' });
      return;
    }
    const row = resolveBannerRow();
    if (row <= 0) {
      bannerSprite.update({ bounds: ZERO_BANNER_RECT, paint: () => '' });
      return;
    }
    const { cols } = opts.getTermSize();
    if (cols <= 2) {
      bannerSprite.update({ bounds: ZERO_BANNER_RECT, paint: () => '' });
      return;
    }
    const label = opts.llmContextBannerLabel ?? DEFAULT_LLM_CONTEXT_BANNER_LABEL;
    const hovered = hoveredLlmBanner;
    // Align with chat-input DropTarget bounds convention (col=1 ·
    // width=cols-2) — the two overlays stack on adjacent rows when the
    // cursor hovers on chat-input, and any column offset between them
    // makes the composite look like the corners are clipped. See
    // image #9 in the 2026-04-23 QA session. The legacy
    // renderLlmContextDropBanner used col=2 for aesthetic purposes;
    // kept there for backwards compat but no longer the render path.
    const bounds: Rect = { row, col: 1, width: Math.max(1, cols - 2), height: 1 };
    bannerSprite.update({
      bounds,
      paint: (b) => paintLlmContextBannerCells(b, label, hovered),
    });
  };

  if (opts.onIngestLlmContext !== undefined) {
    const llmTarget = createLlmContextDropTarget({
      surfaceId: LLM_CONTEXT_SURFACE_ID,
      inputId: LLM_CONTEXT_INPUT_ID,
      getBounds: () => {
        const { cols } = opts.getTermSize();
        const row = resolveBannerRow();
        return {
          row: row > 0 ? row : 1,
          col: 1,
          width: Math.max(1, cols - 2),
          height: 1,
        };
      },
      onIngestContext: opts.onIngestLlmContext,
    });
    dropZones.push(llmTarget);

    bannerSprite = createOverlaySprite({
      tree: opts.tree,
      rc: opts.rc,
      id: 'ds4c:banner' as LayerId,
      bounds: ZERO_BANNER_RECT,
      paint: () => '',
      zTier: 'overlay',
      // zIndex 2 so banner paints above drop-zone highlight (0) +
      // ghost (1) when bounds overlap — consistent with prior layering
      // (banner was written AFTER popover in the legacy path).
      zIndex: 2,
    });

    unsubBegin = opts.manager.on('begin', () => {
      dragActive = true;
      hoveredLlmBanner = false;
      applyBanner();
      try { opts.requestDraw(); } catch { /* swallow */ }
    });
    const clearDrag = (): void => {
      dragActive = false;
      hoveredLlmBanner = false;
      applyBanner();
      try { opts.requestDraw(); } catch { /* swallow */ }
    };
    unsubEnd = opts.manager.on('end', clearDrag);
    unsubCancel = opts.manager.on('cancel', clearDrag);
    unsubPull = opts.manager.on('pull', (ev) => {
      if (ev.kind !== 'pull') return;
      const row = resolveBannerRow();
      const next = row > 0 && ev.at.row === row;
      if (next !== hoveredLlmBanner) {
        hoveredLlmBanner = next;
        applyBanner();
        try { opts.requestDraw(); } catch { /* swallow */ }
      }
    });
  }

  const unregisterDropZones = registerDropZones(opts.manager, dropZones);

  // ── Drag source — working-dir browser pane ───────────────────
  const dragSource: WorkingDirDragSource = bindWorkingDirDragSource({
    manager: opts.manager,
    state: opts.workingDirState,
    surfaceId: BROWSER_PANE_SURFACE_ID,
    ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
  });

  // ── Popover state observer + overlay sprite host ─────────────
  const popover: DropZonePopover = createDropZonePopover({
    manager: opts.manager,
    tree: opts.tree,
    rc: opts.rc,
    onChange: opts.requestDraw,
    getTermSize: opts.getTermSize,
  });
  if (opts.overlayHost) {
    overlayHandle = opts.overlayHost.mount({
      id: 'drag-session',
      order: 100,
      prepareFrame: prepareOverlayFrame,
      paint: paintOverlay,
    });
  }

  // ── Dashboard-mouse-wiring callbacks ─────────────────────────
  const getInputHitTarget = (
    row: number,
    _col: number,
  ): { kind: 'input'; inputId: string } | null => {
    const inputRow = opts.getInputPromptRow();
    if (inputRow <= 0) return null;
    // Chat input is a single-row textInput; allow hits on that exact
    // row only. Wider tolerance (±1) could be added if rendering
    // adds a caret decoration on the line above, but default stays
    // strict to avoid shadowing the bottom pane row.
    if (row === inputRow) return { kind: 'input', inputId: CHAT_INPUT_ID };
    // DS-4c — drag-reactive banner classification. Only during an
    // active drag session does `inputPromptRow - 1` classify as the
    // llm-context-drop target; outside drag, the row is free for
    // other UI (blockAttach banner etc.) to claim.
    if (dragActive && opts.onIngestLlmContext !== undefined) {
      const bannerRow = resolveBannerRow();
      if (bannerRow > 0 && row === bannerRow) {
        return { kind: 'input', inputId: LLM_CONTEXT_INPUT_ID };
      }
    }
    return null;
  };

  const getLlmContextBannerState = (): LlmContextBannerState | null => {
    if (opts.onIngestLlmContext === undefined) return null;
    if (!dragActive) return null;
    const row = resolveBannerRow();
    if (row <= 0) return null;
    const { cols } = opts.getTermSize();
    return {
      active: true,
      row,
      cols,
      hovered: hoveredLlmBanner,
      label: opts.llmContextBannerLabel ?? DEFAULT_LLM_CONTEXT_BANNER_LABEL,
    };
  };

  let disposed = false;
  return {
    onMouse(ev) {
      if (disposed) return;
      dragSource.onMouse(ev);
    },
    getPopoverState() {
      return popover.getState();
    },
    paintOverlay() {
      return paintOverlay();
    },
    prepareOverlayFrame() {
      return prepareOverlayFrame();
    },
    getInputHitTarget,
    getLlmContextBannerState,
    dispose() {
      if (disposed) return;
      disposed = true;
      try { dragSource.dispose(); }      catch { /* swallow */ }
      try { popover.dispose(); }          catch { /* swallow */ }
      try { unregisterDropZones(); }      catch { /* swallow */ }
      try { overlayHandle?.dispose(); }   catch { /* swallow */ }
      if (bannerSprite !== null) {
        // Collapse to zero + flush one last paint so any residual
        // banner cells get erased before the layer tears down —
        // mirrors drop-zone-popover.dispose discipline.
        try {
          bannerSprite.update({ bounds: ZERO_BANNER_RECT, paint: () => '' });
          bannerSprite.paint();
        } catch { /* swallow */ }
        try { bannerSprite.dispose(); } catch { /* swallow */ }
      }
      for (const u of [
        unsubBegin, unsubEnd, unsubCancel, unsubPull,
      ]) {
        if (u !== null) { try { u(); } catch { /* swallow */ } }
      }
    },
  };
}
