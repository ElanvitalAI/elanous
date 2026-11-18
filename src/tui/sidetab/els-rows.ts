// TUI sidetab ⇄ els server (ELS-DESKTOP-SIDETAB-SUBSCRIBE; the «desktop» in the lane name is historic — this is the
// eln TUI side panel). The panel only READS the els list: this host's owner over its Unix socket plus the registered
// remote hosts, through the same federation `els ls` uses. It never starts a server and never writes the journal, so
// closing the panel leaves the server and every pane running. A server that does not answer yields no rows (the
// panel stays what it was); a remote host that does not answer is one row marked ✕.
import { STATUS } from '../../els/status-vocab.js';
import type { SidetabAgentState, SidetabRow } from '../../sidetab-core/model.js';

interface ListedPane { address?: unknown; pane?: unknown; title?: unknown; state?: unknown; host?: unknown; reach?: unknown }
interface ListedHost { name?: unknown; reach?: unknown; reason?: unknown }

const text = (value: unknown): string => typeof value === 'string' ? value : '';

const AGENT_STATE: Readonly<Record<string, SidetabAgentState>> = { working: 'working', idle: 'idle', blocked: 'blocked', done: 'done' };

/** Pane state → the sidetab's own row fields. `exited` keeps the process badge; the rest is the agent state word. */
function stateFields(state: string): Pick<SidetabRow, 'badge' | 'agentState'> {
  if (state === 'exited') return { badge: 'exited' };
  const agentState = AGENT_STATE[state];
  return agentState ? { badge: state === 'working' ? 'busy' : 'idle', agentState } : { badge: 'unknown' };
}

/** `els ls` JSON (federated) → sidetab rows: ⇄host before a remote pane, one ✕ row per host that does not answer. */
export function elsRowsFromList(listJson: string, localHost: string): SidetabRow[] {
  let parsed: unknown;
  try { parsed = JSON.parse(listJson); } catch { return []; }
  // null, a number, a string or an array is valid JSON but not an els list: no rows, no throw.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const listed = parsed as { hosts?: unknown; panes?: unknown };
  const rows: SidetabRow[] = [];
  for (const raw of Array.isArray(listed.panes) ? listed.panes as (ListedPane | null)[] : []) {
    if (!raw || typeof raw !== 'object') continue;
    const address = text(raw.address);
    if (!address) continue;
    const host = text(raw.host);
    const remote = text(raw.reach) === 'up';
    // A child tab's title already carries its ↳ indent and status mark; the row shows it as the els server wrote it.
    const title = text(raw.title) || text(raw.pane);
    rows.push({ id: `els:${address}`, kind: 'els', label: remote ? `⇄${host} ${title}` : title, ...stateFields(text(raw.state)),
      ...(remote ? { remoteHost: host, host } : {}) });
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
