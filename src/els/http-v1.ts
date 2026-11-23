// HTTP API surface for /els/v1/* (ELS-EXTERNAL-SURFACES §3.2).
// The transport builds the Principal from a PAT. A JSON field can never become one.
// Every route walks createControl().run. Missing PAT is 401 and does not execute.
// An allow-list miss is 403. A dangerous shell do is held until a person approves.
// The token, the typed text, and any secret stay out of the response and the audit
// (the door already stores only a sha256 of the text; the response body carries only
// fixed words and numbers — #38453 REVIEW must ③: no executor message, no raw reason).
// The pane kind is the server's to decide, never the requester's `shell` claim
// (#38453 REVIEW must ②): the resolver reads the owner's journal, and a pane it cannot
// vouch for counts as a shell (fail closed) — a dangerous do still needs a person.
// Every request is counted before anything is decided (#38453 REVIEW must ⑤): an
// unknown path, a wrong method and an oversized body all spend the source's minute.
// Signed inbound webhooks live under /els/v1/hook/<name> and walk the same door with
// a webhook key principal instead of a PAT.

import { createServer, type Server } from 'node:http';
import { matchMcpPat } from '../mcp-gateway/pat-store.js';
import { MinuteIpLimiter } from '../mcp-gateway/gateway.js';
import { isAllowedBindAddress, type ElsHttpBind } from './http.js';
import {
  createControl,
  type ControlAction,
  type ControlExecute,
  type ControlOutcome,
  type ControlTarget,
  type HitlAsk,
  type Principal,
} from './control.js';
import { routeElsHook, type HookDeps } from './webhook-in.js';

export interface HttpV1Request {
  readonly method: string;
  readonly rawUrl: string;
  readonly body?: string;
  readonly authorization?: string;
  readonly source?: string;
  /** Inbound webhook headers: X-Els-Signature, X-Els-Timestamp, X-Els-Nonce. */
  readonly hookSignature?: string;
  readonly hookTimestamp?: string;
  readonly hookNonce?: string;
}

export interface HttpV1Deps {
  /** `<state>/els` — control-allow.json and control-audit.jsonl. */
  readonly stateDir: string;
  /** PAT store root passed to matchMcpPat. */
  readonly patRoot: string;
  /** Runs only after the door says yes. */
  readonly execute: ControlExecute;
  /** Asks a person. Absent = a dangerous shell do is held and not sent. */
  readonly hitl?: HitlAsk;
  /**
   * The owner's journal answer to «is this pane a shell?» (#38453 REVIEW must ②). The requester's `shell`
   * field is a claim, not a fact: this decides, and a pane it cannot vouch for counts as a shell (fail
   * closed). The real server boot always passes one; without it every pane is treated as a shell.
   */
  readonly paneIsShell?: (workspace: string, pane: string) => boolean;
  readonly now?: () => number;
  /** Requests per source address per minute for startElsHttpV1. Default 60. */
  readonly rateLimitPerMinute?: number;
  /** Shared across requests. routeElsHttpV1 without one does not rate-limit. */
  readonly limiter?: MinuteIpLimiter;
  /**
   * #38609 REVIEW must ⓑ — seen webhook nonces, one ledger for the life of the server. Required: a
   * per-request Map would forget a replay, so a direct `routeElsHttpV1` caller owns one as well.
   */
  readonly nonces: Map<string, number>;
  /** GRAPH-SCHEDULER §1-3 — person gate for the first firing of a write/external-send graph hook (absent = held). */
  readonly askGraphFirstFiring?: HookDeps['askGraphFirstFiring'];
}

const PATH_ACTION: Readonly<Record<string, ControlAction>> = {
  '/els/v1/ls': 'status',
  '/els/v1/read': 'read',
  '/els/v1/do': 'do',
  '/els/v1/send': 'do',
  '/els/v1/new': 'new',
  '/els/v1/status': 'status',
};

const GETS = new Set(['/els/v1/ls', '/els/v1/read', '/els/v1/status']);
const POSTS = new Set(['/els/v1/do', '/els/v1/send', '/els/v1/new']);

const json = (status: number, body: unknown): { status: number; body: string } => ({ status, body: JSON.stringify(body) });

function bearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header.trim());
  return match?.[1];
}

function sourceOf(req: HttpV1Request): string {
  return (req.source ?? '').replace(/^::ffff:/, '') || 'unknown';
}

function targetFrom(url: URL, body: Record<string, unknown>): { workspace: string; pane: string } | string {
  const workspace = typeof body.workspace === 'string' ? body.workspace : (url.searchParams.get('workspace') ?? '');
  const pane = typeof body.pane === 'string' ? body.pane : (url.searchParams.get('pane') ?? url.searchParams.get('address') ?? '');
  if (!workspace || !pane) return 'need workspace and pane (or address)';
  return { workspace, pane };
}

function textFrom(url: URL, body: Record<string, unknown>): string {
  if (typeof body.text === 'string') return body.text;
  return url.searchParams.get('text') ?? '';
}

/** Fixed words for every failure (#38453 REVIEW must ③): no executor text, no raw reason, ever leaves. */
const OUTCOME_ERROR: Readonly<Record<'denied' | 'held' | 'rejected' | 'timeout' | 'audit-failed' | 'executor-error', string>> = {
  denied: 'forbidden',
  held: 'held for a person',
  rejected: 'rejected by the person',
  timeout: 'not answered in time',
  'audit-failed': 'not sent',
  'executor-error': 'executor failed',
};

const HOOK_PREFIX = '/els/v1/hook/';

async function routeHook(deps: HttpV1Deps, req: HttpV1Request, name: string): Promise<{ status: number; body: string }> {
  // #38453 REVIEW must ⑤ — a hook request counts here (or at the listener's request start) before anything
  // else, a wrong method included: the 405 answers only after the minute is spent.
  const minute = Math.floor((deps.now ?? Date.now)() / 60_000);
  if (deps.limiter && !deps.limiter.allow(sourceOf(req), minute)) return json(429, { error: 'rate limit' });
  if (req.method.toUpperCase() !== 'POST') return json(405, { error: 'method not allowed' });
  // JUD-38609 should — a name with a broken percent escape is an unknown hook (404), not a 500.
  let hookName: string;
  try { hookName = decodeURIComponent(name); } catch { return json(404, { error: 'not found' }); }
  // #38609 REVIEW must ⓑ — the ledger is required on the deps: the caller (listener or direct) owns
  // one nonce Map for the life of the server, so a direct call refuses a replay like the listener does.
  return routeElsHook({
    stateDir: deps.stateDir,
    execute: deps.execute,
    nonces: deps.nonces,
    ...(deps.paneIsShell ? { paneIsShell: deps.paneIsShell } : {}),
    ...(deps.hitl ? { hitl: deps.hitl } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.askGraphFirstFiring ? { askGraphFirstFiring: deps.askGraphFirstFiring } : {}),
  }, {
    name: hookName,
    body: req.body ?? '',
    source: sourceOf(req),
    ...(req.hookSignature !== undefined ? { signature: req.hookSignature } : {}),
    ...(req.hookTimestamp !== undefined ? { timestamp: req.hookTimestamp } : {}),
    ...(req.hookNonce !== undefined ? { nonce: req.hookNonce } : {}),
  });
}

/** One /els/v1 request. Pure enough to call without a socket; the listen path uses the same function. */
export async function routeElsHttpV1(deps: HttpV1Deps, req: HttpV1Request): Promise<{ status: number; body: string }> {
  const url = new URL(req.rawUrl, 'http://els.local');
  if (url.pathname.startsWith(HOOK_PREFIX)) return routeHook(deps, req, url.pathname.slice(HOOK_PREFIX.length));
  // #38453 REVIEW must ⑤ — the minute is spent before anything is decided: an unknown path, a wrong method
  // and (on the listener) an oversized body are all traffic from the same source.
  const source = sourceOf(req);
  const minute = Math.floor((deps.now ?? Date.now)() / 60_000);
  if (deps.limiter && !deps.limiter.allow(source, minute)) return json(429, { error: 'rate limit' });
  const action = PATH_ACTION[url.pathname];
  if (!action) return json(404, { error: 'not found' });
  const method = req.method.toUpperCase();
  if ((method === 'GET' && !GETS.has(url.pathname)) || (method === 'POST' && !POSTS.has(url.pathname)) || (method !== 'GET' && method !== 'POST')) {
    return json(405, { error: 'method not allowed' });
  }

  const token = bearer(req.authorization);
  let pat: { name: string } | null = null;
  try { if (token) pat = matchMcpPat(token, (deps.now ?? Date.now)(), deps.patRoot); }
  catch { pat = null; }
  if (!pat) return json(401, { error: 'unauthorized' });

  let body: Record<string, unknown> = {};
  if (method === 'POST' && req.body) {
    try {
      const parsed: unknown = JSON.parse(req.body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json(400, { error: 'body must be a JSON object' });
      body = parsed as Record<string, unknown>;
    } catch { return json(400, { error: 'body must be JSON' }); }
  }
  // Principal fields in the body are ignored. The transport is the only writer.
  const principal: Principal = { id: pat.name, kind: 'http-token' };
  const target = targetFrom(url, body);
  if (typeof target === 'string') return json(400, { error: target });
  // #38453 REVIEW must ② — the pane kind comes from the owner's journal, never from the request; a pane the
  // resolver cannot vouch for is a shell (fail closed), so a dangerous do still needs a person.
  const shell = deps.paneIsShell ? deps.paneIsShell(target.workspace, target.pane) : true;
  const controlTarget: ControlTarget = { workspace: target.workspace, pane: target.pane, shell };
  const text = textFrom(url, body);

  const control = createControl({
    stateDir: deps.stateDir,
    execute: deps.execute,
    now: deps.now,
    ...(deps.hitl ? { hitl: deps.hitl } : {}),
  });
  // #38453 REVIEW must ④ — the executor sees the path the caller actually used, not the collapsed action.
  const outcome = await control.run({ principal, action, target: controlTarget, ...(text ? { text } : {}), path: url.pathname });
  return outcomeToHttp(outcome);
}

function outcomeToHttp(outcome: ControlOutcome): { status: number; body: string } {
  if (!outcome.ok) {
    const status = outcome.code === 'denied' ? 403 : outcome.code === 'held' || outcome.code === 'rejected' || outcome.code === 'timeout' ? 409 : 500;
    return json(status, { error: OUTCOME_ERROR[outcome.code], code: outcome.code });
  }
  return json(outcome.exitCode === 0 ? 200 : outcome.exitCode === 2 ? 400 : 409, {
    ok: true,
    exitCode: outcome.exitCode,
    danger: outcome.danger,
    ...(outcome.queued !== undefined ? { queued: outcome.queued } : {}),
  });
}

function headerField<K extends string>(key: K, value: string | string[] | undefined): { [P in K]?: string } {
  return typeof value === 'string' ? { [key]: value } as { [P in K]?: string } : {};
}

const MAX_BODY_BYTES = 64 * 1024;

/** Listen on loopback or a tailnet address. Refuses any other bind, same rule as the read window. */
export function startElsHttpV1(deps: HttpV1Deps, bind: ElsHttpBind): Promise<Server> {
  if (!isAllowedBindAddress(bind.host)) return Promise.reject(new Error(`els http v1: ${bind.host} is not a loopback or tailnet address`));
  // One limiter for the life of the server; the nonce ledger is required on the deps (#38609 REVIEW
  // must ⓑ) — per-request ones would never remember anything.
  const { limiter: shared, ...router } = deps;   // the router runs without a limiter: the minute is spent below
  const limiter = shared ?? new MinuteIpLimiter(deps.rateLimitPerMinute ?? 60);
  const server = createServer((req, res) => {
    // #38453 REVIEW must ⑤ — counting starts with the request itself, before the body begins to arrive: a
    // request the listener answers without routing (oversized body, rate limit) still spends the minute.
    const source = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '') || 'unknown';
    const minute = Math.floor((deps.now ?? Date.now)() / 60_000);
    if (!limiter.allow(source, minute)) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate limit' }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_BODY_BYTES) tooLarge = true; else chunks.push(chunk); });
    req.on('end', () => {
      if (tooLarge) { res.writeHead(413, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'body too large' })); return; }
      const body = Buffer.concat(chunks).toString('utf8');
      // The minute was already spent at the top, so the router runs without a limiter (no double count).
      void routeElsHttpV1(router, {
        method: req.method ?? 'GET',
        rawUrl: req.url ?? '/',
        body,
        authorization: req.headers.authorization,
        source: req.socket.remoteAddress ?? '',
        ...headerField('hookSignature', req.headers['x-els-signature']),
        ...headerField('hookTimestamp', req.headers['x-els-timestamp']),
        ...headerField('hookNonce', req.headers['x-els-nonce']),
      }).then(({ status, body: payload }) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(payload);
      }).catch((error: unknown) => {
        // #38453 REVIEW must ③ — the exception text stays on stderr; the socket sees a fixed word.
        process.stderr.write(`els: http v1 request failed: ${error instanceof Error ? error.message : String(error)}\n`);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(bind.port, bind.host, () => {
      server.off('error', reject);
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
