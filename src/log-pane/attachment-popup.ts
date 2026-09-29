// Attachment click popup — log-pane UX, 2026-04-20.
//
// When the user left-clicks an attachment-summary row (e.g.
// `├─ [Md #3] SMOKE.md (41.9KB)`) in the log pane, we open a small
// anchored selector listing the actions they'd otherwise have to
// type slash-commands for: drop, copy the token, copy the source
// path. A SelectView wrapped in BoxView, mounted as a modal surface via
// mountViewAsModalSurface (so it picks up the standard modal-stack
// key routing, focus tracking, and context-key tier management).
//
// The action callback executes dashboard-owned operations (ctxDrop,
// writeClipboard) — this module stays pure over its inputs.

import { SelectView, type SelectOption } from '../ui/widgets/select-view.js';
import { mountViewAsModalSurface, type ViewSurfaceHandle } from '../ui/modal-adapter.js';
import { computePopupBounds } from '../status/popups.js';
import { BoxView } from '../ui/view.js';
import { C } from '../tui.js';
import { resolveWidgetChromeBoxViewOptions } from '../ui/declarative/index.js';
import { resolvePickerChromePresentation } from '../ui/chrome/picker-chrome.js';
import { resolvePickerPopupSize } from '../ui/chrome/picker-popup-sizing.js';
import type { Attachment } from '../context.js';
import { attachSurfaceToWorkspace } from '../display/workspace-affinity.js';

/** Action the user picked in the popup. Caller dispatches. */
export type AttachmentPopupAction = 'drop' | 'copy-token' | 'copy-path';

export interface AttachmentPopupOpts {
  attachment: Attachment;
  ownerWorkspaceId?: string;
  /** 1-indexed click column — popup anchors here. */
  col: number;
  /** 1-indexed click row. */
  row: number;
  termCols: number;
  termRows: number;
  onAction: (action: AttachmentPopupAction, attachment: Attachment) => void;
  onCancel?: () => void;
}

/** Build the option list for a given attachment. Exported so tests
 *  can assert the set/order without mounting the view. */
export function buildAttachmentPopupOptions(
  attachment: Attachment,
): SelectOption<AttachmentPopupAction>[] {
  const shortPath = shortenPath(attachment.sourcePath);
  return [
    {
      value: 'drop',
      label: C.warning('Drop attachment'),
      description: `remove ${attachment.token} from context`,
    },
    {
      value: 'copy-token',
      label: 'Copy token',
      description: attachment.token,
    },
    {
      value: 'copy-path',
      label: 'Copy path',
      description: shortPath,
    },
  ];
}

/** Create the attachment popup as a modal surface. Returns the
 *  ViewSurfaceHandle; caller is responsible for calling
 *  `display.pushModal(handle.surface)` to insert it into the stack.
 *  The popup disposes itself via handle.dispose() on submit/cancel. */
export function createAttachmentPopup(opts: AttachmentPopupOpts): ViewSurfaceHandle {
  const { attachment } = opts;
  const items = buildAttachmentPopupOptions(attachment);
  const title = `${attachment.token} ${attachment.filename}`;
  const bounds = computePopupBounds(
    {
      anchorStartCol: Math.max(0, opts.col - 1),
      anchorEndCol: Math.max(1, opts.col),
      statusRow: opts.row,
      termCols: opts.termCols,
      termRows: opts.termRows,
    },
    resolvePickerPopupSize(items, {
      minWidth: 36,
      maxWidth: 70,
      widthPadding: 8,
      visibleRows: items.length,
      shellRows: 5,
      minContentWidth: title.length + 4,
    }),
  );

  let handle: ViewSurfaceHandle | null = null;
  const presentation = resolvePickerChromePresentation({
    title,
    primaryAction: 'run',
    browseMode: true,
    filterable: false,
    chromeSpec: {
      titleAlign: 'center',
    },
    maxWidth: bounds.width,
  });

  const select = new SelectView<AttachmentPopupAction>({
    options: items,
    searchable: false,
    browseMode: true,
    visibleRows: items.length,
    footerHint: '',
    onSubmit: (picked) => {
      opts.onAction(picked as AttachmentPopupAction, attachment);
      handle?.dispose();
    },
    onCancel: () => {
      opts.onCancel?.();
      handle?.dispose();
    },
  });
  const view = new BoxView(select, resolveWidgetChromeBoxViewOptions(
    undefined,
    presentation.chromeSpec,
    title,
  ));

  // Width: fit the widest label + description + icon/cursor padding,
  // clamped so we don't blow past the viewport on tiny terminals.
  const id = `log-attachment-popup:${attachment.id}:${Date.now().toString(36)}`;
  handle = mountViewAsModalSurface({
    id,
    bounds,
    view,
    priority: 270,   // popup tier — above standard modals (250)
    tier: 'popup',
  });
  attachSurfaceToWorkspace(handle.surface, opts.ownerWorkspaceId);
  return handle;
}

// ── helpers ────────────────────────────────────────────────

/** Truncate a path to ≤ 48 chars for popup description rendering.
 *  Keeps the basename + enough parents to stay recognizable. */
function shortenPath(path: string): string {
  if (path.length <= 48) return path;
  const parts = path.split('/');
  if (parts.length <= 2) return '…' + path.slice(-47);
  const tail = parts.slice(-3).join('/');
  return '…/' + (tail.length > 46 ? tail.slice(-46) : tail);
}
