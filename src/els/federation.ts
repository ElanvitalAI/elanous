// els federation (stage 2) — `els ls` and `els read` over this host's els server and the registered remote hosts.
// Read-only: the local part is a request to the local owner (Unix socket), the remote part is GET on each host's read
// window (`els serve --http`). This module writes nothing (only the owner of each host saves its own journal); a host
// that does not answer stays in the list as down (`?`).

import { formatAddress, parseAddress } from './address.js';
import type { ElsResult } from './core.js';
import type { FederatedHost, HostRegistry } from './hosts.js';
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
}

interface RemotePane { ws: string; tab: string; pane: string; title: string; cwd: string; state: string; build?: unknown; role?: 'coordinator';
  /** ELS-TAB-STATE-BADGE: decided once at the origin server; absent when that server is older (state then reads as before). */
  badge?: string; badgeLabel?: string; stalled?: boolean; lastEventAtMs?: number }

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
      ...(pane.role === 'coordinator' ? { role: 'coordinator' } : {}),
      ...(typeof pane.badge === 'string' ? { badge: pane.badge } : {}),
      ...(typeof pane.badgeLabel === 'string' ? { badgeLabel: pane.badgeLabel } : {}),
      ...(typeof pane.stalled === 'boolean' ? { stalled: pane.stalled } : {}),
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
  return {
    async list(): Promise<ElsResult> {
      const local = await deps.askLocal({ op: 'ls' });
      const hostRows: { name: string; reach: HostReach; reason?: string }[] = [];
      let localBody: { workspaces: unknown[]; tabs: unknown[]; panes: Record<string, unknown>[] } = { workspaces: [], tabs: [], panes: [] };
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
        workspaces: localBody.workspaces, remoteWorkspaces, tabs: localBody.tabs, panes }, null, 2) };
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
  };
}
