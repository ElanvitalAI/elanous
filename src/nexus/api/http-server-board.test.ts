import { afterEach, expect, test } from 'bun:test';
import { createNexusState, type NexusEvent } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { startNexusHttpServer } from './http-server.js';
import type { MembersApi } from '../members/members-api.js';
import type { BoardCardEvent, BoardEventStore } from './board-api.js';

const servers: Array<{ stop(): void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(); });

test('member session routes board reads and explicit approve; Nexus bearer alone cannot read a member board', async () => {
  const log: BoardCardEvent[] = [{ type: 'board.card', cardId: 'card-a', memberId: 'member-a', state: 'suggested', title: '회원 앱', at: '2026-11-09T00:00:00.000Z' }];
  const listeners = new Set<(event: unknown) => void>();
  const store: BoardEventStore = {
    query: async ({ memberId, type }) => log.filter(item => item.memberId === memberId && item.type === type),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    append: async value => {
      const event = value as BoardCardEvent;
      log.push(event);
      for (const listener of listeners) listener(event);
    },
  };
  const membersApi: MembersApi = {
    async handle(request) {
      const cookie = request.headers.get('cookie');
      if (cookie !== 'member-session=valid') return Response.json({ error: 'unauthorized' }, { status: 401 });
      const url = new URL(request.url);
      if (url.pathname === '/v1/members') return Response.json({ member: { id: 'member-a' }, appSlot: { appSlug: 'kaist-demo' } });
      if (url.pathname === '/v1/members/owner' && url.searchParams.get('appSlug') === 'kaist-demo') return Response.json({ memberId: 'member-a' });
      return Response.json({ error: 'not-found' }, { status: 404 });
    },
  };
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  const server = startNexusHttpServer({
    state, registry: new TabRegistry(state), eventBus, membersApi,
    boardEventStore: store,
    metaApi: { bearerToken: 'operator-token', noAuth: false },
    startPort: 46_000 + Math.floor(Math.random() * 1_000),
  });
  servers.push(server);
  try {
    const ownerHeaders = { cookie: 'member-session=valid', 'sec-fetch-site': 'same-origin' };
    const list = await fetch(`${server.url}/v1/board`, { headers: new Headers(ownerHeaders) });
    expect(list.status).toBe(200);
    expect((await list.json() as { cards: Array<{ id: string; memberId: string; title: string; state: string; summary: string; updatedAt: string }> }).cards).toEqual([{ id: 'card-a', memberId: 'member-a', title: '회원 앱', state: 'proposed', summary: '회원 앱', updatedAt: '2026-11-09T00:00:00.000Z' }]);

    const operatorOnly = await fetch(`${server.url}/v1/board`, { headers: { authorization: 'Bearer operator-token', 'sec-fetch-site': 'cross-site' } });
    expect(operatorOnly.status).toBe(401);

    const approved = await fetch(`${server.url}/v1/board/card-a/approve`, {
      method: 'POST', headers: new Headers({ ...ownerHeaders, origin: new URL(server.url).origin, 'content-type': 'application/json' }), body: JSON.stringify({ decision: 'approved' }),
    });
    expect(approved.status).toBe(200);
    expect(log.at(-1)).toMatchObject({ cardId: 'card-a', memberId: 'member-a', state: 'approved' });
    expect(state.events.filter(event => event.kind === 'board.card')).toHaveLength(1);

    const eventAuth = await fetch(`${server.url}/v1/events?topics=board.card`, { headers: new Headers(ownerHeaders) });
    expect(eventAuth.status).toBe(200);
    expect(eventAuth.headers.get('content-type')).toContain('text/event-stream');
    const streamReader = eventAuth.body!.getReader();
    const decoder = new TextDecoder();
    await streamReader.read();
    for (const listener of listeners) listener({ type: 'board.card', cardId: 'card-a', memberId: 'member-a', state: 'building', title: '회원 앱', at: '2026-11-09T00:01:00.000Z' });
    let payload = '';
    while (!payload.includes('card-a')) {
      const { value, done } = await streamReader.read();
      if (done) break;
      payload += decoder.decode(value);
    }
    expect(payload).toContain('building');
    await streamReader.cancel();
    const briefingAuth = await fetch(`${server.url}/v1/events?topics=briefing.ready`, { headers: new Headers(ownerHeaders) });
    expect(briefingAuth.status).toBe(200);
    await briefingAuth.body?.cancel();
    const operatorBriefing = await fetch(`${server.url}/v1/events?topics=briefing.ready,board.card`, { headers: { authorization: 'Bearer operator-token' } });
    expect(operatorBriefing.status).toBe(200);
    const operatorReader = operatorBriefing.body!.getReader();
    const operatorDecoder = new TextDecoder();
    await operatorReader.read();
    eventBus.publish({ ts: Date.parse('2026-11-09T00:01:30.000Z'), kind: 'board.card', memberId: 'member-a', detail: { cardId: 'private-card' } });
    eventBus.publish({ ts: Date.parse('2026-11-09T00:02:00.000Z'), kind: 'briefing.ready', memberId: 'member-a', detail: { briefingId: 'briefing-a' } } as unknown as NexusEvent);
    let operatorPayload = '';
    while (!operatorPayload.includes('briefing-a')) {
      const { value, done } = await operatorReader.read();
      if (done) break;
      operatorPayload += operatorDecoder.decode(value);
    }
    expect(operatorPayload).toContain('briefing-a');
    expect(operatorPayload).not.toContain('private-card');
    await operatorReader.cancel();
    const mixedTopics = await fetch(`${server.url}/v1/events?topics=board.card,session.output`, { headers: new Headers(ownerHeaders) });
    expect(mixedTopics.status).toBe(400);
    expect(await mixedTopics.json()).toEqual({ error: 'member_topic_must_be_isolated' });
    const unownedEventAuth = await fetch(`${server.url}/v1/events?topics=board.card`, { headers: new Headers({ 'sec-fetch-site': 'cross-site' }) });
    expect(unownedEventAuth.status).toBe(401);
  } finally {
    server.stop();
    servers.splice(servers.indexOf(server), 1);
  }
});
