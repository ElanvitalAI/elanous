// els herdr host (ELS-ONE-SPACE ④) — the panes of the herdr running on this machine, brought into the same list as a
// remote host named `herdr`: `els ls` / the sidetab show `⇄herdr <title>` rows with the shared status words, `els read
// herdr:w1/t2/p2` reads the screen, `els do herdr:w1/t2/p2 <text>` types a line (read first, input only through `do`).
// It answers in the shape of an els read window (`/els/ls`, `/els/read`, POST `/els/do`) so `createFederation` needs no
// herdr special case; nothing here is served to other hosts (the local HTTP window never forwards to herdr).
//
// Ids: herdr's `w1:p2` / `w1:t2` carry a colon, which an els address cannot; the address is `herdr:w1/t2/p2` (ws, tab and
// pane without the workspace prefix) and is mapped back to `w1:p2` for the CLI. A pane whose id does not fit that
// shape (pane id not prefixed by its workspace id) is left out, not guessed.
import { clean, MAX_DO_CHARS } from './core.js';
import { asRecord } from '../primitives/guards.js';
import { defaultHerdrCliRunner, type HerdrCliRunner } from '../pty-shell/herdr-prompt.js';
import type { FederatedHost, HostRegistry } from './hosts.js';

export const HERDR_HOST_NAME = 'herdr';

// 출처: same bounds as the TUI portal (src/tui/sidetab/herdr-portal.ts): a local herdr answers a CLI call in well under 2 s.
const SNAPSHOT_TIMEOUT_MS = 2_000;
const PANE_TIMEOUT_MS = 2_000;

type PaneState = 'working' | 'blocked' | 'idle' | 'done' | 'unknown';
const STATE_OF: Readonly<Record<string, PaneState>> = { working: 'working', busy: 'working', blocked: 'blocked', idle: 'idle', done: 'done' };

export interface HerdrListedPane { ws: string; tab: string; pane: string; title: string; cwd: string; state: PaneState }

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const after = (id: string, workspace: string): string | undefined => id.startsWith(`${workspace}:`) && id.length > workspace.length + 1 ? id.slice(workspace.length + 1) : undefined;

/** `herdr api snapshot` JSON → els panes. Shape of herdr 0.9: `result.snapshot.{workspaces,tabs,panes}` (older: `result.panes`). */
export function herdrSnapshotPanes(json: unknown): { panes: HerdrListedPane[]; skipped: number } | undefined {
  const result = asRecord(asRecord(json, { fallback: 'undefined' })?.result, { fallback: 'undefined' });
  const snapshot = asRecord(result?.snapshot, { fallback: 'undefined' }) ?? result;
  if (!snapshot || !Array.isArray(snapshot.panes)) return undefined;
  const labels = new Map<string, string>();
  for (const row of Array.isArray(snapshot.workspaces) ? snapshot.workspaces : []) {
    const ws = asRecord(row, { fallback: 'undefined' });
    if (ws && text(ws.workspace_id)) labels.set(text(ws.workspace_id), text(ws.label));
  }
  const panes: HerdrListedPane[] = [];
  let skipped = 0;
  for (const row of snapshot.panes) {
    const pane = asRecord(row, { fallback: 'undefined' });
    const workspace = text(pane?.workspace_id) || text(pane?.pane_id).split(':')[0] || '';
    const paneId = after(text(pane?.pane_id), workspace);
    const tabId = after(text(pane?.tab_id), workspace);
    if (!pane || !workspace || !paneId || !tabId) { skipped++; continue; }
    const label = labels.get(workspace);
    const name = text(pane.display_agent) || text(pane.title) || text(pane.terminal_title_stripped) || text(pane.terminal_title) || text(pane.agent) || paneId;
    panes.push({ ws: workspace, tab: tabId, pane: paneId, title: label ? `${label} · ${name}` : name, cwd: text(pane.cwd),
      state: STATE_OF[text(pane.agent_status).trim().toLowerCase()] ?? 'unknown' });
  }
  return { panes, skipped };
}

/** The herdr id of an els-side `ws/tab/pane` (`w1/t2/p2` → pane `w1:p2`), or undefined when the address is not herdr-shaped. */
function herdrPaneId(address: string): string | undefined {
  const [ws, tab, pane, ...rest] = address.split('/');
  return ws && tab && pane && rest.length === 0 ? `${ws}:${pane}` : undefined;
}

/** Look the address up in a fresh snapshot: workspace, tab AND pane must all match (a wrong tab is an unknown pane, never «close enough»). */
const locate = (panes: readonly HerdrListedPane[], address: string): HerdrListedPane | undefined => {
  const [ws, tab, pane] = address.split('/');
  return panes.find((row) => row.ws === ws && row.tab === tab && row.pane === pane);
};

const json = (status: number, body: unknown): { status: number; body: unknown } => ({ status, body });

/** The transport pair for `createFederation`, answering only for the herdr host; any other host goes to `next`. */
export function withHerdrHost(deps: {
  readonly env?: NodeJS.ProcessEnv;
  readonly run?: HerdrCliRunner;
  readonly registry: HostRegistry;
  readonly fetchJson: (host: FederatedHost, path: string) => Promise<{ status: number; body: unknown }>;
  readonly postJson?: (host: FederatedHost, path: string, payload: unknown) => Promise<{ status: number; body: unknown }>;
}): { registry: HostRegistry; fetchJson: NonNullable<typeof deps.fetchJson>; postJson: NonNullable<typeof deps.postJson> } {
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultHerdrCliRunner(env);
  const enabled = env.HERDR_ENV === '1' && !deps.registry.hosts.some((host) => host.name === HERDR_HOST_NAME);
  const registry: HostRegistry = enabled
    ? { ...deps.registry, hosts: [...deps.registry.hosts, { name: HERDR_HOST_NAME, baseUrl: 'herdr:', kind: 'herdr' }] }
    : deps.registry;

  const snapshot = async (): Promise<{ panes: HerdrListedPane[]; skipped: number } | string> => {
    const answer = await run(['api', 'snapshot'], SNAPSHOT_TIMEOUT_MS);
    if (answer.code !== 0) return answer.stderr.trim().slice(0, 160) || `herdr exited with rc=${answer.code ?? 'unknown'}`;
    try { return herdrSnapshotPanes(JSON.parse(answer.stdout)) ?? 'herdr snapshot has no panes array'; }
    catch { return 'herdr snapshot is not JSON'; }
  };

  const fetchJson: typeof deps.fetchJson = async (host, path) => {
    if (host.kind !== 'herdr') return deps.fetchJson(host, path);
    const url = new URL(path, 'http://herdr.local');
    if (url.pathname === '/els/ls') {
      const listed = await snapshot();
      if (typeof listed === 'string') return json(502, { error: listed });
      return json(200, { host: HERDR_HOST_NAME, panes: listed.panes });
    }
    if (url.pathname === '/els/read') {
      const address = url.searchParams.get('address') ?? '';
      const id = herdrPaneId(address);
      if (!id) return json(400, { error: 'address must be ws/tab/pane of this host' });
      const known = await snapshot();
      if (typeof known === 'string') return json(502, { error: known });
      if (!locate(known.panes, address)) return json(404, { error: 'unknown pane' });
      const read = await run(['pane', 'read', id, '--source', 'visible', '--format', 'text'], PANE_TIMEOUT_MS);
      if (read.code !== 0) return json(/not found|unknown/i.test(read.stderr) ? 404 : 502, { error: read.stderr.trim().slice(0, 160) || 'herdr pane read failed' });
      return json(200, { screen: read.stdout });
    }
    return json(404, { error: 'not found' });
  };

  const postJson: NonNullable<typeof deps.postJson> = async (host, path, payload) => {
    if (host.kind !== 'herdr') {
      if (!deps.postJson) return json(405, { error: 'remote input is not available here' });
      return deps.postJson(host, path, payload);
    }
    if (path !== '/els/do') return json(404, { error: 'not found' });
    const request = asRecord(payload, { fallback: 'undefined' });
    const address = text(request?.address);
    const id = herdrPaneId(address);
    // Control characters are dropped exactly as core.do does (same `clean`): one line, no escapes into the foreign terminal.
    const line = clean(text(request?.text));
    const from = clean(text(request?.from)).slice(0, 64) || 'unknown';
    if (!id || !line) return json(400, { error: 'need address (ws/tab/pane of this host) and a non-empty text' });
    if (line.length > MAX_DO_CHARS) return json(400, { error: `text is longer than ${MAX_DO_CHARS} chars` });
    // Fail closed, like core.do: the state is read fresh right before typing.
    const listed = await snapshot();
    if (typeof listed === 'string') return json(502, { error: `cannot check whether ${id} is busy, not sent: ${listed}` });
    const target = locate(listed.panes, address);
    if (!target) return json(404, { error: 'unknown pane' });
    // Only a pane that says it is idle (or done) is typed into. working / blocked would be overwritten (herdr has no queue);
    // `unknown` — no agent_status, common on plain shell panes — is not a reading, so nothing is sent (fail closed).
    if (target.state !== 'idle' && target.state !== 'done') return json(409, { error: `${id} is ${target.state}, not sent (herdr has no queue: retry when it is idle)` });
    const typed = await run(['pane', 'send-text', id, `⇢ ${from} · ${line}`], PANE_TIMEOUT_MS);
    if (typed.code !== 0) return json(409, { error: typed.stderr.trim().slice(0, 160) || 'herdr send-text failed' });
    const submitted = await run(['pane', 'send-keys', id, 'enter'], PANE_TIMEOUT_MS);
    if (submitted.code !== 0) return json(409, { error: `typed but not submitted: ${submitted.stderr.trim().slice(0, 120) || 'herdr send-keys failed'}` });
    return json(200, { message: `els do: sent to ${HERDR_HOST_NAME}:${id} (${line.length} chars)` });
  };

  return { registry, fetchJson, postJson };
}
