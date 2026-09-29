import type { DisplayCoordinator } from '../display/coordinator.js';
import type { DisplayMouseEvent } from '../display/types.js';
import {
  showLivePaneMultiModal,
  showPaneMultiModal,
  type LivePaneMultiModalHandle,
  type PaneMultiModalChromeAction,
  type PaneMultiModalChromeSpec,
  type PaneMultiModalHandle,
  type ShowLivePaneMultiModalParams,
  type ShowPaneMultiModalParams,
} from '../dashboard/modals/pane-multi.js';
import {
  resolvePaneMultiLiveSnapshotChrome,
} from '../dashboard/modals/pane-multi-chrome.js';
import type { ThemeTokens } from '../theme/tokens.js';
import type { WidgetHost } from '../widgets/host.js';
import type { PreviewPaneModel } from './model.js';

export interface OpenPreviewPaneModalDeps {
  preview: PreviewPaneModel;
  previewWidgetInstanceId: string;
  modalPreviewWidgetInstanceId?: string;
  title?: string;
  liveMode: boolean;
  widgetHost: Pick<WidgetHost, 'get' | 'spawn' | 'dispose' | 'disposeById' | 'defFor'>;
  coordinator: DisplayCoordinator;
  termCols: number;
  termRows: number;
  captureSnapshot(): string;
  theme: ThemeTokens;
  onDispose?(): void;
  onCancel?(): void;
}

export function createPreviewPaneModalWidgetId(
  previewWidgetInstanceId: string,
): string {
  return `${previewWidgetInstanceId}::preview-pane-modal`;
}

export function createPreviewPaneModalChrome(
  theme: ThemeTokens,
  liveMode: boolean,
): PaneMultiModalChromeSpec {
  return resolvePaneMultiLiveSnapshotChrome({
    theme,
    titlePrefix: '◫',
    controlMode: 'close-only',
    subject: 'preview',
    liveMode,
  });
}

export function syncPreviewPaneWidgetFromModel(
  widgetHost: Pick<WidgetHost, 'get'>,
  widgetInstanceId: string,
  preview: PreviewPaneModel,
): boolean {
  const widget = widgetHost.get(widgetInstanceId) as {
    state?: {
      text?: string;
      scroll?: number;
      focused?: boolean;
      preformatted?: boolean;
    };
    character?: string;
  } | null;
  if (!widget?.state) return false;
  widget.state.text = preview.previewLines.join('\n');
  widget.state.scroll = preview.previewOffset;
  widget.state.focused = false;
  widget.state.preformatted = true;
  widget.character = 'Preview';
  return true;
}

export function disposePreviewPaneModalWidgetInstance(
  widgetHost: Pick<WidgetHost, 'dispose' | 'disposeById'>,
  modalWidgetInstanceId: string,
  reason: string,
): void {
  try { widgetHost.disposeById(modalWidgetInstanceId, reason); }
  catch {
    try { widgetHost.dispose(modalWidgetInstanceId); } catch { /* ignore */ }
  }
}

export function replacePreviewPaneModalWidgetInstance(
  widgetHost: Pick<WidgetHost, 'get' | 'spawn' | 'dispose' | 'disposeById'>,
  sourceWidgetInstanceId: string,
  modalWidgetInstanceId: string,
): boolean {
  disposePreviewPaneModalWidgetInstance(widgetHost, modalWidgetInstanceId, 'preview-pane-modal-replace');
  const sourceWidget = widgetHost.get(sourceWidgetInstanceId);
  if (!sourceWidget) return false;
  widgetHost.spawn({
    id: modalWidgetInstanceId,
    type: sourceWidget.type,
    character: sourceWidget.character,
    config: sourceWidget.config,
  });
  return true;
}

export function resolvePreviewPaneModalChromeAction(
  action: PaneMultiModalChromeAction,
  callbacks: { onClose(): void },
): boolean {
  if (action.controlId !== 'close') return false;
  callbacks.onClose();
  return true;
}

export function openPreviewPaneModal(
  deps: OpenPreviewPaneModalDeps,
): { dispose(): void; id: string; bounds: { row: number; col: number; width: number; height: number } } {
  const modalPreviewWidgetInstanceId =
    deps.modalPreviewWidgetInstanceId
    ?? createPreviewPaneModalWidgetId(deps.previewWidgetInstanceId);
  const title = deps.title ?? 'Preview';
  const chrome = createPreviewPaneModalChrome(deps.theme, deps.liveMode);
  const routeChromeAction = (
    action: PaneMultiModalChromeAction,
    _ev: DisplayMouseEvent,
    handle: { dispose(): void },
  ): void => {
    resolvePreviewPaneModalChromeAction(action, {
      onClose: () => { handle.dispose(); },
    });
  };

  if (deps.liveMode) {
    const hasWidget = replacePreviewPaneModalWidgetInstance(
      deps.widgetHost,
      deps.previewWidgetInstanceId,
      modalPreviewWidgetInstanceId,
    );
    if (hasWidget) {
      syncPreviewPaneWidgetFromModel(
        deps.widgetHost,
        modalPreviewWidgetInstanceId,
        deps.preview,
      );
    }
    let handle: LivePaneMultiModalHandle | null = null;
    const params: ShowLivePaneMultiModalParams = {
      title,
      columns: [{
        title: 'preview',
        widgetInstanceId: hasWidget ? modalPreviewWidgetInstanceId : deps.previewWidgetInstanceId,
        weight: 1,
      }],
      widgetHost: deps.widgetHost,
      coordinator: deps.coordinator,
      termCols: deps.termCols,
      termRows: deps.termRows,
      ttlMs: 0,
      group: 'preview-pane-modal',
      chrome,
      onCancel: deps.onCancel,
      onDispose: () => {
        disposePreviewPaneModalWidgetInstance(
          deps.widgetHost,
          modalPreviewWidgetInstanceId,
          'preview-pane-modal-close',
        );
        deps.onDispose?.();
      },
      onChromeAction: (action, ev) => {
        if (!handle) return;
        routeChromeAction(action, ev, handle);
      },
    };
    handle = showLivePaneMultiModal(params);
    return handle;
  }

  let handle: PaneMultiModalHandle | null = null;
  const params: ShowPaneMultiModalParams = {
    title,
    columns: [{
      title: 'preview',
      lines: deps.captureSnapshot().split('\n'),
      weight: 1,
    }],
    coordinator: deps.coordinator,
    termCols: deps.termCols,
    termRows: deps.termRows,
    ttlMs: 0,
    group: 'preview-pane-modal',
    chrome,
    onCancel: deps.onCancel,
    onDispose: deps.onDispose,
    onChromeAction: (action, ev) => {
      if (!handle) return;
      routeChromeAction(action, ev, handle);
    },
  };
  handle = showPaneMultiModal(params);
  return handle;
}
