import { jsonResponse } from './json-response.js';
import { desiredSha as readDesiredSha } from '../host-registry/desired-sha.js';
import { recordHeartbeat } from '../host-registry/store.js';
import type { HostChannel } from '../host-registry/types.js';

export interface HostsHeartbeatPostDeps {
  now?: () => number;
  ledgerPath?: string;
  desiredSha?: () => string | undefined;
  /** Test seam; production always records into the shared central host registry. */
  record?: typeof recordHeartbeat;
}

const SHA40 = /^[a-f0-9]{40}$/i;

/**
 * Machine-token-authenticated producer path: the installed-sha heartbeat lands in the CENTRAL hosts list.
 * Host identity always comes from the token, never the body (a mismatched body host is a 403).
 */
export async function handleHostsHeartbeatPost(
  req: Request,
  machine: string,
  deps: HostsHeartbeatPostDeps = {},
): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  const raw = body && typeof body === 'object' && !Array.isArray(body)
    ? ((body as { heartbeat?: unknown }).heartbeat ?? body) : undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return jsonResponse({ error: 'heartbeat-required' }, 400);
  const row = raw as { host?: unknown; installedSha?: unknown; seat?: unknown; channel?: unknown; at?: unknown };
  if (row.host !== undefined && row.host !== machine) return jsonResponse({ error: 'host-token-mismatch' }, 403);
  if (typeof row.installedSha !== 'string' || !SHA40.test(row.installedSha)) return jsonResponse({ error: 'installed-sha-required' }, 400);
  if (row.channel !== undefined && row.channel !== 'dev' && row.channel !== 'release') return jsonResponse({ error: 'invalid-channel' }, 400);
  if (row.seat !== undefined && typeof row.seat !== 'string') return jsonResponse({ error: 'invalid-seat' }, 400);
  const atMs = row.at === undefined
    ? (deps.now ?? Date.now)()
    : typeof row.at === 'string' ? Date.parse(row.at) : Number.NaN;
  if (!Number.isFinite(atMs)) return jsonResponse({ error: 'invalid-at' }, 400);
  try {
    const record = (deps.record ?? recordHeartbeat)(machine, row.installedSha.toLowerCase(), atMs, {
      ...(deps.ledgerPath ? { path: deps.ledgerPath } : {}),
      seat: typeof row.seat === 'string' ? row.seat : undefined,
      channel: row.channel as HostChannel | undefined,
      desiredSha: (deps.desiredSha ?? readDesiredSha)(),
    });
    const response = jsonResponse(
      { ok: true, host: record.host, state: record.state, at: new Date(record.lastHeartbeatMs).toISOString() },
      201,
    );
    response.headers.set('cache-control', 'no-store');
    return response;
  } catch {
    return jsonResponse({ error: 'invalid-heartbeat' }, 400);
  }
}