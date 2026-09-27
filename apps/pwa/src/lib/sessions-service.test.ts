/**
 * SessionsService endpoint contract test.
 *
 * PWA 파리티 P1(2026-07-12): picker 데이터원이 구 in-memory `/v1/sessions`
 * → on-disk `/v1/sessions/store` 로 이관. fetch mock 으로 store 응답
 * (SessionStoreCard) → SessionSummary 매핑 + cache + subscriber notify +
 * dedupe + DELETE 경로 검증. 이 파일이 SessionsService의 유일한 canonical
 * 단위 시험 위치이며, 폴링·구독 수명·삭제 인코딩 회귀도 여기서 검증한다.
 * `test/pwa-sessions-service.test.ts`는 이 위치를 가리키는 migration marker다.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { DaemonClient } from './daemon-client';
import { SessionsService, cardToSummary } from './sessions-service';
import type { SessionStoreCard } from './sessions-store-api';

interface FetchCall {
  url: string | URL;
  method?: string;
}

const realFetch = globalThis.fetch;
let calls: FetchCall[] = [];

function mockResponse(opts: { status: number; body: unknown }): typeof fetch {
  return ((async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: input as string | URL, method: init?.method });
    return {
      ok: opts.status >= 200 && opts.status < 300,
      status: opts.status,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => opts.body,
      text: async () => JSON.stringify(opts.body),
    } as unknown as Response;
  }) as unknown) as typeof fetch;
}

function makeClient(): DaemonClient {
  return new DaemonClient({
    baseUrl: 'http://localhost:31415',
    token: '',
    provider: 'anthropic',
  });
}

function makeCard(over: Partial<SessionStoreCard>): SessionStoreCard {
  return {
    id: 'session-x',
    title: 'session',
    source: 'cli',
    createdAt: '2026-05-06T10:00:00Z',
    updatedAt: '2026-05-06T12:00:00Z',
    messageCount: 1,
    preview: 'hello',
    active: false,
    ...over,
  };
}

const SAMPLE_CARDS: SessionStoreCard[] = [
  makeCard({
    id: 'session-pwa-1',
    origin: 'pwa',
    messageCount: 14,
    updatedAt: '2026-05-06T12:00:00Z',
    preview: 'qwen 3.6 reasoning trace…',
  }),
  makeCard({
    id: 'session-cli-1',
    origin: 'cli',
    messageCount: 23,
    updatedAt: '2026-05-06T11:30:00Z',
    preview: '',
  }),
];

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

describe('cardToSummary — SessionStoreCard → SessionSummary 매핑', () => {
  it('maps store fields onto the picker summary shape', () => {
    const s = cardToSummary(SAMPLE_CARDS[0]!);
    expect(s).toEqual({
      id: 'session-pwa-1',
      msgCount: 14,
      lastTurnAt: '2026-05-06T12:00:00Z',
      lastMsgPreview: 'qwen 3.6 reasoning trace…',
      origin: 'pwa',
    });
  });

  it('omits lastMsgPreview when preview is empty (picker renders "(empty session)")', () => {
    const s = cardToSummary(makeCard({ preview: '  ' }));
    expect(s.lastMsgPreview).toBeUndefined();
  });

  it('falls back origin from coarse source when origin is absent (구세대 세션)', () => {
    expect(cardToSummary(makeCard({ origin: undefined, source: 'telegram' })).origin).toBe('tg');
    expect(cardToSummary(makeCard({ origin: undefined, source: 'cli' })).origin).toBe('cli');
  });

  it('drops unknown origin labels instead of rendering garbage', () => {
    const s = cardToSummary(makeCard({ origin: 'weird-surface', source: 'telegram' }));
    expect(s.origin).toBe('tg');
  });
});

describe('SessionsService.forceRefresh — GET /v1/sessions/store', () => {
  it('fetches the on-disk store list and caches mapped summaries', async () => {
    globalThis.fetch = mockResponse({
      status: 200,
      body: { ok: true, sessions: SAMPLE_CARDS, total: 2, ts: '2026-05-06T12:00:01Z' },
    });
    const client = makeClient();
    expect('prompt' in client).toBe(false);
    const service = new SessionsService(client);
    expect(service.list()).toEqual([]);
    await service.forceRefresh();
    expect(String(calls[0]!.url)).toBe('http://localhost:31415/v1/sessions/store');
    expect(service.list().map((s) => s.id)).toEqual(['session-pwa-1', 'session-cli-1']);
    expect(service.list()[0]!.msgCount).toBe(14);
    expect(service.list()[0]!.lastTurnAt).toBe('2026-05-06T12:00:00Z');
    service.dispose();
  });

  it('preserves the origin pill (pwa / cli / tg / dc) on each summary', async () => {
    globalThis.fetch = mockResponse({
      status: 200,
      body: {
        ok: true,
        sessions: [
          makeCard({ id: 's-tg-1', origin: 'tg', source: 'telegram' }),
          makeCard({ id: 's-dc-1', origin: 'dc' }),
        ],
      },
    });
    const service = new SessionsService(makeClient());
    await service.forceRefresh();
    expect(service.list().map((s) => s.origin)).toEqual(['tg', 'dc']);
    service.dispose();
  });

  it('notifies subscribers on cache update', async () => {
    globalThis.fetch = mockResponse({
      status: 200,
      body: { ok: true, sessions: SAMPLE_CARDS },
    });
    const service = new SessionsService(makeClient());
    let calledCount = 0;
    const unsubscribe = service.subscribe(() => { calledCount += 1; });
    await service.forceRefresh();
    expect(calledCount).toBeGreaterThan(0);
    unsubscribe();
    service.dispose();
  });

  it('dedupes concurrent forceRefresh callers — single fetch in flight', async () => {
    let resolveFetch: ((res: Response) => void) | null = null;
    globalThis.fetch = ((async (input: RequestInfo | URL) => {
      calls.push({ url: input as string | URL });
      return await new Promise<Response>((resolve) => { resolveFetch = resolve; });
    }) as unknown) as typeof fetch;

    const service = new SessionsService(makeClient());
    const p1 = service.forceRefresh();
    const p2 = service.forceRefresh();
    // Resolve the single in-flight promise — both callers should settle.
    resolveFetch!({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ ok: true, sessions: SAMPLE_CARDS }),
      text: async () => JSON.stringify({ ok: true, sessions: SAMPLE_CARDS }),
    } as unknown as Response);
    await Promise.all([p1, p2]);
    expect(calls.length).toBe(1);
    service.dispose();
  });

  // ⭐ 아래 둘은 옛 사본(test/pwa-sessions-service.test.ts)이 «지키던» 행동인데 이관에서 빠졌다.
  //   ⛔ 「이관했다」를 「전수로 옮겼다」로 읽지 않는다 — 옛 15개와 이름 단위로 대조해 둘이 남았다(2026-08-28).
  it('직렬 forceRefresh 는 매번 fetch 한다 — dedupe 는 «동시»에만 걸린다', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: { ok: true, sessions: SAMPLE_CARDS } });
    const service = new SessionsService(makeClient());
    await service.forceRefresh();
    await service.forceRefresh();
    // in-flight 가 «끝난 뒤» 부른 것은 새 요청이어야 한다. 여기서 1이 나오면 dedupe 가
    // 동시성 창을 넘어 «영구 캐시»처럼 굳은 것이고, picker 가 영원히 낡은 목록을 본다.
    expect(calls.length).toBe(2);
    service.dispose();
  });

  it('같은 shape 가 다시 오면 구독자를 «안» 부른다 — idle poll 이 re-render 를 터뜨리지 않게', async () => {
    // 📍 sessions-service.ts 가 그 이유를 적어 뒀다: "빈번한 idle poll 시 React re-render 폭발 방지".
    //   ⛔ 그 방어를 재는 자가 없으면 sameShape 를 지워도 초록이 남는다.
    globalThis.fetch = mockResponse({ status: 200, body: { ok: true, sessions: SAMPLE_CARDS } });
    const service = new SessionsService(makeClient());
    let notified = 0;
    service.subscribe(() => { notified += 1; });
    await service.forceRefresh();
    const afterFirst = notified;
    await service.forceRefresh();
    expect(afterFirst).toBeGreaterThan(0);
    expect(notified).toBe(afterFirst);
    service.dispose();
  });

  it('keeps the prior cache when the daemon returns 503', async () => {
    globalThis.fetch = mockResponse({
      status: 200,
      body: { ok: true, sessions: SAMPLE_CARDS },
    });
    const service = new SessionsService(makeClient());
    await service.forceRefresh();
    expect(service.list().length).toBe(2);
    // Now switch to 503 — the next refresh should swallow the error and
    // leave the cached snapshot intact.
    globalThis.fetch = mockResponse({
      status: 503,
      body: { error: 'meta-api-runtime-not-wired' },
    });
    await service.forceRefresh();
    expect(service.list().length).toBe(2);
    service.dispose();
  });

  it('treats a missing `sessions` field as an empty list', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: { ok: true } });
    const service = new SessionsService(makeClient());
    await service.forceRefresh();
    expect(service.list()).toEqual([]);
    service.dispose();
  });
});

describe('SessionsService subscriptions — current store-card updates', () => {
  it('notifies the picker subscriber when a card messageCount changes', async () => {
    const first = makeCard({ id: 'session-a', messageCount: 1 });
    const updated = makeCard({ id: 'session-a', messageCount: 2 });
    globalThis.fetch = mockResponse({ status: 200, body: { ok: true, sessions: [first] } });
    const service = new SessionsService(makeClient());
    let notifications = 0;
    service.subscribe(() => { notifications += 1; });
    await service.forceRefresh();
    globalThis.fetch = mockResponse({ status: 200, body: { ok: true, sessions: [updated] } });
    await service.forceRefresh();
    expect(notifications).toBe(2);
    expect(service.list()[0]!.msgCount).toBe(2);
    service.dispose();
  });

  it('continues notifying a later listener when an earlier listener throws', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: { ok: true, sessions: SAMPLE_CARDS } });
    const service = new SessionsService(makeClient());
    let notifications = 0;
    service.subscribe(() => { throw new Error('listener failure'); });
    service.subscribe(() => { notifications += 1; });
    await service.forceRefresh();
    expect(notifications).toBe(1);
    service.dispose();
  });

  it('does not notify an unsubscribed listener', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: { ok: true, sessions: SAMPLE_CARDS } });
    const service = new SessionsService(makeClient());
    let notifications = 0;
    const unsubscribe = service.subscribe(() => { notifications += 1; });
    unsubscribe();
    await service.forceRefresh();
    expect(notifications).toBe(0);
    service.dispose();
  });
});

describe('SessionsService polling — browser cadence', () => {
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervals = new Map<number, { tick: () => void; ms: number }>();
  let nextTimerId = 0;

  beforeEach(() => {
    intervals.clear();
    nextTimerId = 0;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    globalThis.setInterval = ((tick: () => void, ms: number) => {
      const id = ++nextTimerId;
      intervals.set(id, { tick, ms });
      return id;
    }) as typeof setInterval;
    globalThis.clearInterval = ((id: number) => {
      intervals.delete(id);
    }) as typeof clearInterval;
  });

  afterEach(() => {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    intervals.clear();
    if (originalWindowDescriptor) Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    else delete (globalThis as { window?: unknown }).window;
  });

  it('starts an immediate idle refresh and polls again at the idle cadence', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: { ok: true, sessions: [] } });
    const service = new SessionsService(makeClient(), { activeIntervalMs: 10, idleIntervalMs: 20 });
    try {
      service.start();
      expect(calls.length).toBe(1);
      expect([...intervals.values()].map((timer) => timer.ms)).toEqual([20]);
      await service.forceRefresh();
      intervals.values().next().value!.tick();
      expect(calls.length).toBe(2);
    } finally {
      service.dispose();
    }
    expect(intervals.size).toBe(0);
  });

  it('switches to active cadence and an idempotent release restores idle cadence', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: { ok: true, sessions: [] } });
    const service = new SessionsService(makeClient(), { activeIntervalMs: 10, idleIntervalMs: 50 });
    try {
      service.start();
      await service.forceRefresh();
      const idleId = nextTimerId;
      const release = service.enterActive();
      expect(intervals.has(idleId)).toBe(false);
      expect([...intervals.values()].map((timer) => timer.ms)).toEqual([10]);
      intervals.values().next().value!.tick();
      expect(calls.length).toBe(2);
      await service.forceRefresh();
      const activeId = nextTimerId;
      release();
      release();
      expect(intervals.has(activeId)).toBe(false);
      expect([...intervals.values()].map((timer) => timer.ms)).toEqual([50]);
      intervals.values().next().value!.tick();
      expect(calls.length).toBe(3);
      await service.forceRefresh();
      const nextRelease = service.enterActive();
      expect([...intervals.values()].map((timer) => timer.ms)).toEqual([10]);
      nextRelease();
      expect([...intervals.values()].map((timer) => timer.ms)).toEqual([50]);
    } finally {
      service.dispose();
    }
    expect(intervals.size).toBe(0);
  });
});

describe('SessionsService disposal safety', () => {
  it('keeps list/start/forceRefresh safe after dispose', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: { ok: true, sessions: SAMPLE_CARDS } });
    const service = new SessionsService(makeClient());
    service.dispose();
    expect(service.list()).toEqual([]);
    service.start();
    await service.forceRefresh();
    expect(calls.length).toBe(1);
    expect(service.list()).toEqual(SAMPLE_CARDS.map(cardToSummary));
  });
});

describe('SessionsService.forget — DELETE /v1/sessions/store/:id', () => {
  it('deletes via the store surface then refreshes the list', async () => {
    globalThis.fetch = mockResponse({
      status: 200,
      body: { ok: true, sessions: [], deleted: true },
    });
    const service = new SessionsService(makeClient());
    await service.forget('session-cli-1');
    expect(String(calls[0]!.url)).toBe('http://localhost:31415/v1/sessions/store/session-cli-1');
    expect(calls[0]!.method).toBe('DELETE');
    expect(String(calls[1]!.url)).toBe('http://localhost:31415/v1/sessions/store');
    service.dispose();
  });

  it('encodes path traversal characters before the store DELETE request', async () => {
    globalThis.fetch = mockResponse({ status: 200, body: { ok: true, sessions: [], deleted: true } });
    const service = new SessionsService(makeClient());
    await service.forget('a/b');
    expect(String(calls[0]!.url)).toBe('http://localhost:31415/v1/sessions/store/a%2Fb');
    expect(calls[0]!.method).toBe('DELETE');
    service.dispose();
  });
});
