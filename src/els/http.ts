// els host HTTP — the read-only window a federated els reads this host through (`els serve --http <addr:port>`).
// It runs inside the one owner process and answers from the owner's journal in memory (never from the file):
//   GET /els/ls                        → { host, panes }
//   GET /els/read?address=ws/tab/pane  → { screen }
// The window adds no write path: no send, new or close. A read renders the live screen and the owner saves it as the
// pane's scrollback, exactly like a local `els read`. The bind address must be loopback or inside the tailnet.

import { appendFileSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { parseAddress } from './address.js';
import type { ElsCore } from './core.js';
import { isTailnetOrLoopback } from './hosts.js';

export interface ElsHttpBind {
  readonly host: string;
  readonly port: number;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** An IP literal (or `localhost`) that is loopback or inside the tailnet — never a DNS name, which could resolve anywhere. */
export function isAllowedBindAddress(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (name === 'localhost' || name === '::1') return true;
  return IPV4.test(name) && isTailnetOrLoopback(name);
}

/** `127.0.0.1:8790` · `100.101.102.103:8790` · `[::1]:8790` → bind, or a reason it is refused. */
export function parseHttpBind(raw: string): ElsHttpBind | string {
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(raw.trim());
  if (!match) return `els serve --http: expected <address>:<port>, got ${raw}`;
  const host = match[1]!.replace(/^\[|\]$/g, '');
  const port = Number(match[2]);
  // 출처: TCP ports are 1–65535.
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return `els serve --http: bad port ${match[2]}`;
  if (!isAllowedBindAddress(host)) return `els serve --http: ${host} is not a loopback or tailnet IP address (the read window never binds to a public interface or a DNS name)`;
  return { host, port };
}

const json = (status: number, body: unknown): { status: number; body: string } => ({ status, body: JSON.stringify(body) });

/**
 * Who may type into this host's panes through the window (`POST /els/do`). Off unless the person who runs this host
 * lists the sender's tailnet source address in `<state>/els/do-allow.json` {"sources":["100.64.0.5"]}; every attempt is
 * appended to `<state>/els/do-audit.jsonl` (who, from where, which pane, how many chars — never the text itself).
 */
export interface ElsDoPolicy {
  allows(source: string): boolean;
  audit(entry: Record<string, unknown>): void;
}

export function doPolicy(stateRoot: string): ElsDoPolicy {
  const allowPath = join(stateRoot, 'els', 'do-allow.json');
  return {
    allows(source) {
      try {
        const raw = JSON.parse(readFileSync(allowPath, 'utf8')) as { sources?: unknown };
        const normalized = source.replace(/^::ffff:/, '');
        return Array.isArray(raw.sources) && raw.sources.some((entry) => entry === normalized);
      } catch { return false; }   // missing or broken list = nobody
    },
    audit(entry) {
      try { appendFileSync(join(stateRoot, 'els', 'do-audit.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 }); }
      catch (error) { process.stderr.write(`els: audit not written: ${error instanceof Error ? error.message : String(error)}\n`); }
    },
  };
}

export interface ElsHttpRequestInfo {
  readonly source?: string;
  readonly body?: string;
  readonly policy?: ElsDoPolicy;
}

// 출처: a `do` request is an address plus a line of text (core caps the text at 8000 chars).
const MAX_BODY_BYTES = 64 * 1024;

/** The answer for one request (pure routing over the core, tested without a socket). */
export async function routeElsHttp(core: ElsCore, hostName: string, method: string, rawUrl: string, info: ElsHttpRequestInfo = {}): Promise<{ status: number; body: string }> {
  const url = new URL(rawUrl, 'http://els.local');
  if (method === 'POST' && url.pathname === '/els/do' && info.policy) return routeDo(core, hostName, info);
  if (method !== 'GET') return json(405, { error: 'read-only: GET only' });
  if (url.pathname === '/els/ls') {
    const listed = JSON.parse(core.list().message) as { workspaces?: { id: string; role?: string }[]; panes: { tab: string; pane: string; title: string; cwd: string; state: string; address: string; build?: unknown;
      badge?: string; badgeLabel?: string; stalled?: boolean; lastEventAtMs?: number }[] };
    const coordinators = new Set((listed.workspaces ?? []).filter((ws) => ws.role === 'coordinator').map((ws) => ws.id));
    // ELS-TAB-STATE-BADGE: stalled is decided HERE, once, by the origin server's clock; a federated reader only carries it.
    return json(200, { host: hostName, workspaces: (listed.workspaces ?? []).filter((ws) => ws.role === 'coordinator'), panes: listed.panes.map((row) => ({ ws: row.address.split('/')[0], tab: row.tab, pane: row.pane,
      ...(coordinators.has(row.address.split('/')[0] ?? '') ? { role: 'coordinator' } : {}),
      title: row.title, cwd: row.cwd, state: row.state, build: row.build,
      badge: row.badge, badgeLabel: row.badgeLabel, stalled: row.stalled, lastEventAtMs: row.lastEventAtMs })) });
  }
  if (url.pathname === '/els/read') {
    const address = parseAddress(url.searchParams.get('address') ?? '');
    if (!address || (address.host !== '' && address.host !== hostName)) return json(400, { error: 'address must be ws/tab/pane of this host' });
    const paneId = core.locate(address.ws, address.tab, address.pane);
    if (!paneId) return json(404, { error: 'unknown pane' });
    const read = await core.read(paneId);
    return read.exitCode === 0 ? json(200, { screen: read.message }) : json(502, { error: read.message });
  }
  return json(404, { error: 'not found' });
}

async function routeDo(core: ElsCore, hostName: string, info: ElsHttpRequestInfo): Promise<{ status: number; body: string }> {
  const policy = info.policy!;
  const source = info.source ?? '';
  if (!policy.allows(source)) {
    policy.audit({ source, result: 'refused: source not in do-allow.json' });
    return json(403, { error: 'this source may not send input here' });
  }
  let request: { address?: unknown; text?: unknown; from?: unknown };
  try { request = JSON.parse(info.body ?? '') as typeof request; }
  catch { policy.audit({ source, result: 'bad request: body is not JSON' }); return json(400, { error: 'body must be JSON' }); }
  const address = typeof request.address === 'string' ? parseAddress(request.address) : undefined;
  if (!address || (address.host !== '' && address.host !== hostName) || typeof request.text !== 'string' || typeof request.from !== 'string') {
    policy.audit({ source, address: typeof request.address === 'string' ? request.address : undefined, result: 'bad request: need address of this host, text and from' });
    return json(400, { error: 'need address (ws/tab/pane of this host), text and from' });
  }
  const paneId = core.locate(address.ws, address.tab, address.pane);
  if (!paneId) { policy.audit({ source, from: request.from, address: request.address, result: 'unknown pane' }); return json(404, { error: 'unknown pane' }); }
  const done = await core.do(paneId, request.text, `${request.from}`);
  policy.audit({ source, from: request.from, address: request.address, chars: request.text.length, result: done.message });
  return done.exitCode === 0 ? json(200, { message: done.message }) : json(done.exitCode === 2 ? 400 : 409, { error: done.message });
}

export function startElsHttp(core: ElsCore, hostName: string, bind: ElsHttpBind, policy?: ElsDoPolicy): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_BODY_BYTES) tooLarge = true; else chunks.push(chunk); });
    req.on('end', () => {
      if (tooLarge) { res.writeHead(413, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'body too large' })); return; }
      respond(Buffer.concat(chunks).toString('utf8'));
    });
    const respond = (body: string): void => {
    void routeElsHttp(core, hostName, req.method ?? 'GET', req.url ?? '/', { source: req.socket.remoteAddress ?? '', body, ...(policy ? { policy } : {}) })
      .catch((error: unknown) => json(500, { error: error instanceof Error ? error.message : String(error) }))
      .then(({ status, body }) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body);
      });
    };
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(bind.port, bind.host, () => {
      server.off('error', reject);
      // What the socket is actually bound to must be in the allowed range too.
      const bound = server.address();
      const address = bound && typeof bound === 'object' ? bound.address : '';
      if (!isAllowedBindAddress(address)) {
        server.close();
        reject(new Error(`bound to ${address}, which is not a loopback or tailnet address`));
        return;
      }
      resolve(server);
    });
  });
}
