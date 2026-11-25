// els federation (stage 2 + 5) — `els ls` and `els read` over this host's els server and the registered remote
// hosts, and the remote tab words (`do` · `new` · `close` · `attach`) when the address names another host. The local
// part is a request to the local owner (Unix socket); the remote part is HTTP on each host's window (`els serve
// --http`) — the owner THERE decides (its do-allow list, its audit) and owns the write. A host that does not answer
// stays in the list as down (`?`).

import { parsePaneSeatStatus, type PaneSeatStatus } from './seat-status.js';
import { formatAddress, parseAddress } from './address.js';
import type { ElsResult } from './core.js';
import type { FederatedHost, HostRegistry, HostRouteKind } from './hosts.js';
import type { ElsRequest } from './server.js';

export type HostReach = 'local' | 'up' | 'down';

export interface FederationDeps {
  readonly localHost: string;
  readonly askLocal: (request: ElsRequest) => Promise<ElsResult>;
  readonly registry: HostRegistry;
  /** GET `path` on `host`; rejects when the host cannot be reached in time. */
  readonly fetchJson: (host: FederatedHost, path: string) => Promise<{ status: number; body: unknown }>;
  /** POST `payload` to `path` on `host` (only `do` writes; the remote owner decides). */
  readonly postJson?: (host: FederatedHost, path: string, payload: unknown) => Promise<{ status: number; body: unknown }>;
  /** Remote-tab routes by kind (the seam: relay · vm plug in here). Absent `ssh` = the default built on postJson. */
  readonly routes?: Partial<Record<HostRouteKind, RemoteTabRoute>>;
}

/** One way to reach a host's owner for the remote tab words. Each call is one request and one answer; the owner
 *  THERE decides (allow list, audit) and owns the pane. `new` answers the created-pane JSON; `close` takes the
 *  host's own `ws/tab/pane` or pane id. */
export interface RemoteTabRoute {
  readonly kind: HostRouteKind;
  readonly newPane: (host: FederatedHost, payload: { ws: string; cwd: string; command: readonly string[]; title?: string; from: string; cols?: number; rows?: number }) => Promise<{ status: number; body: unknown }>;
  readonly closePane: (host: FederatedHost, payload: { address: string; from: string }) => Promise<{ status: number; body: unknown }>;
}

/** Stage 1 route (`ssh` — direct tailnet reach): POST on the host's tailnet window. */
export function tailnetWindowRoute(postJson: NonNullable<FederationDeps['postJson']>): RemoteTabRoute {
  return {
    kind: 'ssh',
    newPane: (host, payload) => postJson(host, '/els/new', payload),
    closePane: (host, payload) => postJson(host, '/els/close', payload),
  };
}

export function hostRoute(host: FederatedHost): HostRouteKind {
  return host.route ?? 'ssh';
}

interface RemotePane { ws: string; tab: string; pane: string; title: string; cwd: string; state: string; model?: string; size?: { cols: number; rows: number }; seat?: string | null; spaceCoordinator?: boolean; activityState?: string; kind?: string; build?: unknown; role?: 'coordinator';
  /** ELS-TAB-STATE-BADGE: decided once at the origin server; absent when that server is older (state then reads as before). */
  badge?: string; badgeLabel?: string; stalled?: boolean; lastEventAtMs?: number;
  /** SEAT-STATE-ENUM: the origin server's status codes, validated. */
  status?: PaneSeatStatus }

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The panes of a host's /els/ls answer, or undefined when the answer is malformed: no host name, or a pane whose
 *  `host:ws/tab/pane` address would not parse back to the same parts. */
function remotePanes(body: unknown, hostName: string): RemotePane[] | undefined {
  const record = body && typeof body === 'object' ? body as { host?: unknown; panes?: unknown } : undefined;
  if (!record || typeof record.host !== 'string' || record.host === '' || !Array.isArray(record.panes)) return undefined;
  const rows: RemotePane[] = [];
  for (const row of record.panes) {
    const pane = row && typeof row === 'object' ? row as Record<string, unknown> : undefined;
    if (!pane || !['ws', 'tab', 'pane'].every((key) => typeof pane[key] === 'string')) return undefined;
    const parts = { host: hostName, ws: pane.ws as string, tab: pane.tab as string, pane: pane.pane as string };
    const reparsed = parseAddress(formatAddress(parts));
    if (!reparsed || reparsed.ws !== parts.ws || reparsed.tab !== parts.tab || reparsed.pane !== parts.pane) return undefined;
    rows.push({ ws: parts.ws, tab: parts.tab, pane: parts.pane,
      title: String(pane.title ?? ''), cwd: String(pane.cwd ?? ''), state: String(pane.state ?? ''), build: pane.build,
      ...(typeof pane.model === 'string' ? { model: pane.model } : {}),
      ...(pane.size && typeof pane.size === 'object' && Number.isInteger((pane.size as { cols?: unknown }).cols) && Number.isInteger((pane.size as { rows?: unknown }).rows)
        ? { size: { cols: (pane.size as { cols: number }).cols, rows: (pane.size as { rows: number }).rows } } : {}),
      ...(pane.seat === null || (typeof pane.seat === 'string' && /^[A-Z][A-Z0-9_-]{0,63}$/.test(pane.seat)) ? { seat: pane.seat } : {}),
      ...(typeof pane.kind === 'string' && ['eln', 'codex', 'claude', 'grok', 'shell', 'other'].includes(pane.kind) ? { kind: pane.kind } : {}),
      ...(pane.role === 'coordinator' ? { role: 'coordinator' } : {}),
      ...(pane.spaceCoordinator === true ? { spaceCoordinator: true } : {}),
      ...(typeof pane.activityState === 'string' && ['working', 'idle', 'blocked', 'exited', 'done', 'unknown'].includes(pane.activityState) ? { activityState: pane.activityState } : {}),
      ...(typeof pane.badge === 'string' ? { badge: pane.badge } : {}),
      ...(typeof pane.badgeLabel === 'string' ? { badgeLabel: pane.badgeLabel } : {}),
      ...(typeof pane.stalled === 'boolean' ? { stalled: pane.stalled } : {}),
      ...(parsePaneSeatStatus(pane.status) ? { status: parsePaneSeatStatus(pane.status) } : {}),
      ...(typeof pane.lastEventAtMs === 'number' && Number.isFinite(pane.lastEventAtMs) ? { lastEventAtMs: pane.lastEventAtMs } : {}) });
  }
  return rows;
}

export function createFederation(deps: FederationDeps) {
  // A registered name equal to this host's name would list two hosts under one name and send its reads here.
  const hosts = deps.registry.hosts.filter((host) => host.name !== deps.localHost);
  const rejected = [...deps.registry.rejected,
    ...deps.registry.hosts.filter((host) => host.name === deps.localHost).map((host) => `${host.name}: is this host's own name`)];
  const registryNotes = (): Record<string, unknown> => ({ ...(rejected.length ? { rejectedHosts: rejected } : {}),
    ...(deps.registry.problem ? { hostsProblem: deps.registry.problem } : {}) });
  // A ref that names a remote host: `host:ws/tab/pane` (the federated address), or `host/pane` (stage 5 — a
  // registered host's name before one slash, the rest a bare pane ref on that host). The herdr marker host is never
  // remote here (its panes are read-only, answered from this machine).
  const remoteRef = (ref: string): { host: FederatedHost; pane: string } | undefined => {
    const address = parseAddress(ref);
    if (address) {
      if (address.host === '' || address.host === deps.localHost) return undefined;
      const host = hosts.find((row) => row.name === address.host && row.kind !== 'herdr');
      return host ? { host, pane: `${address.ws}/${address.tab}/${address.pane}` } : undefined;
    }
    const slash = ref.indexOf('/');
    if (slash < 1) return undefined;
    const name = ref.slice(0, slash);
    const pane = ref.slice(slash + 1);
    const host = hosts.find((row) => row.name === name && row.kind !== 'herdr');
    return host && pane !== '' && !pane.includes('/') ? { host, pane } : undefined;
  };
  const routes: Partial<Record<HostRouteKind, RemoteTabRoute>> = {
    ...(deps.postJson ? { ssh: tailnetWindowRoute(deps.postJson) } : {}), ...deps.routes };
  const routeFor = (host: FederatedHost): RemoteTabRoute | undefined => routes[hostRoute(host)];
  return {
    async list(): Promise<ElsResult> {
      const local = await deps.askLocal({ op: 'ls' });
      const hostRows: { name: string; reach: HostReach; reason?: string }[] = [];
      let localBody: { workspaces: unknown[]; tabs: unknown[]; panes: Record<string, unknown>[]; hqCoordinatorSeat?: string } = { workspaces: [], tabs: [], panes: [] };
      if (local.exitCode === 0) {
        localBody = JSON.parse(local.message) as typeof localBody;
        hostRows.push({ name: deps.localHost, reach: 'local' });
      } else {
        // No local server and nothing else to show: the stage-1 answer (start `els serve`), plus any hosts.json problem.
        if (hosts.length === 0) {
          const notes = [deps.registry.problem, ...rejected.map((note) => `els hosts: rejected ${note}`)].filter(Boolean);
          return notes.length ? { exitCode: local.exitCode, message: `${local.message}\n${notes.join('\n')}` } : local;
        }
        hostRows.push({ name: deps.localHost, reach: 'down', reason: local.message });
      }
      const panes: Record<string, unknown>[] = localBody.panes.map((row) => ({ ...row, host: deps.localHost, reach: 'local',
        address: `${deps.localHost}:${String(row.address)}` }));
      const remoteWorkspaces: { id: string; name: string; host: string; reach: 'up'; role: 'coordinator' }[] = [];
      const remote = await Promise.all(hosts.map(async (host) => {
        try {
          const answer = await deps.fetchJson(host, '/els/ls');
          const rows = answer.status === 200 ? remotePanes(answer.body, host.name) : undefined;
          const body = answer.body as { workspaces?: unknown } | null;
          const spaces = Array.isArray(body?.workspaces) ? body.workspaces : [];
          return rows ? { host, rows, spaces } : { host, error: answer.status === 200 ? 'malformed answer' : `http ${answer.status}` };
        } catch (error) {
          return { host, error: reason(error) };
        }
      }));
      for (const result of remote) {
        if ('error' in result) { hostRows.push({ name: result.host.name, reach: 'down', reason: result.error }); continue; }
        hostRows.push({ name: result.host.name, reach: 'up' });
        for (const raw of result.spaces) {
          if (!raw || typeof raw !== 'object') continue;
          const ws = raw as Record<string, unknown>;
          if (ws.role === 'coordinator' && typeof ws.id === 'string' && /^[a-zA-Z0-9._-]+$/.test(ws.id) && typeof ws.name === 'string') {
            remoteWorkspaces.push({ id: ws.id, name: ws.name, host: result.host.name, reach: 'up', role: 'coordinator' });
          }
        }
        for (const row of result.rows) {
          panes.push({ ...row, host: result.host.name, reach: 'up',
            address: formatAddress({ host: result.host.name, ws: row.ws, tab: row.tab, pane: row.pane }) });
        }
      }
      return { exitCode: 0, message: JSON.stringify({ hosts: hostRows, ...registryNotes(),
        workspaces: localBody.workspaces, remoteWorkspaces, tabs: localBody.tabs, panes,
        ...(typeof localBody.hqCoordinatorSeat === 'string' ? { hqCoordinatorSeat: localBody.hqCoordinatorSeat } : {}) }, null, 2) };
    },

    /** `els do <address> <text>`: local → this host's owner; remote → the owner on that host (never written from here). */
    async do(ref: string, text: string, from: string): Promise<ElsResult> {
      const address = parseAddress(ref);
      if (!address) return deps.askLocal({ op: 'do', pane: ref, text, from });
      if (address.host === '' || address.host === deps.localHost) {
        return deps.askLocal({ op: 'do', pane: address.pane, text, from, at: { ws: address.ws, tab: address.tab } });
      }
      const host = hosts.find((row) => row.name === address.host);
      if (!host) return { exitCode: 1, message: `els do: host ${address.host} is not registered in els/hosts.json` };
      if (!deps.postJson) return { exitCode: 1, message: 'els do: remote input is not available here' };
      try {
        // The receiving owner shows where the line came from: «<this host>/<seat>».
        const answer = await deps.postJson(host, '/els/do', { address: `${address.ws}/${address.tab}/${address.pane}`, text, from: `${deps.localHost}/${from}` });
        const body = answer.body && typeof answer.body === 'object' ? answer.body as { message?: unknown; error?: unknown } : {};
        if (answer.status === 200) return { exitCode: 0, message: typeof body.message === 'string' ? body.message : `els do: sent to ${ref}` };
        const why = typeof body.error === 'string' ? body.error : `http ${answer.status}`;
        // Nothing was typed on any non-200: the sender may retry or pick another pane.
        return { exitCode: answer.status === 400 ? 2 : 1, message: `els do: ${address.host} refused: ${why}` };
      } catch (error) {
        return { exitCode: 1, message: `els do: ${address.host} ? ${reason(error)} (not sent)` };
      }
    },

    async read(ref: string): Promise<ElsResult> {
      const address = parseAddress(ref);
      // A bare pane ref (id, title, pty id) is the stage-1 local read.
      if (!address) return deps.askLocal({ op: 'read', pane: ref });
      if (address.host === '' || address.host === deps.localHost) {
        return deps.askLocal({ op: 'read', pane: address.pane, at: { ws: address.ws, tab: address.tab } });
      }
      const host = hosts.find((row) => row.name === address.host);
      if (!host) return { exitCode: 1, message: `els read: host ${address.host} is not registered in els/hosts.json` };
      try {
        const answer = await deps.fetchJson(host, `/els/read?address=${encodeURIComponent(`${address.ws}/${address.tab}/${address.pane}`)}`);
        const body = answer.body && typeof answer.body === 'object' ? answer.body as { screen?: unknown; error?: unknown } : {};
        if (answer.status === 200 && typeof body.screen === 'string') return { exitCode: 0, message: body.screen };
        if (answer.status === 404) return { exitCode: 1, message: `els read: unknown pane ${ref}` };
        return { exitCode: 1, message: `els read: ${address.host} ? ${typeof body.error === 'string' ? body.error : `http ${answer.status}`}` };
      } catch (error) {
        return { exitCode: 1, message: `els read: ${address.host} ? ${reason(error)}` };
      }
    },

    /** Where the live view of `ref` goes when it is not this host (stage 5) — the caller drives the same attach
     *  client either way, so keys, colors and drawing stay one code path. */
    attachTarget(ref: string): { host: FederatedHost; pane: string } | { refused: string } | undefined {
      const remote = remoteRef(ref);
      if (remote && !routeFor(remote.host)) return { refused: `els attach: ${remote.host.name} route ${hostRoute(remote.host)} is not available in this build` };
      return remote;
    },

    /** `els new --host <host>[/ws]`: a registered remote host (the workspace after the slash). Undefined = not a
     *  registered remote host. */
    newTarget(word: string): { host: FederatedHost; ws?: string } | undefined {
      if (word === '') return undefined;
      const slash = word.indexOf('/');
      const name = slash < 0 ? word : word.slice(0, slash);
      const host = hosts.find((row) => row.name === name && row.kind !== 'herdr');
      if (!host) return undefined;
      if (slash < 0 || slash === word.length - 1) return { host };
      const ws = word.slice(slash + 1);
      return ws.includes('/') ? undefined : { host, ws };
    },

    /** `els new` (stage 5): no target → this host's owner; a remote host → POST /els/new there — the receiving
     *  owner decides (its allow list, its audit) and owns the pane. The defaults (workspace, cwd, shell) are the
     *  caller's. */
    async new(target: { host: FederatedHost; ws?: string } | undefined, input: { ws: string; cwd: string; command: readonly string[]; title?: string; size?: { cols: number; rows: number } }, from: string): Promise<ElsResult> {
      if (!target) return deps.askLocal({ op: 'new', ws: input.ws, cwd: input.cwd, command: input.command, ...(input.title ? { title: input.title } : {}) });
      const route = routeFor(target.host);
      if (!route) return { exitCode: 1, message: `els new: ${target.host.name} route ${hostRoute(target.host)} is not available in this build` };
      try {
        const answer = await route.newPane(target.host, { ws: target.ws ?? input.ws, cwd: input.cwd, command: input.command,
          ...(input.title ? { title: input.title } : {}), ...(input.size ? { cols: input.size.cols, rows: input.size.rows } : {}), from: `${deps.localHost}/${from}` });
        const body = answer.body && typeof answer.body === 'object' ? answer.body as { message?: unknown; error?: unknown } : {};
        if (answer.status === 200) {
          // The answer is the remote owner's created-pane JSON — the same shape a local `els new` prints, with the
          // address made federated (`host:ws/tab/pane`) so `els read` · `els attach` · `els pane close` take it as is.
          if (typeof body.message === 'string') return { exitCode: 0, message: body.message };
          const created = answer.body as Record<string, unknown>;
          const local = typeof created.address === 'string' ? parseAddress(created.address) : undefined;
          return { exitCode: 0, message: JSON.stringify(local && local.host === ''
            ? { ...created, address: formatAddress({ host: target.host.name, ws: local.ws, tab: local.tab, pane: local.pane }), host: target.host.name }
            : answer.body) };
        }
        const why = typeof body.error === 'string' ? body.error : `http ${answer.status}`;
        return { exitCode: answer.status === 400 ? 2 : 1, message: `els new: ${target.host.name} refused: ${why}` };
      } catch (error) {
        return { exitCode: 1, message: `els new: ${target.host.name} ? ${reason(error)} (not created)` };
      }
    },

    /** REMOTE-PANE-SIZE: ask the owner of a remote pane to set its PTY to this viewer's pane area (the remote SIGWINCH). */
    async resize(ref: string, cols: number, rows: number, from: string): Promise<ElsResult> {
      const address = parseAddress(ref);
      if (!address || address.host === '' || address.host === deps.localHost) return { exitCode: 2, message: 'els resize: remote address required' };
      const host = hosts.find((row) => row.name === address.host);
      if (!host) return { exitCode: 1, message: `els resize: host ${address.host} is not registered in els/hosts.json` };
      if (!deps.postJson) return { exitCode: 1, message: 'els resize: remote resize is not available here' };
      try {
        const answer = await deps.postJson(host, '/els/resize', { address: `${address.ws}/${address.tab}/${address.pane}`, cols, rows, from: `${deps.localHost}/${from}` });
        const body = answer.body && typeof answer.body === 'object' ? answer.body as { message?: unknown; error?: unknown } : {};
        if (answer.status === 200) return { exitCode: 0, message: typeof body.message === 'string' ? body.message : `${cols}x${rows}` };
        return { exitCode: 1, message: `els resize: ${address.host} refused: ${typeof body.error === 'string' ? body.error : `http ${answer.status}`}` };
      } catch (error) { return { exitCode: 1, message: `els resize: ${address.host} ? ${reason(error)}` }; }
    },

    /** `els pane close <ref>` (stage 5): a bare ref or this host's address → the stage-1 close; a remote ref → the
     *  pane is closed by the owner that has it. */
    async close(ref: string, from: string): Promise<ElsResult> {
      const remote = remoteRef(ref);
      if (!remote) {
        const address = parseAddress(ref);
        if (address && address.host !== '' && address.host !== deps.localHost) {
          const known = hosts.find((row) => row.name === address.host);
          return { exitCode: 1, message: known
            ? `els close: ${known.name} panes are read and input only — close them where they live`
            : `els close: host ${address.host} is not registered in els/hosts.json` };
        }
        return deps.askLocal({ op: 'close', pane: ref });
      }
      const route = routeFor(remote.host);
      if (!route) return { exitCode: 1, message: `els close: ${remote.host.name} route ${hostRoute(remote.host)} is not available in this build` };
      try {
        const answer = await route.closePane(remote.host, { address: remote.pane, from: `${deps.localHost}/${from}` });
        const body = answer.body && typeof answer.body === 'object' ? answer.body as { message?: unknown; error?: unknown } : {};
        if (answer.status === 200) return { exitCode: 0, message: typeof body.message === 'string' ? body.message : `els close: closed ${ref}` };
        if (answer.status === 404) return { exitCode: 1, message: `els close: unknown pane ${ref}` };
        const why = typeof body.error === 'string' ? body.error : `http ${answer.status}`;
        return { exitCode: answer.status === 400 ? 2 : 1, message: `els close: ${remote.host.name} refused: ${why}` };
      } catch (error) {
        return { exitCode: 1, message: `els close: ${remote.host.name} ? ${reason(error)} (not closed)` };
      }
    },
  };
}
