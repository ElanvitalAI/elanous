import type { DeploymentGrantBinding, DeploymentGrantStore } from './deployment-grant-store.js';

export interface DeploymentGrantRouteOptions {
  readonly store?: DeploymentGrantStore;
  /** Must resolve an official fresh aps_ app session and server-owned app slot/entitlement. */
  readonly resolveOwner?: (appSlug: string, sessionToken: string) => Promise<{ memberId: string } | null>;
  /** Must check current membership, deployment entitlement and referenced relay key ownership/state. */
  readonly activeBinding?: (binding: DeploymentGrantBinding) => Promise<boolean>;
}

const jsonHeaders = { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer' };
const issuePath = '/v1/members/deployment-grants';
const introspectPath = issuePath + '/introspect';
// Match the publisher's app/run grammar; authority is still resolved from the server session.
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function bearer(request: Request, prefix: 'aps_' | 'dpg_'): string | null {
  const value = request.headers.get('authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(value);
  return match?.[1]?.startsWith(prefix) ? match[1] : null;
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

async function boundedJson(request: Request, deadline: number): Promise<unknown> {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') ?? '')) throw new Error('json-required');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid-json');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await within(reader.read(), deadline);
      if (done) break;
      length += value.byteLength;
      if (length > 4096) throw new Error('request-too-large');
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { try { reader.releaseLock(); } catch { /* pending cancellation */ } }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new Error('invalid-json'); }
}

type IssueBody = {
  approvalId: string;
  appSlug: string; runId: string; deploymentId: string; sourceHead: string; artifactDigest: string;
  relayKeyId: string; expiresAt: string;
};

function issueBody(value: unknown): IssueBody | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join() !== 'appSlug,approvalId,artifactDigest,deploymentId,expiresAt,relayKeyId,runId,sourceHead') return null;
  if (typeof object.approvalId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(object.approvalId)
    || typeof object.appSlug !== 'string' || !APP_SLUG.test(object.appSlug)
    || typeof object.runId !== 'string' || !RUN_ID.test(object.runId)
    || typeof object.deploymentId !== 'string' || !/^dyn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(object.deploymentId)
    || typeof object.sourceHead !== 'string' || !/^[a-f0-9]{40}$/.test(object.sourceHead)
    || typeof object.artifactDigest !== 'string' || !/^[a-f0-9]{64}$/.test(object.artifactDigest)
    || typeof object.relayKeyId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(object.relayKeyId)
    || typeof object.expiresAt !== 'string' || !Number.isFinite(Date.parse(object.expiresAt))) return null;
  return object as IssueBody;
}

/** Register this before the generic members route. Absent authority callbacks fail closed. */
export function createDeploymentGrantRoute(options: DeploymentGrantRouteOptions) {
  return {
    async handle(request: Request): Promise<Response | undefined> {
      const path = new URL(request.url).pathname;
      const revokeMatch = /^\/v1\/members\/deployment-grants\/([0-9a-f-]{36})$/.exec(path);
      if (path !== issuePath && path !== introspectPath && !revokeMatch) return undefined;
      const deadline = Date.now() + 5_000;
      if (!options.store || !options.resolveOwner || !options.activeBinding)
        return json(503, { error: 'grant-authority-unavailable' });
      if (request.headers.has('cookie') || request.headers.has('origin')) return json(403, { error: 'native-session-required' });

      if (path === issuePath) {
        if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' });
        const token = bearer(request, 'aps_');
        if (!token) return json(401, { error: 'unauthorized' });
        let value: unknown;
        try { value = await boundedJson(request, deadline); }
        catch (error) { return json((error as Error).message === 'request-too-large' ? 413
          : (error as Error).message === 'request-timeout' ? 504 : 400,
          { error: (error as Error).message }); }
        const input = issueBody(value);
        if (!input) return json(400, { error: 'invalid-request' });
        try {
          const owner = await within(options.resolveOwner(input.appSlug, token), deadline);
          if (!owner) return json(401, { error: 'unauthorized' });
          const binding = { memberId: owner.memberId, appSlug: input.appSlug, runId: input.runId,
            deploymentId: input.deploymentId,
            sourceHead: input.sourceHead, artifactDigest: input.artifactDigest, relayKeyId: input.relayKeyId };
          if (!await within(options.activeBinding(binding), deadline)) return json(401, { error: 'unauthorized' });
          if (Date.now() >= deadline) return json(504, { error: 'request-timeout' });
          const issued = options.store.issue({ ...binding, approvalId: input.approvalId,
            requestedExpiresAt: input.expiresAt });
          if (issued.status === 'invalid-expiry') return json(400, { error: 'invalid-expiry' });
          if (issued.status === 'invalid-approval') return json(403, { error: 'approval-required' });
          if (issued.status === 'already-issued') return json(409, { error: 'credential-already-issued',
            grantId: issued.grantId, grantVersion: issued.grantVersion });
          if (issued.status === 'binding-conflict') return json(409, { error: 'binding-conflict' });
          const { revokedAt: _revokedAt, issuedAt: _issuedAt, ...grant } = issued.grant;
          return json(201, { ...grant, credential: issued.credential });
        } catch (error) { return (error as Error).message === 'request-timeout'
          ? json(504, { error: 'request-timeout' }) : json(503, { error: 'grant-authority-unavailable' }); }
      }

      if (path === introspectPath) {
        if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' });
        const token = bearer(request, 'dpg_');
        if (!token) return json(401, { error: 'unauthorized' });
        try {
          const grant = options.store.byCredential(token);
          if (!grant || !await within(options.activeBinding(grant), deadline)) return json(401, { error: 'unauthorized' });
          // The live owner/key check may await I/O. Re-read the authoritative ledger
          // and expiry after it returns so a revoke or timeout during that wait wins.
          const current = options.store.byCredential(token);
          if (Date.now() >= deadline || !current || current.grantId !== grant.grantId || current.grantVersion !== grant.grantVersion)
            return json(401, { error: 'unauthorized' });
          return json(200, { grantId: current.grantId, approvalId: current.approvalId,
            memberId: current.memberId, appSlug: current.appSlug,
            runId: current.runId, deploymentId: current.deploymentId,
            sourceHead: current.sourceHead, artifactDigest: current.artifactDigest,
            relayKeyId: current.relayKeyId, expiresAt: current.expiresAt, grantVersion: current.grantVersion });
        } catch { return json(401, { error: 'unauthorized' }); }
      }

      if (request.method !== 'DELETE') return json(405, { error: 'method-not-allowed' });
      const token = bearer(request, 'aps_');
      if (!token) return json(401, { error: 'unauthorized' });
      try {
        const grant = options.store.byId(revokeMatch![1]!);
        if (!grant) return json(404, { error: 'not-found' });
        const owner = await within(options.resolveOwner(grant.appSlug, token), deadline);
        if (!owner || owner.memberId !== grant.memberId) return json(404, { error: 'not-found' });
        if (Date.now() >= deadline) return json(504, { error: 'request-timeout' });
        return options.store.revoke(grant.grantId, owner.memberId, grant.appSlug)
          ? json(200, { grantId: grant.grantId, revoked: true }) : json(404, { error: 'not-found' });
      } catch { return json(503, { error: 'grant-authority-unavailable' }); }
    },
  };
}
