import { expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { createElement } from 'react';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import MemberSignupPage from './page';
import TryPage from './complete/page';
import { createFakeMemberOidcWorld, FAKE_MEMBER_OIDC_REDIRECT_URI } from '../../../../../src/ux-sim/fake-member-oidc-world.js';

test('invite URL reaches credentialed signup POST with referral and event code', async () => {
  const priorWindow = globalThis.window;
  const priorFetch = globalThis.fetch;
  const priorAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  let assigned = '';
  let posted: unknown;
  Object.assign(globalThis, {
    window: { location: { search: '?referralCode=Aa_12-Z&code=kcb1114', assign: (url: string) => { assigned = url; } } },
    fetch: async (_url: string, init: RequestInit) => {
      expect(init.credentials).toBe('include');
      posted = JSON.parse(String(init.body));
      return Response.json({ authorizationUrl: 'https://accounts.example.test/authorize' }, { status: 201 });
    },
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const daemon = { config: { baseUrl: 'https://api.example.test', token: '', provider: '' },
    client: {}, sessionId: '', setConfig: () => {}, setSessionId: () => {} };
  let root: ReturnType<typeof create> | null = null;
  try {
    await act(async () => { root = create(createElement(DaemonContext.Provider, { value: daemon as never }, createElement(MemberSignupPage))); });
    const input = root!.root.findAllByType('input').find(node => node.props.type === 'checkbox')!;
    await act(async () => { input.props.onChange({ target: { checked: true } }); });
    await act(async () => { await root!.root.findByType('button').props.onClick(); });
    expect(posted).toEqual({ consents: { privacy: 'privacy-v1', terms: 'terms-v1' }, referralCode: 'Aa_12-Z', eventCode: 'KCB1114' });
    expect(assigned).toBe('https://accounts.example.test/authorize');
  } finally {
    if (root) await act(async () => root!.unmount());
    Object.assign(globalThis, { window: priorWindow, fetch: priorFetch });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = priorAct;
  }
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('ordinary referred signup completion keeps the invite-link path', async () => {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ member: { eventCode: null } })) as unknown as typeof fetch;
  let tree: ReturnType<typeof create> | null = null;
  try {
    await act(async () => { tree = create(<TryPage />); await Promise.resolve(); });
    expect(JSON.stringify(tree!.toJSON())).toContain('가입이 완료되었습니다');
    expect(tree!.root.findByType('a').props.href).toBe('/app/member/invite/');
  } finally {
    if (tree) await act(async () => tree!.unmount());
    globalThis.fetch = priorFetch;
  }
});

test('KCB QR fills the event code and signup sends it to member OAuth once', async () => {
  const priorWindow = globalThis.window;
  const priorStorage = globalThis.sessionStorage;
  const priorFetch = globalThis.fetch;
  const stored = new Map<string, string>();
  const requests: Array<{ url: string; body: unknown }> = [];
  let assigned = '';
  Object.assign(globalThis, {
    window: { location: { search: '?code=KCB1114', assign: (url: string) => { assigned = url; } } },
    sessionStorage: { setItem: (key: string, value: string) => stored.set(key, value), getItem: (key: string) => stored.get(key) ?? null },
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fake' }, { status: 201 });
    },
  });
  let tree!: ReturnType<typeof create>;
  try {
    await act(async () => { tree = create(<MemberSignupPage />); });
    expect(tree.root.findByProps({ 'aria-label': '행사 코드' }).props.value).toBe('KCB1114');
    await act(async () => { tree.root.findAllByType('input')[1]!.props.onChange({ target: { checked: true } }); });
    await act(async () => { tree.root.findByType('button').props.onClick(); await Promise.resolve(); });
    expect(requests).toMatchObject([{ url: '/v1/members', body: { eventCode: 'KCB1114' } }]);
    expect(assigned).toStartWith('https://accounts.google.com/');
    expect(stored.has('kcb-qr-journey-started-at')).toBe(true);
  } finally {
    if (tree) await act(async () => tree.unmount());
    Object.assign(globalThis, { window: priorWindow, sessionStorage: priorStorage, fetch: priorFetch });
  }
});

test('QR start survives signup retry and page reload so an old journey cannot become under two minutes', async () => {
  const priorWindow = globalThis.window;
  const priorStorage = globalThis.sessionStorage;
  const priorFetch = globalThis.fetch;
  const priorNow = Date.now;
  const now = Date.parse('2026-11-14T01:03:00.000Z');
  const started = now - 121_000;
  const stored = new Map([['kcb-qr-journey-started-at', String(started)]]);
  // Source: #36725 retry-safety case starts with no submitted signup attempts.
  let attempts = 0;
  Date.now = () => now;
  Object.assign(globalThis, {
    window: { location: { search: '?code=KCB1114', assign: () => {} } },
    sessionStorage: { getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value) },
    fetch: async (url: string, init?: RequestInit) => {
      if (url === '/v1/members' && !init?.method) return Response.json({ member: { eventCode: 'KCB1114' } });
      if (url === '/v1/members/try') return Response.json({ result: '가짜 첫 결과' });
      return ++attempts === 1 ? new Response(null, { status: 503 })
        : Response.json({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fake' }, { status: 201 });
    },
  });
  let tree: ReturnType<typeof create> | null = null;
  let completion: ReturnType<typeof create> | null = null;
  try {
    await act(async () => { tree = create(<MemberSignupPage />); });
    expect(stored.get('kcb-qr-journey-started-at')).toBe(String(started));
    await act(async () => { tree!.root.findAllByType('input')[1]!.props.onChange({ target: { checked: true } }); });
    await act(async () => { tree!.root.findByType('button').props.onClick(); await Promise.resolve(); });
    expect(tree!.root.findByProps({ role: 'alert' }).children.join('')).toContain('다시 시도');
    await act(async () => { tree!.root.findByType('button').props.onClick(); await Promise.resolve(); });
    expect(attempts).toBe(2);
    await act(async () => { tree!.unmount(); tree = create(<MemberSignupPage />); });
    expect(stored.get('kcb-qr-journey-started-at')).toBe(String(started));
    // Source: #36725 acceptance criterion marks a first result beyond 120 seconds as late.
    expect(Date.now() - Number(stored.get('kcb-qr-journey-started-at'))).toBeGreaterThan(120_000);
    await act(async () => { completion = create(<TryPage />); await Promise.resolve(); });
    await act(async () => { completion!.root.findByType('textarea').props.onChange({ target: { value: '오늘 일정' } }); });
    await act(async () => { completion!.root.findAllByType('button').at(-1)!.props.onClick(); await Promise.resolve(); });
    expect(completion!.root.findByProps({ 'aria-label': '첫 결과' }).findAllByType('p')
      .map(node => node.children.join('')).join(' ')).toContain('2분 초과');
  } finally {
    if (completion) await act(async () => completion!.unmount());
    if (tree) await act(async () => tree!.unmount());
    Date.now = priorNow;
    Object.assign(globalThis, { window: priorWindow, sessionStorage: priorStorage, fetch: priorFetch });
  }
});

test('member completion shows three try cards and the first returned result', async () => {
  const priorFetch = globalThis.fetch;
  const priorStorage = globalThis.sessionStorage;
  const requests: Array<{ url: string; body?: unknown }> = [];
  Object.assign(globalThis, {
    sessionStorage: { getItem: () => String(Date.now() - 65_000) },
    fetch: async (url: string, init?: RequestInit) => {
      requests.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      return url === '/v1/members' ? Response.json({ member: { eventCode: 'KCB1114' } })
        : Response.json({ result: '오늘의 짧은 일정표' });
    },
  });
  let tree!: ReturnType<typeof create>;
  try {
    await act(async () => { tree = create(<TryPage />); await Promise.resolve(); });
    expect(tree.root.findAllByProps({ 'aria-pressed': true })).toHaveLength(1);
    expect(tree.root.findAllByProps({ 'aria-pressed': false })).toHaveLength(2);
    await act(async () => { tree.root.findAllByProps({ 'aria-pressed': false })[1]!.props.onClick(); });
    await act(async () => { tree.root.findByType('textarea').props.onChange({ target: { value: '회의 후 정리' } }); });
    await act(async () => { tree.root.findAllByType('button').at(-1)!.props.onClick(); await Promise.resolve(); });
    expect(requests.at(-1)).toEqual({ url: '/v1/members/try', body: { exampleId: 'day-plan', input: '회의 후 정리' } });
    expect(JSON.stringify(tree.toJSON())).toContain('오늘의 짧은 일정표');
  } finally {
    if (tree) await act(async () => tree.unmount());
    Object.assign(globalThis, { fetch: priorFetch, sessionStorage: priorStorage });
  }
});

test('real QR and completion components observe first-result SLA through fake OIDC and LLM', async () => {
  for (const { oauthMs, expectedSeconds, verdict } of [
    { oauthMs: 20_000, expectedSeconds: 65, verdict: '2분 이내' },
    { oauthMs: 76_000, expectedSeconds: 121, verdict: '2분 초과' },
  ]) {
    const priorWindow = globalThis.window;
    const priorStorage = globalThis.sessionStorage;
    const priorFetch = globalThis.fetch;
    const priorNow = Date.now;
    let now = Date.parse('2026-11-14T01:00:00.000Z');
    let authorizationUrl = '';
    let stateCookie = '';
    let memberCookie = '';
    let generated = 0;
    const storage = new Map<string, string>();
    const world = createFakeMemberOidcWorld({ now: () => now, runTryExample: async () => {
      now += 30_000;
      return `가짜 첫 결과 ${++generated}`;
    } });
    // 출처: #36725 — 두 독립 여정이 동일한 가짜 행사 코드에서 가입할 수 있는 fixture 용량.
    world.memberStore.provisionEventCode({ code: 'KCB1114', maxUses: 3 });
    Date.now = () => now;
    Object.assign(globalThis, {
      window: { location: { search: '?code=KCB1114', assign: (url: string) => { authorizationUrl = url; } } },
      sessionStorage: { setItem: (key: string, value: string) => storage.set(key, value), getItem: (key: string) => storage.get(key) ?? null },
      fetch: async (path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        if (init.method === 'POST') headers.set('origin', 'https://app.example.test');
        if (memberCookie) headers.set('cookie', memberCookie);
        const response = await world.membersApi.handle(new Request(new URL(path, 'https://members.example.test'), { ...init, headers }));
        if (!response) throw new Error(`unhandled member path: ${path}`);
        if (init.method === 'POST' && path === '/v1/members') stateCookie = response.headers.get('set-cookie')!.split(';', 1)[0]!;
        return response;
      },
    });
    let signup!: ReturnType<typeof create>;
    let completion!: ReturnType<typeof create>;
    try {
      await act(async () => { signup = create(<MemberSignupPage />); });
      expect(storage.get('kcb-qr-journey-started-at')).toBe(String(now));
      now += 15_000;
      await act(async () => { signup.root.findAllByType('input')[1]!.props.onChange({ target: { checked: true } }); });
      await act(async () => { signup.root.findByType('button').props.onClick(); await Promise.resolve(); });
      expect(authorizationUrl).toStartWith('https://accounts.google.test/');
      now += oauthMs;
      const auth = world.googleWorld.authorize(authorizationUrl);
      const callback = await world.membersApi.handle(new Request(
        `${FAKE_MEMBER_OIDC_REDIRECT_URI}?code=${auth.code}&state=${auth.state}`, { headers: { cookie: stateCookie } },
      ));
      expect(callback?.status).toBe(200);
      const continueHref = /<a href="([^"]+)" rel="noreferrer">Continue<\/a>/.exec(await callback!.text())?.[1];
      expect(continueHref).toBeTruthy();
      expect(new URL(continueHref!).pathname).toBe('/app/signup/complete/');
      memberCookie = callback!.headers.get('set-cookie')!.split(';', 1)[0]!;
      await act(async () => { signup.unmount(); completion = create(<TryPage />); await Promise.resolve(); });
      expect(completion.root.findAllByProps({ 'aria-pressed': false })).toHaveLength(2);
      await act(async () => { completion.root.findByType('textarea').props.onChange({ target: { value: '기사 제목: 행사 시작' } }); });
      await act(async () => { completion.root.findAllByType('button').at(-1)!.props.onClick(); await Promise.resolve(); });
      const first = completion.root.findByProps({ 'aria-label': '첫 결과' }).findAllByType('p').map(node => node.children.join(''));
      expect(first.join(' ')).toContain('가짜 첫 결과 1');
      expect(first.join(' ')).toContain(`${expectedSeconds}초`);
      expect(first.join(' ')).toContain(verdict);
      now += 10_000;
      await act(async () => { completion.root.findAllByProps({ 'aria-pressed': false })[0]!.props.onClick(); });
      await act(async () => { completion.root.findAllByType('button').at(-1)!.props.onClick(); await Promise.resolve(); });
      expect(completion.root.findByProps({ 'aria-label': '첫 결과' }).findAllByType('p').map(node => node.children.join(''))).toEqual(first);
      expect(completion.root.findByProps({ 'aria-label': '추가 결과' }).findAllByType('p').map(node => node.children.join('')).join(' ')).toContain('가짜 첫 결과 2');
    } finally {
      if (completion) await act(async () => completion.unmount());
      if (signup) await act(async () => signup.unmount());
      world.close();
      Date.now = priorNow;
      Object.assign(globalThis, { window: priorWindow, sessionStorage: priorStorage, fetch: priorFetch });
    }
  }
});
