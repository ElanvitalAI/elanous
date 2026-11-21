// 출처: #39067 — WEBCHAT-SESSION-HANDOFF JUD must ⓑ 끝-끝 시험. 넘김 뒤 bare
// `<handle>.elanous.app` 웹채팅이 받는 자격은 파생 wcs_ 쿠키 하나뿐이다. 실 릴레이
// 공개 경로(startRelayServer · memberRequired 회원 게이트) → 실 connectRelayHost →
// 실 routeBareWebChatHostRequest(교환 · 쿠키 → 파생 세션 대조) → 실 routeRequest/
// decideAuth 를 지나, «교환 → 쿠키 → 채팅 쌍 통과 · 다른 핸들 · 만료 · 폐기 · 무쿠키
// → 401» 을 실 fetch 로 잰다(가짜 소켓 0). 조립 선례: bare-webchat-relay-member.test.ts.
import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serverIdFromPublicKey, generateDaemonKeyPair } from './channel.js';
import { connectRelayHost } from './host-connector.js';
import { startRelayServer } from './relay-server.js';
import { createAppKillSwitch } from './app-kill-switch.js';
import { createMemberStore } from '../nexus/members/member-store.js';
import { createOwnedSession } from '../session/index.js';
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

// 출처: OP #107132 — 넘김 토큰은 HMAC-SHA256 서명으로 발급된다. 시험용 더미 키(≥32바이트 — 출처: OP #107132).
process.env.ELANOUS_WEBCHAT_HANDOFF_HMAC_KEY ??= 'x'.repeat(32);

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
  const handoff = createWebChatHandoffLedger({}, () => clockMs); // 출처: OP #107132 — 2인자 원장(핀 대조는 교환 쪽 pinnedHandles/pinOwners)

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
    const bare = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, cookie?: string, extra: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${relay.port}${path}`, {
        method,
        redirect: 'manual',
        headers: Object.fromEntries(Object.entries({   // 빈 값 = 그 헤더를 아예 보내지 않음
          host: 'owner.elanous.app',
          ...(cookie ? { cookie } : {}),
          ...(method === 'POST' || method === 'PATCH' ? { origin: OWN_ORIGIN, 'content-type': 'application/json' }
            : method === 'DELETE' ? { origin: OWN_ORIGIN } : {}),
          ...extra,
        }).filter(([, value]) => value !== '')),
        ...(method === 'POST' ? { body: '{}' } : method === 'PATCH' ? { body: '{"title":"새 제목"}' } : {}),
      });
    const exchange = async () => {
      const token = handoff.issue(owner.id, 'owner')!;
      const response = await bare('GET', `/app/chat/handoff?handoff-token=${encodeURIComponent(token)}`);
      expect(response.status).toBe(303);
      // 세 경로 쿠키가 릴레이를 지나 모두 온다(출처: #39056 — 착지 + 채팅 쌍 2경로). 예전 호스트
      // envelope 은 Object.fromEntries 로 마지막 한 줄(/v1/chat/events)만 남겼다.
      expect(response.headers.getSetCookie().map((line) => /Path=([^;]+)/.exec(line)?.[1]))
        .toEqual(['/app/chat', '/v1/prompt/stream', '/v1/chat/events', '/v1/sessions/store']);
      const cookie = response.headers.getSetCookie().find((line) => line.includes('Path=/v1/prompt/stream'))!;
      return cookie.slice(0, cookie.indexOf(';'));   // «__Secure-elanous_webchat_session=wcs_…»
    };
    const status = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, cookie?: string, extra?: Record<string, string>) => {
      const response = await bare(method, path, cookie, extra);
      await response.body?.cancel();
      return response.status;
    };

    // ① 넘김 → 쿠키 → 채팅 쌍: 인증 통과. GET 은 SSE 200, POST 는 인증 통과 뒤 프롬프트
    //    런타임 미배선 503(출처: #39024 — 같은 조립의 emt_ 통과 결과와 같은 값).
    const cookie = await exchange();
    expect(cookie.startsWith('__Secure-elanous_webchat_session=wcs_')).toBe(true);
    // JUD #39431 필수 ① — 회원 구독은 소유가 확정된 자기 세션만: 없는 세션 403 · 자기 세션 200.
    expect(await status('GET', '/v1/chat/events?sessionId=a1a1a1a1-0000-4000-8000-000000000001', cookie)).toBe(403);
    createOwnedSession('a1a1a1a1-0000-4000-8000-000000000001', owner.id);
    createOwnedSession('a1a1a1a1-0000-4000-8000-000000000002', owner.id);
    expect(await status('GET', '/v1/chat/events?sessionId=a1a1a1a1-0000-4000-8000-000000000001', cookie)).toBe(200);
    expect(await status('POST', '/v1/prompt/stream', cookie)).toBe(503);
    // WEBCHAT-SESSION-HISTORY-PERSIST — 대화 목록·내용 읽기도 같은 쿠키로 릴레이를 지나 회원 Nexus 에 닿는다.
    expect(await status('GET', '/v1/sessions/store', cookie)).toBe(200);
    expect(await status('GET', '/v1/sessions/store/a1a1a1a1-0000-4000-8000-0000000000ff?ifExists=1', cookie)).toBe(200);
    // JUD #39431 필수(경로 탈출) — 생성 규칙 밖 id 는 릴레이를 지나도 400.
    expect(await status('GET', '/v1/sessions/store/no-such-session?ifExists=1', cookie)).toBe(400);
    expect(await status('GET', '/v1/sessions/store')).toBe(401);
    createOwnedSession('s-manage-1', owner.id);
    expect(await status('PATCH', '/v1/sessions/store/s-manage-1', cookie)).toBe(200);
    expect(await status('PATCH', '/v1/sessions/store/s-manage-1', cookie, { origin: 'https://attacker.elanous.app' })).toBe(403);
    expect(await status('DELETE', '/v1/sessions/store/s-manage-1', cookie, { origin: 'https://attacker.elanous.app' })).toBe(403);
    expect(await status('DELETE', '/v1/sessions/store/s-manage-1', cookie)).toBe(200);

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
    expect(await status('GET', '/v1/chat/events?sessionId=a1a1a1a1-0000-4000-8000-000000000002', cookie)).toBe(200);
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

// 출처: OP #108336 — «publicReadableApps 앱 0 + memberRequired + 무쿠키» 조합에서 세션
// 없는 handoff 교환 GET 이 relay 회원 게이트(memberAuthorized)에 걸려 Nexus consume 에
// 닿지 못하던 것을, 우회 목록에 1경로(GET /app/chat/handoff?handoff-token=…)를 추가해
// 수리한 뒤의 끝-끝 시험이다. 위 #39067 시험은 ['owner/chat'] 시드로 anonymousPublicRead
// 가 참이 되어 이 조합이 빈 자리였다. 토큰 민팅·위조는 기존
// src/nexus/api/webchat-handoff-hmac.test.ts 선례(환경변수 ELANOUS_WEBCHAT_HANDOFF_HMAC_KEY
// — 출처: OP #107132 · 모듈 상단 더미 키)를 그대로 재사용하고, 조립도 위 시험과 같다.
test('앱 0 + memberRequired: 무쿠키 handoff 교환 GET 은 Nexus consume 로 흐른다(303 + 3-Path wcs_) · 위조는 401 JSON 사유 · 파라미터 없음·무쿠키 /app/chat 은 기존 401 안내 HTML', async () => {
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
  const state = createNexusState({ nexusVersion: 'test', phase: 'bare-webchat-handoff-only' });
  state.bus = eventBus;
  const routeOpts = {
    state,
    registry: new TabRegistry(state),
    eventBus,
    membersApi: { memberForScope: () => null },   // emt_ 갈래는 닫아 둔다 — 열 수 있는 건 교환 토큰뿐
    metaApi: { bearerToken: 'secret' },            // 출처: #39024 선례 sse 시험과 같은 운영 bearer
  } as never;

  const pins = createRelayWebChatLedger({});
  pins.recordPin('owner', owner.id, Promise.resolve({ ok: true }));
  await new Promise((resolve) => setTimeout(resolve, 0)); // 핀 프라미스 반영 대기
  const handoff = createWebChatHandoffLedger({}, () => now); // 출처: OP #107132 — 2인자 원장(핀 대조는 교환 쪽 pinnedHandles/pinOwners)

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
    publicReadableApps: new Set(),   // 앱 0 — anonymousPublicRead 갈래가 닫힌다(출처: OP #108336 조합)
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

    const bare = (method: 'GET', path: string, extra: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${relay.port}${path}`, {
        method,
        redirect: 'manual',
        headers: { host: 'owner.elanous.app', ...extra },
      });

    // ① 유효 토큰: 교환이 회원 게이트를 지나 Nexus consume 에 닿는다 — 303 +
    //    3-Path 쿠키(출처: #39056 — 착지 + 채팅 쌍 2경로). 값은 파생 wcs_ 토큰.
    const token = handoff.issue(owner.id, 'owner')!;
    const exchanged = await bare('GET', `/app/chat/handoff?handoff-token=${encodeURIComponent(token)}`);
    expect(exchanged.status).toBe(303);
    expect(exchanged.headers.getSetCookie().map((line) => /Path=([^;]+)/.exec(line)?.[1]))
      .toEqual(['/app/chat', '/v1/prompt/stream', '/v1/chat/events', '/v1/sessions/store']);
    const exchangedCookie = exchanged.headers.getSetCookie().find((line) => line.includes('Path=/v1/prompt/stream'))!;
    expect(exchangedCookie.slice(0, exchangedCookie.indexOf(';')).startsWith('__Secure-elanous_webchat_session=wcs_')).toBe(true);
    await exchanged.body?.cancel();

    // ② 위조 토큰(서명 세그먼트 조작 — webchat-handoff-hmac.test.ts ⓐ 선례와 같은 꼴):
    //    판정은 핀 호스트 Nexus consume — 401 + JSON 사유로 거부.
    const parts = token.split('.');   // wch_<payload>.<sig> — 출처: OP #107132 토큰 포맷
    const forged = `${parts[0]}.${parts[1]}A`;
    const refused = await bare('GET', `/app/chat/handoff?handoff-token=${encodeURIComponent(forged)}`);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'webchat-handoff-invalid-signature' });

    // ③ handoff-token 파라미터 없는 GET /app/chat/handoff: 우회 조건에 안 걸린다 —
    //    기존 401 그대로 · 문서 요청은 로그인 안내 HTML 경로를 유지한다.
    const noParam = await bare('GET', '/app/chat/handoff', { accept: 'text/html' });
    expect(noParam.status).toBe(401);
    expect(noParam.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect((await noParam.text()).includes('엘라누스 회원 로그인')).toBe(true);

    // ④ 무쿠키 GET /app/chat (accept: text/html): WEBCHAT-401-LOGIN-PAGE 회귀 방지 —
    //    401 + 안내 HTML 유지(JUD must ⓑ).
    const document = await bare('GET', '/app/chat', { accept: 'text/html' });
    expect(document.status).toBe(401);
    expect(document.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect((await document.text()).includes('엘라누스 회원 로그인')).toBe(true);
  } finally {
    host?.close();
    relay.stop();
    nexus.close();
  }
});

// 출처: RES #108420 · OP #108336 확장 — #39154 착지 뒤 실측 결함. 앱 0 bare 핸들 호스트는
// 공개 앱 판정이 합성 app:""(relay-server.ts publicApp)인데, 회원 게이트 통과 직후
// appKillSwitch.isDown 판정이 validateAppId("") 로 throw 해 교환 GET /app/chat/handoff
// ?handoff-token=… 이 500 이 되었다(문서 GET /app/chat · 채팅 쌍 전부 마찬가지). 기존 두
// 시험이 못 잡은 이유: 시험 하니스가 appKillSwitch 를 주입하지 않아 `?.` 로 판정이 통째로
// 스킵됐다. 여기선 실 createAppKillSwitch(임시 sqlite — app-kill-switch.ts 생성부 서술)를
// 주입해 ① 교환 303 + wcs_ → 문서 200 → 채팅 한 쌍이 500 없이 개통 ③ 합성 bare 앱
// id("") 는 «다운 아님» 판정(RES #108420 수리의 직접 증명)을 잰다.
test('app-kill-switch 주입(앱 0 + memberRequired): 합성 bare 앱 id("") 판정이 500 대신 개통한다 — 교환 303 + wcs_ → 문서 GET /app/chat·/app/chat/ 200 text/html → 채팅 한 쌍 개통 · 무쿠키 문서 GET 은 회원 게이트 401+안내 HTML 유지 · wcs_ fail-closed 리터럴(위조·만료·타 handle·폐기 → 401) (RES #108420 · OP #108575 · 원문 종단 bd47bc34)', async () => {
  const now = Date.parse('2026-11-19T00:00:00.000Z'); // 출처: #39024 선례와 같은 고정 시계 꼴
  const nexus = createMemberStore({ path: ':memory:', now: () => now });
  const owner = nexus.register(
    { sub: 'owner', email: 'owner@example.test', emailVerified: true, name: 'owner' },
    { consents: { privacy: 'v1', terms: 'v1' } },
  );
  // 호스트 WS 회원 게이트 통과용 emt_ — 브라우저(웹채팅)는 이 값을 갖지 않는다.
  const hostToken = nexus.mintMemberAccessToken(owner.initialKey!.id, owner.id, ['relay.connect'], 3600).token; // 출처: #36200 회원 토큰 1시간 기본
  const memberOf = (token: string) => nexus.memberForAccessToken(token, 'relay.connect', undefined, new Date(now).toISOString());

  const killSwitch = createAppKillSwitch(
    join(realpathSync(mkdtempSync(join(tmpdir(), 'app-kill-switch-relay-'))), 'state.sqlite'),
  ); // 실 킬스위치 주입 — 기존 시험들의 빠진 조각(RES #108420). relay.stop() 이 close?.() 로 닫는다.

  const eventBus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'bare-webchat-killswitch' });
  state.bus = eventBus;
  const routeOpts = {
    state,
    registry: new TabRegistry(state),
    eventBus,
    membersApi: { memberForScope: () => null },   // emt_ 갈래는 닫아 둔다 — 열 수 있는 건 교환 토큰뿐
    metaApi: { bearerToken: 'secret' },            // 출처: #39024 선례 sse 시험과 같은 운영 bearer
  } as never;

  const pins = createRelayWebChatLedger({});
  pins.recordPin('owner', owner.id, Promise.resolve({ ok: true }));
  await new Promise((resolve) => setTimeout(resolve, 0)); // 핀 프라미스 반영 대기
  let clockMs = now; // 출처: OP #108575 만료 리터럴 — 유휴 창 넘김용 가변 시계(위 시험 ① ③ 수명 꼴 그대로)
  const handoff = createWebChatHandoffLedger({}, () => clockMs); // 출처: OP #107132 — 2인자 원장(핀 대조는 교환 쪽 pinnedHandles/pinOwners)

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
    publicReadableApps: new Set(),   // 앱 0 — 합성 publicApp = { app: '', user: 'owner' }(#39024 조합 그대로)
    memberRequired: true,
    appKillSwitch: killSwitch,        // ← 회원 게이트 직후 isDown 판정이 도는 자리(수리 전 500 지점)
    validateMemberToken: async (token: string) => memberOf(token),
    hostOwnerMemberIds: new Map([[serverId, owner.id]]),
  });
  const staticDir = mkdtempSync(join(tmpdir(), 'bare-webchat-static-')); // 출처: OP #108575 — 문서 GET 200(text/html) 관측용 실 정적 루트(static-app.ts 해상도: /app/chat/ → <root>/chat/index.html)
  const chatDir = join(staticDir, 'chat');
  mkdirSync(chatDir, { recursive: true }); // mkdirSync 은 recursive 없이는 반환값이 undefined — 경로를 변수로 쓴다
  writeFileSync(join(chatDir, 'index.html'), '<!doctype html><title>elanous webchat</title><p>엘라누스 웹채팅</p>');
  const assetsDir = join(staticDir, '_next', 'static', 'chunks');
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, 'main-12345678abcdef.js'), 'window.webchatReady=true;');
  writeFileSync(join(assetsDir, 'unhashed.js'), 'not public');
  const buildDir = join(staticDir, '_next', 'static', 'test-build-Id');
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(join(buildDir, '_buildManifest.js'), 'self.__BUILD_MANIFEST={};');
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
          staticDir,                     // 출처: OP #108575 — 착지 문서 정적 루트 배선(위 정적 루트)
          forwardApi: async (apiRequest) =>
            (await routeRequest(apiRequest, routeOpts, {} as never, null, createDevProxyRuntimeRef())) ??
            new Response(null, { status: 404 }),
        })) ?? new Response(null, { status: 404 });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50)); // 호스트 공개키 수락 반영 대기

    const OWN_ORIGIN = 'https://owner.elanous.app';
    const bare = (method: 'GET' | 'HEAD' | 'POST', path: string, cookie?: string, extra: Record<string, string> = {}) =>
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
    const status = async (method: 'GET' | 'POST', path: string, cookie?: string) => {
      const response = await bare(method, path, cookie);
      await response.body?.cancel();
      return response.status;
    };

    // The public bare host must serve only immutable build assets without the
    // path-scoped chat cookie, through the actual relay and Nexus static tree.
    const asset = '/app/_next/static/chunks/main-12345678abcdef.js';
    const assetResponse = await bare('GET', asset);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get('content-type')).toContain('javascript');
    expect(await assetResponse.text()).toContain('window.webchatReady=true');
    const headAsset = await bare('HEAD', asset);
    expect(headAsset.status).toBe(200);
    expect(await headAsset.text()).toBe('');
    const manifest = await bare('GET', '/app/_next/static/test-build-Id/_buildManifest.js');
    expect(manifest.status).toBe(200);
    expect(await manifest.text()).toContain('__BUILD_MANIFEST');
    expect((await bare('POST', asset)).status).not.toBe(200);
    expect((await bare('GET', '/app/_next/static/chunks/unhashed.js')).status).not.toBe(200);
    expect((await bare('GET', '/app/_next/static/chunks/main-12345678abcdef.js.map')).status).not.toBe(200);
    expect((await bare('GET', '/app/secret-12345678.js')).status).not.toBe(200);

    // ③ 합성 bare 앱 id(''): 읽기 판정 isDown 은 throw 없이 «다운 아님» — RES #108420 수리
    //    원문. 수리 전엔 validateAppId('') 가 throw('invalid app kill switch app id').
    expect(killSwitch.isDown(owner.id, '')).toBe(false);

    // ① 무쿠키 handoff 교환: #39154 우회 경로 직후 isDown 판정을 지나 Nexus consume 로
    //    303 + 3-Path wcs_ — 수리 전엔 이 한 줄이 500(실측 #108420).
    const token = handoff.issue(owner.id, 'owner')!;
    const exchanged = await bare('GET', `/app/chat/handoff?handoff-token=${encodeURIComponent(token)}`);
    expect(exchanged.status).toBe(303);
    expect(exchanged.headers.getSetCookie().map((line) => /Path=([^;]+)/.exec(line)?.[1]))
      .toEqual(['/app/chat', '/v1/prompt/stream', '/v1/chat/events', '/v1/sessions/store']);
    const cookieLine = exchanged.headers.getSetCookie().find((line) => line.includes('Path=/v1/prompt/stream'))!;
    const cookie = cookieLine.slice(0, cookieLine.indexOf(';'));   // «__Secure-elanous_webchat_session=wcs_…»

    // 그 wcs_ 로 착지 문서 2경로(OP #108575 ① — 릴레이 wcs_-포워드 집합 확장):
    // GET /app/chat 은 호스트 PWA 진입 303 → /app/chat/ · GET /app/chat/ 은 실 정적
    // 문서 200 text/html(static-app.ts — <staticDir>/chat/index.html). 수리 전엔 이
    // 요청이 회원 게이트 401 안내 HTML 로 막혔다(bareWebChatSession 이 채팅 쌍만
    // 열었음 — 원문 종단 bd47bc34 결함). 수리 전후 모두 500 이 아니다.
    const entry = await bare('GET', '/app/chat', cookie, { accept: 'text/html' });
    expect(entry.status).toBe(303);
    expect(entry.headers.get('location')).toBe('/app/chat/');
    const document = await bare('GET', '/app/chat/', cookie, { accept: 'text/html' });
    expect(document.status).toBe(200);
    expect(document.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect((await document.text()).includes('엘라누스 웹채팅')).toBe(true);

    // 채팅 한 쌍 개통: GET 은 SSE 200, POST 는 인증 통과 뒤 프롬프트 런타임 미배선 503
    // (위 #39067 시험 ① 과 같은 값 — 500 아님).
    createOwnedSession('a1a1a1a1-0000-4000-8000-000000000003', owner.id); // JUD #39431 필수 ① — 구독은 소유 확정 세션만
    expect(await status('GET', '/v1/chat/events?sessionId=a1a1a1a1-0000-4000-8000-000000000003', cookie)).toBe(200);
    expect(await status('POST', '/v1/prompt/stream', cookie)).toBe(503);

    // 출처: OP #108575 ② — 문서 GET 의 wcs_ fail-closed 리터럴 4종(위조 · 남의
    // handle 결속 → 401 Nexus 정적 갈래 · 만료 · 폐기 → 401). 무쿠키 문서 GET 은
    // 릴레이 회원 게이트가 기존 401 안내 HTML 로 계속 막는다(① 릴레이측 그대로 ·
    // 경로 확장 0). 리터럴 꼴은 위 시험 ① 의 채팅 쌍 리터럴을 그대로 옮긴다.
    const forged = await bare('GET', '/app/chat/', '__Secure-elanous_webchat_session=wcs_00000000-0000-4000-8000-000000000000');
    expect(forged.status).toBe(401);
    expect((await forged.json()).error).toBe('webchat-session-invalid');
    const otherHandleDoc = handoff.issueDerivedSession(owner.id, 'muse');
    expect((await bare('GET', '/app/chat/', `__Secure-elanous_webchat_session=${otherHandleDoc}`)).status).toBe(401);
    clockMs += 2 * 60 * 60_000 + 1_000;   // 마지막 사용 뒤 유휴 2시간 + 1초(출처: JUD #104249 ⓑ — 위 시험 ① ③ 수명 꼴)
    expect((await bare('GET', '/app/chat/', cookie)).status).toBe(401);
    const token2 = handoff.issue(owner.id, 'owner')!;
    const exchanged2 = await bare('GET', `/app/chat/handoff?handoff-token=${encodeURIComponent(token2)}`);
    expect(exchanged2.status).toBe(303);   // 만료 뒤 재교환으로 새 wcs_ 발급 — 폐기 리터럴 직전 문서 재개통 증명
    const cookieLine2 = exchanged2.headers.getSetCookie().find((line) => line.includes('Path=/v1/prompt/stream'))!;
    const cookie2 = cookieLine2.slice(0, cookieLine2.indexOf(';'));
    expect((await bare('GET', '/app/chat/', cookie2)).status).toBe(200);
    handoff.revokeDerivedForMember(owner.id);   // 폐기 — 위 시험 ① ④ 리터럴 꼴 그대로
    expect((await bare('GET', '/app/chat/', cookie2)).status).toBe(401);
    const noCookieDoc = await bare('GET', '/app/chat/', undefined, { accept: 'text/html' });
    expect(noCookieDoc.status).toBe(401);
    expect(noCookieDoc.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect((await noCookieDoc.text()).includes('엘라누스 회원 로그인')).toBe(true);
  } finally {
    host?.close();
    relay.stop();
    nexus.close();
  }
});

// 출처: RES #108420 대칭 케이스 — 실제 유효 앱 id 를 다운 상태로 만들면 실제 인스턴스의
// isDown 이 참이 된다(403 «App unavailable» 배선 — 회원 게이트 직후 → 403 — 은 기존
// relay-server.test.ts 의 appKillSwitch 주입 시험이 이미 잰다). 수리가 무효 id 관대화로
// 실제 앱 핀 보호를 훼손하지 않음을, 쓰기 경로(applyIncident)의 validateAppId 유지와
// 함께 증명한다.
test('app-kill-switch 주입: 실제 앱 id 다운 상태 전이(실 sqlite 왕복) — 실제 앱 핀 보호 · 쓰기 경로 무효 id 거부 유지 (RES #108420)', async () => {
  const now = Date.parse('2026-11-19T00:00:00.000Z'); // 출처: #39024 선례와 같은 고정 시계 꼴
  const nexus = createMemberStore({ path: ':memory:', now: () => now });
  const owner = nexus.register(
    { sub: 'owner', email: 'owner@example.test', emailVerified: true, name: 'owner' },
    { consents: { privacy: 'v1', terms: 'v1' } },
  );
  const hostToken = nexus.mintMemberAccessToken(owner.initialKey!.id, owner.id, ['relay.connect'], 3600).token; // 출처: #36200 회원 토큰 1시간 기본
  const memberOf = (token: string) => nexus.memberForAccessToken(token, 'relay.connect', undefined, new Date(now).toISOString());

  const killSwitch = createAppKillSwitch(
    join(realpathSync(mkdtempSync(join(tmpdir(), 'app-kill-switch-relay-'))), 'state.sqlite'),
  ); // 실 킬스위스 인스턴스 — 실측 결함(RES #108420)은 시험 하니스가 이 판정을 주입 안 해 놓친 것이다.

  const eventBus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'bare-webchat-killswitch-down' });
  state.bus = eventBus;
  const routeOpts = {
    state,
    registry: new TabRegistry(state),
    eventBus,
    membersApi: { memberForScope: () => null },
    metaApi: { bearerToken: 'secret' },
  } as never;

  const pins = createRelayWebChatLedger({});
  pins.recordPin('owner', owner.id, Promise.resolve({ ok: true }));
  await new Promise((resolve) => setTimeout(resolve, 0)); // 핀 프라미스 반영 대기
  const handoff = createWebChatHandoffLedger({}, () => now); // 출처: OP #107132 — 2인자 원장

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
    publicReadableApps: new Set(['owner/chat']),   // 실제 앱 1개 — publicApp = { app: 'chat', user: 'owner' }
    memberRequired: true,
    appKillSwitch: killSwitch,
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

    // ② 실제 앱 id 를 다운 상태로: 실 인스턴스의 sqlite 상태표 왕복으로 isDown 이 참이 된다.
    killSwitch.applyIncident({
      userId: owner.id,
      appId: 'chat',
      incident: 'abuse-report',
      reason: '회기: 실제 앱 핀 보호 대칭 케이스 — 합성 bare 앱 id 관대화(RES #108420)가 보호를 훼손하지 않음을 증명',
      requestedBy: 'relay-bare-killswitch-guard-test',
    });
    expect(killSwitch.isDown(owner.id, 'chat')).toBe(true);

    // ③ 대칭 단언: 합성 bare 앱 id('') 는 실제 앱이 다운이어도 «다운 아님».
    expect(killSwitch.isDown(owner.id, '')).toBe(false);

    // 쓰기 경로(applyIncident)의 validateAppId 는 그대로 — 무효 앱 id 사고 등록은 여전히 거부.
    expect(() => killSwitch.applyIncident({
      userId: owner.id,
      appId: '',
      incident: 'abuse-report',
      reason: '무효 앱 id 거부 회기',
      requestedBy: 'relay-bare-killswitch-guard-test',
    })).toThrow('invalid app kill switch app id');
  } finally {
    host?.close();
    relay.stop();
    nexus.close();
  }
});
