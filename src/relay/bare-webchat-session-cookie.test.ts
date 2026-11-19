// 출처: #39067 — WEBCHAT-SESSION-HANDOFF JUD must ⓑ 끝-끝 시험. 넘김 뒤 bare
// `<handle>.elanous.app` 웹채팅이 받는 자격은 파생 wcs_ 쿠키 하나뿐이다. 실 릴레이
// 공개 경로(startRelayServer · memberRequired 회원 게이트) → 실 connectRelayHost →
// 실 routeBareWebChatHostRequest(교환 · 쿠키 → 파생 세션 대조) → 실 routeRequest/
// decideAuth 를 지나, «교환 → 쿠키 → 채팅 쌍 통과 · 다른 핸들 · 만료 · 폐기 · 무쿠키
// → 401» 을 실 fetch 로 잰다(가짜 소켓 0). 조립 선례: bare-webchat-relay-member.test.ts.
import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { serverIdFromPublicKey, generateDaemonKeyPair } from './channel.js';
import { connectRelayHost } from './host-connector.js';
import { startRelayServer } from './relay-server.js';
import { createMemberStore } from '../nexus/members/member-store.js';
import {
  createRelayWebChatLedger,
  createWebChatHandoffLedger,
  routeBareWebChatHostRequest,
  routeRequest,
} from '../nexus/api/http-server.js';
import { createDevProxyRuntimeRef } from '../nexus/api/admin-dev-proxy.js';
import { NexusEventBus } from '../nexus/api/event-bus.js';
import { createNexusState } from '../nexus/state/state.js';
import { TabRegistry } from '../nexus/state/tab-registry.js';

test('넘김 뒤 wcs_ 쿠키만으로 채팅 쌍이 열리고(쓰면 연장), 다른 핸들·만료·폐기·무쿠키는 401 · 형제 Origin 403 · text/plain 415', async () => {
  const now = Date.parse('2026-11-19T00:00:00.000Z'); // 출처: #39024 선례와 같은 고정 시계 꼴
  const nexus = createMemberStore({ path: ':memory:', now: () => now });
  const owner = nexus.register(
    { sub: 'owner', email: 'owner@example.test', emailVerified: true, name: 'owner' },
    { consents: { privacy: 'v1', terms: 'v1' } },
  );
  // 호스트 WS 회원 게이트 통과용 emt_ — 브라우저(웹채팅)는 이 값을 갖지 않는다.
  const hostToken = nexus.mintMemberAccessToken(owner.initialKey!.id, owner.id, ['relay.connect'], 3600).token; // 출처: #36200 회원 토큰 1시간 기본
  const memberOf = (token: string) => nexus.memberForAccessToken(token, 'relay.connect', undefined, new Date(now).toISOString());

  const eventBus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'bare-webchat-session-cookie' });
  state.bus = eventBus;
  const routeOpts = {
    state,
    registry: new TabRegistry(state),
    eventBus,
    membersApi: { memberForScope: () => null },   // emt_ 갈래는 닫아 둔다 — 열 수 있는 건 쿠키 갈래뿐
    metaApi: { bearerToken: 'secret' },            // 출처: #39024 선례 sse 시험과 같은 운영 bearer
  } as never;

  const pins = createRelayWebChatLedger({});
  pins.recordPin('owner', owner.id, Promise.resolve({ ok: true }));
  await new Promise((resolve) => setTimeout(resolve, 0)); // 핀 프라미스 반영 대기
  let clockMs = now;
  const handoff = createWebChatHandoffLedger({}, () => clockMs, pins.pinOwners);

  const daemonKeys = await generateDaemonKeyPair(new Uint8Array(32).fill(9)); // 출처: #39024 선례의 결정론 키 꼴
  const serverId = serverIdFromPublicKey(daemonKeys.publicKey);
  const signingKeys = generateKeyPairSync('ed25519');
  const publicKey = (signingKeys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url');
  const relay = startRelayServer({
    port: 0,
    hostname: '127.0.0.1',
    trustedHostKeys: new Map([[serverId, publicKey]]),
    publicDomain: 'elanous.app',
    publicServerId: serverId,
    publicUserId: 'owner',
    publicReadableApps: new Set(['owner/chat']),
    memberRequired: true,
    validateMemberToken: async (token: string) => memberOf(token),
    hostOwnerMemberIds: new Map([[serverId, owner.id]]),
  });
  let host: Awaited<ReturnType<typeof connectRelayHost>> | undefined;
  try {
    host = await connectRelayHost({
      relayUrl: `ws://127.0.0.1:${relay.port}/host`,
      daemonKeys,
      hostSigningKey: signingKeys.privateKey,
      getMemberToken: async () => hostToken,
      async handleRequest(request) {
        return (await routeBareWebChatHostRequest(request, {
          pinnedHandles: pins.handles,
          pinOwners: pins.pinOwners,
          webChatHandoff: handoff,
          forwardApi: async (apiRequest) =>
            (await routeRequest(apiRequest, routeOpts, {} as never, null, createDevProxyRuntimeRef())) ??
            new Response(null, { status: 404 }),
        })) ?? new Response(null, { status: 404 });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50)); // 호스트 공개키 수락 반영 대기

    // 브라우저의 같은 출처 fetch 꼴: Origin = 그 핸들 원점 · POST 몸통은 JSON. extra 로 바꿔 CSRF 꼴을 만든다.
    const OWN_ORIGIN = 'https://owner.elanous.app';
    const bare = (method: 'GET' | 'POST', path: string, cookie?: string, extra: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${relay.port}${path}`, {
        method,
        redirect: 'manual',
        headers: Object.fromEntries(Object.entries({   // 빈 값 = 그 헤더를 아예 보내지 않음
          host: 'owner.elanous.app',
          ...(cookie ? { cookie } : {}),
          ...(method === 'POST' ? { origin: OWN_ORIGIN, 'content-type': 'application/json' } : {}),
          ...extra,
        }).filter(([, value]) => value !== '')),
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
    const exchange = async () => {
      const token = handoff.issue(owner.id, 'owner')!;
      const response = await bare('GET', `/app/chat/handoff?handoff-token=${encodeURIComponent(token)}`);
      expect(response.status).toBe(303);
      // 세 경로 쿠키가 릴레이를 지나 모두 온다(출처: #39056 — 착지 + 채팅 쌍 2경로). 예전 호스트
      // envelope 은 Object.fromEntries 로 마지막 한 줄(/v1/chat/events)만 남겼다.
      expect(response.headers.getSetCookie().map((line) => /Path=([^;]+)/.exec(line)?.[1]))
        .toEqual(['/app/chat', '/v1/prompt/stream', '/v1/chat/events']);
      const cookie = response.headers.getSetCookie().find((line) => line.includes('Path=/v1/prompt/stream'))!;
      return cookie.slice(0, cookie.indexOf(';'));   // «__Secure-elanous_webchat_session=wcs_…»
    };
    const status = async (method: 'GET' | 'POST', path: string, cookie?: string, extra?: Record<string, string>) => {
      const response = await bare(method, path, cookie, extra);
      await response.body?.cancel();
      return response.status;
    };

    // ① 넘김 → 쿠키 → 채팅 쌍: 인증 통과. GET 은 SSE 200, POST 는 인증 통과 뒤 프롬프트
    //    런타임 미배선 503(출처: #39024 — 같은 조립의 emt_ 통과 결과와 같은 값).
    const cookie = await exchange();
    expect(cookie.startsWith('__Secure-elanous_webchat_session=wcs_')).toBe(true);
    expect(await status('GET', '/v1/chat/events?sessionId=wcs-1', cookie)).toBe(200);
    expect(await status('POST', '/v1/prompt/stream', cookie)).toBe(503);

    // ② 무쿠키 · 모양만 맞는 남의 값 · 다른 핸들에 묶인 파생 세션 → 401.
    expect(await status('POST', '/v1/prompt/stream')).toBe(401);
    expect(await status('POST', '/v1/prompt/stream', '__Secure-elanous_webchat_session=wcs_00000000-0000-4000-8000-000000000000')).toBe(401);
    const otherHandle = handoff.issueDerivedSession(owner.id, 'muse');
    expect(await status('POST', '/v1/prompt/stream', `__Secure-elanous_webchat_session=${otherHandle}`)).toBe(401);

    // ②b CSRF(JUD #104249 ⓒ) — 쿠키 인증 요청만: 형제 *.elanous.app Origin → 403 · Origin 없고
    //     Referer 도 남의 것 → 403 · text/plain 단순 요청 → 415 · GET 에 남의 Origin → 403.
    //     같은 출처 Referer 만 있는 POST 는 통과(503 = 인증 통과).
    expect(await status('POST', '/v1/prompt/stream', cookie, { origin: 'https://attacker.elanous.app' })).toBe(403);
    expect(await status('POST', '/v1/prompt/stream', cookie, { origin: 'https://myapp--owner.elanous.app' })).toBe(403);
    expect(await status('POST', '/v1/prompt/stream', cookie, { origin: '', referer: 'https://attacker.elanous.app/x' })).toBe(403);
    expect(await status('POST', '/v1/prompt/stream', cookie, { origin: '' })).toBe(403);   // Origin·Referer 둘 다 없음
    expect(await status('POST', '/v1/prompt/stream', cookie, { origin: '', referer: 'https://owner.elanous.app/app/chat/' })).toBe(503);
    expect(await status('POST', '/v1/prompt/stream', cookie, { 'content-type': 'text/plain' })).toBe(415);
    expect(await status('GET', '/v1/chat/events?sessionId=wcs-x', cookie, { origin: 'https://attacker.elanous.app' })).toBe(403);
    // JUD FU — an Authorization header that is no member credential does not switch the check off:
    // the cookie still authenticates, so the cookie rules apply (before: 503 = prompt ran).
    expect(await status('POST', '/v1/prompt/stream', cookie, { origin: 'https://attacker.elanous.app', authorization: 'Bearer junk' })).toBe(403);
    expect(await status('POST', '/v1/prompt/stream', cookie, { 'content-type': 'text/plain', authorization: 'Bearer junk' })).toBe(415);
    expect(await status('POST', '/v1/prompt/stream', cookie, { authorization: 'Bearer junk' })).toBe(503);

    // ③ 수명(JUD #104249 ⓑ): 넘김 61초 뒤에도 통과(60초 고정 아님) · 쓸 때마다 유휴 창 연장 ·
    //    마지막 사용 뒤 유휴 2시간 + 1초(출처: JUD #104249 ⓑ — 유휴 창 2시간) → 401.
    clockMs += 61_000;
    expect(await status('POST', '/v1/prompt/stream', cookie)).toBe(503);
    clockMs += 90 * 60_000;   // 첫 사용 뒤 1시간 31분 — 연장이 없었다면 2시간 창을 넘었을 시점
    expect(await status('GET', '/v1/chat/events?sessionId=wcs-2', cookie)).toBe(200);
    clockMs += 2 * 60 * 60_000 + 1_000;
    expect(await status('POST', '/v1/prompt/stream', cookie)).toBe(401);

    // ④ 폐기: 새 넘김의 쿠키가 통과하다가, 회원 삭제 경로가 부르는 revoke(member.id) 뒤 401.
    const fresh = await exchange();
    expect(await status('POST', '/v1/prompt/stream', fresh)).toBe(503);
    handoff.revokeDerivedForMember(owner.id);
    expect(await status('POST', '/v1/prompt/stream', fresh)).toBe(401);
    // 미교환 넘김 토큰도 같이 죽는다(JUD terra ⓒ).
    const pending = handoff.issue(owner.id, 'owner')!;
    handoff.revokeDerivedForMember(owner.id);
    expect((await bare('GET', `/app/chat/handoff?handoff-token=${encodeURIComponent(pending)}`)).status).toBe(401);
  } finally {
    host?.close();
    relay.stop();
    nexus.close();
  }
});
