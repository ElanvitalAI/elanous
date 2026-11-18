import type { SpaceJournal } from './space.js';

export type TabClosePlan =
  | { readonly ok: true; readonly paneIds: readonly string[]; readonly next: SpaceJournal }
  | { readonly ok: false; readonly exitCode: 1 | 2; readonly message: string };

/** Plan a local tab closure without changing the journal or touching any PTY. */
export function planTabClose(journal: SpaceJournal, ref: unknown): TabClosePlan {
  if (typeof ref !== 'string' || !ref.trim()) return { ok: false, exitCode: 2, message: 'els tab close: tab id is required' };
  if (!journal.tabs.some(tab => tab.id === ref)) return { ok: false, exitCode: 1, message: `els tab close: unknown tab ${ref}` };
  return {
    ok: true,
    paneIds: journal.panes.filter(pane => pane.tabId === ref).map(pane => pane.id),
    next: { ...journal, tabs: journal.tabs.filter(tab => tab.id !== ref), panes: journal.panes.filter(pane => pane.tabId !== ref) },
  };
}
