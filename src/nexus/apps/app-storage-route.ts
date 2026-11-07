import type { AppStorage } from './app-storage.js';
import type { AppManifest } from './app-contract.js';

const MAX_CONTROL_BODY_BYTES = 16 * 1024;
const APP_SLUG = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';

export interface AppStorageRouteRuntime {
  readonly storage?: AppStorage;
  readonly getManifest: (appSlug: string) => AppManifest | undefined;
  readonly authorize: (request: Request) => boolean | Promise<boolean>;
}

type BoundedBody = { readonly body: Uint8Array } | { readonly status: 400 | 413 };

async function readBoundedBody(request: Request, limit: number): Promise<BoundedBody> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) return { status: 400 };
    if (Number(declared) > limit) return { status: 413 };
  }
  if (!request.body) return { body: new Uint8Array() };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return { status: 413 };
      }
      chunks.push(next.value);
    }
  } catch {
    return { status: 400 };
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return { body };
}

function failed(result: { status: number; reason?: string; retryable?: boolean }): Response {
  return Response.json({ error: result.reason ?? 'storage-request-failed', ...(result.retryable ? { retryable: true } : {}) }, { status: result.status });
}

/** Storage HTTP consumer registered through Nexus's shared appRoutes list. */
export function createAppStorageRoute(runtime: AppStorageRouteRuntime): (request: Request) => Promise<Response | undefined> {
  return async request => {
    const url = new URL(request.url);
    const uploadMatch = new RegExp(`^/_app-storage/(${APP_SLUG})/.+$`).exec(url.pathname);
    if (uploadMatch) {
      const appSlug = uploadMatch[1]!;
      if (request.method.toUpperCase() !== 'PUT') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'PUT' } });
      if (!runtime.getManifest(appSlug)?.storage) return Response.json({ error: 'app-storage-not-configured' }, { status: 404 });
      const storage = runtime.storage;
      if (!storage) return Response.json({ error: 'app-storage-unavailable' }, { status: 503 });
      const authorization = storage.authorizeSignedUpload({ url: request.url, method: request.method, appSlug });
      if (authorization.status !== 200) return Response.json({ error: authorization.reason }, { status: authorization.status });
      const limit = storage.maxUploadBytes(appSlug);
      if (limit === undefined) return Response.json({ error: 'app-storage-not-configured' }, { status: 404 });
      const bounded = await readBoundedBody(request, limit);
      if ('status' in bounded) return Response.json({ error: bounded.status === 413 ? 'too-large' : 'invalid-body' }, { status: bounded.status });
      const result = storage.uploadSigned({
        url: request.url, method: request.method, body: bounded.body,
        contentType: request.headers.get('content-type') ?? '', rateLimitReserved: authorization.anonymous,
      });
      return Response.json({ ok: result.status === 201, ...(result.bytes !== undefined ? { bytes: result.bytes } : {}), ...(result.reason ? { reason: result.reason } : {}) }, { status: result.status });
    }

    const routeMatch = new RegExp(`^/v1/apps/(${APP_SLUG})/storage(?:/(uploads))?$`).exec(url.pathname);
    if (!routeMatch) return undefined;
    const appSlug = routeMatch[1]!;
    const action = routeMatch[2];
    if (!await runtime.authorize(request)) return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (!runtime.getManifest(appSlug)?.storage) return Response.json({ error: 'app-storage-not-configured' }, { status: 404 });
    const storage = runtime.storage;
    if (!storage) return Response.json({ error: 'app-storage-unavailable' }, { status: 503 });

    if (action === 'uploads') {
      if (request.method.toUpperCase() !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
      const bounded = await readBoundedBody(request, MAX_CONTROL_BODY_BYTES);
      if ('status' in bounded) return Response.json({ error: bounded.status === 413 ? 'too-large' : 'invalid-body' }, { status: bounded.status });
      let input: unknown;
      try { input = JSON.parse(new TextDecoder().decode(bounded.body)); }
      catch { return Response.json({ error: 'invalid-json' }, { status: 400 }); }
      if (typeof input !== 'object' || input === null || Array.isArray(input)
        || Object.keys(input).some(key => !['key', 'expiresInMs', 'role', 'anonymous'].includes(key))
        || typeof (input as { key?: unknown }).key !== 'string'
        || typeof (input as { expiresInMs?: unknown }).expiresInMs !== 'number'
        || ((input as { role?: unknown }).role !== undefined && typeof (input as { role?: unknown }).role !== 'string')
        || ((input as { anonymous?: unknown }).anonymous !== undefined && typeof (input as { anonymous?: unknown }).anonymous !== 'boolean')) {
        return Response.json({ error: 'invalid-input' }, { status: 400 });
      }
      const value = input as { key: string; expiresInMs: number; role?: string; anonymous?: boolean };
      try {
        const signedUrl = storage.signUploadUrl({
          appSlug, key: value.key, expiresInMs: value.expiresInMs, role: value.role ?? 'owner',
          anonymous: value.anonymous, origin: url.origin,
        });
        return Response.json({ url: signedUrl }, { headers: { 'cache-control': 'no-store' } });
      } catch {
        return Response.json({ error: 'invalid-storage-request' }, { status: 400 });
      }
    }

    if (request.method.toUpperCase() !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET' } });
    const keys = url.searchParams.getAll('key');
    if (keys.length > 1) return Response.json({ error: 'invalid-input' }, { status: 400 });
    if (keys.length === 1) {
      const result = storage.read({ appSlug, key: keys[0]! });
      if (result.status !== 200 || result.body === undefined) return failed(result);
      return new Response(new Uint8Array(result.body), { status: 200, headers: {
        'content-type': result.contentType ?? 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.filename ?? 'download')}`,
        'cache-control': 'no-store',
      } });
    }
    const result = storage.list(appSlug);
    if (result.status !== 200) return failed(result);
    return Response.json({ files: result.files }, { headers: { 'cache-control': 'no-store' } });
  };
}
