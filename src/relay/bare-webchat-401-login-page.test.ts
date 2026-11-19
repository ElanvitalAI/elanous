import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { serverIdFromPublicKey } from './channel.js';
import { startRelayServer } from './relay-server.js';
import { createMemberStore } from '../nexus/members/member-store.js';
import { routeRequest } from '../nexus/api/http-server.js';
import { createDevProxyRuntimeRef } from '../nexus/api/admin-dev-proxy.js';
import { createNexusRelayMemberVerifier } from './relay-member-verifier.js';

// WEBCHAT-401-LOGIN-PAGE — bare 핸들 호스트(회원 webchat 원점)에서 세션 없는
// «문서 요청»(GET + Accept: text/html)은 401 상태를 유지한 채 로그인 안내 HTML
// 본문으로 바꾼다. API(JSON·SSE)·app 오리진은 기존 401 본문 그대로(401 렌더만 변경).
test('bare handle host 401 keeps status but serves member login guide HTML for document requests only', async () => {
  const signing = generateKeyPairSync('ed25519');
  const publicKey = signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const host = generateKeyPairSync('x25519');
  const serverId = serverIdFromPublicKey(new Uint8Array(host.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)));
  const trustedHostKeys = new Map([[serverId, publicKey]]);
  const now = Date.parse('2026-11-19T00:00:00.000Z');
  const nexus = createMemberStore({ path: ':memory:', now: () => now });
  const owner = nexus.register({ sub: 'owner', email: 'owner@example.test', emailVerified: true, name: 'owner' },
    { consents: { privacy: 'v1', terms: 'v1' } });
  const valid = nexus.mintMemberAccessToken(owner.initialKey!.id, owner.id,
    ['relay.connect'], 3600, serverId).token;
  const validateMemberToken = createNexusRelayMemberVerifier('https://hq.ts.net/',
    (async (input: RequestInfo | URL, init?: RequestInit) => await routeRequest(new Request(input, init),
      { membersApi: { memberForScope: (request: Request, scope: string, audience?: string) =>
        nexus.memberForAccessToken(request.headers.get('authorization')?.slice(7) ?? '', scope, audience,
          new Date(now).toISOString()) } } as never,
      {} as never, null, createDevProxyRuntimeRef()) ?? new Response(null, { status: 404 })) as typeof fetch);
  const publicRelay = startRelayServer({ trustedHostKeys, memberRequired: true,
    hostOwnerMemberIds: new Map([[serverId, owner.id]]), validateMemberToken,
    publicDomain: 'elanous.app', publicServerId: serverId, publicUserId: 'owner' });
  const address = `http://127.0.0.1:${publicRelay.port}/`;
  const browserAccept = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
  try {
    // ① 문서 요청(GET + Accept: text/html): 401 유지 + 안내 문구·링크 리터럴, content-type text/html.
    const doc = await fetch(address, { headers: { host: 'owner.elanous.app', accept: browserAccept } });
    expect(doc.status).toBe(401);
    expect(doc.headers.get('content-type')).toContain('text/html');
    const html = await doc.text();
    expect(html).toContain('엘라누스 회원 로그인 → 내 엘라누스에서 웹채팅 열기');
    expect(html).toContain('https://elanous.ai/members/');
    expect(doc.headers.get('cache-control')).toBe('no-store');
    // ② API(JSON) 요청: 기존 401 «unauthorized» 본문 그대로.
    const json = await fetch(address, { headers: { host: 'owner.elanous.app', accept: 'application/json' } });
    expect(json.status).toBe(401);
    expect(await json.text()).toBe('unauthorized');
    // ③ SSE 요청(/v1/chat/events): 기존 401 «unauthorized» 그대로.
    const sse = await fetch(`${address}v1/chat/events`, { headers: { host: 'owner.elanous.app', accept: 'text/event-stream' } });
    expect(sse.status).toBe(401);
    expect(await sse.text()).toBe('unauthorized');
    // ④ app 오리진 문서 요청은 이번 범위 밖(bareHit 아님): 기존 본문 그대로.
    const app = await fetch(address, { headers: { host: 'notes--owner.elanous.app', accept: 'text/html' } });
    expect(app.status).toBe(401);
    expect(await app.text()).toBe('unauthorized');
    // ⑤ 회원 자격 증명이 유효하면 문서 요청도 게이트 통과(호스트 미연결 503) — 상태·게이트 로직 불변.
    const member = await fetch(address, { headers: { host: 'owner.elanous.app', accept: browserAccept, authorization: `Bearer ${valid}` } });
    expect(member.status).toBe(503);
  } finally { publicRelay.stop(); nexus.close(); }
});

// WEBCHAT-401-LOGIN-PAGE — JUD must ⓑ(OP #103843): 로그인 회원이 busy(429)
// (memberAuthorized 의 member-check 천장 도달)여도 bare «문서 요청»은 로그인 안내
// 401 이 아니라 기존 busy 429 평문을 유지한다. checksGate 는 절대 resolve하지
// 않는다 — 천장 점유 행업 유지(정리 불필요, dangling promise 무해).
test('bare handle host busy(429) member document request keeps the plain busy response, not the login guide', async () => {
  const signing = generateKeyPairSync('ed25519');
  const publicKey = signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const host = generateKeyPairSync('x25519');
  const serverId = serverIdFromPublicKey(new Uint8Array(host.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)));
  const trustedHostKeys = new Map([[serverId, publicKey]]);
  const now = Date.parse('2026-11-19T00:00:00.000Z');
  const nexus = createMemberStore({ path: ':memory:', now: () => now });
  const owner = nexus.register({ sub: 'owner', email: 'owner@example.test', emailVerified: true, name: 'owner' },
    { consents: { privacy: 'v1', terms: 'v1' } });
  // 73 = MAX_MEMBER_CHECKS = MAX_PUBLIC_REQUESTS_PER_SERVER(64) + MAX_CLIENTS_PER_SERVER(8) + 1(relay-server.ts).
  let verifierCalls = 0;
  let signalSaturation: (() => void) | null = null;
  const saturated = new Promise<void>((resolve) => { signalSaturation = resolve; });
  const checksGate = new Promise<void>(() => {});
  const validateMemberToken = (async (_token: string, _serverId: string) => {
    verifierCalls += 1;
    if (verifierCalls >= 73) signalSaturation?.();
    await checksGate;
    return { memberId: owner.id };
  }) as unknown as ReturnType<typeof createNexusRelayMemberVerifier>;
  const publicRelay = startRelayServer({ trustedHostKeys, memberRequired: true,
    hostOwnerMemberIds: new Map([[serverId, owner.id]]), validateMemberToken,
    publicDomain: 'elanous.app', publicServerId: serverId, publicUserId: 'owner' });
  const address = `http://127.0.0.1:${publicRelay.port}/`;
  const browserAccept = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
  const batch: Promise<unknown>[] = [];
  try {
    // 포화: 자격 증명(emt_ 형식이어야 memberCredentials 가 파싱) 73+10건 — 앞 73은 검증자 행업.
    for (let i = 0; i < 83; i++)
      batch.push(fetch(address, { headers: { host: 'owner.elanous.app', authorization: `Bearer emt_hang_${i}` } })
        .catch(() => null));
    await saturated;
    const probe = await fetch(address, { headers: { host: 'owner.elanous.app', accept: browserAccept,
      authorization: 'Bearer emt_probe_busy_member' } });
    expect(probe.status).toBe(429);
    expect((probe.headers.get('content-type') ?? '').toLowerCase()).not.toContain('text/html');
    expect(await probe.text()).toBe('busy');
  } finally {
    publicRelay.stop();
    nexus.close();
    await Promise.allSettled(batch);
  }
});
// (출처: #106092) ⓑ OP #106119 ③ 리터럴 — 익명(자격 증명 없음) bare 핸들
// 문서 요청(GET + Accept: text/html)은 401 상태를 유지하며 회원 로그인 안내
// HTML(#39058 WEBCHAT-401-LOGIN-PAGE) 본문이 나온다: 평문 401 이 안내
// 응답보다 앞서지 않는다(응답 경로 순서 고정).
test('anonymous bare handle document request (Accept: text/html) yields 401 with the login guide HTML body (#106119 ③)', async () => {
  const signing = generateKeyPairSync('ed25519');
  const publicKey = signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const host = generateKeyPairSync('x25519');
  const serverId = serverIdFromPublicKey(new Uint8Array(host.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)));
  const trustedHostKeys = new Map([[serverId, publicKey]]);
  const now = Date.parse('2026-11-19T00:00:00.000Z');
  const nexus = createMemberStore({ path: ':memory:', now: () => now });
  const owner = nexus.register({ sub: 'owner', email: 'owner@example.test', emailVerified: true, name: 'owner' },
    { consents: { privacy: 'v1', terms: 'v1' } });
  const validateMemberToken = createNexusRelayMemberVerifier('https://hq.ts.net/',
    (async (input: RequestInfo | URL, init?: RequestInit) => await routeRequest(new Request(input, init),
      { membersApi: { memberForScope: (request: Request, scope: string, audience?: string) =>
        nexus.memberForAccessToken(request.headers.get('authorization')?.slice(7) ?? '', scope, audience,
          new Date(now).toISOString()) } } as never,
      {} as never, null, createDevProxyRuntimeRef()) ?? new Response(null, { status: 404 })) as typeof fetch);
  const publicRelay = startRelayServer({ trustedHostKeys, memberRequired: true,
    hostOwnerMemberIds: new Map([[serverId, owner.id]]), validateMemberToken,
    publicDomain: 'elanous.app', publicServerId: serverId, publicUserId: 'owner' });
  try {
    // 익명 — 자격 증명 없음: 401 유지 + 안내 HTML 본문(평문 아님).
    const doc = await fetch(`http://127.0.0.1:${publicRelay.port}/`, { headers: { host: 'owner.elanous.app',
      accept: 'text/html' } });
    expect(doc.status).toBe(401);
    expect((doc.headers.get('content-type') ?? '').toLowerCase()).toContain('text/html');
    const html = await doc.text();
    expect(html).toContain('엘라누스 회원 로그인'); // (출처: #39058) 안내 문구
    expect(html).toContain('https://elanous.ai/members/'); // (출처: #39058) 안내 링크
    expect(html).not.toBe('unauthorized'); // 평문 401 이 앞서지 않는다
  } finally { publicRelay.stop(); nexus.close(); }
});
