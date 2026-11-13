import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleScraps } from './scraps.js';
import { routeRequest, type NexusHttpServerOpts } from './http-server.js';
import { createNexusScrapsRouteOptions, createScrapsWebDigest } from './scraps-web-digest.js';
import { createMembersApi } from '../members/members-api.js';
import { createMemberStore } from '../members/member-store.js';
import { isPublicRoute } from './public-routes.js';
import { consumeTelegramMemberCode, verifiedTelegramMember } from '../../telegram-member-scrap.js';
import { debug } from '../../debug/log.js';

// Source: the member article reader's outbound deadline contract.
const EXPECTED_WEB_TIMEOUT_MS = 15_000;
// Source: the OAuth stub is never entered by the verified-owner scraps route.
const UNUSED_OAUTH_STATE_AGE_SECONDS = 0;

test('Nexus article route uses the bounded reader and retains a durable scrap on reader failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-web-scrap-'));
  const url = 'https://example.test/article';
  const calls: Array<{ url: string; timeoutMs?: number; quiet?: boolean }> = [];
  const request = (key: string, articleUrl = url) => new Request('https://member.example.test/v1/scraps', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ kind: 'web', source: 'android-share', raw: { url: articleUrl } }),
  });
  try {
    const success = createNexusScrapsRouteOptions(root, async (received, options) => {
      calls.push({ url: received, timeoutMs: options?.timeoutMs, quiet: options?.quiet });
      return { title: 'Article', content: 'First point. Second point.' };
    });
    const owner = { resolveOwner: async () => ({ memberId: 'member-a' }) };
    const created = await handleScraps(request('article-success-001'), { ...success, ...owner });
    expect(created.status).toBe(201);
    const accepted = await created.json() as { id: string; status: string };
    expect(accepted.id).toBeTruthy();
    expect(accepted.status).toBe('absorbed');
    expect(calls).toEqual([{ url, timeoutMs: EXPECTED_WEB_TIMEOUT_MS, quiet: true }]);

    const failure = createNexusScrapsRouteOptions(root, async () => { throw new Error('private fetch credential detail'); });
    const failed = await handleScraps(request('article-failure-001', 'https://example.test/failure'), { ...failure, ...owner });
    expect(failed.status).toBe(502);
    const rejected = await failed.json() as { id: string; status: string; failure: { stage: string; reason: string } };
    expect(rejected.id).toBeTruthy();
    expect(rejected.status).toBe('failed');
    expect(rejected.failure).toEqual({ stage: 'extract', reason: 'web digest unavailable' });
    const listed = await handleScraps(new Request('https://member.example.test/v1/scraps'), { ...success, ...owner });
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).toContain(rejected.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('member article reader refuses private URLs through the existing public-URL guard', async () => {
  await expect(createScrapsWebDigest()('http://127.0.0.1/internal')).rejects.toThrow('web digest unavailable');
});

test('MK 12206719 Reader layout without legacy detail marker extracts the article only', async () => {
  const url = 'https://www.mk.co.kr/news/economy/12206719';
  const title = '낮에 싸게 팔아도 … 기업들 전기 안쓰는 이유는';
  const content = [
    '[경제](https://www.mk.co.kr/news/economy)>[경제 정책](https://www.mk.co.kr/news/economy/economic-policy)',
    `## ${title}`,
    '태양광 발전 이후 낮 시간대 전력 소비 비중을 살펴본 기사다. 산업용 요금 변화와 기업의 조업 시간을 함께 설명한다.',
    '전력 소비 비중에 관한 자료를 검토하고, 요금 차이만으로 생산 일정을 바꾸기 어려운 사정을 여러 문장으로 풀어 쓴다. '.repeat(3),
    '[강민우 기자]',
    '**주의사항** : 본 서비스는 AI의 구조적 한계로 인해 오류가 발생할 수 있습니다.',
    '### 핵심요약 쏙',
    'AI 해설은 기사 본문과 표현에 차이가 있을 수 있습니다.',
  ].join('\n\n');
  const digest = await createScrapsWebDigest(async () => ({ title, content }))(url);
  expect(digest.title).toBe(title);
  expect(digest.body).toContain('전력 소비 비중');
  expect(digest.body).not.toContain('주의사항');
  expect(digest.body).not.toContain('핵심요약');
});

test('MK fallback still rejects empty or mismatched article content', async () => {
  const url = 'https://www.mk.co.kr/news/economy/12206719';
  const title = '낮에 싸게 팔아도 … 기업들 전기 안쓰는 이유는';
  await expect(createScrapsWebDigest(async () => ({ title, content: `## ${title}\n\n빈 본문` }))(url))
    .rejects.toThrow('web digest unavailable');
  await expect(createScrapsWebDigest(async () => ({ title, content: `## 다른 기사\n\n${'본문 '.repeat(100)}` }))(url))
    .rejects.toThrow('web digest unavailable');
});

test('MK fallback cuts copyright, comments, and related links; missing footer fails closed', async () => {
  const url = 'https://www.mk.co.kr/news/economy/12206719';
  const title = '낮에 싸게 팔아도 … 기업들 전기 안쓰는 이유는';
  const article = `## ${title}\n\n${'산업용 전기요금과 전력 소비 비중을 분석한다. '.repeat(12)}`;
  for (const footer of ['ⓒ 매일경제 무단전재', '[ⓒ 매일경제]', 'Copyright 2026 MK', '무단전재 및 재배포 금지', '### 댓글 23', '### 관련기사', '[관련기사]']) {
    const digest = await createScrapsWebDigest(async () => ({ title, content: `${article}\n\n${footer}\n광고와 댓글 본문` }))(url);
    expect(digest.body).toContain('전력 소비 비중');
    expect(digest.body).not.toContain(footer);
    expect(digest.body).not.toContain('광고와 댓글 본문');
  }
  await expect(createScrapsWebDigest(async () => ({ title, content: article }))(url))
    .rejects.toThrow('web digest unavailable');
});

test('MK fallback keeps ordinary article paragraphs beginning with 댓글', async () => {
  const url = 'https://www.mk.co.kr/news/economy/12206719';
  const title = '낮에 싸게 팔아도 … 기업들 전기 안쓰는 이유는';
  const paragraph = '댓글 반응은 실제 전력 사용량의 변화와 다르게 나타날 수 있다는 설명을 덧붙였다.';
  const content = `## ${title}\n\n${'기사 본문은 산업용 요금과 조업 시간의 관계를 설명한다. '.repeat(10)}\n\n${paragraph}\n\n[강민우 기자]\n\n### 댓글 23`;
  const digest = await createScrapsWebDigest(async () => ({ title, content }))(url);
  expect(digest.body).toContain(paragraph);
  expect(digest.body).not.toContain('### 댓글');
});

test('MK fallback preserves a normal (c) list item before the real copyright marker', async () => {
  const url = 'https://www.mk.co.kr/news/economy/12206719';
  const title = '낮에 싸게 팔아도 … 기업들 전기 안쓰는 이유는';
  const listItem = '(c) 세 번째 항목은 전력 소비 비중을 설명한다.';
  const content = `## ${title}\n\n${'기사는 산업용 전기요금과 조업 시간의 관계를 설명한다. '.repeat(10)}\n\n${listItem}\n\n[ⓒ 매일경제]`;
  const digest = await createScrapsWebDigest(async () => ({ title, content }))(url);
  expect(digest.body).toContain(listItem);
  expect(digest.body).not.toContain('[ⓒ');
});

test('web digest logs Reader HTTP/timeout separately from parser mismatch without leaking response details', async () => {
  const events: Array<{ event: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'absorb.web-digest') events.push({ event, data });
  });
  const url = 'https://www.mk.co.kr/news/economy/12206719';
  try {
    for (const [reason, status] of [['http', 429], ['timeout', undefined]] as const) {
      await expect(createScrapsWebDigest(async (_url, opts) => { opts?.onFailure?.(reason, status); return null; })(url))
        .rejects.toThrow('web digest unavailable');
    }
    await expect(createScrapsWebDigest(async () => ({ title: 'Article', content: 'No matching article heading, but plenty of unrelated navigation text.'.repeat(6) }))(url))
      .rejects.toThrow('web digest unavailable');
    expect(events).toEqual([
      { event: 'reader-failed', data: { stage: 'http', status: 429 } },
      { event: 'reader-failed', data: { stage: 'timeout', status: null } },
      { event: 'parser-failed', data: { stage: 'parser' } },
    ]);
  } finally { log.mockRestore(); }
});

test('MK article without a footer fails extraction before storing a card', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-mk-no-footer-'));
  const url = 'https://www.mk.co.kr/news/hot-issues/7963792';
  const reader = async () => ({ title: '나훈아 콘서트 예매', content: [
    '# 기사 상세', '[매일경제 스타투데이 권성미 인턴기자]',
    'YES24 접속 장애가 발생했다가 복구됐다.', '댓글정책', '공감순 최신순 오래된순',
  ].join('\n\n') });
  try {
    const response = await handleScraps(new Request('https://member.example.test/v1/scraps', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'mk-no-footer-001' },
      body: JSON.stringify({ kind: 'web', source: 'android-share', raw: { url } }),
    }), { ...createNexusScrapsRouteOptions(root, reader), resolveOwner: async () => ({ memberId: 'member-a' }) });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ status: 'failed', failure: { stage: 'extract', reason: 'web digest unavailable' } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Nexus public route uses the production article adapter with a verified owner session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-web-scrap-route-'));
  const store = createMemberStore({ path: join(root, 'members.sqlite') });
  const member = store.register({ sub: 'article-owner', email: 'owner@example.test', emailVerified: true, name: 'Owner' },
    { consents: { privacy: 'v1', terms: 'v1' } });
  const token = 'aps_verified-article-owner';
  const membersApi = createMembersApi({
    store,
    google: { redirectUri: 'https://example.test/v1/members/oauth/google/callback',
      start: async () => ({ authorizationUrl: 'https://accounts.example.test', state: 'unused', cookieValue: 'unused', maxAgeSeconds: UNUSED_OAUTH_STATE_AGE_SECONDS }),
      complete: async () => { throw new Error('unused'); } },
    successRedirectUri: 'https://example.test/signup/complete',
    resolveVerifiedMemberOwner: credential => credential === token
      ? { memberId: member.id, userSlug: 'owner', plan: 'free', entitlements: {} } : null,
  });
  const scraps = createNexusScrapsRouteOptions(root, async () => ({ title: 'Article', content: 'A useful article with two points.' }));
  const opts = { metaApi: { bearerToken: 'owner-secret', noAuth: false }, membersApi, scraps } as unknown as NexusHttpServerOpts;
  try {
    const anonymousEnrollment = await routeRequest(new Request('http://nexus.test/v1/telegram/member-enrollment', { method: 'POST' }), opts, {} as never, null, {} as never);
    expect(anonymousEnrollment?.status).toBe(401);
    const enrollment = await routeRequest(new Request('http://nexus.test/v1/telegram/member-enrollment', {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ memberId: 'attacker' }),
    }), opts, {} as never, null, {} as never);
    expect(enrollment?.status).toBe(200);
    const { code } = await enrollment!.json() as { code: string };
    const telegramIdentity = { botId: '123', userId: 42, chatId: 42 };
    expect(consumeTelegramMemberCode(root, telegramIdentity, code)).toBe(true);
    expect(verifiedTelegramMember(root, telegramIdentity)).toBe(member.id);
    const post = new Request('http://nexus.test/v1/scraps', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'verified-article-001' },
      body: JSON.stringify({ kind: 'web', source: 'android-share', raw: { url: 'https://example.test/article' } }),
    });
    const created = await routeRequest(post, opts, {} as never, null, {} as never);
    expect(created?.status).toBe(201);
    const accepted = await created!.json() as { memberId: string; id: string; status: string };
    expect(accepted.memberId).toBe(member.id);
    expect(accepted.id).toBeTruthy();
    const reread = await routeRequest(new Request('http://nexus.test/v1/scraps', {
      headers: { authorization: `Bearer ${token}` },
    }), opts, {} as never, null, {} as never);
    expect(reread?.status).toBe(200);
    expect(await reread!.json()).toMatchObject({ scraps: [expect.objectContaining({ id: accepted.id, status: 'absorbed' })] });
    const denied = await routeRequest(new Request('http://nexus.test/v1/scraps'), opts, {} as never, null, {} as never);
    expect(denied?.status).toBe(401);
    const deniedPost = await routeRequest(new Request('http://nexus.test/v1/scraps', { method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'anonymous-article-001' },
      body: JSON.stringify({ kind: 'web', source: 'android-share', raw: { url: 'https://example.test/article' } }),
    }), opts, {} as never, null, {} as never);
    expect(deniedPost?.status).toBe(401);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('ordinary web member cookie can issue a Telegram code while an anonymous request cannot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-enroll-cookie-'));
  const store = createMemberStore({ path: join(root, 'members.sqlite') });
  try {
    const membersApi = createMembersApi({ store,
      google: { redirectUri: 'https://api.example.test/v1/members/oauth/google/callback',
        complete: async () => ({ identity: { sub: 'cookie-member', email: 'cookie@example.test', emailVerified: true, name: 'Cookie Member' },
          intent: { consents: { privacy: 'v1', terms: 'v1' } } }) } as never,
      successRedirectUri: 'https://app.example.test/member', webOrigin: 'https://app.example.test',
    });
    const callback = await membersApi.handle(new Request('https://api.example.test/v1/members/oauth/google/callback?code=fake&state=valid-state', {
      headers: { cookie: '__Host-elanous_member_oauth_state=fake-state' },
    }));
    const session = /__Host-elanous_member_session=([^;]+)/.exec(callback?.headers.get('set-cookie') ?? '')?.[1];
    expect(session).toBeTruthy();
    const opts = { metaApi: { bearerToken: 'owner-secret', noAuth: false }, membersApi,
      scraps: createNexusScrapsRouteOptions(root, async () => ({ title: 'Article', content: 'Body.' })) } as unknown as NexusHttpServerOpts;
    const endpoint = 'https://api.example.test/v1/telegram/member-enrollment';
    expect(isPublicRoute('POST', '/v1/telegram/member-enrollment', { setupMode: false })).toBe(true);
    expect(isPublicRoute('GET', '/v1/telegram/member-enrollment', { setupMode: false })).toBe(false);
    expect((await routeRequest(new Request(endpoint, { method: 'POST' }), opts, {} as never, null, {} as never))?.status).toBe(401);
    expect((await routeRequest(new Request(endpoint, { method: 'GET', headers: { authorization: 'Bearer owner-secret' } }), opts, {} as never, null, {} as never))?.status).toBe(405);
    const enrolled = await routeRequest(new Request(endpoint, { method: 'POST',
      headers: { cookie: `__Host-elanous_member_session=${session}` } }), opts, {} as never, null, {} as never);
    expect(enrolled?.status).toBe(200);
    const { code } = await enrolled!.json() as { code: string };
    const tg = { botId: '123', userId: 42, chatId: 42 };
    expect(consumeTelegramMemberCode(root, tg, code)).toBe(true);
    const memberId = store.memberForGoogleSub('cookie-member')?.id;
    expect(memberId).toBeTruthy();
    expect(verifiedTelegramMember(root, tg)).toBe(memberId!);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
