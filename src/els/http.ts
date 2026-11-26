// els host HTTP — the window a federated els reaches this host through (`els serve --http <addr:port>`). It runs
// inside the one owner process and answers from the owner's journal in memory (never from the file):
//   GET /els/ls                        → { host, panes }
//   GET /els/read?address=ws/tab/pane  → { screen }
//   POST /els/new · POST /els/close    → one request, one JSON answer
//   POST /els/attach/<pane>?cols&rows&from → the attach stream: frames out (chunked), input/resize lines in
// Every write path is the `els do` pattern: off unless the sender's source address is in els/do-allow.json, and
// every attempt is appended to els/do-audit.jsonl (who, from where, which pane — never the typed bytes). A read
// renders the live screen and the owner saves it as the pane's scrollback, exactly like a local `els read`. The
// bind address must be loopback or inside the tailnet.

import { remoteResize } from './local-viewer-size.js';
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { parseAddress } from './address.js';
import type { ElsCore } from './core.js';
import { isTailnetOrLoopback } from './hosts.js';
import { createLineDecoder } from './wire.js';

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
  if (method === 'POST' && url.pathname === '/els/new' && info.policy) return routeNew(core, info);
  if (method === 'POST' && url.pathname === '/els/close' && info.policy) return routeClose(core, hostName, info);
  if (method === 'POST' && url.pathname === '/els/resize' && info.policy) return routeResize(core, hostName, info);
  if (method !== 'GET') return json(405, { error: 'read-only: GET only' });
  if (url.pathname === '/els/ls') {
    const listed = JSON.parse(core.list().message) as { workspaces?: { id: string; role?: string }[]; panes: { tab: string; pane: string; title: string; cwd: string; state: string; address: string; build?: unknown;
      seat?: string | null; size?: { cols: number; rows: number }; spaceCoordinator?: boolean; activityState?: string; kind?: string; badge?: string; badgeLabel?: string; stalled?: boolean; lastEventAtMs?: number; status?: unknown; git?: { branch: string; ahead: number; behind: number; dirty: boolean; root: string | null } }[] };
    const coordinators = new Set((listed.workspaces ?? []).filter((ws) => ws.role === 'coordinator').map((ws) => ws.id));
    // ELS-TAB-STATE-BADGE: stalled is decided HERE, once, by the origin server's clock; a federated reader only carries it.
    return json(200, { host: hostName, workspaces: (listed.workspaces ?? []).filter((ws) => ws.role === 'coordinator'), panes: listed.panes.map((row) => ({ ws: row.address.split('/')[0], tab: row.tab, pane: row.pane,
      ...(coordinators.has(row.address.split('/')[0] ?? '') ? { role: 'coordinator' } : {}),
      ...(row.spaceCoordinator === true ? { spaceCoordinator: true } : {}),
      ...(typeof row.activityState === 'string' ? { activityState: row.activityState } : {}),
      title: row.title, cwd: row.cwd, state: row.state, build: row.build, ...(row.size ? { size: row.size } : {}),
      ...(['eln', 'codex', 'claude', 'grok', 'shell', 'other'].includes(row.kind ?? '') ? { kind: row.kind } : {}),
      ...(row.seat === null || (typeof row.seat === 'string' && /^[A-Z][A-Z0-9_-]{0,63}$/.test(row.seat)) ? { seat: row.seat } : {}),
      badge: row.badge, badgeLabel: row.badgeLabel, stalled: row.stalled, lastEventAtMs: row.lastEventAtMs,
      // SEAT-STATE-ENUM: the status codes, decided here like the stall (origin clock).
      ...(row.status !== undefined ? { status: row.status } : {}),
      // ELS-GIT-AWARENESS-HERDR (OP #139752): the pane's git labels ride along from the origin's cache; the read-only window runs no git of its own.
      ...(row.git !== undefined ? { git: row.git } : {}) })) });
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

/** POST /els/new — a federated `els new <host>[/ws] -- …` lands here: the owner of THIS host opens the pane. The
 *  allow list decides; the audit names the sender, the workspace and the cwd it asked for — never the command words. */
async function routeNew(core: ElsCore, info: ElsHttpRequestInfo): Promise<{ status: number; body: string }> {
  const policy = info.policy!;
  const source = info.source ?? '';
  if (!policy.allows(source)) {
    policy.audit({ source, op: 'new', result: 'refused: source not in do-allow.json' });
    return json(403, { error: 'this source may not open panes here' });
  }
  let request: { ws?: unknown; cwd?: unknown; command?: unknown; title?: unknown; from?: unknown; cols?: unknown; rows?: unknown };
  try { request = JSON.parse(info.body ?? '') as typeof request; }
  catch { policy.audit({ source, op: 'new', result: 'bad request: body is not JSON' }); return json(400, { error: 'body must be JSON' }); }
  const shape = typeof request.ws === 'string' && typeof request.cwd === 'string' && typeof request.from === 'string'
    && Array.isArray(request.command) && request.command.every((word) => typeof word === 'string');
  if (!shape) {
    policy.audit({ source, op: 'new', result: 'bad request: need ws, cwd, command (strings) and from' });
    return json(400, { error: 'need ws, cwd, command (an array of strings) and from' });
  }
  const made = await core.newPane({ ws: request.ws as string, cwd: request.cwd as string, command: request.command as string[],
    ...(typeof request.title === 'string' ? { title: request.title } : {}) });
  policy.audit({ source, op: 'new', from: request.from, ws: request.ws, cwd: request.cwd, result: made.message });
  if (made.exitCode !== 0) return json(made.exitCode === 2 ? 400 : 409, { error: made.message });
  // REMOTE-PANE-SIZE: the requesting viewer's pane area — the PTY starts at that size, not the 80x24 default.
  if (typeof request.cols === 'number' && typeof request.rows === 'number') {
    try { const id = (JSON.parse(made.message) as { pane?: unknown }).pane; if (typeof id === 'string') core.resize(id, request.cols, request.rows); } catch { /* the frames tell the true size */ }
  }
  // The answer is the created-pane JSON — the same shape a local `els new` prints (and herdr words wrap).
  try { return json(200, JSON.parse(made.message) as Record<string, unknown>); } catch { return json(200, { message: made.message }); }
}

/** POST /els/close — close one pane of this host: `address` = ws/tab/pane of this host, or a bare pane id. */
async function routeClose(core: ElsCore, hostName: string, info: ElsHttpRequestInfo): Promise<{ status: number; body: string }> {
  const policy = info.policy!;
  const source = info.source ?? '';
  if (!policy.allows(source)) {
    policy.audit({ source, op: 'close', result: 'refused: source not in do-allow.json' });
    return json(403, { error: 'this source may not close panes here' });
  }
  let request: { address?: unknown; from?: unknown };
  try { request = JSON.parse(info.body ?? '') as typeof request; }
  catch { policy.audit({ source, op: 'close', result: 'bad request: body is not JSON' }); return json(400, { error: 'body must be JSON' }); }
  if (typeof request.address !== 'string' || typeof request.from !== 'string') {
    policy.audit({ source, op: 'close', result: 'bad request: need address and from' });
    return json(400, { error: 'need address (ws/tab/pane of this host, or a pane id) and from' });
  }
  const address = parseAddress(request.address);
  const paneId = address
    ? address.host === '' || address.host === hostName ? core.locate(address.ws, address.tab, address.pane) : undefined
    : core.paneExists(request.address);
  if (!paneId) { policy.audit({ source, op: 'close', from: request.from, address: request.address, result: 'unknown pane' }); return json(404, { error: 'unknown pane' }); }
  const done = await core.close(paneId);
  policy.audit({ source, op: 'close', from: request.from, address: request.address, result: done.message });
  return done.exitCode === 0 ? json(200, { message: done.message }) : json(done.exitCode === 2 ? 400 : 409, { error: done.message });
}

/** POST /els/resize — REMOTE-PANE-SIZE: a federated viewer showing one of this host's panes asks for its pane area
 *  (`address` ws/tab/pane, `cols`, `rows`) — the SIGWINCH a local attach would send. Same allow list and audit as do. */
async function routeResize(core: ElsCore, hostName: string, info: ElsHttpRequestInfo): Promise<{ status: number; body: string }> {
  const policy = info.policy!;
  const source = info.source ?? '';
  if (!policy.allows(source)) {
    policy.audit({ source, op: 'resize', result: 'refused: source not in do-allow.json' });
    return json(403, { error: 'this source may not resize panes here' });
  }
  let request: { address?: unknown; cols?: unknown; rows?: unknown; from?: unknown };
  try { request = JSON.parse(info.body ?? '') as typeof request; }
  catch { policy.audit({ source, op: 'resize', result: 'bad request: body is not JSON' }); return json(400, { error: 'body must be JSON' }); }
  const address = typeof request.address === 'string' ? parseAddress(request.address) : undefined;
  if (!address || (address.host !== '' && address.host !== hostName) || typeof request.cols !== 'number' || typeof request.rows !== 'number' || typeof request.from !== 'string') {
    policy.audit({ source, op: 'resize', result: 'bad request: need address of this host, cols, rows and from' });
    return json(400, { error: 'need address (ws/tab/pane of this host), cols, rows and from' });
  }
  const paneId = core.locate(address.ws, address.tab, address.pane);
  if (!paneId) { policy.audit({ source, op: 'resize', from: request.from, address: request.address, result: 'unknown pane' }); return json(404, { error: 'unknown pane' }); }
  // ELS-PANE-HEIGHT: a viewer attached on this host keeps its size; the remote ask does not shrink the pane under it.
  const { result: done, kept } = remoteResize(core, paneId, request.cols, request.rows, `host:${request.from}`);
  policy.audit({ source, op: 'resize', from: request.from, address: request.address, result: kept ? `kept ${done.message}: a local view is attached` : done.message });
  return done.exitCode === 0 ? json(200, { message: done.message }) : json(done.exitCode === 2 ? 400 : 409, { error: done.message });
}

// 출처: the socket attach (src/els/server.ts serveAttach) — 10 frames a second, a frame only when the screen
// changed, and a client that stops reading stops getting frames once this much is queued.
const ATTACH_POLL_MS = 100;
const ATTACH_MAX_QUEUED_BYTES = 1_048_576;

/** What the attach stream has actually queued to the client: the last screen key and its frame number. */
export interface AttachShown { lastKey?: string; seq: number }

/** One poll of the attach stream: a changed screen is sent as the next frame; it counts as shown only when `send`
 *  queued it (a full buffer drops it, and the same screen is tried again on the next poll — the client never
 *  misses the final screen). */
export function attachFrameStep(shown: AttachShown, key: string, send: (seq: number) => boolean): void {
  if (key === shown.lastKey) return;
  if (!send(shown.seq + 1)) return;
  shown.lastKey = key;
  shown.seq += 1;
}

/**
 * POST /els/attach/<pane>?cols=&rows=&from= — the els-attach line-JSON protocol over one HTTP request: frames out
 * (chunked), `input`/`resize` lines in, the request body ending = detach (a client going away never touches the
 * pane). The source must be in do-allow.json before anything is sent, and the attempt is audited.
 */
function serveHttpAttach(core: ElsCore, hostName: string, policy: ElsDoPolicy, req: IncomingMessage, res: ServerResponse, url: URL): void {
  const source = req.socket.remoteAddress ?? '';
  const rawPane = url.pathname.slice('/els/attach/'.length);
  const from = url.searchParams.get('from') ?? '';
  let pane = rawPane;
  const refuse = (status: number, error: string, result: string): void => {
    policy.audit({ source, op: 'attach', from, pane, result });
    req.resume();   // drain whatever the sender keeps writing; it reads the refusal and stops
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error }));
  };
  // The allow check comes before anything is decoded; a malformed %-escape is a 400, never a throw out of the owner.
  if (!policy.allows(source)) return refuse(403, 'this source may not attach here', 'refused: source not in do-allow.json');
  try { pane = decodeURIComponent(rawPane); }
  catch { return refuse(400, 'bad pane in the path', 'bad request: pane is not valid %-encoding'); }
  // `<pane>` = a pane id of this host, or this host's ws/tab/pane (what `els attach host:ws/tab/pane` sends).
  const address = parseAddress(pane);
  const paneId = address
    ? address.host === '' || address.host === hostName ? core.locate(address.ws, address.tab, address.pane) : undefined
    : core.paneExists(pane);
  if (!paneId) return refuse(404, 'unknown pane', 'unknown pane');
  const cols = Number(url.searchParams.get('cols'));
  const rows = Number(url.searchParams.get('rows'));
  if (Number.isInteger(cols) && cols > 0 && Number.isInteger(rows) && rows > 0) {
    void remoteResize(core, paneId, cols, rows, `host:${from}`);   // a refused resize is not fatal: the frames tell the true size
  }
  policy.audit({ source, op: 'attach', from, pane: paneId, result: 'attached' });
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });   // no content length → chunked
  const shown: AttachShown = { seq: 0 };
  let busy = false;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  // Returns whether the line was queued: a frame dropped on a full buffer must be sent again once it drains.
  const send = (value: object): boolean => {
    if (closed || res.destroyed || res.writableEnded || res.writableLength >= ATTACH_MAX_QUEUED_BYTES) return false;
    res.write(`${JSON.stringify(value)}\n`);
    return true;
  };
  const stop = (): void => { closed = true; if (timer !== undefined) clearInterval(timer); };
  const tick = async (): Promise<void> => {
    if (busy || closed || res.destroyed) return;
    busy = true;
    try {
      const frame = await core.frame(paneId);
      if (closed) return;
      if (frame.exitCode !== 0) { send({ type: 'end', exitCode: 1, message: frame.message }); stop(); res.end(); return; }
      const size = core.paneSize(paneId);
      const key = `${size.cols}x${size.rows}\n${frame.message}`;   // a resize alone is a change too
      attachFrameStep(shown, key, (next) => send({ type: 'frame', pane: paneId, seq: next, cols: size.cols, rows: size.rows, screen: frame.message }));
      if (!core.paneIsLive(paneId)) { send({ type: 'end', exitCode: 0, message: 'pane exited' }); stop(); res.end(); }
    } finally { busy = false; }
  };
  const poke = (): void => { void tick().catch(() => { busy = false; }); };
  timer = setInterval(poke, ATTACH_POLL_MS);
  timer.unref?.();
  res.on('close', stop);   // the client went away: detach — the pane is untouched
  const lines = createLineDecoder((line) => {
    let value: { op?: string; bytes?: unknown; cols?: unknown; rows?: unknown };
    try { value = JSON.parse(line) as typeof value; } catch { return; }
    if (value.op === 'input' && typeof value.bytes === 'string') {
      const done = core.input(paneId, value.bytes);
      if (done.exitCode !== 0) send({ type: 'error', message: done.message });
    } else if (value.op === 'resize' && typeof value.cols === 'number' && typeof value.rows === 'number') {
      const { result: done } = remoteResize(core, paneId, value.cols, value.rows, `host:${from}`);
      if (done.exitCode !== 0) send({ type: 'error', message: done.message });
      else poke();
    }
  });
  req.on('data', (chunk: Buffer) => { lines.push(chunk); if (lines.pending() > ATTACH_MAX_QUEUED_BYTES) req.destroy(); });
  req.on('end', () => {   // the client ended its request: detach
    stop();
    if (!res.writableEnded) { send({ type: 'end', exitCode: 0, message: 'detached' }); res.end(); }
  });
  req.on('error', stop);
  poke();
}

export function startElsHttp(core: ElsCore, hostName: string, bind: ElsHttpBind, policy?: ElsDoPolicy): Promise<Server> {
  const server = createServer((req, res) => {
    // The attach stream is not one-request-1-answer: it keeps the request open, lines both ways (stage 5).
    if (policy && req.method === 'POST') {
      const streamUrl = new URL(req.url ?? '/', 'http://els.local');
      if (streamUrl.pathname.startsWith('/els/attach/')) {
        try { serveHttpAttach(core, hostName, policy, req, res, streamUrl); }
        catch {   // the owner process never dies of one bad attach request
          if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'attach failed' })); }
          else res.destroy();
        }
        return;
      }
    }
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
  // An attach stream is one long request that never "completes"; Node's request timeout would cut it at 5 minutes.
  server.requestTimeout = 0;
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
