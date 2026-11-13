import { expect, test } from 'bun:test';
import { createAppSiteDeployRoute, type AppSiteDeploymentRuntime } from './app-site-deploy.js';
import { handleBoardRoute, type BoardCardEvent, type BoardEventStore } from '../api/board-api.js';

const owner = { memberId: 'member-7', userSlug: 'kaist-demo', plan: 'free', entitlements: {} };

function runtime(recordPublished: NonNullable<AppSiteDeploymentRuntime['recordPublished']>, verifyBody = 'marker'):
  AppSiteDeploymentRuntime {
  return {
    configuredPublicUserId: 'kaist-demo', resolveOwner: async () => owner,
    createFromTemplate: async () => ({ appRoot: '/sim/app' }),
    build: async () => ({ appRoot: '/sim/out', verifyText: 'marker' }),
    publish: async () => {}, verify: async () => ({ status: 200, body: verifyBody }),
    recordPublished,
  };
}

function request(): Request {
  return new Request('http://localhost/v1/apps/lecture-scrap/deploy', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ templateId: 'next-app-lecture-scrap' }),
  });
}

test('failed content verification never records a released card', async () => {
  let records = 0;
  const route = createAppSiteDeployRoute(runtime(async () => { records += 1; }, 'wrong content'));
  expect((await route(request()))?.status).toBe(502);
  expect(records).toBe(0);
});


test('failed board append discards the newly built source and withholds success', async () => {
  let discarded = 0;
  const fixture: AppSiteDeploymentRuntime = {
    ...runtime(async () => { throw new Error('journal unavailable'); }),
    discard: async () => { discarded += 1; },
  };
  const response = await createAppSiteDeployRoute(fixture)(request());
  expect(response?.status).toBe(502);
  expect(discarded).toBe(1);
  expect((await response?.json()).rawOutput).toMatchObject({ status: 'failed' });
});


test('two releases of one card show the latest manifest title while another card keeps its own title', async () => {
  const events: BoardCardEvent[] = [
    { type: 'board.card', cardId: 'app-lecture-scrap', memberId: 'member-7', state: 'released', title: 'Lecture v1', result: { publicUrl: 'https://lecture-scrap--kaist-demo.elanous.app/' }, at: '2026-11-12T01:00:00.000Z' },
    { type: 'board.card', cardId: 'app-team-notes', memberId: 'member-7', state: 'released', title: 'Team notes', result: { publicUrl: 'https://team-notes--kaist-demo.elanous.app/' }, at: '2026-11-12T01:01:00.000Z' },
    { type: 'board.card', cardId: 'app-lecture-scrap', memberId: 'member-7', state: 'released', title: 'Lecture v2', result: { publicUrl: 'https://lecture-scrap--kaist-demo.elanous.app/' }, at: '2026-11-12T01:02:00.000Z' },
  ];
  const store: BoardEventStore = { query: async () => events, append: async event => { events.push(event); } };
  const response = await handleBoardRoute(new Request('http://localhost/v1/board'), '/v1/board', {
    store, resolveOwner: async () => ({ memberId: 'member-7' }),
  });
  expect(response?.status).toBe(200);
  const cards = (await response!.json() as { cards: Array<{ id: string; title: string }> }).cards;
  expect(cards.find(card => card.id === 'app-lecture-scrap')?.title).toBe('Lecture v2');
  expect(cards.find(card => card.id === 'app-team-notes')?.title).toBe('Team notes');
});
