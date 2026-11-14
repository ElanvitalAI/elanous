import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MemberStore } from './member-store.js';

const TTL_MS = 2 * 60_000;
const MAX_PENDING = 512;
const MAX_PER_CALLER = 3;
const MAX_START_ATTEMPTS = 8;
const MAX_ATTEMPT_KEYS = 1024;
const MAX_POLL_FAILURES = 8;
const USER_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const VALUE = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[A-Za-z0-9_-]{24}$/;

interface Pending {
  readonly state: string;
  readonly challenge: string;
  readonly pollHash: Buffer;
  readonly userCodeHash: Buffer;
  readonly callerKey: string;
  readonly csrf: string;
  readonly expiresAt: number;
  previewMemberId?: string;
  code?: string;
  issuing?: boolean;
  pollFailures?: number;
}

export interface MemberConnectEntryOptions {
  readonly store: Pick<MemberStore, 'createAppAuthCode' | 'ensureNativeAppSlotForMember'>;
  readonly memberForRequest: (request: Request) => string | null;
  readonly origin: string;
  readonly enabled?: boolean;
  readonly now?: () => number;
}

function response(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'private, no-store' } });
}

function busy(retryMs: number): Response {
  return Response.json({ error: 'connect-busy' }, { status: 429, headers: {
    'cache-control': 'private, no-store', 'retry-after': String(Math.max(1, Math.ceil(retryMs / 1000))),
  } });
}

async function readTextBounded(request: Request, maxBytes: number): Promise<string | null> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (!Number.isFinite(length) || length > maxBytes) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } catch { return null; }
  finally { reader.releaseLock(); }
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const text = await readTextBounded(request, 4096);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** One process holds only short-lived challenges. App auth codes remain in the existing member store. */
export function createMemberConnectEntry(options: MemberConnectEntryOptions): {
  handle(request: Request, callerKey?: string): Promise<Response | undefined>;
} {
  const pending = new Map<string, Pending>();
  const startAttempts = new Map<string, { count: number; expiresAt: number }>();
  const now = options.now ?? Date.now;
  const prune = () => {
    const at = now();
    for (const [id, item] of pending) if (item.expiresAt <= at) pending.delete(id);
    for (const [key, entry] of startAttempts) if (entry.expiresAt <= at) startAttempts.delete(key);
  };
  return { async handle(request, callerKey = 'unknown') {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!['/v1/members/connect/start', '/v1/members/connect/approve', '/v1/members/connect/poll'].includes(path)) return undefined;
    prune();

    if (path === '/v1/members/connect/start') {
      if (request.method !== 'POST') return response({ error: 'method-not-allowed' }, 405);
      if (options.enabled === false || !options.store.createAppAuthCode) return response({ error: 'issuer-unavailable' }, 503);
      const caller = callerKey.length <= 128 ? callerKey : 'unknown';
      const at = now();
      const budget = startAttempts.get(caller);
      if (budget && budget.count >= MAX_START_ATTEMPTS) return busy(budget.expiresAt - at);
      if (!budget && startAttempts.size >= MAX_ATTEMPT_KEYS) return busy(TTL_MS);
      if (budget) budget.count++;
      else startAttempts.set(caller, { count: 1, expiresAt: at + TTL_MS });
      // Count attempts before reading even malformed or indefinitely streamed bodies.
      const body = await readBody(request);
      if (!body || Object.keys(body).length !== 3 || typeof body.state !== 'string' || !VALUE.test(body.state)
        || typeof body.codeChallenge !== 'string' || !VALUE.test(body.codeChallenge)
        || typeof body.pollSecret !== 'string' || !VALUE.test(body.pollSecret)) return response({ error: 'invalid-request' }, 400);
      prune();
      const callerLimit = caller === 'unknown' ? 1 : MAX_PER_CALLER;
      const callerPending = [...pending.values()].filter(item => item.callerKey === caller);
      if (callerPending.length >= callerLimit) return busy(Math.min(...callerPending.map(item => item.expiresAt)) - now());
      if (pending.size >= MAX_PENDING) return busy(Math.min(...[...pending.values()].map(item => item.expiresAt)) - now());
      const id = randomBytes(18).toString('base64url');
      const digits = randomBytes(8);
      const userCode = [...digits].map(byte => USER_CODE_ALPHABET[byte & 31]).join('');
      const printedCode = `${userCode.slice(0, 4)}-${userCode.slice(4)}`;
      pending.set(id, { state: body.state, challenge: body.codeChallenge,
        pollHash: createHash('sha256').update(body.pollSecret).digest(),
        userCodeHash: createHash('sha256').update(printedCode).digest(), callerKey: caller,
        csrf: randomBytes(18).toString('base64url'), expiresAt: now() + TTL_MS });
      return response({ approvalUrl: `${options.origin}/v1/members/connect/approve?id=${id}`, id,
        userCode: printedCode, expiresInSeconds: TTL_MS / 1000 }, 201);
    }

    const id = url.searchParams.get('id');
    if (!id || !ID.test(id) || url.searchParams.getAll('id').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'id')) {
      return response({ error: 'not-found' }, 404);
    }
    const item = pending.get(id);
    if (!item) return response({ error: 'not-found' }, 404);

    if (path === '/v1/members/connect/poll') {
      if (request.method !== 'POST') return response({ error: 'method-not-allowed' }, 405);
      const body = await readBody(request);
      if (pending.get(id) !== item || item.expiresAt <= now()) return response({ error: 'not-found' }, 404);
      const rejectPoll = () => {
        item.pollFailures = (item.pollFailures ?? 0) + 1;
        if (item.pollFailures >= MAX_POLL_FAILURES) pending.delete(id);
        return response({ error: 'not-found' }, 404);
      };
      if (!body || Object.keys(body).length !== 1 || typeof body.pollSecret !== 'string' || !VALUE.test(body.pollSecret)) {
        return rejectPoll();
      }
      const supplied = createHash('sha256').update(body.pollSecret).digest();
      if (!timingSafeEqual(supplied, item.pollHash)) return rejectPoll();
      if (!item.code) return response({ approved: false }, 202);
      pending.delete(id);
      return response({ code: item.code, state: item.state }, 200);
    }

    const memberId = options.memberForRequest(request);
    if (!memberId) return response({ error: 'unauthorized' }, 401);
    if (item.previewMemberId && item.previewMemberId !== memberId) return response({ error: 'wrong-member' }, 403);
    if (request.method === 'GET') {
      item.previewMemberId = memberId;
      const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>Elanous TUI 연결 승인</title><h1>이 기기의 TUI 연결을 승인하시겠습니까?</h1><p>요청은 2분 뒤 만료됩니다. 본인의 TUI 화면에 표시된 확인 코드를 직접 입력하세요. 코드를 모르면 승인하지 마세요.</p><form method="post" action="/v1/members/connect/approve?id=${id}"><input type="hidden" name="csrf" value="${item.csrf}"><label>확인 코드 <input name="userCode" required maxlength="9" autocomplete="off"></label><button type="submit">이 기기 연결 승인</button></form></html>`;
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8',
        'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; style-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } });
    }
    if (request.method !== 'POST') return response({ error: 'method-not-allowed' }, 405);
    if (request.headers.get('origin') !== options.origin || item.code) return response({ error: 'approval-refused' }, 403);
    const text = await readTextBounded(request, 512);
    if (text === null) return response({ error: 'invalid-request' }, 400);
    const form = new URLSearchParams(text);
    const suppliedCode = form.get('userCode');
    if (form.getAll('csrf').length !== 1 || form.get('csrf') !== item.csrf
      || form.getAll('userCode').length !== 1 || !suppliedCode || !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(suppliedCode)
      || [...form.keys()].some(key => key !== 'csrf' && key !== 'userCode')
      || !timingSafeEqual(createHash('sha256').update(suppliedCode).digest(), item.userCodeHash)) {
      return response({ error: 'approval-refused' }, 403);
    }
    if (!options.store.createAppAuthCode) return response({ error: 'issuer-unavailable' }, 503);
    // Body reads yield to other approvals and the expiry timer. Claim this item before issuing.
    if (pending.get(id) !== item || item.expiresAt <= now() || item.previewMemberId !== memberId
      || item.code || item.issuing) return response({ error: 'approval-refused' }, 403);
    item.issuing = true;
    try {
      const at = new Date(now()).toISOString();
      const slot = options.store.ensureNativeAppSlotForMember(memberId, at);
      if (!slot) {
        pending.delete(id);
        return response({ error: 'app-slot-unavailable' }, 503);
      }
      if (pending.get(id) !== item || item.expiresAt <= now() || item.previewMemberId !== memberId) {
        pending.delete(id);
        return response({ error: 'approval-refused' }, 403);
      }
      const code = randomBytes(32).toString('base64url');
      options.store.createAppAuthCode({ code, state: item.state, codeChallenge: item.challenge,
        memberId, appId: slot.appId, expiresAt: new Date(item.expiresAt).toISOString() }, at);
      item.code = code;
      return new Response('<!doctype html><html lang="ko"><meta charset="utf-8"><h1>승인 완료</h1><p>TUI로 돌아가 연결을 마치세요.</p></html>',
        { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store',
          'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" } });
    } catch {
      pending.delete(id);
      return response({ error: 'approval-unavailable' }, 503);
    }
  } };
}
