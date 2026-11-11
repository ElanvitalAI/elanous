// ── Working-directory workspace types ──
// The dashboard is now always in the working-dir workspace — Session 10
// retired the legacy skill-workspace enum after Skill view (V3) absorbed
// its functionality. Plugins remain global and swap the active layout
// via the plugin host rather than a workspace toggle.

/** Layouts inside the working-dir workspace. Shared state (cwd,
 *  cursor, selection) persists across view switches.
 *  V1: Normal    — browser + preview + scratch, log    (default)
 *  V2: Obsidian  — Working | Preview | Obsidian / Log | Scratch
 *  V3: Skill     — Skill Browser | Skill File | Preview / Log | Scratch | Working Browser
 *  V4: Scheduler — status lanes / scheduler + inspector / log + scratch
 *  Session 9 renumbered from the earlier Obsidian-first layout and
 *  dropped the slim `browser | log` variant — the dense Normal view
 *  is now the default and the Skill view ingests what used to live
 *  in a separate skill workspace. */
export type WorkingDirView = 1 | 2 | 3 | 4;

/** Which UI element owns the keyboard. `input` is the default — pane
 *  focus is only reached by an explicit transition (Escape on an empty
 *  input, or a focus cycle key). Shortcuts scoped to a pane fire only
 *  when that pane is the focus.
 *
 *  The `browser` pane is the unified folders+files list (yazi-style):
 *  Enter on a folder cd's into it, Enter on a file attaches it.
 *
 *  The `scratch` pane is a transient ANSI buffer alongside preview in
 *  V2 — image previews, ephemeral debug dumps, etc. Cleared by
 *  whatever writes to it next. */
// Surface-unification v2.2 V2.2-5 Part 2 (2026-05-11) — `scheduler-*`
// PaneFocus variants retired, then restored: the Scheduler view
// (WorkingDirView 4) remains active and `src/views/pane-policy.ts`
// maps its lanes to these pane foci.
export type PaneFocus =
  | 'input' | 'browser' | 'obsidian' | 'preview' | 'scratch' | 'log'
  | 'skill-browser' | 'skill-file'
  | 'agent-roster' | 'agent-detail' | 'agent-log'
  | 'debug-events' | 'debug-detail' | 'debug-stack' | 'debug-prompts'
  | 'scheduler-board' | 'scheduler-inspector' | 'scheduler-paused'
  | 'scheduler-active' | 'scheduler-ready' | 'scheduler-draft'
  | 'sessions-sidebar'
  | `plugin:${string}`;

/** Which browser the Preview pane mirrors. Valid source values
 *  depend on the active view; `smart` works everywhere and tracks
 *  the last-focused browser.
 *    - 'working'  — always the Working browser
 *    - 'obsidian' — (V2 only) always the Obsidian browser
 *    - 'skill'    — (V3 only) always the Skill File list
 *    - 'smart'    — follow whichever browser was focused last
 *  The dashboard resets invalid combinations (e.g. `obsidian` in V3)
 *  back to `smart` on view switch. */
export type PreviewSource = 'working' | 'obsidian' | 'skill' | 'smart';

/** File list sort mode. Users cycle through these with a toggle key
 *  inside the file pane. */
export type FileSortMode = 'name' | 'mtime' | 'type' | 'size';

export const FILE_SORT_ORDER: FileSortMode[] = ['name', 'mtime', 'type', 'size'];

/** Cycle to the next sort mode. Wraps. */
export function nextSortMode(current: FileSortMode): FileSortMode {
  const i = FILE_SORT_ORDER.indexOf(current);
  return FILE_SORT_ORDER[(i + 1) % FILE_SORT_ORDER.length]!;
}
