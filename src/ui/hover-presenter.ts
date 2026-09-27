// IDX-5 Phase 1 — hover → Tooltip presenter.
//
// R1.3 policy lock: tooltip family paints through the modal-surface
// authority path, not the non-modal transient overlay host. See
// `src/display/transient-overlay-policy.ts`.
//
// Subscribes to a HoverTracker and auto-shows a Tooltip ModalSurface
// when the pointer stabilises on a target that declares tooltipText.
// On leave / re-hover / dispose it tears the surface back down.
//
// The presenter is intentionally dumb: it does NOT know about pills,
// panes, or any specific hit-region semantics. Callers feed the
// tracker with whatever HoverTarget they choose; this module just
// turns stable-hover → floating bubble.
//
// ModalSurface shape: `focus: 'none'`, low priority (0) so the
// tooltip never steals focus and always paints *below* real modals
// in z-order. That matches AppCUI tooltip layering
// (appcui-rs/src/surface/tooltip.rs:1-40): tooltip is a decoration,
// not a focus target.

import type { ModalBounds, ModalSurface } from '../display/modal-stack.js';
import type { SurfaceOwner } from '../display/types.js';
import { Printer } from './printer.js';
import { ansi } from '../tui.js';
import { Tooltip, tooltipPlacement } from './widgets/tooltip.js';
import type { HoverTracker, HoverEvent } from './hover-tracker.js';
import type { ThemeTokens } from '../theme/tokens.js';
import type { WidgetChromeSpec } from './declarative/spec.js';

export interface HoverPresenterDeps {
  /** Live terminal geometry so tooltip placement clamps correctly. */
  termSize: () => { rows: number; cols: number };
  /** Mount a modal surface and return its dispose handle. Dashboard
   *  supplies the coordinator's pushModalSurface. */
  pushSurface: (surface: ModalSurface) => { dispose: () => void };
  /** Request a redraw after the tooltip appears / disappears. Omit
   *  for tests that don't render — they can assert on lifecycle
   *  instead. */
  redraw?: () => void;
  /** Optional: override the surface id prefix. Defaults to 'idx5-tooltip'. */
  surfaceIdPrefix?: string;
  /** Optional: override the surface owner. Defaults to 'dashboard'. */
  surfaceOwner?: SurfaceOwner;
  /** Optional: anchor→position mapper for hover-over events. Presenter
   *  uses the most recent hover-over position as the tooltip anchor;
   *  this hook lets callers translate (e.g. map status-bar row). By
   *  default the hover-over position is used verbatim. */
  anchorForTarget?: (ev: { x: number; y: number }) => { x: number; y: number };
  /** Time source for Tooltip TTL — tests pass a fake clock. */
  nowMs?: () => number;
  /** Tooltip TTL in ms. Omit for no TTL (tooltip lives until hover
   *  leaves or the tracker fires a new stable with a different
   *  target). Default 10_000 so a tooltip never strands on screen
   *  forever if hover-leave somehow gets lost. */
  ttlMs?: number;
  /** IDX-6 round-2 — live theme accessor. Evaluated per-mount so
   *  theme switches during long-running sessions pick up on the
   *  next hover-stable. Omit for legacy C.muted painter. */
  getTheme?: () => ThemeTokens | null | undefined;
  /** Declarative overlay chrome accessor. Lets real consumers opt
   *  hover tooltips into the YAML/IUL chrome vocabulary while tests
   *  can keep legacy behaviour by omitting it. */
  getChromeSpec?: () => WidgetChromeSpec | null | undefined;
  /** Optional host visibility gate. False prevents stable-hover from mounting
   *  a tooltip; other hosts may omit the gate. */
  enabled?: () => boolean;
}

export interface HoverPresenter {
  /** Dispose the subscription + any active tooltip surface. Idempotent. */
  dispose(): void;
  /** Test hook — the id of the currently mounted surface, or null. */
  _activeSurfaceId(): string | null;
}

/** Wire a HoverTracker into the coordinator so hover-stable turns
 *  into a visible Tooltip surface. */
export function createHoverPresenter(
  tracker: HoverTracker,
  deps: HoverPresenterDeps,
): HoverPresenter {
  const idPrefix = deps.surfaceIdPrefix ?? 'idx5-tooltip';
  const owner: SurfaceOwner = deps.surfaceOwner ?? 'dashboard';
  let seq = 0;
  let active: {
    id: string;
    targetId: string;
    dispose: () => void;
  } | null = null;
  let lastAnchor: { x: number; y: number } | null = null;

  const clearActive = (): void => {
    if (!active) return;
    try { active.dispose(); } catch { /* isolate */ }
    active = null;
    deps.redraw?.();
  };

  const showFor = (targetId: string, text: string): void => {
    const anchorRaw = lastAnchor ?? { x: 0, y: 0 };
    const anchor = deps.anchorForTarget ? deps.anchorForTarget(anchorRaw) : anchorRaw;
    const { rows, cols } = deps.termSize();
    if (rows <= 0 || cols <= 0) return;

    // Build the view once to compute required size, then clamp via
    // tooltipPlacement to the host rectangle (0,0,cols,rows).
    const theme = deps.getTheme?.() ?? undefined;
    const chromeSpec = deps.getChromeSpec?.() ?? undefined;
    const view = new Tooltip({
      text,
      ttlMs: deps.ttlMs ?? 10_000,
      nowMs: deps.nowMs,
      theme: theme ?? undefined,
      chromeSpec: chromeSpec ?? undefined,
    });
    const desired = view.requiredSize({ width: cols, height: rows });
    const placed = tooltipPlacement(anchor, desired, { width: cols, height: rows });

    const bounds: ModalBounds = {
      row: placed.y + 1,   // 1-indexed ANSI
      col: placed.x + 1,
      width: placed.width,
      height: placed.height,
    };

    seq += 1;
    const id = `${idPrefix}:${seq}`;
    const surface: ModalSurface = {
      id,
      kind: 'modal',
      owner,
      focus: 'none',
      priority: 0,
      tier: 'tooltip',  // IDX-F4 — hover tooltip sits at top tier
      bounds,
      render: () => [],
      paint(): string {
        const p = Printer.create({ width: bounds.width, height: bounds.height });
        view.draw(p);
        const lines = p.lines();
        const out: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          out.push(ansi.moveTo(bounds.row + i, bounds.col));
          out.push(lines[i]!);
        }
        return out.join('');
      },
    };

    const { dispose } = deps.pushSurface(surface);
    active = { id, targetId, dispose };
    deps.redraw?.();
  };

  const onEvent = (ev: HoverEvent): void => {
    if (ev.kind === 'hover-over') {
      lastAnchor = { x: ev.x, y: ev.y };
      return;
    }
    if (ev.kind === 'hover-enter') {
      // A new target arrived — kill any stale tooltip from the previous
      // target. Tooltip re-appears on the next stable-hover.
      clearActive();
      return;
    }
    if (ev.kind === 'hover-leave') {
      clearActive();
      return;
    }
    if (ev.kind === 'hover-stable') {
      // Host-disabled tooltips are cleared rather than mounted.
      if (deps.enabled && !deps.enabled()) {
        clearActive();
        return;
      }
      const text = ev.target.tooltipText;
      if (!text) {
        // Nothing to show; make sure any stale tooltip from a prior
        // target is gone.
        clearActive();
        return;
      }
      // If we already have the tooltip for this target, noop.
      if (active && active.targetId === ev.target.id) return;
      clearActive();
      showFor(ev.target.id, text);
    }
  };

  const unsubscribe = tracker.subscribe(onEvent);

  return {
    dispose(): void {
      try { unsubscribe(); } catch { /* isolate */ }
      clearActive();
    },
    _activeSurfaceId(): string | null {
      return active ? active.id : null;
    },
  };
}
