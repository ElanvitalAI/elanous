// LC4 — View interface + foundational views.
//
// A View is the smallest composable drawing unit for widgets.
// It pairs three responsibilities:
//   1. measure — tell parent what size it needs for a constraint
//   2. paint   — draw itself onto a Printer region
//   3. react   — consume or ignore a KeyEvent
//
// The interface is deliberately small (cursive inspired) because
// widgets compose these into bigger pieces via LinearLayout,
// ScrollView, etc. (LC5+).
//
// Focus model: a View can accept focus or decline it. Only one View
// in a tree is "focused" at a time; keys route to it first, and the
// parent chain may offer keys to other views only if it returns
// Ignored. The Printer carries a `focused` flag per region so a view
// can paint itself differently when it holds focus.

import type { KeyEvent } from '../plugins/core/types.js';
import type { Printer } from './printer.js';
import type { MouseEvent } from './mouse-events.js';

/** IDX-5 Phase 4 — declared drag intent. Views that opt into drag
 *  (by returning a non-null `DragStartResult` from `onDragStart`)
 *  may tag the gesture with one of these modes so the DragMachine
 *  and drop-zone rendering path know what the user is trying to do:
 *
 *    - `'reorder'`     — shuffle items within a single container
 *                        (reorderable list rows, etc.)
 *    - `'move'`        — relocate something between peers
 *                        (pane title bars, VW title-swap)
 *    - `'resize'`      — adjust a dimension via a handle
 *                        (VW divider drag)
 *    - `'select-range'` — pick a contiguous sub-region
 *                        (future: text selection over log rows)
 *
 *  The mode is advisory — the machine does not enforce per-mode
 *  restrictions today. Drop-zone helpers read it to choose a
 *  visual treatment (reorder = separator line, move = ghost title,
 *  resize = axis-specific cursor, select-range = highlight band).
 *  Legacy views that omit the mode get `undefined`; callers should
 *  treat that the same as `'reorder'` (the pre-Phase-4 default for
 *  existing drag-origin views). */
export type DragMode = 'reorder' | 'move' | 'resize' | 'select-range';

/** IDX-F5c — refinement returned by `View.describeHit`. Modal-adapter
 *  merges this with the enclosing `modalId` to produce the final
 *  `HitTarget` attached to the `DisplayMouseEvent`. Shape is a narrow
 *  subset of the `HitTarget` union's modal-body / modal-button kinds
 *  — adding `modalId` inside the view would redundantly duplicate
 *  data the adapter already knows. */
export type ViewHitDescriptor =
  | { kind: 'modal-body'; itemIndex?: number }
  | { kind: 'modal-button'; buttonId: string };

/** Return shape of View.onDragStart — signals the DragMachine (MX3)
 *  that the view is claiming this click as a drag origin. `carrier`
 *  is an opaque payload shuttled to the eventual drop target.
 *
 *  Policy note: implementing this marks the view as a capture
 *  primitive. General chooser/menu/list widgets should usually stay
 *  on intent-level mouse contracts and avoid raw release semantics. */
export interface DragStartResult {
  carrier: unknown;
  /** IDX-5 Phase 4 — optional drag intent. Omit for legacy views
   *  (treated as `'reorder'` by downstream consumers). */
  mode?: DragMode;
}

/** Payload delivered to a receiver's onDropReceive when a drag ends
 *  inside its region (and the origin was someone else). */
export interface DropReceiveEvent {
  /** Exactly the value the origin returned from onDragStart. */
  carrier: unknown;
  /** Position inside the receiver's region (0-indexed, local). */
  x: number;
  y: number;
  /** Position in the root frame (0-indexed, absolute). */
  absX: number;
  absY: number;
}

/** Items returned by a view's `contextActions`. The host wraps them
 *  in a ContextMenu popup on right-click. Shape mirrors the LC9
 *  ContextMenu widget's own item type so callers can pass them
 *  through with minimal transformation. */
export interface ContextMenuActionItem {
  /** Stable id — returned via onPick so the caller can dispatch. */
  value: string;
  label: string;
  /** 1-char keyboard accelerator inside the context menu. */
  shortcut?: string;
  disabled?: boolean;
  /** Fires before onPick with the picked value — matches
   *  SelectionItem.action semantics. */
  onRun?: () => void;
}

export interface Size {
  width: number;
  height: number;
}

export type FocusSource = 'front' | 'back' | 'none';

export type EventResult =
  | { kind: 'ignored' }
  | { kind: 'consumed'; callback?: () => void };

export const Ignored: EventResult = Object.freeze({ kind: 'ignored' });

export function Consumed(callback?: () => void): EventResult {
  return { kind: 'consumed', callback };
}

export interface View {
  /** Paint the view into the given region. Coordinates are relative
   *  to `p` — (0, 0) is the view's own top-left. `p.width` and
   *  `p.height` tell the view how much space it has. */
  draw(p: Printer): void;

  /** React to a key event. Return Consumed to stop propagation (and
   *  optionally run a callback after this frame ends). Return Ignored
   *  to let the parent try other siblings or the next handler. */
  onEvent(ev: KeyEvent): EventResult;

  /** React to a mouse event — MX1. Optional. The coordinator's
   *  mouse router (MX2) only calls this on the view whose registered
   *  click region was hit; propagation is therefore 1-hop by default.
   *  Returning Ignored lets the router fall back to other handlers
   *  (bubble to parent surface / global scroll). */
  onMouse?(ev: MouseEvent): EventResult;

  /** Opt into drag mode — MX3. Invoked by the DragMachine when a
   *  click lands on this view's region. Returning a value makes this
   *  view the "drag origin": subsequent drag/release events are
   *  routed back here regardless of where the pointer roams. Return
   *  null to decline (the click stays a plain click).
   *
   *  This is the main boundary between ordinary widgets and
   *  low-level capture primitives. */
  onDragStart?(ev: MouseEvent): DragStartResult | null;

  /** Called on the drop-target view — i.e. the view whose region
   *  the pointer was over when the drag finished — when that target
   *  is DIFFERENT from the drag origin. The origin itself just
   *  receives a regular onMouse(type='release'). */
  onDropReceive?(ev: DropReceiveEvent): EventResult;

  /** Invoked on right-click — MX6. Return a list of context-menu
   *  items (or null/empty to decline). The host wraps the result in
   *  a ContextMenu popup via `buildContextMenuPopup` and mounts it.
   *  Widgets that want a standard set of actions declare them here
   *  instead of hand-rolling their own popup. */
  contextActions?(ev: MouseEvent): ContextMenuActionItem[] | null;

  /** IDX-5 Phase 1 — hover event hook. Invoked with the widget-level
   *  MouseEvent whose `type` is one of 'hover-enter', 'hover-leave',
   *  'hover-over', or 'hover-stable'. The widget uses this to drive
   *  visual hover affordances (tint a row, highlight a button) and
   *  to surface tooltipText for the auto-tooltip via the hover-
   *  tracker (src/ui/hover-tracker.ts). Hover events never produce
   *  an EventResult — return type is void because the widget can
   *  neither consume nor bubble hover (the hover-tracker is the
   *  single source of truth for "what's under the pointer"). */
  onHover?(ev: MouseEvent): void;

  /** IDX-F5c — structural hit-test refinement.
   *
   *  Given coordinates LOCAL to this view (0-indexed, view's own
   *  top-left is (0,0)), return a refinement of the coarse
   *  `{kind:'modal-body', modalId}` HitTarget the wiring layer
   *  already attached. Modal-adapter merges the refinement with the
   *  surrounding modalId, yielding e.g.
   *  `{kind:'modal-body', modalId, itemIndex}` (SelectView row) or
   *  `{kind:'modal-button', modalId, buttonId}` (Dialog button bar).
   *
   *  The modal-adapter also falls back to a payload-convention
   *  reader on `hit.payload` (`{kind:'row', filtIdx}` and
   *  `{kind:'button', buttonId}`), so widgets that already register
   *  those payloads (SelectView, upcoming Dialog ButtonBar) get
   *  refinement for free without having to implement this method.
   *  Implement `describeHit` explicitly only when the registry
   *  mapping isn't sufficient — e.g. a custom widget that wants to
   *  classify clicks outside any registered region, or return
   *  refinements from cached layout info.
   *
   *  Coordinates: `localRow` / `localCol` are 0-indexed within the
   *  view's paint region. Return null for clicks that don't resolve
   *  to a refinable target (e.g. click on title row or padding).
   *  F5c only introduces the type + the adapter wiring; adoption by
   *  SelectView / Dialog / ListView can land incrementally — the
   *  payload-convention fallback already covers their existing
   *  registration shapes. */
  describeHit?(localRow: number, localCol: number): ViewHitDescriptor | null;

  /** Called by the parent after it decides this view's final size.
   *  Most views can leave this as a no-op — needed only for caches. */
  layout(size: Size): void;

  /** Parent asks: "how much space do you want, given up to this
   *  constraint?" Should honor the constraint (never ask for more
   *  than what's offered). */
  requiredSize(constraint: Size): Size;

  /** Parent offers focus. Return true if accepted (focus moves to
   *  this view). `source` hints the direction focus is coming from,
   *  useful for list-like views that should enter from the top or
   *  bottom. */
  takeFocus(source?: FocusSource): boolean;
}

// ── Foundational views ──────────────────────────────────────────

/** Renders a single-line or multi-line string. Non-focusable.
 *  Wraps on embedded '\n' only — no auto-wrap (that's TextArea's job). */
export class TextView implements View {
  private _lines: string[];

  constructor(text: string | string[] = '') {
    this._lines = Array.isArray(text) ? [...text] : text.split('\n');
  }

  get text(): string { return this._lines.join('\n'); }

  setText(text: string | string[]): void {
    this._lines = Array.isArray(text) ? [...text] : text.split('\n');
  }

  draw(p: Printer): void {
    for (let i = 0; i < Math.min(p.height, this._lines.length); i++) {
      p.text(0, i, this._lines[i]!);
    }
  }

  onEvent(_ev: KeyEvent): EventResult { return Ignored; }

  layout(_size: Size): void { /* no-op */ }

  requiredSize(constraint: Size): Size {
    let w = 0;
    for (const ln of this._lines) {
      const len = visibleLen(ln);
      if (len > w) w = len;
    }
    return {
      width: Math.min(constraint.width, w),
      height: Math.min(constraint.height, this._lines.length),
    };
  }

  takeFocus(): boolean { return false; }
}

export interface BoxViewOptions {
  border?: boolean;
  title?: string;
  titleAlign?: 'left' | 'center' | 'right';
  titleStyle?: string;
  focusedTitleStyle?: string;
  titleBarStyle?: string;
  focusedTitleBarStyle?: string;
  titleRight?: string;
  titleRightStyle?: string;
  focusedTitleRightStyle?: string;
  fill?: string;
  style?: string;
  focusedStyle?: string;
  borderVariant?: 'plain' | 'rounded' | 'double' | 'heavy';
  focusedBorderVariant?: 'plain' | 'rounded' | 'double' | 'heavy';
}

/** Wraps another view in an optional border + title + background
 *  fill. Does NOT take focus itself — delegates to the inner view. */
export class BoxView implements View {
  constructor(private inner: View, private opts: BoxViewOptions = {}) {}

  setInner(view: View): void { this.inner = view; }

  draw(p: Printer): void {
    const {
      border = false,
      title,
      titleAlign = 'left',
      titleStyle,
      focusedTitleStyle,
      titleBarStyle,
      focusedTitleBarStyle,
      titleRight,
      titleRightStyle,
      focusedTitleRightStyle,
      fill,
      style = '',
      focusedStyle,
      borderVariant = 'plain',
      focusedBorderVariant,
    } = this.opts;
    const borderStyle = p.focused && focusedStyle ? focusedStyle : style;
    const resolvedBorderVariant = p.focused && focusedBorderVariant
      ? focusedBorderVariant
      : borderVariant;
    if (fill !== undefined) p.fill(fill, borderStyle);
    if (border) {
      p.border(borderStyle, resolvedBorderVariant);
      const titleBarPaint = p.focused && focusedTitleBarStyle
        ? focusedTitleBarStyle
        : titleBarStyle;
      if (titleBarPaint && p.width >= 3) {
        p.text(1, 0, titleBarPaint + ' '.repeat(Math.max(0, p.width - 2)) + '\x1b[0m');
      }
      if (title && p.width >= 4) {
        const maxTitle = Math.max(0, p.width - 4);
        const text = ` ${truncateSimple(title, maxTitle)} `;
        const paint = p.focused && focusedTitleStyle
          ? focusedTitleStyle
          : (titleStyle ?? borderStyle);
        const titleWidth = visibleLen(text);
        let titleX = 1;
        if (titleAlign === 'center') {
          titleX = Math.max(1, Math.floor((p.width - titleWidth) / 2));
        } else if (titleAlign === 'right') {
          const rightText = titleRight ? ` ${truncateSimple(titleRight, Math.max(0, p.width - 4))} ` : '';
          const rightReserved = rightText ? visibleLen(rightText) + 1 : 1;
          titleX = Math.max(1, p.width - rightReserved - titleWidth);
        }
        p.text(titleX, 0, paint + text + (paint ? '\x1b[0m' : ''));
      }
      if (titleRight && p.width >= 4) {
        const maxRight = Math.max(0, p.width - 4);
        const text = ` ${truncateSimple(titleRight, maxRight)} `;
        const rightX = Math.max(1, p.width - visibleLen(text) - 1);
        const minRightX = title ? 2 + visibleLen(` ${truncateSimple(title, Math.max(0, p.width - 4))} `) : 1;
        if (rightX >= minRightX) {
          const paint = p.focused && focusedTitleRightStyle
            ? focusedTitleRightStyle
            : (titleRightStyle ?? borderStyle);
          p.text(rightX, 0, paint + text + (paint ? '\x1b[0m' : ''));
        }
      }
    }
    const pad = border ? 1 : 0;
    const innerW = Math.max(0, p.width - pad * 2);
    const innerH = Math.max(0, p.height - pad * 2);
    if (innerW > 0 && innerH > 0) {
      this.inner.draw(p.sub(pad, pad, innerW, innerH));
    }
  }

  onEvent(ev: KeyEvent): EventResult { return this.inner.onEvent(ev); }

  onMouse(ev: MouseEvent): EventResult {
    if (!this.inner.onMouse) return Ignored;
    const pad = this.opts.border ? 1 : 0;
    const x = ev.x - pad;
    const y = ev.y - pad;
    if (x < 0 || y < 0) return Ignored;
    return this.inner.onMouse({ ...ev, x, y });
  }

  layout(size: Size): void {
    const pad = this.opts.border ? 1 : 0;
    this.inner.layout({
      width: Math.max(0, size.width - pad * 2),
      height: Math.max(0, size.height - pad * 2),
    });
  }

  requiredSize(constraint: Size): Size {
    const pad = this.opts.border ? 1 : 0;
    const inner = this.inner.requiredSize({
      width: Math.max(0, constraint.width - pad * 2),
      height: Math.max(0, constraint.height - pad * 2),
    });
    return {
      width: Math.min(constraint.width, inner.width + pad * 2),
      height: Math.min(constraint.height, inner.height + pad * 2),
    };
  }

  takeFocus(source?: FocusSource): boolean { return this.inner.takeFocus(source); }
}

// ── helpers ─────────────────────────────────────────────────────

function visibleLen(s: string): number {
  // Minimal impl — callers that need full SGR/wide handling use
  // cellWidth from printer.ts. For requiredSize a rough character
  // count plus ANSI strip is enough.
  const plain = s.replace(/\x1b\[[0-9;]*m/g, '');
  return plain.length;
}

function truncateSimple(s: string, maxW: number): string {
  if (s.length <= maxW) return s;
  return s.slice(0, Math.max(0, maxW - 1)) + '…';
}
