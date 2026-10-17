import type { Attachment, ContextRegistry } from '../context.js';
import { debug } from '../debug/log.js';
import type { FoldStack, FoldTarget } from '../fold-stack.js';
import type { AttachmentRowMap } from '../log-pane/attachment-row-map.js';
import type { LogClickDispatchDeps } from '../log-pane/click-dispatch.js';
import type { AttachmentPopupAction } from '../log-pane/attachment-popup.js';
import { tryPillHitAtLineIndex } from '../log-pane/pill-click-dispatch.js';
import type { ViewSurfaceHandle } from '../ui/modal-adapter.js';

export interface DashboardLogClickRuntimeDeps {
  termSize: () => { rows: number; cols: number };
  computePaneH: (rows: number) => number;
  computeLogH: (rows: number) => number;
  chatLinesLength: () => number;
  chatScrollOffset: () => number;
  logFrozenTailIndex: () => number | null;
  chatFooterLine: () => string | null;
  attachmentRowMap: AttachmentRowMap;
  contextRegistry: ContextRegistry;
  ownerWorkspaceId?: string;
  setWorkingFocus: (pane: 'log', reason: string) => void;
  pushTypedModal: (
    typeName: 'attachment-popup',
    opts: { idempotencyKey: string },
    surface: ViewSurfaceHandle['surface'],
  ) => {
    generation: number;
    isDisposed(): boolean;
    dispose(): void;
  } | null;
  onPushRejected?: (surfaceId: string) => void;
  onPushAccepted?: (surfaceId: string, generation: number) => void;
  onAttachmentAction: (action: AttachmentPopupAction, attachment: Attachment) => void;
  draw: () => void;
  debug: LogClickDispatchDeps['debug'];
  /** Wave C — pill cascade hooks. When both are present a click on
   *  the pill row triggers `onPillClick` (typically opens /bg popup)
   *  and consumes the click as `popup-opened`. */
  pillRowGetter?: () => number | null;
  onPillClick?: () => void;
  /** When present, a click on a fold range toggles it (collapse only on
   *  the expanded first/last line or the row that expanded it; otherwise
   *  `toggleAtLine` decides). Hosts
   *  that omit it keep the legacy attachment/pill-only behavior. */
  foldStack?: FoldStack;
  /** Keeps the viewport where the click happened while a click toggles a
   *  fold (#81). Hosts that omit it keep FoldStack's own scroll policy. */
  foldClickAnchor?: FoldClickScrollAnchor;
}

/** Scroll state the fold-click anchor reads and writes. Offsets are the
 *  log pane's visual-row offsets (`-1` = pinned to the tail). */
export interface FoldClickScrollState {
  getScrollOffset: () => number;
  setScrollOffset: (offset: number) => void;
  /** Max visual-row offset for the current chatLines (after a splice). */
  maxScroll: () => number;
  getFrozenTail: () => number | null;
  setFrozenTail: (index: number | null) => void;
  /** chatLines length — tells new output from the fold's own splice. */
  lineCount: () => number;
}

export interface FoldClickScrollAnchor {
  /** Current top visual row and raw offset — the click's frame. */
  viewport(): { top: number; scrollOffset: number };
  /** Run a click toggle with the viewport top held in place. */
  run<T>(toggle: () => T): T;
  /** FoldStack `onAfterToggle` hook: inside `run` it keeps the top row;
   *  outside (the `f` key, bulk toggles) it falls back to `otherwise`. */
  onAfterToggle(target: FoldTarget, delta: number): void;
  /** Call before each paint: a pane that was following the tail when the
   *  click expanded a block goes back to the tail as soon as new output
   *  arrives (the click must not leave the pane stuck off the tail). */
  reconcile(): void;
}

/** #81 — the old `onAfterToggle` pinned every toggle to the tail, so a
 *  click that expanded a block near the bottom pushed its header up the
 *  screen and a second click on the same spot landed in the body (rejected
 *  as `expanded-body`). A click toggle now keeps the top row; it only
 *  returns to the tail when the kept top would be past the new bottom. */
export function createFoldClickScrollAnchor(
  state: FoldClickScrollState,
  otherwise: (target: FoldTarget, delta: number) => void,
): FoldClickScrollAnchor {
  let heldTop: number | null = null;
  // Set when a click moved a tail-following pane off the tail: the offset
  // it set and the line count right after the splice.
  let followTail: { offset: number; lineCount: number } | null = null;
  const viewport = (): { top: number; scrollOffset: number } => {
    const scrollOffset = state.getScrollOffset();
    const max = state.maxScroll();
    return { top: scrollOffset < 0 ? max : Math.min(scrollOffset, max), scrollOffset };
  };
  return {
    viewport,
    run<T>(toggle: () => T): T {
      const prev = heldTop;
      heldTop = viewport().top;
      try {
        return toggle();
      } finally {
        heldTop = prev;
      }
    },
    onAfterToggle(target, delta) {
      if (heldTop === null) {
        otherwise(target, delta);
        return;
      }
      // The splice moved every line after the block; a frozen tail past it
      // must move with them or the pane would cut the expanded rows short.
      const frozen = state.getFrozenTail();
      if (frozen !== null && target.kind === 'static' && target.lineStart < frozen) {
        state.setFrozenTail(frozen + delta);
      }
      const offsetBefore = state.getScrollOffset();
      const wasFollowing = offsetBefore < 0 || followTail?.offset === offsetBefore;
      const max = state.maxScroll();
      const next = heldTop >= max ? -1 : heldTop;
      state.setScrollOffset(next);
      if (next < 0) state.setFrozenTail(null);
      // No freeze here: the pane still follows the tail (see reconcile).
      followTail = next >= 0 && wasFollowing ? { offset: next, lineCount: state.lineCount() } : null;
      debug.log('log.fold', 'fold-click-anchor', {
        lineStart: target.kind === 'static' ? target.lineStart : null,
        delta,
        topBefore: heldTop,
        scrollOffsetAfter: next,
        maxScrollAfter: max,
        followTail: followTail !== null,
      });
    },
    reconcile() {
      if (followTail === null) return;
      // Someone else moved the pane (scroll keys, search, tail pin) — theirs.
      if (state.getScrollOffset() !== followTail.offset) {
        followTail = null;
        return;
      }
      if (state.lineCount() <= followTail.lineCount) return;
      debug.log('log.fold', 'fold-click-follow-tail', {
        offset: followTail.offset,
        lineCountBefore: followTail.lineCount,
        lineCountNow: state.lineCount(),
      });
      followTail = null;
      state.setScrollOffset(-1);
      state.setFrozenTail(null);
    },
  };
}

export function createDashboardLogClickDeps(
  deps: DashboardLogClickRuntimeDeps,
): LogClickDispatchDeps {
  return {
    termSize: deps.termSize,
    computePaneH: deps.computePaneH,
    computeLogH: deps.computeLogH,
    chatLinesLength: deps.chatLinesLength,
    chatScrollOffset: deps.chatScrollOffset,
    logFrozenTailIndex: deps.logFrozenTailIndex,
    chatFooterLine: deps.chatFooterLine,
    attachmentRowMap: deps.attachmentRowMap,
    contextRegistry: deps.contextRegistry,
    ownerWorkspaceId: deps.ownerWorkspaceId,
    setWorkingFocus: deps.setWorkingFocus,
    pushModal: (handle) => {
      const modalHandle = deps.pushTypedModal(
        'attachment-popup',
        { idempotencyKey: 'log-attachment-popup' },
        handle.surface,
      );
      if (!modalHandle) {
        deps.onPushRejected?.(handle.surface.id);
        return;
      }
      deps.onPushAccepted?.(handle.surface.id, modalHandle.generation);
      const originalDispose = handle.dispose.bind(handle);
      handle.dispose = () => {
        originalDispose();
        if (!modalHandle.isDisposed()) modalHandle.dispose();
      };
    },
    onAttachmentAction: deps.onAttachmentAction,
    draw: deps.draw,
    debug: deps.debug,
    // Wave C — when the host wires both deps, expose the pill cascade
    // to click-dispatch. Hosts that omit them (test harnesses) get
    // the legacy attachment-only behavior.
    ...(deps.pillRowGetter && deps.onPillClick
      ? {
          tryPillHit: (absIdx: number): boolean =>
            tryPillHitAtLineIndex(absIdx, {
              pillRowGetter: deps.pillRowGetter!,
              onPillClick: deps.onPillClick!,
              debug: deps.debug,
            }) === 'opened',
        }
      : {}),
    ...(deps.foldStack
      ? {
          tryFoldToggle: (absIdx: number): boolean => {
            const fold = deps.foldStack!;
            const anchor = deps.foldClickAnchor;
            // Screen frame of the click — lets the log tell «same spot again»
            // from «a different row» (#81 had no way to).
            const frame = anchor ? (() => {
              const v = anchor.viewport();
              return { screenRow: absIdx - v.top, top: v.top, scrollOffset: v.scrollOffset };
            })() : {};
            // Collapse from the first/last line of an expanded range or
            // the row whose click expanded it (#16 — same spot again folds).
            // Other lines of that range are rejected first so a body
            // click cannot fold the block under a reader. Folded
            // containment is left to toggleAtLine (false when none).
            if (!fold.isExpandedCollapseLine(absIdx)) {
              const targets = fold.snapshot();
              for (let i = targets.length - 1; i >= 0; i--) {
                const t = targets[i]!;
                if (t.lineStart == null || t.lineEnd == null) continue;
                if (absIdx >= t.lineStart && absIdx < t.lineEnd) {
                  if (t.expanded) {
                    debug.log('log.fold', 'expanded-body-reject', {
                      lineIndex: absIdx,
                      reason: 'expanded-body',
                      lineStart: t.lineStart,
                      lineEnd: t.lineEnd,
                      ...frame,
                    });
                    return false;
                  }
                  break;
                }
              }
            }
            const toggle = (): boolean => fold.toggleAtLine(absIdx, frame);
            const toggled = anchor ? anchor.run(toggle) : toggle();
            if (toggled) deps.draw();
            return toggled;
          },
        }
      : {}),
  };
}
