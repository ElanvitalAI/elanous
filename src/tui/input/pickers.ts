/**
 * TUI-DIET-SEAM-PICKERS — the five input pickers that used to live as
 * closures inside `showDashboard` (src/dashboard/index.ts):
 *
 *   - openAgentRosterSearch — `/` over the agent roster
 *   - openTransferPicker    — browser → ssh / iphone transfer target
 *   - openFinderPicker      — Ctrl+T file finder
 *   - openDirectoryPicker   — Alt+C directory finder
 *   - openSshPicker         — Ctrl+K SSH host picker
 *
 * Pure move: the bodies are unchanged except that dashboard-owned
 * mutable state is reached through `deps.state` (live get/set accessors
 * owned by the dashboard — never a value copy). Everything else the
 * bodies captured is passed in once as an explicit dependency.
 *
 * ⛔ This module must not import src/dashboard/index.ts (cycle).
 */
import { homedir } from 'node:os';
import { C, termSize } from '../../tui.js';
import { createSearchModal, type SearchModalHandle, type SearchItem } from '../../chat/search/modal.js';
import { globalAgentRegistry } from '../../agent/registry.js';
import { attachSurfaceToWorkspace } from '../../display/workspace-affinity.js';
import type { DisplayCoordinator } from '../../display/coordinator.js';
import type { AgentSurfaceStore } from '../../display/agent-surface.js';
import { resolveBrowserTransferCapability } from '../../browser-pane/capabilities.js';
import { listTransferTargets, type TransferTarget } from '../../transfer/transfer-targets.js';
import { createTransferPickerModal } from '../../transfer/transfer-picker-modal.js';
import { scanFinder as defaultScanFinder, relativizeResults } from '../../finder/finder-scan.js';
import { scanRemoteFinder as defaultScanRemoteFinder, relativizeRemoteResults } from '../../finder/finder-scan-remote.js';
import { createFinderModal, type FinderItem } from '../../finder/finder-modal.js';
import { getSessionCwd } from '../../session/working-dir.js';
import { createSshPickerModal } from '../../ssh/ssh-picker-modal.js';
import { touchSshHost, type SshHost } from '../../ssh/ssh-hosts.js';
import { refreshRemoteWorkingDir, enterRemoteDirectory } from '../../ssh/remote-browser.js';
import {
  type BrowserPaneModel,
  refreshWorkingDir,
  enterDirectory,
  type WorkingDirState,
} from '../../working-dir/index.js';
import type { PaneFocus } from '../../workspace-types.js';
import type { ThemeTokens } from '../../theme/tokens.js';
export interface PickerTransferFeedback {
  onNoFilesToTransfer(): void;
  onTransferDisabled(reason?: string | null): void;
  onNoTransferTargets(): void;
}

export interface PickerFinderFeedback {
  onFinderScanStarted(target: string): void;
  onFinderScanCompleted(options: { count: number; backend: string; truncated: boolean; durationMs: number }): void;
  onFinderScanEmpty(): void;
  onSshConnectStarted(options: { name: string; host: string }): void;
  onSshConnectSucceeded(name: string): void;
  onSshConnectFailed(name: string, message: string): void;
}

/** Dashboard-owned mutable state. Implemented by the dashboard as live
 *  get/set accessors so a write here is the dashboard's write. */
export interface InputPickersState {
  agentSearchModal: SearchModalHandle | null;
  agentSearchHandle: { dispose: () => void } | null;
  agentRosterCursor: number;
  agentCursorLockedId: string;
  agentCursorManual: boolean;
  chatScrollOffset: number;
  readonly chatLines: string[];
}

export interface InputPickersDeps {
  state: InputPickersState;
  display: DisplayCoordinator;
  agentSurfaceStore: AgentSurfaceStore;
  workingDir: WorkingDirState;
  dockedPreview: Parameters<typeof refreshRemoteWorkingDir>[2];
  transferFeedbackRuntime: PickerTransferFeedback;
  finderFeedbackRuntime: PickerFinderFeedback;
  currentThemeTokens: () => ThemeTokens;
  currentWorkspaceOwnerId: () => string;
  activeBrowserWidgetId: () => string;
  resolveBrowserStateById: (browserId?: string | null) => BrowserPaneModel | null;
  fmtBytes: (n: number) => string;
  runTransfer: (
    target: TransferTarget,
    files: Array<{ localPath: string; size?: number }>,
  ) => Promise<void>;
  /** Existing dashboard closure — passed in, not moved. */
  closeAgentRosterSearch: () => void;
  pushDebugLine: (line: string) => void;
  refreshRemotePreviewBridge: () => Promise<void>;
  refreshWorkingDirPreview: (opts?: { force?: boolean }) => void;
  setWorkingFocus: (next: PaneFocus, reason?: string) => void;
  startRemoteModeBridge: (host: SshHost, cwd?: string) => void;
  draw: () => void;
  /** Scan seams — default to the real fd/ssh scanners. Tests inject fakes. */
  scanFinder?: typeof defaultScanFinder;
  scanRemoteFinder?: typeof defaultScanRemoteFinder;
}

export interface InputPickers {
  openAgentRosterSearch(): void;
  openTransferPicker(
    files: Array<{ localPath: string; size?: number }>,
    browserId?: string,
  ): void;
  openFinderPicker(): Promise<void>;
  openDirectoryPicker(): Promise<void>;
  openSshPicker(): void;
}

export function createInputPickers(deps: InputPickersDeps): InputPickers {
  const {
    state,
    display,
    agentSurfaceStore,
    workingDir,
    dockedPreview,
    transferFeedbackRuntime,
    finderFeedbackRuntime,
    currentThemeTokens,
    currentWorkspaceOwnerId,
    activeBrowserWidgetId,
    resolveBrowserStateById,
    fmtBytes,
    runTransfer,
    closeAgentRosterSearch,
    pushDebugLine,
    refreshRemotePreviewBridge,
    refreshWorkingDirPreview,
    setWorkingFocus,
    startRemoteModeBridge,
    draw,
    scanFinder = defaultScanFinder,
    scanRemoteFinder = defaultScanRemoteFinder,
  } = deps;

  /** Open the agent-roster search modal. Reads the current roster
   *  from agentSurfaceStore + globalAgentRegistry. Items: each
   *  entry's name + last 8 chars of id. Enter sets cursor; Esc
   *  dismisses. */
  function openAgentRosterSearch(): void {
    if (state.agentSearchModal) return;
    const roster = agentSurfaceStore.syncTasks(globalAgentRegistry.list());
    const cols = termSize().cols;
    const modalWidth = Math.min(60, cols - 4);
    const modalRow = 3;       // top-anchored over the roster pane
    const modalCol = Math.max(2, Math.floor((cols - modalWidth) / 2));
    const filterable = roster.length > 3;
    const handle = createSearchModal({
      id: `agent-roster-search:${Date.now().toString(36)}`,
      bounds: { row: modalRow, col: modalCol, width: modalWidth, height: 12 },
      title: 'Search agents',
      width: modalWidth,
      maxVisible: 8,
      primaryActionLabel: 'jump',
      cancelActionLabel: 'cancel',
      filterable,
      actionButtons: true,
      chromeSpec: {
        titleAlign: 'center',
      },
      onQuery: (q) => {
        const roster = agentSurfaceStore.syncTasks(globalAgentRegistry.list());
        const needle = q.trim().toLowerCase();
        const match = (t: typeof roster[number]) => {
          if (!needle) return true;
          return t.name.toLowerCase().includes(needle)
              || t.definitionName.toLowerCase().includes(needle)
              || (t.summary ?? '').toLowerCase().includes(needle)
              || t.id.toLowerCase().includes(needle);
        };
        return roster.filter(match).map((t): SearchItem => ({
          label: `${t.name}  ${t.definitionName}  ${t.id.slice(0, 8)}`,
          payload: t.id,
        }));
      },
      onAccept: (item) => {
        const roster = agentSurfaceStore.syncTasks(globalAgentRegistry.list());
        const idx = roster.findIndex(t => t.id === item.payload);
        if (idx >= 0) {
          state.agentRosterCursor = idx;
          state.agentCursorLockedId = roster[idx]!.id;
          state.agentCursorManual = true;
        }
        closeAgentRosterSearch();
      },
      onCancel: () => closeAgentRosterSearch(),
      theme: currentThemeTokens(),
    });
    attachSurfaceToWorkspace(handle.surface, currentWorkspaceOwnerId());
    state.agentSearchModal = handle;
    state.agentSearchHandle = display.pushModal(handle.surface);
  }

  /** T5-J5 — open the transfer picker. Files arg = local paths to
   *  ship; destination comes from the picker. Handles both ssh and
   *  iphone target kinds. Remote-mode browser isn't supported here
   *  yet — the user is transferring LOCAL files (focused entry +
   *  selected set) to a remote destination. Transferring REMOTE→X
   *  is a separate flow (not this phase). */
  function openTransferPicker(
    files: Array<{ localPath: string; size?: number }>,
    browserId: string = activeBrowserWidgetId(),
  ): void {
    const targetBrowser = resolveBrowserStateById(browserId) ?? (workingDir as BrowserPaneModel);
    if (files.length === 0) {
      transferFeedbackRuntime.onNoFilesToTransfer();
      return;
    }
    const capability = resolveBrowserTransferCapability(
      targetBrowser,
      listTransferTargets(),
    );
    if (!capability.enabled) {
      transferFeedbackRuntime.onTransferDisabled(capability.reason);
      return;
    }
    const targets = capability.targets;
    if (targets.length === 0) {
      transferFeedbackRuntime.onNoTransferTargets();
      return;
    }
    const totalBytes = files.reduce((a, f) => a + (f.size ?? 0), 0);
    const summary = `${files.length} file${files.length === 1 ? '' : 's'}${
      totalBytes > 0 ? ` (${fmtBytes(totalBytes)})` : ''
    }`;

    const { cols, rows } = termSize();
    const width = Math.min(74, Math.max(46, cols - 6));
    const visibleRows = Math.min(10, targets.length);
    const height = visibleRows + 3;
    const bounds = {
      row: Math.max(1, Math.floor((rows - height) / 2)),
      col: Math.max(1, Math.floor((cols - width) / 2)),
      width,
      height,
    };
    let handle: ReturnType<typeof display.pushModal> | null = null;
    const picker = createTransferPickerModal({
      targets,
      bounds,
      width,
      maxVisible: visibleRows,
      summary,
      theme: currentThemeTokens(),
      onAccept: (target) => {
        state.agentSearchModal = null;
        handle?.dispose();
        void runTransfer(target, files);
        draw();
      },
      onCancel: () => {
        state.agentSearchModal = null;
        handle?.dispose();
        draw();
      },
    });
    attachSurfaceToWorkspace(picker.surface, currentWorkspaceOwnerId());
    handle = display.pushModal(picker.surface);
    state.agentSearchModal = picker;
    draw();
  }

  /** T4-F2 / T4-F3 — open the Ctrl+T finder modal. Scans the
   *  current working dir (local only at MVP; remote scan is a
   *  follow-up). On accept, cd's the browser pane to the file's
   *  parent dir, focuses the file in the listing, and switches
   *  pane focus to browser so the user can e/enter next. */
  async function openFinderPicker(): Promise<void> {
    const targetBrowserId = activeBrowserWidgetId();
    const targetBrowser = resolveBrowserStateById(targetBrowserId) ?? (workingDir as BrowserPaneModel);
    // T5-I2 — branch on remote vs local. Both paths produce the
    // same {absPath, relPath} finder items so the modal + onAccept
    // handler stay unified.
    let finderItems: FinderItem[] = [];
    let backend = 'fd';
    let truncated = false;
    let scanDurationMs = 0;

    if (workingDir.remote) {
      const host = workingDir.remote.host;
      const remoteRoot = workingDir.remote.cwd;
      finderFeedbackRuntime.onFinderScanStarted(`${host.name}:${remoteRoot}`);
      draw();
      const scan = await scanRemoteFinder({ host, root: remoteRoot });
      const rels = relativizeRemoteResults(scan.paths, remoteRoot);
      finderItems = scan.paths.map((absPath, i) => ({
        absPath, relPath: rels[i] ?? absPath,
      }));
      backend = `${scan.backend}@${scan.host}`;
      truncated = scan.truncated;
      scanDurationMs = scan.durationMs;
    } else {
      // 2026-05-03 — scan from the Session Working Directory (the
      // "project root"), NOT the browser pane's current navigation
      // cursor. SWD is mutable only via Ctrl+W / /wd / SetWorkingDir
      // tool — exactly the user's intent for "project root". Browser
      // pane's cwd is purely UI navigation and should not narrow
      // Ctrl+T's search scope (matches working-dir.ts:5-8 contract).
      const scanRoot = getSessionCwd();
      finderFeedbackRuntime.onFinderScanStarted(scanRoot);
      draw();
      const scan = await scanFinder({ root: scanRoot });
      const rels = relativizeResults(scan.paths, scanRoot);
      finderItems = scan.paths.map((absPath, i) => ({
        absPath, relPath: rels[i] ?? absPath,
      }));
      backend = scan.backend;
      truncated = scan.truncated;
      scanDurationMs = scan.durationMs;
    }
    if (finderItems.length === 0) {
      finderFeedbackRuntime.onFinderScanEmpty();
      draw();
      return;
    }
    finderFeedbackRuntime.onFinderScanCompleted({
      count: finderItems.length,
      backend,
      truncated,
      durationMs: scanDurationMs,
    });

    const { cols, rows } = termSize();
    const width = Math.min(90, Math.max(50, cols - 6));
    const visibleRows = Math.min(15, Math.max(6, rows - 8));
    const height = visibleRows + 3;
    const bounds = {
      row: Math.max(1, Math.floor((rows - height) / 2)),
      col: Math.max(1, Math.floor((cols - width) / 2)),
      width,
      height,
    };
    let handle: ReturnType<typeof display.pushModal> | null = null;
    // Title reflects the actual scan root — SWD for local (project
     // root), remote cwd for remote mode. Browser pane's nav cursor
     // is intentionally NOT shown because the scan ignores it.
    const titleRoot = workingDir.remote
      ? `${workingDir.remote.host.name}:${workingDir.remote.cwd}`
      : getSessionCwd().replace(homedir(), '~');
    const picker = createFinderModal({
      items: finderItems,
      bounds, width, maxVisible: visibleRows,
      truncated,
      title: `Find file in ${titleRoot}`,
      theme: currentThemeTokens(),
      onAccept: (item) => {
        state.agentSearchModal = null;
        handle?.dispose();
        const parentDir = item.absPath.slice(0, item.absPath.lastIndexOf('/')) || '/';
        const basename = item.absPath.slice(item.absPath.lastIndexOf('/') + 1);
        if (workingDir.remote) {
          // T5-I2 — remote cd + focus-by-basename.
          enterRemoteDirectory(workingDir, parentDir);
          (async () => {
            await refreshRemoteWorkingDir(workingDir, {}, dockedPreview);
            const idx = workingDir.entries.findIndex(e => e.name === basename);
            if (idx >= 0) {
              workingDir.cursor = idx;
              workingDir.offset = Math.max(0, idx - 3);
            }
            await refreshRemotePreviewBridge();
            pushDebugLine(C.muted(`  ${workingDir.remote?.host.name}:${item.relPath}`));
            state.chatScrollOffset = -1;
            draw();
          })().catch(() => {});
        } else {
          enterDirectory(targetBrowser as WorkingDirState, parentDir);
          refreshWorkingDir(targetBrowser as WorkingDirState);
          const idx = targetBrowser.entries.findIndex(e => e.name === basename);
          if (idx >= 0) {
            targetBrowser.cursor = idx;
            targetBrowser.offset = Math.max(0, idx - 3);
          }
          refreshWorkingDirPreview();
          pushDebugLine(C.muted(`  ${item.relPath}`));
          state.chatScrollOffset = -1;
        }
        setWorkingFocus('browser', 'agent-roster-search-pick');
        draw();
      },
      onCancel: () => {
        state.agentSearchModal = null;
        handle?.dispose();
        draw();
      },
    });
    attachSurfaceToWorkspace(picker.surface, currentWorkspaceOwnerId());
    handle = display.pushModal(picker.surface);
    state.agentSearchModal = picker;
    draw();
  }

  /** Yazi-style Alt+C — directory finder. Symmetric with openFinder
   *  Picker but enumerates directories only (`scanFinder kind:'dir'`)
   *  and on accept cd's the browser pane to the chosen directory.
   *  Remote-mode is currently unsupported (surfaces a warning) — the
   *  remote finder would need a parallel kind-aware backend. */
  async function openDirectoryPicker(): Promise<void> {
    if (workingDir.remote) {
      state.chatLines.push(C.warning('  Alt+C: directory finder is local-only — Esc remote first.'));
      state.chatScrollOffset = -1;
      draw();
      return;
    }
    const targetBrowserId = activeBrowserWidgetId();
    const targetBrowser = resolveBrowserStateById(targetBrowserId) ?? (workingDir as BrowserPaneModel);
    // Symmetric with openFinderPicker — scan from SWD (project root),
    // not the browser pane's nav cursor. The accept handler still
    // mutates targetBrowser to navigate into the chosen dir.
    const scanRoot = getSessionCwd();
    finderFeedbackRuntime.onFinderScanStarted(`${scanRoot} (dirs)`);
    draw();
    const scan = await scanFinder({ root: scanRoot, kind: 'dir' });
    const rels = relativizeResults(scan.paths, scanRoot);
    const dirItems: FinderItem[] = scan.paths.map((absPath, i) => ({
      absPath, relPath: rels[i] ?? absPath,
    }));
    if (dirItems.length === 0) {
      finderFeedbackRuntime.onFinderScanEmpty();
      draw();
      return;
    }
    finderFeedbackRuntime.onFinderScanCompleted({
      count: dirItems.length,
      backend: scan.backend,
      truncated: scan.truncated,
      durationMs: scan.durationMs,
    });

    const { cols, rows } = termSize();
    const width = Math.min(90, Math.max(50, cols - 6));
    const visibleRows = Math.min(15, Math.max(6, rows - 8));
    const height = visibleRows + 3;
    const bounds = {
      row: Math.max(1, Math.floor((rows - height) / 2)),
      col: Math.max(1, Math.floor((cols - width) / 2)),
      width,
      height,
    };
    let handle: ReturnType<typeof display.pushModal> | null = null;
    const titleRoot = scanRoot.replace(homedir(), '~');
    const picker = createFinderModal({
      items: dirItems,
      bounds, width, maxVisible: visibleRows,
      truncated: scan.truncated,
      title: `Find directory in ${titleRoot}`,
      theme: currentThemeTokens(),
      onAccept: (item) => {
        state.agentSearchModal = null;
        handle?.dispose();
        enterDirectory(targetBrowser as WorkingDirState, item.absPath);
        refreshWorkingDir(targetBrowser as WorkingDirState);
        refreshWorkingDirPreview();
        pushDebugLine(C.muted(`  cd ${item.relPath}`));
        state.chatScrollOffset = -1;
        setWorkingFocus('browser', 'alt-c-dir-pick');
        draw();
      },
      onCancel: () => {
        state.agentSearchModal = null;
        handle?.dispose();
        draw();
      },
    });
    attachSurfaceToWorkspace(picker.surface, currentWorkspaceOwnerId());
    handle = display.pushModal(picker.surface);
    state.agentSearchModal = picker;
    draw();
  }

  /** T4-E4 — open the SSH host picker (Ctrl+K). Accept connects
   *  the browser pane to the remote host; Esc cancels silently.
   *  Routes keys through state.agentSearchModal (shared pattern with
   *  window + session pickers). */
  function openSshPicker(): void {
    const { cols, rows } = termSize();
    const width = Math.min(72, Math.max(44, cols - 6));
    const visibleRows = 8;
    const height = visibleRows + 3;
    const bounds = {
      row: Math.max(1, Math.floor((rows - height) / 2)),
      col: Math.max(1, Math.floor((cols - width) / 2)),
      width,
      height,
    };
    let handle: ReturnType<typeof display.pushModal> | null = null;
    const picker = createSshPickerModal({
      bounds, width, maxVisible: visibleRows,
      activeHostName: workingDir.remote?.host.name ?? null,
      theme: currentThemeTokens(),
      onAccept: async (host) => {
        state.agentSearchModal = null;
        handle?.dispose();
        touchSshHost(host.name);
        startRemoteModeBridge(host, '.');
        finderFeedbackRuntime.onSshConnectStarted({ name: host.name, host: host.host });
        draw();
        try {
          await refreshRemoteWorkingDir(workingDir, {}, dockedPreview);
          await refreshRemotePreviewBridge();
          finderFeedbackRuntime.onSshConnectSucceeded(host.name);
        } catch (err) {
          finderFeedbackRuntime.onSshConnectFailed(
            host.name,
            err instanceof Error ? err.message : String(err),
          );
        }
        draw();
      },
      onCancel: () => {
        state.agentSearchModal = null;
        handle?.dispose();
        draw();
      },
    });
    attachSurfaceToWorkspace(picker.surface, currentWorkspaceOwnerId());
    handle = display.pushModal(picker.surface);
    state.agentSearchModal = picker;
    draw();
  }

  return {
    openAgentRosterSearch,
    openTransferPicker,
    openFinderPicker,
    openDirectoryPicker,
    openSshPicker,
  };
}
