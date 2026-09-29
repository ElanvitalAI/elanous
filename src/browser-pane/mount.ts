import type { DisplayCoordinator } from '../display/coordinator.js';
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
import type { BrowserPaneRegistry } from './registry.js';
import type { FsEntry } from './model.js';
import {
  navigateBrowserPreviewModalDirectory,
  projectBrowserPreviewModalBrowserState,
  syncBrowserPreviewModalCursorFromWidgetState,
} from '../dashboard/modals/browser-preview-modal-seams.js';

export interface OpenBrowserPaneModalDeps {
  browserWidgetInstanceId: string;
  liveMode: boolean;
  browserPaneRegistry: Pick<BrowserPaneRegistry, 'cloneInto' | 'delete'>;
  widgetHost: Pick<WidgetHost, 'get' | 'spawn' | 'dispose' | 'disposeById' | 'defFor'>;
  coordinator: DisplayCoordinator;
  termCols: number;
  termRows: number;
  captureSnapshot(): string;
  theme: ThemeTokens;
  fmtEntryColored(entry: FsEntry): string;
  iconForEntry(entry: FsEntry): string;
  onSubmit?(text: string): void;
  onDispose?(): void;
  onCancel?(): void;
}

export function createBrowserPaneModalChrome(
  theme: ThemeTokens,
  liveMode: boolean,
): PaneMultiModalChromeSpec {
  return resolvePaneMultiLiveSnapshotChrome({
    theme,
    titlePrefix: '⠿',
    controlMode: 'close-only',
    subject: 'browser',
    liveMode,
  });
}

function disposeBrowserPaneModalWidgetInstance(
  widgetHost: Pick<WidgetHost, 'dispose' | 'disposeById'>,
  modalWidgetInstanceId: string,
  reason: string,
): void {
  try { widgetHost.disposeById(modalWidgetInstanceId, reason); }
  catch {
    try { widgetHost.dispose(modalWidgetInstanceId); } catch { /* ignore */ }
  }
}

function replaceBrowserPaneModalWidgetInstance(
  widgetHost: Pick<WidgetHost, 'get' | 'spawn' | 'dispose' | 'disposeById'>,
  sourceWidgetInstanceId: string,
  modalWidgetInstanceId: string,
): boolean {
  disposeBrowserPaneModalWidgetInstance(widgetHost, modalWidgetInstanceId, 'browser-pane-modal-replace');
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

function resolveBrowserPaneModalChromeAction(
  action: PaneMultiModalChromeAction,
  callbacks: { onClose(): void },
): boolean {
  if (action.controlId !== 'close') return false;
  callbacks.onClose();
  return true;
}

export function openBrowserPaneModal(
  deps: OpenBrowserPaneModalDeps,
): { dispose(): void; id: string; bounds: { row: number; col: number; width: number; height: number } } {
  const modalBrowserWidgetInstanceId = `${deps.browserWidgetInstanceId}::browser-pane-modal`;
  const modalBrowser = deps.browserPaneRegistry.cloneInto(
    deps.browserWidgetInstanceId,
    modalBrowserWidgetInstanceId,
  );
  const chrome = createBrowserPaneModalChrome(deps.theme, deps.liveMode);
  let handle: LivePaneMultiModalHandle | PaneMultiModalHandle | null = null;

  const syncBrowserWidgetFromState = (): void => {
    const inst = deps.widgetHost.get(modalBrowserWidgetInstanceId) as {
      state?: {
        items?: string[];
        icons?: string[];
        cursor?: number;
        offset?: number;
        preserveAnsi?: boolean;
        submitText?: string[];
        selected?: Set<string>;
      };
    } | null;
    if (!inst?.state) return;
    const projection = projectBrowserPreviewModalBrowserState(modalBrowser, {
      browserWidgetInstanceId: deps.browserWidgetInstanceId,
      fmtEntryColored: deps.fmtEntryColored,
      iconForEntry: deps.iconForEntry,
    });
    inst.state.items = projection.items;
    inst.state.icons = projection.icons;
    inst.state.cursor = projection.cursor;
    inst.state.offset = projection.offset;
    inst.state.preserveAnsi = projection.preserveAnsi;
    inst.state.submitText = projection.submitText;
    inst.state.selected = projection.selected;
  };

  const dispose = (): void => {
    if (handle) {
      const current = handle;
      handle = null;
      current.dispose();
      return;
    }
    disposeBrowserPaneModalWidgetInstance(
      deps.widgetHost,
      modalBrowserWidgetInstanceId,
      'browser-pane-modal-close',
    );
    deps.browserPaneRegistry.delete(modalBrowserWidgetInstanceId);
    deps.onDispose?.();
  };

  const onSubmit = (text: string): void => {
    dispose();
    deps.onSubmit?.(text);
  };

  if (deps.liveMode) {
    const hasWidget = replaceBrowserPaneModalWidgetInstance(
      deps.widgetHost,
      deps.browserWidgetInstanceId,
      modalBrowserWidgetInstanceId,
    );
    if (hasWidget) {
      syncBrowserWidgetFromState();
    }
    const params: ShowLivePaneMultiModalParams = {
      title: 'Browser',
      columns: [{
        title: 'browser',
        widgetInstanceId: hasWidget ? modalBrowserWidgetInstanceId : deps.browserWidgetInstanceId,
        weight: 1,
        onIntercept: (ev) => {
          if (ev.name !== 'left' && ev.name !== 'right') return undefined;
          const navResult = navigateBrowserPreviewModalDirectory(modalBrowser, ev.name);
          if (navResult.changed) {
            syncBrowserWidgetFromState();
          }
          return 'consumed';
        },
        onAfterKey: (action) => {
          const inst = deps.widgetHost.get(modalBrowserWidgetInstanceId) as {
            state?: { cursor?: number; offset?: number };
          } | null;
          syncBrowserPreviewModalCursorFromWidgetState(modalBrowser, inst?.state);
          if (action.type === 'submit') onSubmit(action.text);
        },
        onAfterMouse: (action) => {
          const inst = deps.widgetHost.get(modalBrowserWidgetInstanceId) as {
            state?: { cursor?: number; offset?: number };
          } | null;
          syncBrowserPreviewModalCursorFromWidgetState(modalBrowser, inst?.state);
          if (action.type === 'submit') onSubmit(action.text);
        },
      }],
      widgetHost: deps.widgetHost,
      coordinator: deps.coordinator,
      termCols: deps.termCols,
      termRows: deps.termRows,
      ttlMs: 0,
      group: 'browser-pane-modal',
      chrome,
      onDispose: () => {
        disposeBrowserPaneModalWidgetInstance(
          deps.widgetHost,
          modalBrowserWidgetInstanceId,
          'browser-pane-modal-close',
        );
        deps.browserPaneRegistry.delete(modalBrowserWidgetInstanceId);
        deps.onDispose?.();
      },
      onCancel: deps.onCancel,
      onChromeAction: (action) => {
        resolveBrowserPaneModalChromeAction(action, {
          onClose: () => { handle?.dispose(); },
        });
      },
    };
    handle = showLivePaneMultiModal(params);
    return handle;
  }

  const params: ShowPaneMultiModalParams = {
    title: 'Browser',
    columns: [{
      title: 'browser',
      lines: deps.captureSnapshot().split('\n'),
      weight: 1,
    }],
    coordinator: deps.coordinator,
    termCols: deps.termCols,
    termRows: deps.termRows,
    ttlMs: 0,
    group: 'browser-pane-modal',
    chrome,
    onDispose: () => {
      deps.browserPaneRegistry.delete(modalBrowserWidgetInstanceId);
      deps.onDispose?.();
    },
    onCancel: deps.onCancel,
    onChromeAction: (action) => {
      resolveBrowserPaneModalChromeAction(action, {
        onClose: () => { handle?.dispose(); },
      });
    },
  };
  handle = showPaneMultiModal(params);
  return handle;
}
