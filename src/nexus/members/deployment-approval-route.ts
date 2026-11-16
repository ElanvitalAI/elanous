import type { DeploymentGrantBinding } from './deployment-grant-store.js';
import type { openDeploymentApprovalStore } from './deployment-approval-store.js';

type ApprovalStore = ReturnType<typeof openDeploymentApprovalStore>;
export interface DeploymentApprovalRouteOptions {
  readonly store?: ApprovalStore;
  readonly officialOrigin?: string;
  /** Resolve a fresh verified native APS app session; never trust a caller memberId. */
  readonly resolveOwner?: (appSlug: string, token: string) => Promise<{ memberId: string } | null>;
  /** Resolve a fresh verified same-owner browser cookie, not a bearer credential. */
  readonly resolveBrowserOwner?: (request: Request, appSlug: string) => Promise<{ memberId: string } | null>;
  readonly activeBinding?: (binding: DeploymentGrantBinding) => Promise<boolean>;
}

const base = '/v1/members/deployment-approvals';
const intentPath = base + '/intents';
const confirmPath = new RegExp(`^${base}/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`);
const pollPath = new RegExp(`^${intentPath}/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/poll$`);
const approvePath = new RegExp(`^${base}/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/approve$`);
const headers = { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'same-origin' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });

function aps(request: Request): string | null {
  const match = /^Bearer (aps_[A-Za-z0-9_-]+)$/.exec(request.headers.get('authorization') ?? '');
  return match?.[1] ?? null;
}

async function within<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('request-timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('request-timeout')), remaining);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function boundedText(request: Request, limit: number, deadline: number): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('body-required');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await within(reader.read(), deadline);
      if (done) break;
      length += value.byteLength;
      if (length > limit) { void reader.cancel(); throw new Error('request-too-large'); }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { try { reader.releaseLock(); } catch { /* a cancelled read can still be pending */ } }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

function parseIntent(value: unknown): (Omit<DeploymentGrantBinding, 'memberId'> & { expiresAt: string }) | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== 'appSlug,artifactDigest,deploymentId,expiresAt,relayKeyId,runId,sourceHead') return null;
  if (typeof row.appSlug !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/.test(row.appSlug)
    || typeof row.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(row.runId)
    || typeof row.deploymentId !== 'string' || !/^dyn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.deploymentId)
    || typeof row.sourceHead !== 'string' || !/^[a-f0-9]{40}$/.test(row.sourceHead)
    || typeof row.artifactDigest !== 'string' || !/^[a-f0-9]{64}$/.test(row.artifactDigest)
    || typeof row.relayKeyId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.relayKeyId)
    || typeof row.expiresAt !== 'string' || !Number.isFinite(Date.parse(row.expiresAt))) return null;
  return row as Omit<DeploymentGrantBinding, 'memberId'> & { expiresAt: string };
}

const html = (body: string, status = 200) => new Response(body, { status, headers: {
  'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; form-action 'self'; base-uri 'none'",
  'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff' } });
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!);

/** These routes require an authoritative store and two real, distinct session resolvers. */
export function createDeploymentApprovalRoute(options: DeploymentApprovalRouteOptions) {
  return {
    async handle(request: Request): Promise<Response | undefined> {
      const deadline = Date.now() + 5_000;
      const url = new URL(request.url);
      const confirm = confirmPath.exec(url.pathname);
      const approve = approvePath.exec(url.pathname);
      const poll = pollPath.exec(url.pathname);
      if (url.pathname !== intentPath && !confirm && !approve && !poll) return undefined;
      if (!options.store || !options.officialOrigin || !options.resolveOwner
        || !options.resolveBrowserOwner || !options.activeBinding) return json(503, { error: 'approval-authority-unavailable' });
      if (url.origin !== options.officialOrigin) return json(403, { error: 'wrong-origin' });
      try {
        if (url.pathname === intentPath) {
          if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' });
          if (request.headers.has('cookie') || request.headers.has('origin')) return json(403, { error: 'native-session-required' });
          const token = aps(request);
          if (!token) return json(401, { error: 'unauthorized' });
          if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') ?? ''))
            return json(400, { error: 'json-required' });
          const input = parseIntent(JSON.parse(await boundedText(request, 4096, deadline)));
          if (!input) return json(400, { error: 'invalid-request' });
          const owner = await within(options.resolveOwner(input.appSlug, token), deadline);
          if (!owner) return json(401, { error: 'unauthorized' });
          const binding = { memberId: owner.memberId, appSlug: input.appSlug, runId: input.runId,
            deploymentId: input.deploymentId, sourceHead: input.sourceHead,
            artifactDigest: input.artifactDigest, relayKeyId: input.relayKeyId };
          if (!await within(options.activeBinding(binding), deadline)) return json(403, { error: 'inactive-binding' });
          if (Date.now() >= deadline) return json(504, { error: 'request-timeout' });
          const proposed = options.store.propose(binding, input.expiresAt);
          if (!proposed) return json(400, { error: 'invalid-expiry' });
          return json(201, { ...proposed, approvalUrl: options.officialOrigin + base + '/' + proposed.approvalId });
        }
        if (poll) {
          if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' });
          if (request.headers.has('cookie') || request.headers.has('origin')) return json(403, { error: 'native-session-required' });
          const token = aps(request);
          if (!token) return json(401, { error: 'unauthorized' });
          // A caller cannot select the app or owner. Resolve the app from the server row.
          const stored = options.store.lookup(poll[1]!);
          if (!stored) return json(403, { error: 'denied' });
          const owner = await within(options.resolveOwner(stored.appSlug, token), deadline);
          if (!owner || owner.memberId !== stored.memberId) return json(403, { error: 'denied' });
          if (!await within(options.activeBinding(stored), deadline)) return json(403, { error: 'denied' });
          const state = options.store.poll(stored.approvalId, owner.memberId);
          if (state.status === 'pending') return json(202, { status: 'pending', pendingExpiresAt: state.pendingExpiresAt });
          if (state.status === 'expired') return json(410, { error: 'expired' });
          if (state.status === 'denied') return json(403, { error: 'denied' });
          const a = state.approval;
          return json(200, { approvalId: a.approvalId, memberId: a.memberId, appSlug: a.appSlug,
            runId: a.runId, deploymentId: a.deploymentId, sourceHead: a.sourceHead,
            artifactDigest: a.artifactDigest, relayKeyId: a.relayKeyId,
            expiresAt: a.approvedExpiresAt });
        }
        const id = (confirm ?? approve)![1]!;
        const stored = options.store.lookup(id);
        if (!stored) return json(404, { error: 'not-found' });
        if (request.headers.has('authorization')) return json(403, { error: 'browser-session-required' });
        const owner = await within(options.resolveBrowserOwner(request, stored.appSlug), deadline);
        if (!owner || owner.memberId !== stored.memberId) return json(404, { error: 'not-found' });
        if (!await within(options.activeBinding(stored), deadline)) return json(403, { error: 'inactive-binding' });
        if (confirm) {
          if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' });
          const prepared = options.store.prepareConfirmation(id, owner.memberId);
          if (!prepared) return json(410, { error: 'expired-or-approved' });
          const a = prepared.approval;
          return html(`<!doctype html><meta charset="utf-8"><title>Approve deployment</title><h1>Approve deployment</h1><p>App: ${escapeHtml(a.appSlug)}</p><p>Run: ${escapeHtml(a.runId)}</p><p>Source: ${escapeHtml(a.sourceHead)}</p><p>Artifact: ${escapeHtml(a.artifactDigest)}</p><p>Expires: ${escapeHtml(a.requestedExpiresAt)}</p><form method="post" action="${base}/${id}/approve"><input type="hidden" name="nonce" value="${prepared.nonce}"><button type="submit">Approve</button></form>`);
        }
        if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' });
        if (request.headers.get('origin') !== options.officialOrigin) return json(403, { error: 'wrong-origin' });
        if (!/^application\/x-www-form-urlencoded(?:\s*;|\s*$)/i.test(request.headers.get('content-type') ?? ''))
          return json(400, { error: 'form-required' });
        const form = new URLSearchParams(await boundedText(request, 1024, deadline));
        if ([...form.keys()].join() !== 'nonce') return json(400, { error: 'invalid-form' });
        const approved = options.store.approve(id, owner.memberId, form.get('nonce') ?? '');
        return approved ? html('<!doctype html><meta charset="utf-8"><p>Deployment approved.</p>')
          : json(410, { error: 'expired-or-invalid' });
      } catch (error) {
        if ((error as Error).message === 'request-too-large') return json(413, { error: 'request-too-large' });
        if ((error as Error).message === 'request-timeout') return json(504, { error: 'request-timeout' });
        if (error instanceof SyntaxError || (error as Error).message === 'body-required') return json(400, { error: 'invalid-request' });
        return json(503, { error: 'approval-authority-unavailable' });
      }
    },
  };
}
