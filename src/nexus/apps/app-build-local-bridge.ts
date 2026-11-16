import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { TuiMemberSession } from '../../tui/member-session-contract.js';
import { createDynamicAppPublishRoute, type DynamicAppPublisher } from './dynamic-app-publish.js';
import { publicAppAddress } from './console-address.js';
import type { AppBuildRunAuthority } from './app-build-run-authority.js';

export const OFFICIAL_MEMBER_ORIGIN = 'https://api.elanous.ai';
// Same bounded control envelope as C's dynamic-deployment route.
const MAX_CONTROL_BYTES = 8 * 1024;
// Owner verification uses the existing dashboard owner resolver deadline.
const OWNER_TIMEOUT_MS = 5_000;
function refuse(): never { throw new Error('BUILD_LOCAL_ISSUER_REFUSED'); }
function privateText(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_CONTROL_BYTES
    || (stat.mode & 0o077) !== 0 || realpathSync(path) !== path
    || process.getuid && stat.uid !== process.getuid()) refuse();
  return readFileSync(path, 'utf8');
}

/** Existing local control credential only: never create/copy an SDK session. */
export function readLocalAppBuildIssuer(configDir: string, runtimePath: string): { origin: string; token: string } {
  try {
    const runtime = JSON.parse(privateText(runtimePath));
    if (!runtime || runtime.httpAuth !== 'on' || !Number.isSafeInteger(runtime.httpPort) || runtime.httpPort <= 0
      || !Number.isSafeInteger(runtime.pid) || runtime.pid <= 0) refuse();
    process.kill(runtime.pid, 0);
    const origin = new URL('http://127.0.0.1:' + runtime.httpPort).origin;
    const token = privateText(join(configDir, 'acp-token')).trim();
    if (!/^[A-Za-z0-9_-]+$/u.test(token)) refuse();
    return { origin, token };
  } catch { refuse(); }
}

type Options = {
  sourceHead?: string; publisher: DynamicAppPublisher;
  /** Must require the existing local control bearer, excluding noauth/temp tokens. */
  authorizeControl: (request: Request) => boolean;
  /** Host transport metadata only; never derive this from request headers or URL. */
  peerAddress: (request: Request) => string | undefined;
  getSession: () => TuiMemberSession | undefined; fetcher?: typeof fetch;
  /** Existing operator-approved relay verification credential; never request supplied. */
  relayToken?: string;
  runAuthority?: AppBuildRunAuthority;
};

async function boundedAction(request: Request): Promise<{ action: string; runId: string }> {
  const reader = request.clone().body?.getReader(); if (!reader) refuse();
  const parts: Uint8Array[] = []; let size = 0;
  try { for (;;) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.byteLength; if (size > MAX_CONTROL_BYTES) { await reader.cancel(); refuse(); }
    parts.push(part.value);
  } } finally { reader.releaseLock(); }
  const item = JSON.parse(Buffer.concat(parts).toString('utf8')) as { action?: unknown; runId?: unknown };
  if (!item || typeof item !== 'object' || typeof item.action !== 'string'
    || !['reserve', 'attest', 'inspect', 'approval-start', 'approval-poll', 'publish', 'undo'].includes(item.action)
    || typeof item.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u.test(item.runId)) refuse();
  return { action: item.action, runId: item.runId };
}

/** Installed local issuer bridge: local control authority plus a fresh official SDK
 * owner verification invokes the existing local C issuer, seal, and publisher. */
export function createAppBuildLocalIssuerBridge(options: Options) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const match = /^\/v1\/apps\/([a-z0-9][a-z0-9-]*)\/dynamic-deployment-local$/u.exec(url.pathname);
    if (!match) return undefined;
    const denied = (status: number) => Response.json({ error: 'local-issuer-refused' }, {
      status, headers: { 'cache-control': 'no-store' },
    });
    if (request.method !== 'POST') return denied(405);
    const peer = options.peerAddress?.(request);
    if (peer !== '127.0.0.1' && peer !== '::1') return denied(403);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || request.headers.has('origin') || request.headers.has('cookie')
      || request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'none') return denied(403);
    if (!options.authorizeControl(request)) return denied(401);
    const expectedOwner = request.headers.get('x-elanous-app-build-owner');
    const expectedHead = request.headers.get('x-elanous-app-build-head');
    if (!expectedOwner || !/^[0-9a-f]{40}$/u.test(options.sourceHead ?? '') || expectedHead !== options.sourceHead) return denied(403);
    let operation: { action: string; runId: string };
    try { operation = await boundedAction(request); } catch { return denied(400); }
    let verifiedReserveSession: TuiMemberSession | undefined;
    const resolveOwner = async () => {
      try {
        // Cleanup remains available after the build seal expires. The publisher
        // checks the live deployment/grant identity before revoking it.
        if (options.runAuthority && operation.action !== 'reserve' && operation.action !== 'undo'
          && operation.action !== 'approval-start' && operation.action !== 'approval-poll') {
          const owner = options.runAuthority.resolve(operation.runId, match[1]!, options.sourceHead!);
          return owner?.memberId === expectedOwner ? owner : null;
        }
        const session = options.getSession();
        if (!session || session.nexusUrl !== OFFICIAL_MEMBER_ORIGIN || session.appSlug !== match[1]
          || !/^aps_[A-Za-z0-9_-]+$/u.test(session.sessionToken)) return null;
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(OWNER_TIMEOUT_MS)]);
        const response = await (options.fetcher ?? fetch)(OFFICIAL_MEMBER_ORIGIN + '/v1/members/owner?'
          + new URLSearchParams({ appSlug: match[1]! }), {
          method: 'GET', redirect: 'manual', credentials: 'omit', signal,
          headers: { authorization: 'Bearer ' + session.sessionToken, accept: 'application/json' },
        });
        if (!response.ok) { await response.body?.cancel(); return null; }
        const reader = response.body?.getReader(); if (!reader) return null;
        const parts: Uint8Array[] = []; let size = 0;
        try { for (;;) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_CONTROL_BYTES) { await reader.cancel(); return null; }
          parts.push(part.value);
        } } finally { reader.releaseLock(); }
        const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
        if (!value || value.memberId !== expectedOwner || typeof value.userSlug !== 'string') return null;
        publicAppAddress({ appSlug: match[1]!, userSlug: value.userSlug });
        if (operation.action === 'reserve') verifiedReserveSession = session;
        return { memberId: value.memberId as string, userSlug: value.userSlug as string };
      } catch { return null; }
    };
    // C's native route and repeated stillOwner checks remain intact. Only the
    // trusted server can supply the test relay verification credential.
    const headers = new Headers(request.headers);
    headers.delete('x-elanous-test-relay-token');
    if (options.relayToken) headers.set('x-elanous-test-relay-token', options.relayToken);
    const target = new URL(url);
    target.pathname = '/v1/apps/' + match[1]! + '/dynamic-deployment';
    const forwarded = new Request(target, request);
    for (const key of [...forwarded.headers.keys()]) forwarded.headers.delete(key);
    for (const [key, value] of headers) forwarded.headers.set(key, value);
    const route = createDynamicAppPublishRoute(options.publisher, resolveOwner);
    const response = await route(forwarded);
    if (response?.ok && operation.action === 'reserve' && options.runAuthority) {
      try {
        const grant = await response.clone().json() as Parameters<AppBuildRunAuthority['issue']>[0];
        if (!verifiedReserveSession) refuse();
        options.runAuthority.issue(grant, verifiedReserveSession);
      } catch { return denied(403); }
    }
    return response;
  };
}
