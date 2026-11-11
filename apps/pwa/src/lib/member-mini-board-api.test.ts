import { describe, expect, test } from 'bun:test';
import { createMemberMiniBoardApi } from './member-mini-board-api';

class FakeEventSource {
  listeners = new Map<string, EventListenerOrEventListenerObject>();
  closed = false;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, _options?: boolean | AddEventListenerOptions) {
    if (listener) this.listeners.set(type, listener);
  }
  close() { this.closed = true; }
  emit(type: string, data: unknown) {
    const listener = this.listeners.get(type);
    if (typeof listener === 'function') listener(new MessageEvent(type, { data: JSON.stringify(data) }));
    else listener?.handleEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

describe('member mini board API', () => {
  test('verifies the member session and app-bound owner before using member endpoints', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/v1/members')) return Response.json({ member: { id: 'member-a' }, appSlot: { appSlug: 'lecture-scrap' } });
      if (url.includes('/v1/members/owner?')) return Response.json({ memberId: 'member-a', userSlug: 'member-a', plan: 'free' });
      return Response.json([]);
    }) as typeof fetch;
    const api = createMemberMiniBoardApi('https://nexus.example.test/', fetchImpl);
    expect(await api.getVerifiedOwner()).toEqual({ memberId: 'member-a', appSlug: 'lecture-scrap' });
    expect(calls.map((call) => call.url)).toEqual([
      'https://nexus.example.test/v1/members',
      'https://nexus.example.test/v1/members/owner?appSlug=lecture-scrap',
    ]);
    for (const call of calls) {
      expect(call.init?.credentials).toBe('include');
      expect(new Headers(call.init?.headers).has('authorization')).toBe(false);
    }
  });

  test('fails closed when verified owner differs from the member session', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => String(input).endsWith('/v1/members')
      ? Response.json({ member: { id: 'member-a' }, appSlot: { appSlug: 'lecture-scrap' } })
      : Response.json({ memberId: 'member-b' })) as typeof fetch;
    const api = createMemberMiniBoardApi('https://nexus.example.test', fetchImpl);
    await expect(api.getVerifiedOwner()).rejects.toThrow('본인 앱 소유권을 확인하지 못했습니다');
  });

  test('subscribes with the member cookie and refreshes only for that member event', () => {
    const source = new FakeEventSource();
    let init: EventSourceInit | undefined;
    let url = '';
    const api = createMemberMiniBoardApi('https://nexus.example.test', fetch, (nextUrl, nextInit) => {
      url = nextUrl;
      init = nextInit;
      return source as unknown as EventSource;
    });
    let refreshes = 0;
    const unsubscribe = api.subscribe('member-a', () => { refreshes += 1; });
    expect(new URL(url).searchParams.get('topics')).toBe('briefing.ready,board.card');
    expect(init?.withCredentials).toBe(true);
    source.emit('board.card', { memberId: 'member-b' });
    source.emit('briefing.ready', { memberId: 'member-a' });
    expect(refreshes).toBe(1);
    unsubscribe();
    expect(source.closed).toBe(true);
  });
});
