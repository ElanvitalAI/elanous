// Browser-pane help overlay — yazi-style `~` action.
//
// Builds the lines and hands them to the dashboard's `showHelpModal`
// dep — which is itself a thin wrapper
// over `showTransientTerminalModal` (group: 'browser-help', auto-
// dismiss after ttlMs).
//
// The yazi precedent (yazi-fm/src/help/help.rs:14-37 +
// yazi-fm/src/help/bindings.rs:14-51) renders 3 columns (key · run ·
// desc). We collapse to "key  desc" pairs because (a) we don't have
// machine-readable run names, and (b) the existing help modal style
// in this project is a single ANSI-styled lines list.

export interface BrowserHelpRuntimeDeps {
  termSize(): { cols: number; rows: number };
  keyLabel(key: string, desc: string): string;
  sectionLabel(title: string): string;
  muted(text: string): string;
  showHelpModal(spec: {
    title: string;
    lines: string[];
    termCols: number;
    termRows: number;
    ttlMs: number;
    group: string;
  }): void;
}

export interface BrowserHelpRuntime {
  /** Render the help overlay. Replaces any existing 'browser-help'
   *  modal — pressing `~` twice shows the same overlay, doesn't
   *  stack. */
  showHelp(): void;
}

export const BROWSER_HELP_TTL_MS = 10_000;
export const BROWSER_HELP_GROUP = 'browser-help';

export function createBrowserHelpRuntime(
  deps: BrowserHelpRuntimeDeps,
): BrowserHelpRuntime {
  return {
    showHelp() {
      const { cols: tc, rows: tr } = deps.termSize();
      const k = deps.keyLabel;
      const s = deps.sectionLabel;
      const m = deps.muted;
      const lines: string[] = [
        s('Navigation'),
        k('j / ↓',     'cursor down'),
        k('k / ↑',     'cursor up'),
        k('h / ←',     'parent dir'),
        k('l / →',     'enter dir at cursor'),
        k('Enter',     'cd folder · attach file'),
        k('< ',        'parent dir (jump)'),
        '',
        s('File ops'),
        k('e',         'edit in $EDITOR (full-screen nvim/vim)'),
        k('a',         'attach selection to chat input'),
        k('Space',     'toggle file selection'),
        k('A',         'select / deselect all'),
        k('c',         'copy absolute path to log'),
        k('t',         'open transfer modal'),
        k('.',         'toggle hidden files'),
        k('s',         'cycle sort mode'),
        '',
        s('Yazi-style chords ( , prefix · 700 ms window )'),
        k(', v',       'launch $EDITOR (nvim) full-screen'),
        k(', s',       'LLM summarize this file → popup'),
        k(', ?',       'this help'),
        '',
        s('Find'),
        k('Ctrl+T',    'fuzzy file finder (fd)'),
        k('Ctrl+P',    'fuzzy file finder (alias)'),
        k('Alt+C',     'fuzzy directory finder'),
        '',
        s('Misc'),
        k('Ctrl+W',    'promote folder to session working dir'),
        k('Esc',       'exit remote-mode (when SSH-attached)'),
        k('~',         'show this help (auto-dismiss 10 s)'),
        '',
        m('Korean IME aliases handled automatically (ㅍ=v, ㄴ=s, ㅁ=, …)'),
        m('Mirrors yazi keymap conventions'),
      ];
      deps.showHelpModal({
        title: 'File browser keybindings',
        lines,
        termCols: tc,
        termRows: tr,
        ttlMs: BROWSER_HELP_TTL_MS,
        group: BROWSER_HELP_GROUP,
      });
    },
  };
}
