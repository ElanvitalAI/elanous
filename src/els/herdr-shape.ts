// els JSON in herdr's words: `{ result: { panes | workspaces | tabs: [...] } }` with *_id fields, so scripts written for
// `herdr pane list` / `workspace list` / `tab list` read els output unchanged. Ids are els ids (wXXXX / tXXXX / pXXXX),
// not herdr's `w1:p1`; the full address (`host:ws/tab/pane`) rides along as `address`.

import { parseAddress } from './address.js';

interface ListedPane { address?: string; workspace?: string; tab?: string; pane?: string; title?: string; cwd?: string; state?: string;
  host?: string; reach?: string; command?: string[]; build?: unknown }
interface ListedWorkspace { id?: string; name?: string; rootCwd?: string; host?: string }
interface ListedTab { id?: string; workspaceId?: string; label?: string; focusPaneId?: string }
interface Listed { hosts?: unknown; panes?: ListedPane[]; workspaces?: ListedWorkspace[]; tabs?: ListedTab[] }

const wsIdOf = (row: ListedPane): string => {
  const parsed = row.address ? parseAddress(row.address) : undefined;
  return parsed?.ws ?? '';
};

export function herdrPanes(listed: Listed, workspace?: string): object {
  const panes = (listed.panes ?? [])
    .map((row) => ({ pane_id: row.pane ?? '', tab_id: row.tab ?? '', workspace_id: wsIdOf(row), workspace: row.workspace ?? '',
      title: row.title ?? '', cwd: row.cwd ?? '', state: row.state ?? '', host: row.host ?? '', reach: row.reach ?? '',
      address: row.address ?? '', build: row.build }))
    .filter((row) => !workspace || row.workspace_id === workspace || row.workspace === workspace);
  return { result: { panes } };
}

export function herdrWorkspaces(listed: Listed): object {
  return { result: { workspaces: (listed.workspaces ?? []).map((ws) => ({ workspace_id: ws.id ?? '', name: ws.name ?? '', cwd: ws.rootCwd ?? '', host: ws.host ?? '' })) } };
}

export function herdrTabs(listed: Listed, workspace?: string): object {
  const tabs = (listed.tabs ?? [])
    .filter((tab) => !workspace || tab.workspaceId === workspace)
    .map((tab) => ({ tab_id: tab.id ?? '', workspace_id: tab.workspaceId ?? '', label: tab.label ?? '', focus_pane_id: tab.focusPaneId ?? '' }));
  return { result: { tabs } };
}

/** `els new` answer ({address, pane, ptyId, cwd}) in herdr's creation shape (`.result.pane.pane_id`). */
export function herdrCreated(created: { address: string; pane: string; ptyId: string; cwd: string }): object {
  const [ws = '', tab = ''] = created.address.split('/');
  return { result: { workspace: { workspace_id: ws }, tab: { tab_id: tab, workspace_id: ws }, root_pane: { pane_id: created.pane, tab_id: tab, workspace_id: ws, cwd: created.cwd },
    pane: { pane_id: created.pane, tab_id: tab, workspace_id: ws, cwd: created.cwd } } };
}
