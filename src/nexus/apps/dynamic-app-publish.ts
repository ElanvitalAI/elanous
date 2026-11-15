import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NexusAppHost } from './app-host.js';
import { sealAppSource } from './app-source-seal.js';
import { startAppService, type AppServiceBinding } from './app-service-runtime.js';
import { publicAppAddress } from './console-address.js';
import type { DynamicAppDeployHook } from '../../agent/app-deploy-plugin.js';
import type { MemberStore } from '../members/member-store.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
const RUN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
function refuse(): never { throw new Error('dynamic app publish refused'); }
function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || realpathSync(path) !== path) refuse();
}
export interface DynamicOwner { readonly memberId: string; readonly userSlug: string }
/** The owner endpoint attests memberId; the current public handle comes from the member store. */
export function verifiedDynamicOwner(
  receipt: unknown,
  store: Pick<MemberStore, 'activeForAuth' | 'memberPlanForMember' | 'publicUserSlugForMember' | 'memberForPublicUserSlug'>,
): DynamicOwner | null {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  const memberId = (receipt as { memberId?: unknown }).memberId;
  if (typeof memberId !== 'string' || !memberId || !store.activeForAuth(memberId)
    || !store.memberPlanForMember(memberId)) return null;
  const userSlug = store.publicUserSlugForMember(memberId);
  if (!userSlug || store.memberForPublicUserSlug(userSlug) !== memberId) return null;
  return { memberId, userSlug };
}
export interface DynamicPublisherOptions {
  readonly sourceRoot: string;
  readonly sealRoot: string;
  readonly runtimeRoot: string;
  readonly appHost: NexusAppHost;
  /** Exact OP-approved test member and handle. Missing values disable publication. */
  readonly testMemberId?: string;
  readonly testHandle?: string;
  readonly testApprovalExpiresAt?: string;
  /** Server-pinned producer revision; never accepted from an agent or request body. */
  readonly issuerSourceHead?: string;
  /** Trusted exact-artifact approval; model metadata and HTTP bodies never provide this value. */
  readonly approveArtifact: (owner: DynamicOwner, runId: string, appSlug: string, artifactDigest: string) => boolean | Promise<boolean>;
  /** Short interval only for deterministic revocation tests; production checks once per second. */
  readonly authorizationPollMsForTesting?: number;
  readonly verifyPublic?: (url: string, request: Request) => Promise<{ status: number; marker: string | null }>;
}
interface LiveDeployment { id: string; ownerId: string; runId: string; appSlug: string; userSlug: string;
  artifactDigest: string; service: AppServiceBinding; timer?: ReturnType<typeof setInterval> }

export function createDynamicAppPublisher(options: DynamicPublisherOptions) {
  const sources = resolve(options.sourceRoot);
  const seals = resolve(options.sealRoot);
  const runtime = resolve(options.runtimeRoot);
  for (const path of [sources, seals, runtime]) privateDirectory(path);
  const pollMs = options.authorizationPollMsForTesting ?? 1_000;
  if (!Number.isInteger(pollMs) || pollMs < 10 || pollMs > 60_000) refuse();
  const live = new Map<string, LiveDeployment>();
  /** Cleanup never re-enters the approval gate: expiry or revocation is a reason to stop. */
  const retire = async (deployment: LiveDeployment): Promise<void> => {
    if (live.get(deployment.appSlug) !== deployment) return;
    live.delete(deployment.appSlug);
    if (deployment.timer) clearInterval(deployment.timer);
    try { options.appHost.unregisterDynamicService?.(deployment.appSlug, deployment.ownerId,
      deployment.runId, deployment.artifactDigest); }
    finally { await deployment.service.stop(); }
  };
  const approved = (owner: DynamicOwner) => !!options.testMemberId && !!options.testHandle
    && !!options.testApprovalExpiresAt && Number.isFinite(Date.parse(options.testApprovalExpiresAt))
    && Date.now() < Date.parse(options.testApprovalExpiresAt)
    && owner.memberId === options.testMemberId && owner.userSlug === options.testHandle;
  const slot = (owner: DynamicOwner, runId: string, appSlug: string) => {
    if (!approved(owner) || !RUN.test(runId) || !SLUG.test(appSlug)
      || !/^[0-9a-f]{40}$/.test(options.issuerSourceHead ?? '')) refuse();
    const hash = createHash('sha256').update(owner.memberId).digest('hex');
    const parent = join(sources, hash, runId);
    return { parent, claim: join(parent, appSlug + '.claim.json') };
  };
  const verify = options.verifyPublic ?? (async (url: string, request: Request) => {
    const relayToken = request.headers.get('x-elanous-test-relay-token');
    if (!relayToken || !/^emt_[A-Za-z0-9_-]{16,4096}$/.test(relayToken)) refuse();
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8_000),
      headers: { authorization: `Bearer ${relayToken}` } });
    await response.body?.cancel();
    return { status: response.status, marker: response.headers.get('x-elanous-dynamic-route') };
  });
  const reserve = (owner: DynamicOwner, runId: string, appSlug: string) => {
    const item = slot(owner, runId, appSlug);
    mkdirSync(item.parent, { recursive: true, mode: 0o700 });
    privateDirectory(item.parent);
    const sourceRoot = join(item.parent, appSlug + '-' + randomBytes(16).toString('hex'));
    if (existsSync(sourceRoot) || existsSync(item.claim)) refuse();
    writeFileSync(item.claim, JSON.stringify({ ownerId: owner.memberId, userSlug: owner.userSlug, runId, appSlug,
      root: sourceRoot, issuerExpiresAt: options.testApprovalExpiresAt, sourceHead: options.issuerSourceHead }),
      { flag: 'wx', mode: 0o600 });
    return { sourceRoot, ownerId: owner.memberId, userSlug: owner.userSlug, runId, appSlug,
      issuerExpiresAt: options.testApprovalExpiresAt, sourceHead: options.issuerSourceHead };
  };
  const sourceFor = (owner: DynamicOwner, runId: string, appSlug: string): string => {
    const item = slot(owner, runId, appSlug);
    const stat = lstatSync(item.claim);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2048 || (stat.mode & 0o077) !== 0) refuse();
    const claim = JSON.parse(readFileSync(item.claim, 'utf8')) as Record<string, unknown>;
    const sourceRoot = claim.root;
    if (claim.ownerId !== owner.memberId || claim.userSlug !== owner.userSlug || claim.runId !== runId
      || claim.issuerExpiresAt !== options.testApprovalExpiresAt || claim.sourceHead !== options.issuerSourceHead
      || claim.appSlug !== appSlug || typeof sourceRoot !== 'string'
      || !new RegExp('^' + appSlug + '-[0-9a-f]{32}$').test(sourceRoot.slice(item.parent.length + 1))
      || !sourceRoot.startsWith(item.parent + '/')) refuse();
    return sourceRoot;
  };
  /** Reopen the server-held claim before a trusted materializer writes any source bytes. */
  const attest = (owner: DynamicOwner, runId: string, appSlug: string) => ({
    sourceRoot: sourceFor(owner, runId, appSlug), ownerId: owner.memberId, userSlug: owner.userSlug,
    runId, appSlug, issuerExpiresAt: options.testApprovalExpiresAt, sourceHead: options.issuerSourceHead,
  });
  const sealFor = async (owner: DynamicOwner, runId: string, appSlug: string,
    stillAuthorized: () => boolean | Promise<boolean>) =>
    await sealAppSource({ sourceRoot: sourceFor(owner, runId, appSlug), sealRoot: seals,
      ownerId: owner.memberId, runId, stillAuthorized });
  const inspect = async (owner: DynamicOwner, runId: string, appSlug: string,
    stillAuthorized: () => boolean | Promise<boolean>) => {
    if (!await stillAuthorized()) refuse();
    const sealed = await sealFor(owner, runId, appSlug, stillAuthorized);
    return { status: 'inspected' as const, artifactDigest: sealed.artifactDigest,
      declaredPort: sealed.runtime.port ?? null, files: sealed.files };
  };
  const publish = async (owner: DynamicOwner, runId: string, appSlug: string, request: Request,
    stillAuthorized: () => boolean | Promise<boolean>, transactionActive: () => boolean = () => true) => {
    const authorized = async () => approved(owner) && await stillAuthorized() && approved(owner);
    const during = async () => transactionActive() && await authorized() && transactionActive();
    if (!await during() || live.has(appSlug) || !options.appHost.registerDynamicService) refuse();
    const sealed = await sealFor(owner, runId, appSlug, during);
    const approvedArtifact = async () => await authorized()
      && await options.approveArtifact(owner, runId, appSlug, sealed.artifactDigest);
    if (!await approvedArtifact() || !transactionActive()) refuse();
    let service: AppServiceBinding | undefined;
    let registered = false;
    try {
      service = await startAppService({ sealed, runtimeRoot: runtime, ownerId: owner.memberId, runId, stillAuthorized: approvedArtifact });
      if (!await during() || !await approvedArtifact()) refuse();
      const routeNonce = randomBytes(24).toString('hex');
      options.appHost.registerDynamicService({ appSlug, userSlug: owner.userSlug, ownerId: owner.memberId,
        runId, artifactDigest: sealed.artifactDigest, routeNonce, service, stillAuthorized: approvedArtifact });
      registered = true;
      const url = publicAppAddress({ appSlug, userSlug: owner.userSlug });
      const verified = await verify(url, request);
      if (verified.status !== 200 || verified.marker !== routeNonce || !await during() || !await approvedArtifact()) refuse();
      const deployment: LiveDeployment = { id: 'dyn-' + randomUUID(), ownerId: owner.memberId, runId,
        appSlug, userSlug: owner.userSlug, artifactDigest: sealed.artifactDigest, service };
      live.set(appSlug, deployment);
      deployment.timer = setInterval(() => {
        void approvedArtifact().then(ok => { if (!ok) return retire(deployment); })
          .catch(() => retire(deployment)).catch(() => {});
      }, pollMs);
      deployment.timer.unref?.();
      return { status: 'published' as const, deploymentId: deployment.id, publicUrl: url, port: service.port };
    } catch (error) {
      if (registered) {
        try { options.appHost.unregisterDynamicService?.(appSlug, owner.memberId, runId, sealed.artifactDigest); } catch { /* fail closed */ }
      }
      await service?.stop();
      throw error;
    }
  };
  const undo = async (owner: DynamicOwner, runId: string, appSlug: string, deploymentId: string) => {
    const deployment = live.get(appSlug);
    if (!deployment || deployment.id !== deploymentId || deployment.ownerId !== owner.memberId
      || deployment.runId !== runId || deployment.userSlug !== owner.userSlug) refuse();
    await retire(deployment);
    return { status: 'undone' as const, deploymentId };
  };
  return { reserve, attest, inspect, publish, undo, isApproved: approved, isPublicSlug: (slug: string) => live.has(slug),
    close: async () => { for (const deployment of [...live.values()]) await retire(deployment).catch(() => {}); } };
}
export type DynamicAppPublisher = ReturnType<typeof createDynamicAppPublisher>;

/** Bridge an authenticated prompt request to the same owner-checked product route. */
export function createDynamicAppDeployHook(
  promptRequest: Request,
  route: (request: Request) => Promise<Response | undefined>,
  relayToken?: string,
): DynamicAppDeployHook {
  const call = async (action: 'inspect' | 'publish', appId: string, runId: string) => {
    const headers = new Headers();
    for (const name of ['authorization', 'cookie', 'origin', 'sec-fetch-site']) {
      const value = promptRequest.headers.get(name); if (value) headers.set(name, value);
    }
    if (relayToken) headers.set('x-elanous-test-relay-token', relayToken);
    headers.set('content-type', 'application/json');
    const request = new Request(new URL(`/v1/apps/${appId}/dynamic-deployment`, promptRequest.url), {
      method: 'POST', headers, body: JSON.stringify({ action, runId }), signal: promptRequest.signal,
    });
    const response = await route(request);
    if (!response?.ok) throw new Error('generated app publish refused');
    return await response.json() as Record<string, unknown>;
  };
  return {
    inspect: async ({ appId, runId }) => {
      const result = await call('inspect', appId, runId);
      if (result.status !== 'inspected' || typeof result.artifactDigest !== 'string') throw new Error('generated app inspect refused');
      return { artifactDigest: result.artifactDigest };
    },
    publish: async ({ appId, runId }) => {
      const result = await call('publish', appId, runId);
      if (result.status !== 'published' || typeof result.publicUrl !== 'string') throw new Error('generated app publish refused');
      return { publicUrl: result.publicUrl };
    },
  };
}

/** Authenticated product route; source root is derived from the reservation, never from a request body. */
export function createDynamicAppPublishRoute(publisher: DynamicAppPublisher,
  resolveOwner: (request: Request) => Promise<DynamicOwner | null>, webOrigin?: string) {
  return async (request: Request): Promise<Response | undefined> => {
    const match = /^\/v1\/apps\/([a-z0-9][a-z0-9-]*)\/dynamic-deployment$/.exec(new URL(request.url).pathname);
    if (!match) return undefined;
    if (request.method !== 'POST') return Response.json({ error: 'method-not-allowed' }, { status: 405 });
    if (!request.headers.has('authorization') && !request.headers.has('cookie')) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const origin = request.headers.get('origin');
    const native = /^Bearer [A-Za-z0-9_-]+$/.test(request.headers.get('authorization') ?? '') && !request.headers.has('cookie');
    if (request.headers.get('sec-fetch-site') === 'cross-site' || (origin ? origin !== webOrigin : !native))
      return Response.json({ error: 'origin-not-allowed' }, { status: 403 });
    const gate = AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]);
    const expired = new Promise<never>((_, reject) => {
      gate.addEventListener('abort', () => reject(new Error('dynamic publish request expired')), { once: true });
    });
    const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, expired]);
    try {
      const owner = await bounded(resolveOwner(request));
      if (!owner) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) refuse();
      const reader = request.body?.getReader(); if (!reader) refuse();
      const parts: Uint8Array[] = []; let size = 0;
      try { for (;;) {
        const part = await bounded(reader.read()); if (part.done) break;
        size += part.value.byteLength;
        if (size > 8192) { await reader.cancel(); refuse(); }
        parts.push(part.value);
      } } catch { await reader.cancel().catch(() => {}); refuse(); }
      finally { reader.releaseLock(); }
      const body = JSON.parse(Buffer.concat(parts.map(part => Buffer.from(part))).toString('utf8')) as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !['action', 'runId', 'deploymentId'].includes(key))
        || typeof body.runId !== 'string') refuse();
      const slug = match[1]!;
      const credentialHeaders = new Headers();
      for (const name of ['authorization', 'cookie']) {
        const value = request.headers.get(name); if (value) credentialHeaders.set(name, value);
      }
      const stillOwner = async () => {
        const current = await resolveOwner(new Request(request.url, { headers: credentialHeaders }));
        return current?.memberId === owner.memberId && current?.userSlug === owner.userSlug;
      };
      if (gate.aborted || !await bounded(stillOwner())) refuse();
      const result = body.action === 'reserve' ? publisher.reserve(owner, body.runId, slug)
        : body.action === 'attest' ? publisher.attest(owner, body.runId, slug)
        : body.action === 'inspect' ? await bounded(publisher.inspect(owner, body.runId, slug, stillOwner))
          : body.action === 'publish' ? await bounded(publisher.publish(owner, body.runId, slug, request, stillOwner, () => !gate.aborted))
          : body.action === 'undo' && typeof body.deploymentId === 'string'
            ? await publisher.undo(owner, body.runId, slug, body.deploymentId) : refuse();
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    } catch { return Response.json({ error: 'dynamic-app-operation-refused' }, { status: 400, headers: { 'cache-control': 'no-store' } }); }
  };
}
