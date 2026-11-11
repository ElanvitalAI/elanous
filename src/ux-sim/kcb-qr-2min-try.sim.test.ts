import { expect, test } from 'bun:test';
import { createFakeMemberOidcWorld, FAKE_MEMBER_OIDC_REDIRECT_URI } from './fake-member-oidc-world.js';
import { KCB_EVENT_CODE, KCB_TRY_MAX_ATTEMPTS, kcbArticleExcerpt, kcbTryMessages } from '../nexus/members/kcb-try.js';

const origin = 'https://app.example.test';
const api = 'https://members.example.test';

test('KCB fake Google signup → first fake LLM result through member API', async () => {
  let now = Date.parse('2026-11-14T01:00:00.000Z');
  const prompts: string[] = [];
  let failNext = false;
  const world = createFakeMemberOidcWorld({ now: () => now, runTryExample: async (exampleId, input) => {
    prompts.push(`${exampleId}:${input}`);
    if (failNext) { failNext = false; throw new Error('fake LLM offline'); }
    now += 30_000;
    return '기사 제목을 바탕으로 한 짧은 브리핑입니다.';
  } });
  // 출처: #36725 — KCB 행사 동시 참가자 300명 계약.
  world.memberStore.provisionEventCode({ code: KCB_EVENT_CODE, maxUses: 300 });
  try {
    const qr = new URL('https://app.example.test/app/signup/?code=KCB1114');
    expect(qr.searchParams.get('code')).toBe(KCB_EVENT_CODE);
    now += 15_000; // QR open and consent.
    const start = await world.membersApi.handle(new Request(`${api}/v1/members`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ eventCode: qr.searchParams.get('code'), consents: { privacy: 'privacy-v1', terms: 'terms-v1' } }),
    }), '203.0.113.41');
    expect(start?.status).toBe(201);
    const { authorizationUrl } = await start!.json() as { authorizationUrl: string };
    const stateCookie = start!.headers.get('set-cookie')!.split(';', 1)[0]!;
    now += 20_000; // One fake Google login.
    const authorization = world.googleWorld.authorize(authorizationUrl);
    const complete = await world.membersApi.handle(new Request(
      `${FAKE_MEMBER_OIDC_REDIRECT_URI}?code=${authorization.code}&state=${authorization.state}`,
      { headers: { cookie: stateCookie } },
    ));
    expect(complete?.status).toBe(200);
    expect(await complete!.text()).toContain('https://app.example.test/app/signup/complete/');
    const memberCookie = complete!.headers.get('set-cookie')!.split(';', 1)[0]!;
    const profile = await world.membersApi.handle(new Request(`${api}/v1/members`, { headers: { cookie: memberCookie } }));
    expect(profile?.status).toBe(200);
    expect((await profile!.json()).member.eventCode).toBe(KCB_EVENT_CODE);
    const run = () => world.membersApi.handle(new Request(`${api}/v1/members/try`, {
      method: 'POST', headers: { origin, cookie: memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ exampleId: 'article-brief', input: '기사 제목: 티켓 대란' }),
    }));
    const first = await run();
    expect(first?.status).toBe(200);
    expect((await first!.json()).result).toContain('브리핑');
    expect(prompts[0]).toContain('기사 제목: 티켓 대란');
    failNext = true;
    const failed = await run();
    expect(failed?.status).toBe(503);
    expect(await failed!.json()).toEqual({ error: 'try-unavailable' });
    expect((await run())?.status).toBe(200);
    expect((await run())?.status).toBe(200);
    expect((await run())?.status).toBe(429);
    expect(prompts).toHaveLength(KCB_TRY_MAX_ATTEMPTS + 1); // failed attempt reached the provider but was released
    const fullInput = '일'.repeat(799) + '끝';
    const messages = kcbTryMessages('day-plan', fullInput);
    expect(messages[0]?.content).toContain('일정표');
    expect(messages[1]?.content).toBe(fullInput);
    // 출처: #36725 — 기사 발췌까지 포함하는 사용자 메시지 비용 상한 800자.
    expect(kcbArticleExcerpt('https://example.test/article', '긴 제목'.repeat(100), '본문'.repeat(8_000)).length).toBeLessThanOrEqual(800);
  } finally { world.close(); }
});
