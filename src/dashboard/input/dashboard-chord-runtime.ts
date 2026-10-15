import {
  createDashboardChordActionRunner,
} from './dashboard-chord-actions.js';
import type { SessionsSidebarState } from '../../session/sidebar-widget.js';
import type { PreviewTerminal } from '../../preview/terminal.js';

export interface DashboardChordRuntimeDeps<Pane> {
  focusBrowser: () => void;
  focusObsidian: () => void;
  reopenScratch: () => void;
  toggleBell: () => void;
  refreshSessionCardsInto: () => void;
  focusSessionsSidebar: () => void;
  getSessionsSidebarState: () => SessionsSidebarState | undefined;
  focusSessionSidebarCursor: (state: SessionsSidebarState | undefined) => { sessionId?: string | null };
  cycleSessionSidebarCursor: (state: SessionsSidebarState, delta: 1 | -1) => { sessionId?: string | null };
  markNotificationRead: (sessionId: string) => void;
  closeFocusedPane: () => boolean;
  focusedPaneLabel: () => string;
  onPaneClosed: (message: string) => void;
  reopenPanes: () => void;
  onPanesReopened: () => void;
  getOpenPaneModalTarget: () => Pane | 'input';
  openPaneModal: (pane: Pane) => void;
  toggleLogZoom: () => void | Promise<void>;
  openPreviewTerminal: () => void;
  getPreviewTerminal: () => PreviewTerminal | null;
  getTerminalExpanded: () => boolean;
  setTerminalExpanded: (next: boolean) => void;
  resetPreviewTerminalDims: () => void;
  focusPreviewAfterTerminalExpand: () => void;
  onPreviewTerminalExpandChanged: (expanded: boolean) => void;
  onMissingPreviewTerminal: () => void;
  toggleAllFolds?: () => void;
}

export function createDashboardChordRuntime<Pane>(
  deps: DashboardChordRuntimeDeps<Pane>,
): ReturnType<typeof createDashboardChordActionRunner> {
  return createDashboardChordActionRunner({
    focusBrowser: deps.focusBrowser,
    focusObsidian: deps.focusObsidian,
    reopenScratch: deps.reopenScratch,
    toggleBell: deps.toggleBell,
    focusSessions: () => {
      deps.refreshSessionCardsInto();
      deps.focusSessionsSidebar();
      const focused = deps.focusSessionSidebarCursor(deps.getSessionsSidebarState());
      if (focused.sessionId) {
        deps.markNotificationRead(focused.sessionId);
        deps.refreshSessionCardsInto();
      }
    },
    cycleSessions: (delta) => {
      deps.refreshSessionCardsInto();
      const state = deps.getSessionsSidebarState();
      if (state) {
        const landed = deps.cycleSessionSidebarCursor(state, delta);
        if (landed.sessionId) {
          deps.markNotificationRead(landed.sessionId);
          deps.refreshSessionCardsInto();
        }
      }
      deps.focusSessionsSidebar();
    },
    closePane: () => {
      const closed = deps.closeFocusedPane();
      if (closed) {
        deps.onPaneClosed(deps.focusedPaneLabel());
        return true;
      }
      return false;
    },
    reopenPanes: () => {
      deps.reopenPanes();
      deps.onPanesReopened();
    },
    openPaneModal: () => {
      const pane = deps.getOpenPaneModalTarget();
      if (pane !== 'input') deps.openPaneModal(pane);
    },
    toggleLogZoom: deps.toggleLogZoom,
    openPreviewTerminal: deps.openPreviewTerminal,
    toggleAllFolds: deps.toggleAllFolds,
    togglePreviewTerminalExpand: () => {
      const term = deps.getPreviewTerminal();
      if (term !== null && term.isAlive) {
        const nextExpanded = !deps.getTerminalExpanded();
        deps.setTerminalExpanded(nextExpanded);
        deps.resetPreviewTerminalDims();
        deps.focusPreviewAfterTerminalExpand();
        deps.onPreviewTerminalExpandChanged(nextExpanded);
      } else {
        deps.onMissingPreviewTerminal();
      }
    },
  });
}
