import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { createElement, type ReactElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { _resetSessionsServiceSingletonForTest } from '@/lib/sessions-service';
import MemberBoardPage from '../board/page';
import MemberInvitePage from './invite/page';
import { createFakeMemberOidcWorld, FAKE_MEMBER_OIDC_REDIRECT_URI } from '../../../../../src/ux-sim/fake-member-oidc-world';
import { createSimCookieJar } from '../../../../../src/ux-sim/sim-cookie-jar';
import { KCB_EVENT_CODE } from '../../../../../src/nexus/members/kcb-try';
import { KCB_SIGNUP_WINDOW } from '../../../../../src/nexus/members/members-api';

// A193 mock lap (OP79613 · Terra #37957 MF1): one member walks QR signup → board → handle → web chat
// through the real PWA renders. Cookies only move through a simulated browser jar; the test never
// copies a session value. Fake: the Google edge, the LLM, and empty Nexus board/briefing lists.
// NOT proved: a real member server, a real browser, the ChatPanel model backend, or a public URL.
const web = 'https://app.example.test';
const api = 'https://members.example.test';
const BASE_PATH = '/app'; // 출처: apps/pwa/next.config.ts basePath
const appRoot = new URL('../', import.meta.url); // apps/pwa/src/app/

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const priorFetch = globalThis.fetch;
const priorGlobals = ['window', 'document', 'localStorage'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  globalThis.fetch = priorFetch;
  for (const [key, descriptor] of priorGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  _resetSessionsServiceSingletonForTest();
});

const settle = async () => { for (let index = 0; index < 20; index += 1) await act(async () => { await Promise.resolve(); }); };
const webChatEntries = (root: ReactTestInstance) => root.findAll((node) => node.type === 'a' && node.props['data-member-webchat-entry'] === true);
/** Next static export: `/app/<route>/` is served by `app/<route>/page.tsx`. */
const routeFile = (href: string, from: string): URL => {
  const target = new URL(href, from);
  expect(target.origin).toBe(web); // Same-origin navigation: no token travels in the URL.
  expect(target.search).toBe('');
  expect(target.pathname.startsWith(`${BASE_PATH}/`)).toBe(true);
  return new URL(`${target.pathname.slice(BASE_PATH.length + 1)}page.tsx`, appRoot);
};

test('A193 lap: QR signup → board → handle → web chat route, carried only by the browser cookie jar', async () => {
  let now = Date.parse('2026-11-16T03:00:00.000Z');
  const prompts: string[] = [];
  const world = createFakeMemberOidcWorld({ now: () => now, runTryExample: async (exampleId, input) => {
    prompts.push(`${exampleId}:${input}`);
    return '콘서트 예매 일정표 초안입니다.';
  } });
  // Production window (#37264, open through 11-30), not the store's default event window.
  world.memberStore.provisionEventCode({ code: KCB_EVENT_CODE, ...KCB_SIGNUP_WINDOW });
  const jar = createSimCookieJar(() => now);
  const nexusLists = new Map([['/v1/board', { cards: [] }], ['/v1/briefings', { briefings: [] }]]);
  const route = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (nexusLists.has(path)) return Response.json(nexusLists.get(path));
    return world.membersApi.handle(request, '203.0.113.42');
  };
  const page = jar.browserFetch(route, web);
  try {
    // 1. Signup from the PWA, then the browser follows Google's redirect to the members callback.
    const start = await page(`${api}/v1/members`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventCode: KCB_EVENT_CODE, consents: { privacy: 'privacy-v1', terms: 'terms-v1' } }) });
    expect(start.status).toBe(201);
    const { authorizationUrl } = await start.json() as { authorizationUrl: string };
    now += 20_000;
    const authorization = world.googleWorld.authorize(authorizationUrl);
    const callback = await jar.browserFetch(route, api)(`${FAKE_MEMBER_OIDC_REDIRECT_URI}?code=${authorization.code}&state=${authorization.state}`);
    expect(callback.status).toBe(303);
    const landing = new URL(callback.headers.get('location')!, web).toString();
    expect(landing).toBe(`${web}${BASE_PATH}/board/`); // 출처: #37624 KCB landing.
    const session = jar.snapshot().find((cookie) => cookie.name.startsWith('__Host-elanous_member_session'));
    expect(session).toMatchObject({ host: 'members.example.test', hostOnly: true, httpOnly: true, secure: true });

    // 2. Board: the landing route's real page renders, verifies the owner via the jar, and leads with web chat.
    globalThis.fetch = page;
    expect(existsSync(routeFile(landing, web))).toBe(true);
    await act(async () => { tree = create(createElement(NexusProvider, { client: { baseUrl: api } as never, children: createElement(MemberBoardPage) })); });
    await settle();
    const [boardEntry] = webChatEntries(tree!.root);
    expect(boardEntry?.props.href).toBeDefined();
    const chatFromBoard = routeFile(boardEntry!.props.href, landing);
    await act(async () => tree!.unmount());

    // 3. Handle: the real invite page claims it through its own form; the entry appears right after.
    const invite = `${web}${BASE_PATH}/member/invite/`;
    await act(async () => { tree = create(createElement(NexusProvider, { client: { baseUrl: api } as never, children: createElement(MemberInvitePage) })); });
    await settle();
    expect(webChatEntries(tree!.root)).toHaveLength(0);
    const field = tree!.root.findByProps({ id: 'member-public-id' });
    await act(async () => { field.props.onChange({ currentTarget: { value: 'a193lap' } }); });
    await act(async () => { tree!.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
    await settle();
    const [inviteEntry] = webChatEntries(tree!.root);
    expect(routeFile(inviteEntry!.props.href, invite).href).toBe(chatFromBoard.href);
    await act(async () => tree!.unmount());

    // 4. Web chat: the route file the entry resolves to renders ChatPanel.
    expect(existsSync(chatFromBoard)).toBe(true);
    const { default: ChatRoute } = await import(chatFromBoard.href) as { default: () => ReactElement };
    // Browser globals and an offline daemon client, as in ChatPanel.test.tsx; the chat backend is not part of this lap.
    const saved = new Map<string, string>();
    const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) };
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), {
      innerWidth: 412, location: { search: '' }, sessionStorage: { getItem: () => null }, localStorage: storage }) });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: new EventTarget() });
    const client = { fetchJson: async (path: string) => path === '/v1/projects' ? { projects: [] } : { sessions: [], messages: [] },
      sessionStoreEventsUrl: () => '', voiceWsUrl: () => '', connectAcp: () => { throw Error('offline'); } };
    const daemon = { client: client as never, config: { baseUrl: '', token: '', provider: '' },
      sessionId: 'lap', setSessionId: () => {}, setConfig: () => {} };
    await act(async () => { tree = create(createElement(DaemonContext.Provider, { value: daemon as never }, createElement(ChatRoute))); });
    expect(tree!.root.findAllByType(ChatPanel)).toHaveLength(1);

    // 5. The same browser still carries the member session on arrival, and the first member turn runs.
    const profile = await page(`${api}/v1/members`, { credentials: 'include' });
    expect(profile.status).toBe(200);
    expect(((await profile.json()) as { member: { handle: string } }).member.handle).toBe('a193lap');
    expect((await page(`${api}/v1/members/try`, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ exampleId: 'day-plan', input: '토요일 콘서트 예매 일정 짜줘' }) })).status).toBe(401);
    expect(prompts).toEqual([]);
    const first = await page(`${api}/v1/members/try`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ exampleId: 'day-plan', input: '토요일 콘서트 예매 일정 짜줘' }) });
    expect(first.status).toBe(200);
    expect(prompts).toEqual(['day-plan:토요일 콘서트 예매 일정 짜줘']);
  } finally { world.close(); }
});
