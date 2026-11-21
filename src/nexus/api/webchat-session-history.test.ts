// WEBCHAT-SESSION-HISTORY-PERSIST — 시뮬레이션 장치: 가짜 세션 저장소(회원 A · 회원 B · 데몬 ·
// 소유자 기록 없는 옛 웹채팅)를 임시 디렉터리에 깔고, 실 routeBareWebChatHostRequest(핀 · wcs_
// 파생 세션 대조) → 실 routeRequest(기본 거부 게이트) → 실 sessions-store 를 지나 잰다.
// 기대값은 제품 상수·함수에서 만들지 않고 리터럴로 둔다(규칙 11).
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptSession, appendMessage, createSession, deleteSession, onSessionCreated, sessionFile, updateSessionMeta } from '../../session/index.js';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { DaemonSessionHistory } from '../../boot/daemon-runtime.js';
import { runDaemonPromptTurn } from '../../boot/daemon-prompt-turn.js';
import * as coreTurnModule from '../../core-turn/run-core-turn.js';
import { createWebChatHandoffLedger, routeBareWebChatHostRequest, routeRequest } from './http-server.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { handleChatEventsGet, handlePromptStreamPost, registerRelayHostChannelRequest } from './meta-api.js';
import { defaultChatEventBus } from './chat-event-bus.js';
import { handleSessionsStoreDelete, handleSessionsStoreGet } from './sessions-store.js';
import { claimSessionForMember, findSessionMeta } from './webchat-session-owner.js';
import { handleSessionsStorePatch } from './sessions-store.js';
import { DaemonClient } from '../../../apps/pwa/src/lib/daemon-client.js';
import { BARE_CAPABILITIES_META_NAME, bareCapabilitiesContent } from '../../relay/bare-surface.js';

process.env.ELANOUS_WEBCHAT_HANDOFF_HMAC_KEY ??= 'x'.repeat(32);

const OWNER_BEARER = 'daemon-owner-bearer-for-test';
const COOKIE = '__Secure-elanous_webchat_session';

let root = '';
let previousRoot: string | undefined;
const ids = { a: '', b: '', daemon: '', legacy: '' };

function seed(title: string, origin: string, owner?: string): string {
  const meta = createSession({ title, origin, source: origin === 'cli' ? 'cli' : 'pwa' }, root);
  appendMessage(meta.id, { role: 'user', content: `${title} 질문`, ts: '2026-11-21T00:00:00.000Z' }, root);
  appendMessage(meta.id, { role: 'assistant', content: `${title} 답`, ts: '2026-11-21T00:00:01.000Z' }, root);
  if (owner) updateSessionMeta(meta.id, (m) => { m.ownerMemberId = owner; }, root);
  return meta.id;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'webchat-session-history-'));
  previousRoot = process.env.ELANOUS_SESSION_ROOT;
  process.env.ELANOUS_SESSION_ROOT = root;
  ids.a = seed('회원A 대화', 'pwa', 'member-a');
  ids.b = seed('회원B 대화', 'pwa', 'member-b');
  ids.daemon = seed('운영자 CLI 대화', 'cli');
  ids.legacy = seed('member-a의 옛 웹채팅', 'pwa');
});
afterAll(() => {
  if (previousRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
  else process.env.ELANOUS_SESSION_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => { mock.restore(); });

const ledger = createWebChatHandoffLedger({});
const pinOwners = new Map<string, string>([['alpha', 'member-a'], ['bravo', 'member-b']]);
const routeOpts = { metaApi: { bearerToken: OWNER_BEARER } } as never;

async function viaBare(host: string, path: string, token?: string, init: RequestInit = {}): Promise<Response> {
  const request = new Request(`https://${host}${path}`, {
    ...init,
    headers: { ...(token ? { cookie: `${COOKIE}=${encodeURIComponent(token)}` } : {}), ...init.headers },
  });
  const response = await routeBareWebChatHostRequest(request, {
    pinnedHandles: new Set(['alpha', 'bravo']),
    pinOwners,
    webChatHandoff: ledger,
    forwardApi: async (apiRequest) =>
      (await routeRequest(apiRequest, routeOpts, {} as never, null, createDevProxyRuntimeRef())) ??
      new Response(null, { status: 404 }),
  });
  if (!response) throw new Error('bare route missing');
  return response;
}

async function direct(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const response = await routeRequest(
    new Request(`http://127.0.0.1:31415${path}`, { headers }),
    routeOpts, {} as never, null, createDevProxyRuntimeRef(),
  );
  if (!response) throw new Error('route missing');
  return response;
}

async function listIds(response: Response): Promise<string[]> {
  const body = (await response.json()) as { sessions: { id: string }[] };
  return body.sessions.map((s) => s.id).sort();
}

describe('회원 웹채팅 대화 목록 — 회원 스코프', () => {
  test('bare 첫 복원은 실 DaemonClient에서 실 회원 라우터까지 도달한다', async () => {
    const tokenA = ledger.issueDerivedSession('member-a', 'alpha');
    const ownPath = `/v1/sessions/store/${ids.a}?ifExists=1`;
    const fromRouter = await viaBare('alpha.elanous.app', ownPath, tokenA);
    expect(fromRouter.status).toBe(200);
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const previousFetch = globalThis.fetch;
    const requests: string[] = [];
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { querySelector: (selector: string) => {
        const name = /meta\[name="([^"]+)"\]/.exec(selector)?.[1];
        const content = name === 'elanous-bare-webchat' ? '1'
          : name === BARE_CAPABILITIES_META_NAME ? bareCapabilitiesContent() : undefined;
        return content === undefined ? null : { getAttribute: () => content };
      } },
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = `${url.pathname}${url.search}`;
      requests.push(path);
      return viaBare('alpha.elanous.app', path, tokenA, init);
    }) as typeof fetch;
    try {
      const client = new DaemonClient({ baseUrl: 'https://alpha.elanous.app', token: '', provider: '' });
      const own = await client.fetchJson<{ messages: { content: string }[] }>(ownPath);
      expect(own.messages.map((m) => m.content)).toEqual(['회원A 대화 질문', '회원A 대화 답']);
      const foreignPath = `/v1/sessions/store/${ids.b}?ifExists=1`;
      expect(await client.fetchJson<{ ok: boolean; exists: boolean; messages: unknown[] }>(foreignPath))
        .toEqual({ ok: true, exists: false, messages: [] });
      expect((await client.fetchResponse(`/v1/sessions/store/${ids.a}/fork`)).status).toBe(404);
      expect(requests).toEqual([ownPath, foreignPath]);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
      else delete (globalThis as { document?: unknown }).document;
    }
  });

  test('회원 A 토큰 목록 = A 의 대화만 (B · 데몬 · 소유자 없는 옛 세션 제외)', async () => {
    const tokenA = ledger.issueDerivedSession('member-a', 'alpha');
    const response = await viaBare('alpha.elanous.app', '/v1/sessions/store', tokenA);
    expect(response.status).toBe(200);
    expect(await listIds(response)).toEqual([ids.a]);
  });

  test('회원 B 토큰 목록 = B 의 대화만', async () => {
    const tokenB = ledger.issueDerivedSession('member-b', 'bravo');
    const response = await viaBare('bravo.elanous.app', '/v1/sessions/store', tokenB);
    expect(response.status).toBe(200);
    expect(await listIds(response)).toEqual([ids.b]);
  });

  test('릴레이 핀과 PWA 표지·제목은 옛 세션의 회원 소유 증명이 아니다', async () => {
    const tokenA = ledger.issueDerivedSession('member-a', 'alpha');
    const tokenB = ledger.issueDerivedSession('member-b', 'bravo');
    const before = findSessionMeta(ids.legacy, root);
    expect(before).toMatchObject({ source: 'pwa', origin: 'pwa', title: 'member-a의 옛 웹채팅' });
    expect(before?.ownerMemberId).toBeUndefined();
    for (const [host, token] of [['alpha.elanous.app', tokenA], ['bravo.elanous.app', tokenB]] as const) {
      const list = await viaBare(host, '/v1/sessions/store', token);
      expect(list.status).toBe(200);
      expect(await listIds(list)).not.toContain(ids.legacy);
      expect((await viaBare(host, `/v1/sessions/store/${ids.legacy}`, token)).status).toBe(404);
      const probe = await viaBare(host, `/v1/sessions/store/${ids.legacy}?ifExists=1`, token);
      expect(await probe.json()).toEqual({ ok: true, exists: false, messages: [] });
    }
    expect(findSessionMeta(ids.legacy, root)?.ownerMemberId).toBeUndefined();
  });

  test('목록 응답은 웹채팅 쿠키를 지우지 않는다(Max-Age=0 없음)', async () => {
    const tokenA = ledger.issueDerivedSession('member-a', 'alpha');
    const response = await viaBare('alpha.elanous.app', '/v1/sessions/store', tokenA);
    expect(response.headers.getSetCookie().filter((line) => line.includes('Max-Age=0'))).toEqual([]);
  });

  test('A 는 자기 대화를 id 로 열고, B · 데몬 · 옛 세션은 404 (ifExists=1 이면 «없음» 과 같은 답)', async () => {
    const tokenA = ledger.issueDerivedSession('member-a', 'alpha');
    const own = await viaBare('alpha.elanous.app', `/v1/sessions/store/${ids.a}`, tokenA);
    expect(own.status).toBe(200);
    const body = (await own.json()) as { messages: { content: string }[] };
    expect(body.messages.map((m) => m.content)).toEqual(['회원A 대화 질문', '회원A 대화 답']);
    for (const id of [ids.b, ids.daemon, ids.legacy]) {
      const denied = await viaBare('alpha.elanous.app', `/v1/sessions/store/${id}`, tokenA);
      expect([id, denied.status]).toEqual([id, 404]);
      const probe = await viaBare('alpha.elanous.app', `/v1/sessions/store/${id}?ifExists=1`, tokenA);
      expect([id, probe.status, await probe.json()]).toEqual([id, 200, { ok: true, exists: false, messages: [] }]);
    }
  });

  test('익명(쿠키 없음) · 위조 쿠키 · 다른 핸들의 쿠키 → 401', async () => {
    expect((await viaBare('alpha.elanous.app', '/v1/sessions/store')).status).toBe(401);
    expect((await viaBare('alpha.elanous.app', '/v1/sessions/store', 'wcs_00000000-0000-4000-8000-000000000000')).status).toBe(401);
    const tokenB = ledger.issueDerivedSession('member-b', 'bravo');
    expect((await viaBare('alpha.elanous.app', '/v1/sessions/store', tokenB)).status).toBe(401);
    expect((await viaBare('alpha.elanous.app', `/v1/sessions/store/${ids.a}`, tokenB)).status).toBe(401);
  });

  test('릴레이 배선을 거치지 않은 직접 요청은 쿠키가 있어도 401 (표시는 위조 불가)', async () => {
    const tokenA = ledger.issueDerivedSession('member-a', 'alpha');
    expect((await direct('/v1/sessions/store')).status).toBe(401);
    expect((await direct('/v1/sessions/store', { cookie: `${COOKIE}=${tokenA}` })).status).toBe(401);
    expect((await direct(`/v1/sessions/store/${ids.a}`, { cookie: `${COOKIE}=${tokenA}` })).status).toBe(401);
  });

  test('데몬 소유자 bearer 의 전체 목록은 그대로 (네 세션 모두)', async () => {
    const response = await direct('/v1/sessions/store', { authorization: `Bearer ${OWNER_BEARER}` });
    expect(response.status).toBe(200);
    expect(await listIds(response)).toEqual([ids.a, ids.b, ids.daemon, ids.legacy].sort());
    const other = await direct(`/v1/sessions/store/${ids.b}`, { authorization: `Bearer ${OWNER_BEARER}` });
    expect(other.status).toBe(200);
  });
});

describe('회원 웹채팅 세션 관리 — 자기 소유만', () => {
  test('삭제된 A 세션의 옛 SSE는 같은 id로 재생성한 B 세션의 이벤트를 받지 않는다', async () => {
    const id = 's-reused-1';
    const tokenA = ledger.issueDerivedSession('member-a', 'alpha');
    const tokenB = ledger.issueDerivedSession('member-b', 'bravo');
    expect(claimSessionForMember(id, 'member-a', root)).toBe(true);
    const old = await viaBare('alpha.elanous.app', `/v1/chat/events?sessionId=${id}`, tokenA);
    expect(old.status).toBe(200);
    const oldReader = old.body!.getReader();
    await oldReader.read(); // subscribed marker
    try {
      const deleted = await viaBare('alpha.elanous.app', `/v1/sessions/store/${id}`, tokenA, {
        method: 'DELETE', headers: { origin: 'https://alpha.elanous.app' },
      });
      expect(deleted.status).toBe(200);
      expect(claimSessionForMember(id, 'member-b', root)).toBe(true);
      const fresh = await viaBare('bravo.elanous.app', `/v1/chat/events?sessionId=${id}`, tokenB);
      expect(fresh.status).toBe(200);
      const freshReader = fresh.body!.getReader();
      await freshReader.read();
      try {
        defaultChatEventBus().publish(id, { event: 'text-delta', data: { text: 'B only' } });
        const nextFresh = await freshReader.read();
        expect(new TextDecoder().decode(nextFresh.value)).toContain('B only');
        const nextOld = await Promise.race([
          oldReader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('old SSE remained open')), 100)),
        ]);
        expect(nextOld.done).toBe(true);
      } finally {
        await freshReader.cancel();
      }
    } finally {
      await oldReader.cancel();
      deleteSession(id, root);
    }
  });

  test('활성 턴 중 삭제는 디스크 파일 제거 전에 쓰기를 중단한다', async () => {
    const id = 's-active-1';
    expect(claimSessionForMember(id, 'member-a', root)).toBe(true);
    const file = sessionFile(id, root);
    const request = new Request(`https://alpha.elanous.app/v1/sessions/store/${id}`, {
      method: 'DELETE', headers: { origin: 'https://alpha.elanous.app' },
    });
    registerRelayHostChannelRequest(request, 'member-a', 'member-a');
    let filePresentAtAbort = false;
    try {
      const response = handleSessionsStoreDelete(request, id, {
        bearerToken: OWNER_BEARER,
        abortSession: () => {
          filePresentAtAbort = existsSync(file);
          writeFileSync(file, 'late turn write');
          return true;
        },
      });
      expect(response.status).toBe(200);
      expect(filePresentAtAbort).toBe(true);
      expect(existsSync(file)).toBe(false);
    } finally {
      deleteSession(id, root);
    }
  });

  test('자기 대화 이름 변경·삭제는 통과하고 남의 대화는 존재를 숨긴다', async () => {
    const id = 's-ownededit-1';
    expect(claimSessionForMember(id, 'member-a', root)).toBe(true);
    appendMessage(id, { role: 'user', content: '안녕', ts: '2026-11-21T00:00:00.000Z' }, root);
    const tokenA = ledger.issueDerivedSession('member-a', 'alpha');
    const tokenB = ledger.issueDerivedSession('member-b', 'bravo');
    const patch = (host: string, token: string, title: string) => viaBare(host, `/v1/sessions/store/${id}`, token, {
      method: 'PATCH', headers: { origin: `https://${host}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const remove = (host: string, token: string) => viaBare(host, `/v1/sessions/store/${id}`, token, {
      method: 'DELETE', headers: { origin: `https://${host}` },
    });
    try {
      expect((await patch('bravo.elanous.app', tokenB, '훔친 제목')).status).toBe(404);
      expect((await remove('bravo.elanous.app', tokenB)).status).toBe(404);
      expect((await patch('alpha.elanous.app', tokenA, '   ')).status).toBe(400);
      expect((await viaBare('alpha.elanous.app', `/v1/sessions/store/${id}`, tokenA, {
        method: 'PATCH', headers: { origin: 'https://alpha.elanous.app', 'content-type': 'application/json' }, body: '{',
      })).status).toBe(400);
      expect((await viaBare('alpha.elanous.app', `/v1/sessions/store/${id}`, tokenA, {
        method: 'PATCH', headers: { origin: 'https://alpha.elanous.app', 'content-type': 'application/json' },
        body: JSON.stringify({ title: '가'.repeat(600) }),
      })).status).toBe(413);
      const failedBody = new Request(`https://alpha.elanous.app/v1/sessions/store/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: new ReadableStream({ pull(controller) { controller.error(new Error('body read failed')); } }),
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      registerRelayHostChannelRequest(failedBody, 'member-a', 'member-a');
      expect((await handleSessionsStorePatch(failedBody, id, { bearerToken: OWNER_BEARER })).status).toBe(503);
      expect((await viaBare('alpha.elanous.app', `/v1/sessions/store/${id}`, tokenA, {
        method: 'DELETE', headers: { origin: 'https://attacker.elanous.app' },
      })).status).toBe(403);
      expect((await viaBare('alpha.elanous.app', `/v1/sessions/store/${id}`, undefined, {
        method: 'DELETE', headers: { origin: 'https://alpha.elanous.app' },
      })).status).toBe(401);
      expect((await viaBare('alpha.elanous.app', '/v1/sessions/store/s-ownededit-1%2Fother', tokenA, {
        method: 'DELETE', headers: { origin: 'https://alpha.elanous.app' },
      })).status).toBe(400);
      expect((await viaBare('alpha.elanous.app', `/v1/sessions/store/${ids.legacy}`, tokenA, {
        method: 'PATCH', headers: { origin: 'https://alpha.elanous.app', 'content-type': 'application/json' },
        body: '{"title":"소급 시도"}',
      })).status).toBe(404);
      expect((await viaBare('alpha.elanous.app', `/v1/sessions/store/${ids.legacy}`, tokenA, {
        method: 'DELETE', headers: { origin: 'https://alpha.elanous.app' },
      })).status).toBe(404);
      expect(findSessionMeta(id, root)?.title).not.toBe('훔친 제목');
      const renamed = await patch('alpha.elanous.app', tokenA, '내 대화');
      expect(renamed.status).toBe(200);
      expect(findSessionMeta(id, root)?.title).toBe('내 대화');
      const deleted = await remove('alpha.elanous.app', tokenA);
      expect(deleted.status).toBe(200);
      expect(findSessionMeta(id, root)).toBeUndefined();
    } finally {
      deleteSession(id, root);
    }
  });
});

describe('회원 웹채팅 턴 — 세션 소유', () => {
  test('삭제로 중단된 턴이 준비 단계에서 돌아와도 user 메시지 파일을 다시 만들지 않는다', async () => {
    const id = 's-preabort-1';
    expect(claimSessionForMember(id, 'member-a', root)).toBe(true);
    expect(deleteSession(id, root)).toBe(true);
    const signal = new AbortController();
    signal.abort();
    spyOn(coreTurnModule, 'runCoreTurn').mockResolvedValue({ stopReason: 'end_turn', finalText: 'late' });
    try {
      await runDaemonPromptTurn({
        history: new DaemonSessionHistory({ diskDir: root }),
        request: {
          sessionId: id, userText: 'late user write', userContent: null,
          source: { kind: 'daemon-api', route: '/v1/prompt/stream' },
          effectiveSystemPrompt: undefined, tools: null,
        },
        signal: signal.signal,
        dispatchToolErrorMessage: 'unused',
      });
    } catch { /* an aborted turn may reject */ }
    expect(existsSync(sessionFile(id, root))).toBe(false);
  });

  test('실제 활성 회원 턴을 삭제하면 늦은 완료 콜백도 파일을 되살리지 않는다', async () => {
    const id = 's-live-1';
    expect(claimSessionForMember(id, 'member-a', root)).toBe(true);
    const history = new DaemonSessionHistory({ diskDir: root });
    let releaseTurn!: () => void;
    const heldTurn = new Promise<void>((resolve) => { releaseTurn = resolve; });
    let enterTurn!: () => void;
    const enteredTurn = new Promise<void>((resolve) => { enterTurn = resolve; });
    let turnSignal: AbortSignal | undefined;
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      turnSignal = ctx.signal;
      enterTurn();
      await heldTurn;
      ctx.callbacks?.onTurnComplete?.([{ role: 'assistant', content: 'late answer' }]);
      return { stopReason: 'end_turn', finalText: 'late answer' };
    });
    try {
      const response = await handlePromptStreamPost(memberPrompt(id), {
        history, bearerToken: OWNER_BEARER, toolCwd: process.cwd(),
      } as never);
      expect(response.status).toBe(200);
      await Promise.race([enteredTurn, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('turn did not start')), 2000))]);
      const request = new Request(`https://alpha.elanous.app/v1/sessions/store/${id}`, {
        method: 'DELETE', headers: { origin: 'https://alpha.elanous.app' },
      });
      registerRelayHostChannelRequest(request, 'member-a', 'member-a');
      const deleted = handleSessionsStoreDelete(request, id, { history, bearerToken: OWNER_BEARER });
      expect(deleted.status).toBe(200);
      expect(turnSignal?.aborted).toBe(true);
      releaseTurn();
      await response.text();
      expect(existsSync(sessionFile(id, root))).toBe(false);
      expect(findSessionMeta(id, root)).toBeUndefined();
    } finally {
      releaseTurn();
      deleteSession(id, root);
    }
  });

  test('claimSessionForMember: 새 세션은 회원 소유로 새기고, 남의 · 옛 세션은 거부', () => {
    expect(claimSessionForMember('11111111-1111-4111-8111-111111111111', 'member-a', root)).toBe(true);
    expect(findSessionMeta('11111111-1111-4111-8111-111111111111', root)?.ownerMemberId).toBe('member-a');
    expect(claimSessionForMember('11111111-1111-4111-8111-111111111111', 'member-a', root)).toBe(true);
    expect(claimSessionForMember('11111111-1111-4111-8111-111111111111', 'member-b', root)).toBe(false);
    expect(claimSessionForMember(ids.b, 'member-a', root)).toBe(false);
    expect(claimSessionForMember(ids.legacy, 'member-a', root)).toBe(false);
    expect(claimSessionForMember(ids.daemon, 'member-a', root)).toBe(false);
  });

  function memberPrompt(sessionId: string): Request {
    const request = new Request('https://alpha.elanous.app/v1/prompt/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userText: '이어서', sessionId }),
    });
    registerRelayHostChannelRequest(request, 'member-a', 'member-a');
    return request;
  }

  test('회원 A 가 B 의 · 옛 세션 id 로 턴을 보내면 403 (문맥 유출 없음 · 턴 안 돎)', async () => {
    const turns: number[] = [];
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async () => {
      turns.push(1);
      return { stopReason: 'end_turn', finalText: 'OK' };
    });
    const opts = { history: new DaemonSessionHistory(), bearerToken: OWNER_BEARER, toolCwd: process.cwd() };
    for (const id of [ids.b, ids.legacy, ids.daemon]) {
      const response = await handlePromptStreamPost(memberPrompt(id), opts as never);
      expect([id, response.status]).toEqual([id, 403]);
    }
    expect(turns).toEqual([]);
  });

  test('회원 A 의 새 세션 턴은 돌고, 그 세션은 A 소유로 남아 A 목록에 뜬다', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async () => ({ stopReason: 'end_turn', finalText: 'OK' }));
    const opts = { history: new DaemonSessionHistory(), bearerToken: OWNER_BEARER, toolCwd: process.cwd() };
    const response = await handlePromptStreamPost(memberPrompt('22222222-2222-4222-8222-222222222222'), opts as never);
    expect(response.status).toBe(200);
    await response.text();
    expect(findSessionMeta('22222222-2222-4222-8222-222222222222', root)?.ownerMemberId).toBe('member-a');
  });

  // JUD #39431 필수 ② — 조회·채택·소유자 기록이 갈라져 있으면 그 사이 다른 경로가 만든 세션을 회원 것으로 잡는다.
  test('다른 경로가 먼저 만든 빈 무소유 세션은 채택하지 않는다', () => {
    adoptSession('33333333-3333-4333-8333-333333333333', { source: 'pwa', origin: 'pwa' }, root);
    expect(claimSessionForMember('33333333-3333-4333-8333-333333333333', 'member-a', root)).toBe(false);
    expect(findSessionMeta('33333333-3333-4333-8333-333333333333', root)?.ownerMemberId).toBeUndefined();
  });

  test('색인에 없지만 내용이 있는 세션 파일은 회원 것으로 채택하지 않는다(남의 내용 노출 차단)', () => {
    writeFileSync(sessionFile('44444444-4444-4444-8444-444444444444', root), `${JSON.stringify({ role: 'user', content: '남의 글', ts: '2026-11-21T00:00:00.000Z' })}\n`, 'utf-8');
    expect(claimSessionForMember('44444444-4444-4444-8444-444444444444', 'member-a', root)).toBe(false);
    expect(findSessionMeta('44444444-4444-4444-8444-444444444444', root)).toBeUndefined();
  });

  test('세션 생성과 최초 소유자 기록은 한 번의 쓰기다(생성 알림 순간에 이미 소유자가 있다)', () => {
    const seen: (string | undefined)[] = [];
    const off = onSessionCreated((meta) => { if (meta.id === '55555555-5555-4555-8555-555555555555') seen.push(meta.ownerMemberId); });
    try {
      expect(claimSessionForMember('55555555-5555-4555-8555-555555555555', 'member-a', root)).toBe(true);
    } finally { off(); }
    expect(seen).toEqual(['member-a']);
  });

  // JUD #39431 필수 ① — 아직 없는 세션 구독을 열어 두면 나중에 그 id 의 남의 세션 이벤트가 흐른다.
  test('회원은 아직 없는 세션을 구독하지 못한다(403)', () => {
    const url = new URL('https://alpha.elanous.app/v1/chat/events?sessionId=66666666-6666-4666-8666-666666666666');
    const request = new Request(url);
    registerRelayHostChannelRequest(request, 'member-a', 'member-a');
    expect(handleChatEventsGet(request, url, { bearerToken: OWNER_BEARER } as never).status).toBe(403);
  });

  test('회원 A 는 B 의 세션 이벤트를 구독하지 못한다(403) · 자기 세션은 200', async () => {
    const make = (sessionId: string) => {
      const url = new URL(`https://alpha.elanous.app/v1/chat/events?sessionId=${sessionId}`);
      const request = new Request(url);
      registerRelayHostChannelRequest(request, 'member-a', 'member-a');
      return { request, url };
    };
    const opts = { bearerToken: OWNER_BEARER } as never;
    const denied = make(ids.b);
    expect(handleChatEventsGet(denied.request, denied.url, opts).status).toBe(403);
    const own = make(ids.a);
    const ok = handleChatEventsGet(own.request, own.url, opts);
    expect(ok.status).toBe(200);
    await ok.body?.cancel();
  });
});

// JUD #39431 필수(경로 탈출) — 회원 요청의 sessionId 는 생성 규칙(UUID · PWA 대체 s-<ts>-<rand> · 데몬 http-<ts>-<rand>)
// 밖이면 프로젝트·세션 조회 전에 400 이고, 세션 루트 밖 파일·색인을 건드리지 않는다.
describe('회원 sessionId 검증 · 세션 루트 가둠', () => {
  const BAD_IDS = ['../escape-a', '../../etc/escape-b', '/tmp/escape-c', 'a/b', 'a\\b', '..', '.', 'x'.repeat(200), '', 'ok id'];

  function marked(request: Request): Request {
    registerRelayHostChannelRequest(request, 'member-a', 'member-a');
    return request;
  }
  function indexText(): string {
    const p = join(root, 'index.json');
    return existsSync(p) ? readFileSync(p, 'utf-8') : '';
  }

  test('턴: 잘못된 id 는 400 · 루트 밖 파일 0 · 색인 불변 · 턴 0회', async () => {
    const turns: number[] = [];
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async () => { turns.push(1); return { stopReason: 'end_turn', finalText: 'OK' }; });
    const opts = { history: new DaemonSessionHistory(), bearerToken: OWNER_BEARER, toolCwd: process.cwd() };
    for (const id of BAD_IDS.filter((x) => x !== '')) {
      const before = indexText();
      const request = marked(new Request('https://alpha.elanous.app/v1/prompt/stream', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userText: '이어서', sessionId: id }),
      }));
      const response = await handlePromptStreamPost(request, opts as never);
      expect([id.slice(0, 20), response.status]).toEqual([id.slice(0, 20), 400]);
      expect(indexText()).toBe(before);
    }
    expect(existsSync(join(root, '..', 'escape-a.jsonl'))).toBe(false);
    expect(existsSync(join(root, '..', '..', 'etc', 'escape-b.jsonl'))).toBe(false);
    expect(existsSync('/tmp/escape-c.jsonl')).toBe(false);
    expect(turns).toEqual([]);
  });

  test('구독 · id 읽기: 잘못된 id 는 400', () => {
    for (const id of BAD_IDS.filter((x) => x !== '')) {
      const url = new URL(`https://alpha.elanous.app/v1/chat/events?sessionId=${encodeURIComponent(id)}`);
      const events = handleChatEventsGet(marked(new Request(url)), url, { bearerToken: OWNER_BEARER } as never);
      expect([id.slice(0, 20), events.status]).toEqual([id.slice(0, 20), 400]);
      const read = handleSessionsStoreGet(marked(new Request('https://alpha.elanous.app/v1/sessions/store/x')), id, { bearerToken: OWNER_BEARER } as never);
      expect([id.slice(0, 20), read.status]).toEqual([id.slice(0, 20), 400]);
    }
  });

  test('claimSessionForMember: 잘못된 id · 루트 안 심볼릭 링크는 거부하고 쓰지 않는다', () => {
    for (const id of BAD_IDS) expect([id.slice(0, 20), claimSessionForMember(id, 'member-a', root)]).toEqual([id.slice(0, 20), false]);
    const outside = mkdtempSync(join(tmpdir(), 'webchat-outside-'));
    try {
      const target = join(outside, 'victim.jsonl');
      writeFileSync(target, '', 'utf-8');
      const linked = '77777777-7777-4777-8777-777777777777';
      symlinkSync(target, join(root, `${linked}.jsonl`));
      expect(claimSessionForMember(linked, 'member-a', root)).toBe(false);
      expect(findSessionMeta(linked, root)).toBeUndefined();
      expect(readFileSync(target, 'utf-8')).toBe('');
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  test('생성 규칙 안의 id(UUID · s-… · http-…)는 그대로 통과', () => {
    expect(claimSessionForMember('88888888-8888-4888-8888-888888888888', 'member-a', root)).toBe(true);
    expect(claimSessionForMember('s-mf3k2a1-abc123de', 'member-a', root)).toBe(true);
    expect(claimSessionForMember('http-mf3k2a1-abc123', 'member-a', root)).toBe(true);
  });
});
