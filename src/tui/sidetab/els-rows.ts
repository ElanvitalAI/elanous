// TUI sidetab ⇄ els server (ELS-DESKTOP-SIDETAB-SUBSCRIBE; the «desktop» in the lane name is historic — this is the
// eln TUI side panel). The panel only READS the els list: this host's owner over its Unix socket plus the registered
// remote hosts, through the same federation `els ls` uses. It never starts a server and never writes the journal, so
// closing the panel leaves the server and every pane running. A server that does not answer yields no rows (the
// panel stays what it was); a remote host that does not answer is one row marked ✕.
import { parseAddress } from '../../els/address.js';
import { STATUS } from '../../els/status-vocab.js';
import type { SidetabAgentState, SidetabRow } from '../../sidetab-core/model.js';

interface ListedPane { stalled?: unknown; address?: unknown; workspace?: unknown; pane?: unknown; title?: unknown; state?: unknown; host?: unknown; reach?: unknown }
interface ListedHost { name?: unknown; reach?: unknown; reason?: unknown }

const text = (value: unknown): string => typeof value === 'string' ? value : '';

const AGENT_STATE: Readonly<Record<string, SidetabAgentState>> = { working: 'working', idle: 'idle', blocked: 'blocked', done: 'done', stalled: 'stalled' };

/** Pane state → the sidetab's own row fields. `exited` keeps the process badge; the rest is the agent state word. */
function stateFields(state: string): Pick<SidetabRow, 'badge' | 'agentState'> {
  if (state === 'exited') return { badge: 'exited' };
  const agentState = AGENT_STATE[state];
  return agentState ? { badge: state === 'working' || state === 'stalled' ? 'busy' : 'idle', agentState } : { badge: 'unknown' };
}

const named = (value: unknown, key: string): Map<string, string> => new Map((Array.isArray(value) ? value as Record<string, unknown>[] : [])
  .flatMap((row) => row && typeof row === 'object' && text(row.id) && text(row[key]) ? [[text(row.id), text(row[key])] as const] : []));

/**
 * A header's status is its most urgent descendant, with the SAME precedence as markOf in src/els/space-tabs-view.ts
 * (ELS-TAB-STATE-BADGE): failed and blocked (approval wait) outrank stalled, stalled outranks working, then idle, then done.
 * So a header over a stalled-working descendant shows stalled, and over a failed/blocked descendant shows blocked (the sidetab
 * has no separate failed state); a stalled pane never hides a failed or blocked pane under the same header. All exited stays `exited`.
 * (A host that does not answer has no panes here: it is the one ✕ row below.)
 */
function summaryState(panes: readonly TreePane[]): string {
  const states = panes.map((pane) => pane.state);
  if (states.includes('failed') || states.includes('blocked')) return 'blocked';
  if (panes.some((pane) => pane.stalled)) return 'stalled';
  return ['working', 'idle', 'done'].find((word) => states.includes(word)) ?? (states.every((state) => state === 'exited') ? 'exited' : 'unknown');
}

interface TreePane { readonly address: string; readonly title: string; readonly state: string; readonly stalled: boolean }
interface TreeTab { readonly label: string; readonly panes: TreePane[] }
interface TreeWorkspace { readonly name: string; readonly tabs: Map<string, TreeTab> }
interface TreeHost { readonly remote: boolean; readonly workspaces: Map<string, TreeWorkspace> }

/** `els ls` JSON (federated) → the els TREE as sidetab rows, one row per node, indented by depth:
 *  [⇄host] → workspace → tab → pane (a remote host is its own subtree one level deeper; this host has no header).
 *  A pane row keeps its `els:<address>` id, so click / send / read still resolve it; a header row has no address.
 *  One ✕ row per host that does not answer. Order is the server's (workspaces, tabs, panes as a person set them). */
export function elsRowsFromList(listJson: string, localHost: string): SidetabRow[] {
  let parsed: unknown;
  try { parsed = JSON.parse(listJson); } catch { return []; }
  // null, a number, a string or an array is valid JSON but not an els list: no rows, no throw.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const listed = parsed as { hosts?: unknown; panes?: unknown; workspaces?: unknown; tabs?: unknown };
  const workspaceNames = named(listed.workspaces, 'name');
  const tabLabels = named(listed.tabs, 'label');
  const tree = new Map<string, TreeHost>();
  for (const raw of Array.isArray(listed.panes) ? listed.panes as (ListedPane | null)[] : []) {
    if (!raw || typeof raw !== 'object') continue;
    const address = text(raw.address);
    const parts = address ? parseAddress(address) : undefined;
    if (!address || !parts) continue;
    const host = text(raw.host);
    const hostNode = tree.get(host) ?? { remote: text(raw.reach) === 'up', workspaces: new Map<string, TreeWorkspace>() };
    tree.set(host, hostNode);
    // The names and labels in the list are this host's own: a remote id that happens to equal a local one is not renamed by them.
    const own = !hostNode.remote;
    const workspace = hostNode.workspaces.get(parts.ws) ?? { name: (own ? workspaceNames.get(parts.ws) : undefined) ?? (text(raw.workspace) || parts.ws), tabs: new Map<string, TreeTab>() };
    hostNode.workspaces.set(parts.ws, workspace);
    const tab = workspace.tabs.get(parts.tab) ?? { label: (own ? tabLabels.get(parts.tab) : undefined) ?? parts.tab, panes: [] };
    workspace.tabs.set(parts.tab, tab);
    // A child tab's title already carries its ↳ indent and status mark; the row shows it as the els server wrote it.
    tab.panes.push({ address, title: text(raw.title) || text(raw.pane), state: text(raw.state), stalled: raw.stalled === true });
  }
  const rows: SidetabRow[] = [];
  const header = (id: string, label: string, depth: number, panes: readonly TreePane[], remoteHost: string | undefined): void => {
    rows.push({ id, kind: 'els', label: `${'  '.repeat(depth)}${label}`, nestDepth: depth, ...stateFields(summaryState(panes)),
      ...(remoteHost ? { remoteHost, host: remoteHost } : {}) });
  };
  for (const [host, hostNode] of tree) {
    const remoteHost = hostNode.remote ? host : undefined;
    const base = hostNode.remote ? 1 : 0;
    const panesOf = (workspace: TreeWorkspace) => [...workspace.tabs.values()].flatMap((tab) => tab.panes);
    if (hostNode.remote) header(`els-host:${host}`, `⇄${host}`, 0, [...hostNode.workspaces.values()].flatMap(panesOf), remoteHost);
    for (const [ws, workspace] of hostNode.workspaces) {
      header(`els-ws:${host}:${ws}`, workspace.name, base, panesOf(workspace), remoteHost);
      for (const [tabId, tab] of workspace.tabs) {
        header(`els-tab:${host}:${ws}/${tabId}`, tab.label, base + 1, tab.panes, remoteHost);
        for (const pane of tab.panes) {
          rows.push({ id: `els:${pane.address}`, kind: 'els', label: `${'  '.repeat(base + 2)}${pane.title}`, nestDepth: base + 2, ...stateFields(pane.stalled ? 'stalled' : pane.state),
            ...(remoteHost ? { remoteHost, host: remoteHost } : {}) });
        }
      }
    }
  }
  for (const raw of Array.isArray(listed.hosts) ? listed.hosts as (ListedHost | null)[] : []) {
    if (!raw || typeof raw !== 'object') continue;
    if (text(raw.reach) !== 'down') continue;
    const name = text(raw.name);
    // This host being down means no local server: the panel's normal «els off», not a broken remote.
    if (!name || name === localHost) continue;
    rows.push({ id: `els-host:${name}`, kind: 'els', label: `${STATUS.failed.mark} ⇄${name} · 연결 끊김`, badge: 'stale', remoteHost: name, host: name,
      status: text(raw.reason) });
  }
  return rows;
}

export interface ElsSubscribeDeps {
  /** The federated list: `createFederation(...).list()` in the TUI. */
  readonly list: () => Promise<{ exitCode: number; message: string }>;
  readonly localHost: string;
}

/** One poll. A refused or failed list is no rows (never a throw): the sidetab keeps its other sections. */
export async function fetchElsSidetabRows(deps: ElsSubscribeDeps): Promise<SidetabRow[]> {
  try {
    const answer = await deps.list();
    return answer.exitCode === 0 ? elsRowsFromList(answer.message, deps.localHost) : [];
  } catch { return []; }
}
