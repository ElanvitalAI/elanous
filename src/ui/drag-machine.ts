// MX3 — DragMachine.
//
// State machine that captures a drag origin on mouse-down and
// re-routes subsequent drag/release events to that origin, even
// if the pointer wanders out of the origin's region. On release,
// if the pointer landed in a DIFFERENT region than the origin,
// the drop target's `onDropReceive` is invoked with the carrier
// payload.
//
// Contract (opt-in for capture primitives only):
//   - view.onDragStart(ev) → DragStartResult | null
//       Return non-null to claim this click as a drag start.
//       `carrier` is shuttled to the eventual drop target.
//   - view.onMouse(ev of type 'drag')
//       Called continuously while the drag is active — always the
//       drag origin, never the cell under the cursor.
//   - view.onMouse(ev of type 'release')
//       Called once when the button releases, on the origin.
//   - receiver.onDropReceive(ev)
//       Called on the view the cursor is over at release time, but
//       only when that view is different from the origin.
//
// The machine itself is a pure value object — the adapter (or any
// other router) feeds it events, and the machine reports what to
// do next. It does NOT hold references to views it isn't using;
// once state clears, GC can reclaim the carrier.

import type { ClickRegion } from './click-registry.js';
import type { DragMode, DragStartResult, DropReceiveEvent, View } from './view.js';
import type { MouseEvent } from './mouse-events.js';

/** Opaque internal record tracked while a drag is in-flight. */
interface DragState {
  origin: ClickRegion;
  carrier: unknown;
  /** IDX-5 Phase 4 — declared drag intent from the origin view's
   *  onDragStart. Undefined when the view didn't declare one
   *  (legacy consumers); readers should default to `'reorder'`. */
  mode: DragMode | undefined;
  /** Root-frame coords where the drag started (for gesture math). */
  startRootX: number;
  startRootY: number;
}

/** Result of DragMachine.onMouseDown — tells the caller whether the
 *  click turned into a drag start. If `started`, subsequent
 *  drag/release events should flow through the machine. */
export interface DragDownResult {
  started: boolean;
}

/** Result of DragMachine.onRelease — the router applies these. */
export interface DragReleaseResult {
  /** Origin view to receive `onMouse(type='release')`. null when
   *  no drag was in flight. */
  origin: View | null;
  /** Drop target — set only when different from origin. null when
   *  same region or no drag. */
  drop: { view: View; ev: DropReceiveEvent } | null;
}

export class DragMachine {
  private state: DragState | null = null;

  /** Called when a click (left-button press) lands on `hit`. If the
   *  view opts into drag via onDragStart, the machine captures it.
   *  `ev` is the click's local MouseEvent (for the view's view). */
  onMouseDown(hit: ClickRegion, ev: MouseEvent): DragDownResult {
    const view = hit.view;
    const result: DragStartResult | null | undefined = view.onDragStart?.(ev);
    if (!result) return { started: false };
    this.state = {
      origin: hit,
      carrier: result.carrier,
      mode: result.mode,
      startRootX: ev.absX,
      startRootY: ev.absY,
    };
    return { started: true };
  }

  /** Called on each `drag` event. Returns the origin region to
   *  forward the event to, or null when no drag is in flight. */
  onDrag(_absX: number, _absY: number): ClickRegion | null {
    return this.state ? this.state.origin : null;
  }

  /** Called on a `release` event. Returns the origin (to receive
   *  onMouse type='release') and, if the release cell is in a
   *  different region than the origin, a drop target. Clears
   *  machine state. */
  onRelease(currentHit: ClickRegion | null, absX: number, absY: number): DragReleaseResult {
    if (!this.state) return { origin: null, drop: null };
    const origin = this.state.origin;
    let drop: DragReleaseResult['drop'] = null;
    if (currentHit && currentHit.view !== origin.view) {
      const localX = absX - currentHit.absX;
      const localY = absY - currentHit.absY;
      drop = {
        view: currentHit.view,
        ev: {
          carrier: this.state.carrier,
          x: localX,
          y: localY,
          absX,
          absY,
        },
      };
    }
    const originView = origin.view;
    this.state = null;
    return { origin: originView, drop };
  }

  /** True while a drag is in flight. */
  isDragging(): boolean {
    return this.state !== null;
  }

  /** Root-frame coords where the current drag started, or null. */
  startPos(): { x: number; y: number } | null {
    if (!this.state) return null;
    return { x: this.state.startRootX, y: this.state.startRootY };
  }

  /** IDX-5 Phase 4 — drag intent declared by the origin view via
   *  `onDragStart` → `DragStartResult.mode`. Returns `undefined`
   *  when no drag is active OR when the origin didn't declare a
   *  mode (legacy consumers). Drop-zone renderers and other
   *  consumers should default undefined to `'reorder'`, which
   *  matches the pre-Phase-4 behavior for drag-origin views. */
  currentMode(): DragMode | undefined {
    return this.state?.mode;
  }

  /** Drop any in-flight drag. Use on modal close / abort. */
  abort(): void {
    this.state = null;
  }
}
