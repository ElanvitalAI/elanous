import { expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import MemberSignupPage from './page';
import TryPage from './complete/page';
import { createFakeMemberOidcWorld, FAKE_MEMBER_OIDC_REDIRECT_URI } from '../../../../../src/ux-sim/fake-member-oidc-world.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('fake KCB OAuth signup persists decline and the authenticated PWA recheck changes it', async () => {
  const priorWindow = globalThis.window;
  const priorStorage = globalThis.sessionStorage;
  const priorFetch = globalThis.fetch;
  const world = createFakeMemberOidcWorld({ now: () => Date.parse('2026-11-14T01:00:00.000Z') });
  // Source: #37053 registers one synthetic member before rechecking their preference in this isolated journey.
  world.memberStore.provisionEventCode({ code: 'KCB1114', maxUses: 1 });
  let authorizationUrl = '';
  let stateCookie = '';
  let memberCookie = '';
  Object.assign(globalThis, {
    window: { location: { search: '?code=KCB1114', assign: (url: string) => { authorizationUrl = url; } } },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    fetch: async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (init.method === 'POST' || init.method === 'PUT') headers.set('origin', 'https://app.example.test');
      if (memberCookie) headers.set('cookie', memberCookie);
      const response = await world.membersApi.handle(new Request(new URL(path, 'https://members.example.test'), { ...init, headers }));
      if (!response) throw new Error(`unhandled member path: ${path}`);
      if (init.method === 'POST' && path === '/v1/members') stateCookie = response.headers.get('set-cookie')!.split(';', 1)[0]!;
      return response;
    },
  });
  let signup: ReturnType<typeof create> | null = null;
  let completion: ReturnType<typeof create> | null = null;
  try {
    await act(async () => { signup = create(<MemberSignupPage />); });
    await act(async () => { signup!.root.findAllByType('input').find(input => input.props.type === 'checkbox')!.props.onChange({ target: { checked: true } }); });
    await act(async () => { signup!.root.findByProps({ name: 'newsletterPreference', value: 'declined' }).props.onChange(); });
    await act(async () => { await signup!.root.findByType('button').props.onClick(); });
    expect(authorizationUrl).toStartWith('https://accounts.google.test/');
    const auth = world.googleWorld.authorize(authorizationUrl);
    const callback = await world.membersApi.handle(new Request(
      `${FAKE_MEMBER_OIDC_REDIRECT_URI}?code=${auth.code}&state=${auth.state}`, { headers: { cookie: stateCookie } },
    ));
    expect(callback?.status).toBe(303);
    expect(new URL(callback!.headers.get('location')!).pathname).toBe('/app/board/');
    memberCookie = callback!.headers.get('set-cookie')!.split(';', 1)[0]!;
    await act(async () => { completion = create(<TryPage />); await Promise.resolve(); });
    expect(JSON.stringify(completion!.toJSON())).toContain('현재 수신 거부 상태입니다');
    expect(world.memberStore.newsletterOptInCount()).toBe(0);
    await act(async () => { completion!.root.findByProps({ name: 'newsletterPreference', value: 'opted_in' }).props.onChange(); });
    await act(async () => { await completion!.root.findAllByType('button').find(button => button.children.includes('선택 저장'))!.props.onClick(); });
    expect(JSON.stringify(completion!.toJSON())).toContain('현재 수신 동의 상태입니다');
    expect(world.memberStore.newsletterOptInCount()).toBe(1);
  } finally {
    if (completion) await act(async () => completion!.unmount());
    if (signup) await act(async () => signup!.unmount());
    world.close();
    Object.assign(globalThis, { window: priorWindow, sessionStorage: priorStorage, fetch: priorFetch });
  }
});
