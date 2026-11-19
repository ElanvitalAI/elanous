// 출처: #39024 — HANDLE-BARE-HOST-WEBCCHAT-PROXY-FU must ⓐ 끝-끝 시험. 실 릴레이
// (startRelayServer) → 실 connectRelayHost(host-connector) → 실
// routeBareWebChatHostRequest → 실 routeRequest/decideAuth 을 갈아 끼우고, bare
// `<handle>.elanous.app` 회원 채팅 쌍이 «같은 소유자 emt_ → 승인(200), 다른
// 소유자 emt_ → 401, 릴레이 표시 없는 요청 → 401» 계약을 지키는지 실측한다.
// 릴레이 하니스·mux 프레임·전화 채널 조립은 선례 host-connector.test.ts, 회원
// 저장소·토큰 시계는 선례 relay-member-auth.sim.test.ts, 라우팅 부트는 선례
// http-server-bare-webchat-sse.test.ts 를 따른다.
import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  serverIdFromPublicKey,
  generateDaemonKeyPair,
  createPhoneChannel,
} from './channel.js';
import { connectRelayHost } from './host-connector.js';
import { MuxDecoder, MuxEncoder, MuxStreamState } from './mux.js';
import { startRelayServer } from './relay-server.js';
import { createMemberStore } from '../nexus/members/member-store.js';
import {
  createRelayWebChatLedger,
  routeBareWebChatHostRequest,
  routeRequest,
} from '../nexus/api/http-server.js';
import { createDevProxyRuntimeRef } from '../nexus/api/admin-dev-proxy.js';
import { NexusEventBus } from '../nexus/api/event-bus.js';
import { createNexusState } from '../nexus/state/state.js';
import { TabRegistry } from '../nexus/state/tab-registry.js';

type RelayFrame = {
  streamId: number;
  kind: 'open' | 'data' | 'close' | 'end';
  data?: Uint8Array;
};

type RelayEnvelope = {
  status: number;
  headers: Record<string, string>;
  body: string;
  stream?: boolean;
};

test('bare 웹채팅 채팅 쌍은 릴레이 신뢰채널 + 핀 소유자 일치 emt_ 만 승인한다', async () => {
  // ── 회원: 실 createMemberStore + 실 emt_ 발급(선례 sim 시험의 고정 시계) ──
  const now = Date.parse('2026-11-18T00:00:00.000Z'); // 출처: #39024 — 선례와 같은 고정 시계
  const nexus = createMemberStore({ path: ':memory:', now: () => now });
  const register = (sub: string) =>
    nexus.register(
      { sub, email: `${sub}@example.test`, emailVerified: true, name: sub },
      { consents: { privacy: 'v1', terms: 'v1' } },
    );
  const owner = register('owner');
  const foreign = register('foreign');
  const mint = (member: typeof owner) =>
    nexus
      .mintMemberAccessToken(
        member.initialKey!.id,
        member.id,
        ['relay.connect'],
        3600, // 출처: #36200 — 회원 토큰 1시간 기본(선례 sim 시험과 같은 ttl); PWA 는 audience 값을 모르므로 생략
      )
      .token;
  const ownerToken = mint(owner);
  const foreignToken = mint(foreign);

  // ── 라우팅 옵트: 선례 sse 시험 부트 + sim 시험 membersApi 손잡이 ──
  const eventBus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'bare-webchat-member' });
  state.bus = eventBus;
  const routeOpts = {
    state,
    registry: new TabRegistry(state),
    eventBus,
    membersApi: {
      memberForScope: (request: Request, scope: string, audience?: string) =>
        nexus.memberForAccessToken(
          request.headers.get('authorization')?.slice(7) ?? '', // 출처: #39024 — 'Bearer ' 접두어 길이(선례 sim 시험과 동일 코드)
          scope,
          audience,
          new Date(now).toISOString(),
        ),
    },
    metaApi: { bearerToken: 'secret' }, // 출처: #39024 — emt_ 와 절대 같아질 수 없는 운영 bearer(선례 sse 시험과 같은 값)
  } as never;

  // ── 핀 원장: 실 createRelayWebChatLedger — recordPin(handle, memberId, pin) 확장 계약 ──
  const ledger = createRelayWebChatLedger({});
  ledger.recordPin('owner', owner.id, Promise.resolve({ ok: true }));
  await new Promise((resolve) => setTimeout(resolve, 0)); // 출처: #39024 — 핀 프라미스 결과 반영 대기
  expect(ledger.handles.has('owner')).toBe(true); // 출처: #39024 — 핀 성공 → 서빙 게이트
  expect(ledger.pinOwners.get('owner')).toBe(owner.id); // 출처: #39024 — 핀 성공 → 소유자 기록

  // ── 릴레이: 실 startRelayServer + 실 connectRelayHost(운영 배선과 같은 구성) ──
  const daemonKeys = await generateDaemonKeyPair(new Uint8Array(32).fill(7)); // 출처: #39024 — 선례 host-connector.test.ts 결정론 키
  const serverId = serverIdFromPublicKey(daemonKeys.publicKey);
  const signingKeys = generateKeyPairSync('ed25519');
  const publicKey = (signingKeys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
    .subarray(-32)
    .toString('base64url');
  const relay = startRelayServer({
    port: 0,
    hostname: '127.0.0.1',
    trustedHostKeys: new Map([[serverId, publicKey]]),
  });
  let host: Awaited<ReturnType<typeof connectRelayHost>> | undefined;
  let phone: WebSocket | undefined;
  try {
    host = await connectRelayHost({
      relayUrl: `ws://127.0.0.1:${relay.port}/host`,
      daemonKeys,
      hostSigningKey: signingKeys.privateKey,
      async handleRequest(request) {
        // 운영 배선(http-server.ts startRelayConnection)과 같은 구성: bare 원점은
        // routeBareWebChatHostRequest 로 들어가고, 채팅 쌍 신뢰채널 표시는 그
        // 안의 pinOwners 대조가 남긴다(표시 → routeRequest → decideAuth).
        return (
          (await routeBareWebChatHostRequest(request, {
            pinnedHandles: ledger.handles,
            pinOwners: ledger.pinOwners, // 출처: #39024 — 운영 배선과 같은 소유자 지도
            forwardApi: async (apiRequest) =>
              (await routeRequest(apiRequest, routeOpts, {} as never, null, createDevProxyRuntimeRef())) ??
              new Response(null, { status: 404 }), // 출처: #39024 — routeRequest 미처리 폴백(운영 배선과 동일 형태)
          })) ?? new Response(null, { status: 404 }) // 출처: #39024 — bare 미분기 폴백
        );
      },
    });

    // ── 전화(소비자) 소켓: 선례 host-connector.test.ts 조립 그대로 ──
    phone = new WebSocket(`ws://127.0.0.1:${relay.port}/client?serverId=${serverId}`);
    phone.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('relay connected frame missing')), 3000); // 출처: #39024 — 선례와 같은 3초 대기
      const onMessage = (event: MessageEvent) => {
        if (typeof event.data !== 'string') return;
        if ((JSON.parse(event.data) as { type?: string }).type !== 'connected') return;
        clearTimeout(timeout);
        phone!.removeEventListener('message', onMessage);
        resolve();
      };
      phone!.addEventListener('message', onMessage);
      phone!.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('relay phone socket error'));
      }, { once: true });
    });
    const phoneResult = await createPhoneChannel(
      daemonKeys.publicKey,
      daemonKeys.publicKey,
      new Uint8Array(32).fill(8), // 출처: #39024 — 선례 host-connector.test.ts 같은 채널 시드
    );
    if (!phoneResult.ok) throw new Error(phoneResult.reason);
    const phoneChannel = phoneResult.value;
    const streams = new MuxStreamState();
    const encoder = new MuxEncoder(streams);
    const decoder = new MuxDecoder(streams);
    const sendMuxFrame = (frame: Parameters<typeof encoder.encode>[0]) => {
      const encoded = encoder.encode(frame);
      if (!encoded.ok) throw new Error(encoded.reason);
      const sealed = phoneChannel.channel.seal(encoded.value);
      if (!sealed.ok) throw new Error(sealed.reason);
      phone!.send(sealed.value);
    };
    phone!.send(phoneChannel.phonePublicKey);

    // 프레임당 정확히 한 번만 decode 한다(선례와 같은 소비 규칙).
    const awaitFrame = (accept: (frame: RelayFrame) => boolean): Promise<RelayFrame> =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timed out waiting for relay frame')), 3000); // 출처: #39024 — 선례와 같은 3초 대기
        const onMessage = (event: MessageEvent) => {
          if (typeof event.data === 'string') return;
          const opened = phoneChannel.channel.open(new Uint8Array(event.data as ArrayBuffer));
          if (!opened.ok) return;
          const decoded = decoder.decode(opened.value);
          if (!decoded.ok) return;
          const frame = decoded.value as RelayFrame;
          if (!accept(frame)) return;
          clearTimeout(timeout);
          phone!.removeEventListener('message', onMessage);
          resolve(frame);
        };
        phone!.addEventListener('message', onMessage);
        phone!.addEventListener('error', () => {
          clearTimeout(timeout);
          reject(new Error('relay phone socket error'));
        }, { once: true });
      });

    let streamId = 400; // 출처: #39024 — 선례 host-connector.test.ts 같은 임의 streamId 밴드
    const requestBare = async (method: 'GET' | 'POST', path: string, authorization?: string) => {
      const id = streamId++;
      sendMuxFrame({
        streamId: id,
        kind: 'open',
        protocol: 'http',
        method,
        path,
        headers: {
          host: 'owner.elanous.app', // 출처: #39024 — bare 회원 원점(단일 레이블 핸들)
          ...(authorization ? { authorization } : {}),
          ...(method === 'POST' ? { 'content-length': '0' } : {}), // 출처: #39024 — 빈 몸통 POST
        },
      });
      sendMuxFrame({ streamId: id, kind: 'end' });
      const envelopeFrame = await awaitFrame((frame) => frame.kind === 'data' && frame.streamId === id);
      const envelope = JSON.parse(new TextDecoder().decode(envelopeFrame.data)) as RelayEnvelope;
      return { id, envelope };
    };

    // 같은 소유자 emt_ — GET /v1/chat/events → 200 SSE 스캐폴드 + subscribed 청크.
    const own = await requestBare('GET', '/v1/chat/events?sessionId=bare-member-1', `Bearer ${ownerToken}`);
    expect(own.envelope.status).toBe(200); // 출처: #39024 — must ⓐ: 같은 소유자 emt_ 승인
    expect(own.envelope.headers['content-type']?.toLowerCase()).toContain('text/event-stream'); // 출처: #39024 — SSE 응답 계약
    expect(own.envelope.stream).toBe(true); // 출처: #39024 — 몸통은 뒤따르는 chunk 프레임(#39009 전송 계약)
    const chunkFrame = await awaitFrame((frame) => frame.kind === 'data' && frame.streamId === own.id);
    const chunk = JSON.parse(new TextDecoder().decode(chunkFrame.data)) as { chunk: string };
    const chunkText = Buffer.from(chunk.chunk, 'base64').toString('utf8');
    expect(chunkText).toContain('event: subscribed'); // 출처: #39024 — 첫 SSE 프레임(선례 sse 시험과 동일 계약)
    sendMuxFrame({ streamId: own.id, kind: 'close', reason: 'test done' }); // 출처: #39024 — 스트림 정리

    // 다른 소유자 emt_ — 같은 경로·같은 핀 원점이어도 401.
    const alien = await requestBare('GET', '/v1/chat/events?sessionId=bare-member-2', `Bearer ${foreignToken}`);
    expect(alien.envelope.status).toBe(401); // 출처: #39024 — must ⓐ: 소유자 불일치 폐쇄

    // POST 쌍: 같은 소유자 emt_ → 인증 통과(런타임 미와이어 503), 다른 소유자/무토큰 → 401.
    const promptOk = await requestBare('POST', '/v1/prompt/stream', `Bearer ${ownerToken}`);
    expect(promptOk.envelope.status).toBe(503); // 출처: #39024 — 인증 갈래 통과 + 프롬프트 런타임 미와이어(선례 sse 시험과 동일 결과)
    const promptAlien = await requestBare('POST', '/v1/prompt/stream', `Bearer ${foreignToken}`);
    expect(promptAlien.envelope.status).toBe(401); // 출처: #39024
    const promptNoAuth = await requestBare('POST', '/v1/prompt/stream');
    expect(promptNoAuth.envelope.status).toBe(401); // 출처: #39024 — 표시가 있어도 자격증이 없으면 폐쇄

    // 릴레이를 거치지 않은 요청(공개 인터넷 흉내)은 같은 소유자 emt_ 여도 401 —
    // 신뢰채널 표시 없이는 갈래가 절대 열리지 않는다.
    const spoofed = await routeRequest(
      new Request('http://owner.elanous.app/v1/chat/events?sessionId=bare-member-3', {
        headers: { authorization: `Bearer ${ownerToken}` },
      }),
      routeOpts,
      {} as never,
      null,
      createDevProxyRuntimeRef(),
    );
    expect(spoofed?.status).toBe(401); // 출처: #39024 — must ⓐ: 미표시 요청 폐쇄
  } finally {
    phone?.close();
    host?.close();
    relay.stop();
    nexus.close();
  }
});
