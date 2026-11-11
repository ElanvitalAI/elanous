import { describe, expect, test } from 'bun:test';
import { createFakeAndroidApiClient, createFakeAndroidClientWorld } from './fake-android-client.js';
import { createBriefingsApi, type BriefingApiRecord } from '../nexus/api/briefings-api.js';

describe('fake Android client world', () => {
  test('briefing, board, and approval use the authenticated member scope', () => {
    const world = createFakeAndroidClientWorld();
    const briefings = world.request({ method: 'GET', path: '/v1/briefings?day=2026-11-09', bearer: 'owner-a' });
    expect(briefings.status).toBe(200);
    expect((briefings.body as { briefings: Array<{ id: string }> }).briefings.map(({ id }) => id)).toEqual(['brief-a']);
    expect(world.request({ method: 'GET', path: '/v1/briefings/brief-b', bearer: 'owner-a' }).status).toBe(404);
    expect(world.request({ method: 'GET', path: '/v1/board', bearer: 'owner-a' }).status).toBe(200);
    expect(world.request({ method: 'POST', path: '/v1/board/card-a/approve', bearer: 'owner-a' }).status).toBe(200);
    expect(world.request({ method: 'POST', path: '/v1/board/card-a/approve', bearer: 'owner-a' }).status).toBe(409);
    expect(world.request({ method: 'POST', path: '/v1/board/card-a/approve', bearer: 'owner-b' }).status).toBe(404);
  });

  test('SSE events are owner-scoped and unauthenticated calls are empty', () => {
    const world = createFakeAndroidClientWorld();
    expect(world.events('owner-a').map(({ event, data }) => [event, (data as { memberId: string }).memberId]))
      .toEqual([['briefing.ready', 'member-a'], ['board.card', 'member-a']]);
    expect(world.events('owner-b').map(({ event, data }) => [event, (data as { memberId: string }).memberId]))
      .toEqual([['briefing.ready', 'member-b']]);
    expect(world.events('invalid')).toEqual([]);
    expect(world.request({ method: 'GET', path: '/v1/briefings?day=2026-11-09' }).status).toBe(401);
    expect(world.networkAttempts).toEqual([]);
  });

  test('replays Android briefing requests through the actual owner-scoped API handler', async () => {
    const rows: BriefingApiRecord[] = [
      { id: 'brief-a', memberId: 'member-a', day: '2026-11-09', topics: [], todos: [], suggestionIds: [], createdAt: '2026-11-09T00:00:00.000Z' },
      { id: 'brief-b', memberId: 'member-b', day: '2026-11-09', topics: [], todos: [], suggestionIds: [], createdAt: '2026-11-09T00:00:00.000Z' },
    ];
    const api = createBriefingsApi({
      ownerForRequest: (request) => request.headers.get('authorization') === 'Bearer owner-a' ? 'member-a' : 'member-b',
      getByDay: (memberId, day) => rows.find((row) => row.memberId === memberId && row.day === day) ?? null,
      getById: (memberId, id) => rows.find((row) => row.memberId === memberId && row.id === id) ?? null,
    });
    const android = createFakeAndroidApiClient(api);
    const own = await android.request({ method: 'GET', path: '/v1/briefings/brief-a', bearer: 'owner-a' });
    const crossOwner = await android.request({ method: 'GET', path: '/v1/briefings/brief-b', bearer: 'owner-a' });
    expect(own.status).toBe(200);
    expect((own.body as BriefingApiRecord).memberId).toBe('member-a');
    expect(crossOwner.status).toBe(404);
    expect(android.requests).toHaveLength(2);
  });
});
