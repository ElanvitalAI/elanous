import { join } from 'node:path';
import { createGlobalRequestLimiter } from '../api/request-limiter.js';
import { handleMarkdownServe } from '../api/markdown-publish.js';
import { nexusRootDir } from '../paths.js';
import { createPublishArtifactStore, isValidPublishId } from '../../publishing/artifact-store.js';
import { createMarkdownRenderer } from '../../publishing/markdown-renderer.js';
import { MarkdownPublisher, MarkdownPublishError } from '../../publishing/markdown-publisher.js';
import { MAX_MARKDOWN_UTF8_BYTES, MAX_TITLE_CHARACTERS, type PublishRequest } from '../../publishing/types.js';
import type { AppManifest } from './app-contract.js';
import type { NexusAppHost } from './app-host.js';
import { parsePublicAppHost } from '../../relay/relay-server.js';
import { publicAppAddress } from './console-address.js';

/** A deployment may report success only for the authenticated owner's exact app origin. */
export function verifiedAppDeploymentUrl(appSlug: string, userSlug: string, value: string): string {
  const expected = publicAppAddress({ appSlug, userSlug });
  const url = new URL(value);
  if (url.origin !== expected || url.protocol !== 'https:' || url.username || url.password || url.port
    || url.pathname !== '/' || url.search || url.hash) throw new Error('public app URL is invalid');
  return url.toString();
}

const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const APP_HOST_SUFFIX = '.app.localhost';
const PUBLIC_APP_DOMAIN = 'elanous.app';
const MAX_REQUEST_BYTES = MAX_MARKDOWN_UTF8_BYTES + 8_192;
const SHARE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox";

export interface AppPublishRenderRuntime {
  readonly getManifest: (appSlug: string) => AppManifest | undefined;
  readonly authorizeOwner: (request: Request, appSlug: string) => boolean | Promise<boolean>;
  /** Isolated tests inject a disposable path; production uses the Nexus state resolver. */
  readonly rootForApp?: (appSlug: string) => string;
  readonly originForApp: (appSlug: string) => string;
  readonly now?: () => number;
}

export interface AppPublishRenderEntry {
  /** POST /v1/apps/:slug/publish; owner session is checked before parsing the payload. */
  readonly handleApiRequest: (request: Request) => Promise<Response | undefined>;
  /** GET /share/:publishId on the app's isolated hostname. */
  readonly handleShareRequest: (request: Request) => Response | undefined;
}

export interface AppPublishServerAdapter {
  readonly appHost: NexusAppHost;
  readonly handleApiRequest: (request: Request) => Promise<Response | undefined>;
}

function appPublishRootDir(appSlug: string): string {
  if (!APP_SLUG.test(appSlug)) throw new Error('invalid app slug');
  return join(nexusRootDir(), 'apps', appSlug, 'published');
}

function jsonError(error: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ error }, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

function publicOriginForApp(runtime: AppPublishRenderRuntime, appSlug: string): string {
  const origin = runtime.originForApp(appSlug);
  let parsed: URL;
  try { parsed = new URL(origin); }
  catch { throw new Error('app publish origin must be an absolute public URL'); }
  const host = parsePublicAppHost(parsed.host, PUBLIC_APP_DOMAIN);
  if (parsed.protocol !== 'https:' || parsed.origin !== origin || !host || host.app !== appSlug) {
    throw new Error('app publish origin must be the app public HTTPS origin');
  }
  return parsed.origin;
}

async function readBoundedBody(request: Request): Promise<string | undefined> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_REQUEST_BYTES)) return undefined;
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(part.value);
    }
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
}

function parsePublishRequest(raw: string): PublishRequest | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['markdown', 'title', 'description', 'lang'].includes(key))) return undefined;
  if (typeof input.markdown !== 'string' || Buffer.byteLength(input.markdown, 'utf8') > MAX_MARKDOWN_UTF8_BYTES) return undefined;
  if (input.title !== undefined && (typeof input.title !== 'string' || [...input.title].length > MAX_TITLE_CHARACTERS)) return undefined;
  if (input.description !== undefined && (typeof input.description !== 'string' || [...input.description].length > 300)) return undefined;
  if (input.lang !== undefined && (typeof input.lang !== 'string' || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(input.lang))) return undefined;
  return {
    markdown: input.markdown,
    target: 'funnel',
    ...(typeof input.title === 'string' ? { title: input.title } : {}),
    ...(typeof input.description === 'string' ? { description: input.description } : {}),
    ...(typeof input.lang === 'string' ? { lang: input.lang } : {}),
  };
}

export function createAppPublishRenderEntry(runtime: AppPublishRenderRuntime): AppPublishRenderEntry {
  const limiter = createGlobalRequestLimiter();
  const perApp = new Map<string, { publisher: MarkdownPublisher; store: ReturnType<typeof createPublishArtifactStore> }>();
  const entryFor = (appSlug: string) => {
    let entry = perApp.get(appSlug);
    if (!entry) {
      const root = runtime.rootForApp?.(appSlug) ?? appPublishRootDir(appSlug);
      const store = createPublishArtifactStore({ root, ...(runtime.now ? { now: runtime.now } : {}) });
      const origin = publicOriginForApp(runtime, appSlug);
      const publisher = new MarkdownPublisher({
        store,
        origin,
        render: createMarkdownRenderer(origin),
        ...(runtime.now ? { now: runtime.now } : {}),
      });
      entry = { publisher, store };
      perApp.set(appSlug, entry);
    }
    return entry;
  };

  return {
    async handleApiRequest(request) {
      const url = new URL(request.url);
      const match = /^\/v1\/apps\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\/publish$/.exec(url.pathname);
      if (!match) return undefined;
      if (request.method.toUpperCase() !== 'POST') return jsonError('method-not-allowed', 405, { allow: 'POST' });
      const appSlug = match[1]!;
      let authorized = false;
      try { authorized = await runtime.authorizeOwner(request, appSlug); } catch { /* fail closed */ }
      if (!authorized) return jsonError('unauthorized', 401);
      const manifest = runtime.getManifest(appSlug);
      if (!manifest || manifest.slug !== appSlug) return jsonError('app-not-found', 404);
      if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') ?? '')) {
        return jsonError('json-required', 415);
      }
      const raw = await readBoundedBody(request);
      if (raw === undefined) return jsonError('invalid-or-oversized-body', 413);
      const publishRequest = parsePublishRequest(raw);
      if (!publishRequest) return jsonError('invalid-publish-request', 400);
      const permit = limiter.acquire();
      if (!permit.ok) return permit.response;
      try {
        const { publisher } = entryFor(appSlug);
        const published = publisher.publish(publishRequest);
        const origin = publicOriginForApp(runtime, appSlug);
        const shareUrl = new URL(`/share/${published.id}`, origin).toString();
        return Response.json({ id: published.id, version: published.id, shareUrl, createdAt: published.createdAt, expiresAt: published.expiresAt }, {
          status: 201,
          headers: { 'cache-control': 'no-store' },
        });
      } catch (error) {
        if (error instanceof MarkdownPublishError) return jsonError('publish-rejected', 422);
        return jsonError('publish-failed', 500);
      } finally {
        permit.release();
      }
    },
    handleShareRequest(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/share/')) return undefined;
      if (request.method !== 'GET' && request.method !== 'HEAD') return jsonError('method-not-allowed', 405, { allow: 'GET, HEAD' });
      const host = (request.headers.get('host') ?? url.host).toLowerCase().replace(/:\d+$/, '');
      if (!host.endsWith(APP_HOST_SUFFIX)) return jsonError('not-found', 404);
      const appSlug = host.slice(0, -APP_HOST_SUFFIX.length);
      const match = /^\/share\/([A-Za-z0-9_-]{22})$/.exec(url.pathname);
      if (!APP_SLUG.test(appSlug) || !match || !runtime.getManifest(appSlug)) return jsonError('not-found', 404);
      const id = match[1]!;
      if (!isValidPublishId(id)) return jsonError('not-found', 404);
      let response = handleMarkdownServe(id, { publisher: entryFor(appSlug).publisher, limiter, store: entryFor(appSlug).store });
      if (response.status !== 200) return response;
      const headers = new Headers(response.headers);
      headers.set('x-app-version', id);
      headers.set('cache-control', 'public, max-age=300');
      headers.set('content-security-policy', SHARE_CSP);
      headers.set('referrer-policy', 'no-referrer');
      headers.set('x-content-type-options', 'nosniff');
      return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
    },
  };
}

/** Put the public share route before NexusAppHost's static file fallback without editing that hot module. */
export function withAppPublishRenderEntry(appHost: NexusAppHost, entry: AppPublishRenderEntry): NexusAppHost {
  return {
    get slugs() { return appHost.slugs; },
    getManifest: appSlug => appHost.getManifest(appSlug),
    issueInvitation: (appSlug, invitedBy, ttlMs, role) => appHost.issueInvitation(appSlug, invitedBy, ttlMs, role),
    issueOwnerSession: (appSlug, memberId) => appHost.issueOwnerSession(appSlug, memberId),
    resolveVerifiedOwner: (appSlug, credential, members, publicUserId) => appHost.resolveVerifiedOwner(appSlug, credential, members, publicUserId),
    resolveVerifiedMemberOwner: (credential, members, publicUserId) => appHost.resolveVerifiedMemberOwner(credential, members, publicUserId),
    databaseBackupStatus: appSlug => appHost.databaseBackupStatus(appSlug),
    restoreDatabaseBackup: (appSlug, targetPath) => appHost.restoreDatabaseBackup(appSlug, targetPath),
    mountDirectory: appSlug => appHost.mountDirectory(appSlug),
    unmountDirectory: appSlug => appHost.unmountDirectory(appSlug),
    setConceptProofResolver: resolver => appHost.setConceptProofResolver(resolver),
    close: () => appHost.close(),
    async handle(request) {
      const published = entry.handleShareRequest(request);
      if (published) return published;
      return appHost.handle(request);
    },
  };
}

/** Compose the owner publish route and public share renderer for Nexus boot wiring. */
export function createAppPublishServerAdapter(
  appHost: NexusAppHost,
  runtime: AppPublishRenderRuntime,
): AppPublishServerAdapter {
  const entry = createAppPublishRenderEntry(runtime);
  return {
    appHost: withAppPublishRenderEntry(appHost, entry),
    handleApiRequest: request => entry.handleApiRequest(request),
  };
}
