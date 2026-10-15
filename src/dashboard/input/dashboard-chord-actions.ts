import type { Key } from '../../tui.js';

export type DashboardChordAction =
  | { kind: 'focus-browser' }
  | { kind: 'focus-obsidian' }
  | { kind: 'reopen-scratch' }
  | { kind: 'toggle-bell' }
  | { kind: 'focus-sessions' }
  | { kind: 'cycle-sessions'; delta: 1 | -1 }
  | { kind: 'close-pane' }
  | { kind: 'reopen-panes' }
  | { kind: 'open-pane-modal' }
  | { kind: 'toggle-log-zoom' }
  | { kind: 'open-preview-terminal' }
  | { kind: 'toggle-preview-terminal-expand' }
  | { kind: 'toggle-all-folds' };

export function matchDashboardChordAction(key: Key): DashboardChordAction | null {
  if (key.ctrl && (key.name === 'w' || key.name === 'ㅈ')) {
    return { kind: 'focus-browser' };
  }
  if (key.ctrl && (key.name === 'o' || key.name === 'ㅐ')) {
    return { kind: 'focus-obsidian' };
  }
  if (key.ctrl && (key.name === 's' || key.name === 'ㄴ')) {
    return { kind: 'reopen-scratch' };
  }
  if (!key.ctrl && (key.name === 'b' || key.name === 'ㅠ')) {
    return { kind: 'toggle-bell' };
  }
  if (key.name === 'S' || key.name === 'ㄴ') {
    return { kind: 'focus-sessions' };
  }
  if (key.name === 'n' || key.name === 'ㅜ') {
    return { kind: 'cycle-sessions', delta: 1 };
  }
  if (key.name === 'p' || key.name === 'ㅔ') {
    return { kind: 'cycle-sessions', delta: -1 };
  }
  if (key.name === 'x' || key.name === 'ㅌ') {
    return { kind: 'close-pane' };
  }
  if (key.name === 'o' || key.name === 'ㅐ') {
    return { kind: 'reopen-panes' };
  }
  if (key.name === 'm' || key.name === 'ㅡ') {
    return { kind: 'open-pane-modal' };
  }
  if (key.name === 'z' || key.name === 'ㅋ') {
    return { kind: 'toggle-log-zoom' };
  }
  if (key.name === 't' || key.name === 'ㅅ') {
    return { kind: 'open-preview-terminal' };
  }
  if (key.name === 'e' || key.name === 'ㄷ') {
    return { kind: 'toggle-preview-terminal-expand' };
  }
  // #19 — the log-pane `F` bulk fold toggle, reachable from the input (plain `F` types a letter there).
  if (!key.ctrl && (key.name === 'f' || key.name === 'ㄹ')) {
    return { kind: 'toggle-all-folds' };
  }
  return null;
}

export interface DashboardChordActionRunnerDeps<Pane> {
  focusBrowser: () => void;
  focusObsidian: () => void;
  reopenScratch: () => void;
  toggleBell: () => void;
  focusSessions: () => void;
  cycleSessions: (delta: 1 | -1) => void;
  closePane: () => boolean;
  reopenPanes: () => void;
  openPaneModal: () => void;
  toggleLogZoom: () => void | Promise<void>;
  openPreviewTerminal: () => void;
  togglePreviewTerminalExpand: () => void;
  toggleAllFolds?: () => void;
}

export function createDashboardChordActionRunner<Pane>(
  deps: DashboardChordActionRunnerDeps<Pane>,
): (action: DashboardChordAction) => void | Promise<void> {
  return async (action) => {
    switch (action.kind) {
      case 'focus-browser':
        deps.focusBrowser();
        return;
      case 'focus-obsidian':
        deps.focusObsidian();
        return;
      case 'reopen-scratch':
        deps.reopenScratch();
        return;
      case 'toggle-bell':
        deps.toggleBell();
        return;
      case 'focus-sessions':
        deps.focusSessions();
        return;
      case 'cycle-sessions':
        deps.cycleSessions(action.delta);
        return;
      case 'close-pane':
        deps.closePane();
        return;
      case 'reopen-panes':
        deps.reopenPanes();
        return;
      case 'open-pane-modal':
        deps.openPaneModal();
        return;
      case 'toggle-log-zoom':
        await deps.toggleLogZoom();
        return;
      case 'open-preview-terminal':
        deps.openPreviewTerminal();
        return;
      case 'toggle-preview-terminal-expand':
        deps.togglePreviewTerminalExpand();
        return;
      case 'toggle-all-folds':
        deps.toggleAllFolds?.();
        return;
    }
  };
}
