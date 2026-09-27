// Node-catalog v2 (2026-05-11) — webhook router (pure dispatcher).
//
// Given a registry of webhook entries + a `runWorkflow` callback,
// `buildWebhookRouter` returns a request handler the daemon's HTTP
// server can call. The handler matches the incoming (method, path)
// against the registry, runs the auth check, and dispatches the
// workflow with the request body forwarded as `$ARGUMENTS`.
//
// Pure: no I/O of its own. The actual HTTP wiring lives in
// `src/nexus/api/http-server.ts` and is a one-line `app.all(path,
// router(req, res))` integration (v2.5 follow-up).

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookHmacAuth } from '../types.js';
import type { WebhookEntry } from './registry.js';

export interface WebhookRouterRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface WebhookRouterResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

export interface WebhookRouterOpts {
  registry: WebhookEntry[];
  /** Invoked when a webhook matches + auth passes. Receives the entry
   *  + raw request body (forwarded as the workflow's `$ARGUMENTS`).
   *  The callback should return ok=true once the workflow run is
   *  enqueued; downstream consumers can fetch the run status via the
   *  existing `/v1/workflows/runs/:runId` route. */
  runWorkflow: (
    entry: WebhookEntry,
    body: string,
  ) => Promise<{ ok: true; runId: string } | { ok: false; error: string }>;  /** Looks up the secret named by an `hmac` auth's `secretRef`. Omitted
   *  = no secrets available (every hmac route answers 500). */
  resolveSecret?: (ref: string) => string | undefined | Promise<string | undefined>;
  /** Called when auth refuses a request (never for workflow failures). */
  onAuthRejected?: (entry: WebhookEntry, res: WebhookRouterResponse) => void;
}

/** Pure: encode `basic` auth from raw username:password. Identical to
 *  the helper in `nodes/http.ts` but kept local here so the router
 *  has zero cross-module deps. */
function basicAuthHeader(username: string, password: string): string {
  const raw = `${username}:${password}`;
  const encoded =
    typeof Buffer !== 'undefined'
      ? Buffer.from(raw, 'utf8').toString('base64')
      : btoa(raw);
  return `Basic ${encoded}`;
}

/** Pure: check the inbound `Authorization` header against the
 *  registered auth. Returns null on success, or the response to
 *  emit when auth fails. Exposed for tests. */
export function checkAuth(
  entry: WebhookEntry,
  headers: Record<string, string | undefined>,
  signed: { body?: string; secret?: string } = {},
): WebhookRouterResponse | null {
  const auth = entry.trigger.auth;
  if (!auth) return null; // open
  if (auth.type === 'hmac') return checkHmac(auth, headers, signed.body ?? '', signed.secret);
  const provided = headers['authorization'] ?? headers['Authorization'];
  if (typeof provided !== 'string') {
    return { status: 401, body: 'Authorization required' };
  }
  if (auth.type === 'bearer') {
    if (provided !== `Bearer ${auth.token}`) {
      return { status: 401, body: 'Invalid bearer token' };
    }
    return null;
  }
  if (auth.type === 'basic') {
    if (provided !== basicAuthHeader(auth.username, auth.password)) {
      return { status: 401, body: 'Invalid basic credentials' };
    }
    return null;
  }
  return { status: 500, body: 'Server: unknown auth type' };
}

/** Pure: verify a provider signature over the raw body. The secret is
 *  resolved by the caller; a missing secret is a server fault (500), not
 *  a client one — the route is configured but cannot verify anything. */
export function checkHmac(
  auth: WebhookHmacAuth,
  headers: Record<string, string | undefined>,
  body: string,
  secret: string | undefined,
): WebhookRouterResponse | null {
  if (secret === undefined || secret === '') {
    return { status: 500, body: `Server: webhook secret '${auth.secretRef}' is not configured` };
  }
  const provided = headers[auth.header.toLowerCase()] ?? headers[auth.header];
  if (typeof provided !== 'string' || provided === '') {
    return { status: 401, body: 'Signature required' };
  }
  const digest = createHmac(auth.algorithm ?? 'sha256', secret).update(body, 'utf8').digest(auth.encoding ?? 'hex');
  const expected = Buffer.from(`${auth.prefix ?? ''}${digest}`, 'utf8');
  const actual = Buffer.from(provided.trim(), 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { status: 401, body: 'Invalid signature' };
  }
  return null;
}

export type WebhookRouter = {
  (req: WebhookRouterRequest): Promise<WebhookRouterResponse>;
  /** Add a webhook entry to the routing table at runtime. Idempotent
   *  on (method, path) — a re-register replaces the previous entry. */
  register(entry: WebhookEntry): void;
  /** Remove a webhook entry. Returns true when an entry was removed. */
  unregister(method: string, path: string): boolean;
  /** Snapshot of currently registered (method, path) pairs — for
   *  diagnostics. */
  routes(): ReadonlyArray<{ method: string; path: string }>;
};

export function buildWebhookRouter(opts: WebhookRouterOpts): WebhookRouter {
  // Mutable registry so the daemon can fan post-start subscriptions
  // (`registerWorkflow`) into the router without rebuilding (lazy
  // workflow discovery · 2026-05-12).
  const registry: WebhookEntry[] = [...opts.registry];

  async function dispatch(req: WebhookRouterRequest): Promise<WebhookRouterResponse> {
    const entry = registry.find(
      (w) => w.trigger.method === req.method && w.trigger.path === req.path,
    );
    if (!entry) {
      return { status: 404, body: 'No webhook registered for this route' };
    }
    const auth = entry.trigger.auth;
    const secret = auth?.type === 'hmac'
      ? await (async () => opts.resolveSecret?.(auth.secretRef))().catch(() => undefined)
      : undefined;
    const authFail = checkAuth(entry, req.headers, { body: req.body, ...(secret !== undefined ? { secret } : {}) });
    if (authFail) {
      try { opts.onAuthRejected?.(entry, authFail); } catch { /* observation must not change the answer */ }
      return authFail;
    }
    const result = await opts.runWorkflow(entry, req.body);
    if (result.ok) {
      return {
        status: 202,
        body: JSON.stringify({ ok: true, runId: result.runId, workflow: entry.workflowName }),
        headers: { 'content-type': 'application/json' },
      };
    }
    return {
      status: 500,
      body: JSON.stringify({ ok: false, error: result.error }),
      headers: { 'content-type': 'application/json' },
    };
  }

  const router = dispatch as WebhookRouter;
  router.register = (entry: WebhookEntry): void => {
    const idx = registry.findIndex(
      (w) => w.trigger.method === entry.trigger.method && w.trigger.path === entry.trigger.path,
    );
    if (idx >= 0) registry[idx] = entry;
    else registry.push(entry);
  };
  router.unregister = (method: string, path: string): boolean => {
    const idx = registry.findIndex((w) => w.trigger.method === method && w.trigger.path === path);
    if (idx < 0) return false;
    registry.splice(idx, 1);
    return true;
  };
  router.routes = (): ReadonlyArray<{ method: string; path: string }> => registry.map((w) => ({
    method: w.trigger.method,
    path: w.trigger.path,
  }));
  return router;
}
