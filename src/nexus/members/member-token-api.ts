import type { MemberStore, MemberAccessMatch } from './member-store.js';
import { isIP } from 'node:net';

const MAX_BODY_BYTES = 16 * 1024;
// relay.connect is minted before the guarded relay consumer lands; scraps/board await their routes.
const SCOPES = new Set(['llm.proxy', 'relay.connect']);
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
function bearer(request: Request): string | null {
  return /^Bearer (\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? null;
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES || !request.body) throw new Error('invalid-request');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let raw = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(raw + decoder.decode());
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error('invalid-request');
      }
      raw += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

export function createMemberTokenApi(options: { store: MemberStore; now?: () => number }) {
  const now = options.now ?? Date.now;
  return {
    memberForScope(request: Request, scope: string, audience?: string): MemberAccessMatch | null {
      const token = bearer(request);
      return token ? options.store.memberForAccessToken(token, scope, audience, new Date(now()).toISOString()) : null;
    },
    async handle(request: Request): Promise<Response> {
      if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
      const key = bearer(request);
      const member = key ? options.store.memberForKey(key, new Date(now()).toISOString()) : null;
      if (!member) return json({ error: 'unauthorized' }, 401);
      let body: unknown;
      try { body = await readBoundedJson(request); } catch { return json({ error: 'invalid-request' }, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'invalid-request' }, 400);
      const input = body as Record<string, unknown>;
      if (Object.keys(input).some(key => !['scopes', 'ttlSec', 'audience'].includes(key))
        || !Array.isArray(input.scopes) || input.scopes.length < 1 || input.scopes.length > 16
        || input.scopes.some(scope => typeof scope !== 'string' || !SCOPES.has(scope))
        || (input.ttlSec !== undefined && (!Number.isSafeInteger(input.ttlSec) || Number(input.ttlSec) < 1 || Number(input.ttlSec) > 86_400))
        || (input.audience !== undefined && (typeof input.audience !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.audience)))
        || (input.scopes.includes('llm.proxy') && input.audience !== undefined && typeof input.audience === 'string' && isIP(input.audience) === 0)) return json({ error: 'invalid-request' }, 400);
      const plan = options.store.memberPlanForMember(member.memberId);
      if (!plan || input.scopes.some(scope => plan.entitlements[scope as string] !== true)) return json({ error: 'scope-denied' }, 403);
      try {
        const issued = options.store.mintMemberAccessToken(member.keyId, member.memberId, input.scopes as string[],
          (input.ttlSec as number | undefined) ?? 3_600, input.audience as string | undefined, new Date(now()).toISOString());
        return json(issued, 201);
      } catch { return json({ error: 'unauthorized' }, 401); }
    },
  };
}
