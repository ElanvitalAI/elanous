// 출처: #39009 — HANDLE-BARE-HOST-WEBCCHAT-PROXY-FU: bare 오리진 회원 인증
// 채팅 API 의 SSE 스트리밍 계약 시험. 최소 부트는 선례
// check-same-origin.test.ts:106 (state=createNexusState / registry=TabRegistry /
// eventBus=NexusEventBus / hostname·startPort / metaApi:{bearerToken}) 을 따른다.
import { afterEach, expect, test } from 'bun:test';
import { startNexusHttpServer } from './http-server.js';
import { NexusEventBus } from './event-bus.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { defaultChatEventBus } from './chat-event-bus.js';

let server: ReturnType<typeof startNexusHttpServer> | undefined;

afterEach(() => server?.stop());

function boot() {
  const eventBus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'bare-webchat-sse' });
  state.bus = eventBus;
  server = startNexusHttpServer({
    state,
    registry: new TabRegistry(state),
    eventBus,
    hostname: '127.0.0.1',
    startPort: 46000 + Math.floor(Math.random() * 1000), // 출처: #39009 — 선례와 같은 포트 밴드
    metaApi: {
      bearerToken: 'secret',
      voiceRest: {
        handleCost: () => new Response('{}', { status: 200 }), // 출처: #39009 — 선례와 같은 최소 voiceRest 스텁
        handleTranscribe: async () => new Response('{}', { status: 200 }), // 출처: #39009
      },
    },
  });
  return server;
}

const authHeaders = { authorization: 'Bearer secret', 'sec-fetch-site': 'same-origin' };

test('무인증 GET /v1/chat/events 는 401, 정당 bearer 는 200 text/event-stream + subscribed', async () => {
  const { url } = boot();
  const unauth = await fetch(`${url}/v1/chat/events?sessionId=bare-sse-1`);
  expect(unauth.status).toBe(401); // 출처: #39009 — 무인증 거절 계약

  const response = await fetch(`${url}/v1/chat/events?sessionId=bare-sse-1`, {
    headers: authHeaders,
  });
  expect(response.status).toBe(200); // 출처: #39009
  expect(response.headers.get('content-type')).toContain('text/event-stream'); // 출처: #39009 — SSE content-type 계약
  const reader = response.body!.getReader();
  const first = await reader.read();
  const firstText = new TextDecoder().decode(first.value!);
  expect(firstText).toContain('event: subscribed'); // 출처: #39009 — 첫 SSE 프레임은 subscribed
  expect(firstText).toContain('bare-sse-1'); // 출처: #39009 — 구독 sessionId 가 프레임에 실린다
  await reader.cancel();
});

test('POST /v1/prompt/stream 몸통 없음은 503, 잡경로는 404', async () => {
  const { url } = boot();
  const prompt = await fetch(`${url}/v1/prompt/stream`, {
    method: 'POST',
    headers: authHeaders,
  });
  expect(prompt.status).toBe(503); // 출처: #39009 — 프롬프트 런타임 미와이어 시 503

  const notFound = await fetch(`${url}/v1/no-such-bare-route`, { headers: authHeaders });
  expect(notFound.status).toBe(404); // 출처: #39009 — 잡경로 폴백
});

test('SSE 청크 프레임은 발행 순서 그대로 흐른다(실측)', async () => {
  const { url } = boot();
  const bus = defaultChatEventBus();
  const response = await fetch(`${url}/v1/chat/events?sessionId=bare-order-1`, {
    headers: authHeaders,
  });
  expect(response.status).toBe(200); // 출처: #39009
  const reader = response.body!.getReader();
  const dec = new TextDecoder();

  const first = await reader.read();
  const firstText = dec.decode(first.value!);
  expect(firstText).toContain('event: subscribed'); // 출처: #39009 — 1번째 프레임: subscribed

  bus.publish('bare-order-1', { event: 'turn-begin', data: { turn: 1 } }); // 출처: #39009 — 1번째 발행
  const second = await reader.read();
  const secondText = dec.decode(second.value!);
  expect(secondText).toContain('event: turn-begin'); // 출처: #39009 — 2번째 프레임은 발행 순서 그대로
  expect(secondText).toContain('"turn":1'); // 출처: #39009

  bus.publish('bare-order-1', { event: 'turn-end', data: { turn: 1 } }); // 출처: #39009 — 2번째 발행
  const third = await reader.read();
  const thirdText = dec.decode(third.value!);
  expect(thirdText).toContain('event: turn-end'); // 출처: #39009 — 3번째 프레임, 순서 보존

  await reader.cancel();
});
