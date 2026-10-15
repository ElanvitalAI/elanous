import type { Attachment, ContextRegistry } from '../context.js';
import { debug } from '../debug/log.js';
import type { FoldStack } from '../fold-stack.js';
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
                    });
                    return false;
                  }
                  break;
                }
              }
            }
            const toggled = fold.toggleAtLine(absIdx);
            if (toggled) deps.draw();
            return toggled;
          },
        }
      : {}),
  };
}
