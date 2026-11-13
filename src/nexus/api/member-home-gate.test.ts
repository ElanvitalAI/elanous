import { expect, test } from 'bun:test';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { routeRequest, type NexusHttpServerOpts } from './http-server.js';
import { createMemberStore } from '../members/member-store.js';
import { createMembersApi } from '../members/members-api.js';

test('HTTP gate delegates member home to its own session check', async () => {
  const store = createMemberStore({ path: ':memory:' });
  try {
    const member = store.register({ sub: 'home-gate', email: 'home-gate@example.test',
      emailVerified: true, name: 'Home Gate' }, { consents: { privacy: 'v1', terms: 'v1' } });
    const membersApi = createMembersApi({ store, google: {
      redirectUri: 'https://api.example.test/v1/members/oauth/google/callback',
    } as never, successRedirectUri: 'https://app.example.test/member', webOrigin: 'https://app.example.test' });
    const opts = { membersApi } as NexusHttpServerOpts;
    const route = (path: string, headers?: HeadersInit) => routeRequest(
      new Request(`https://api.example.test${path}`, { headers }), opts, {} as never, null, createDevProxyRuntimeRef());

    const home = await route('/v1/members/home', {
      cookie: `__Host-elanous_member_session=${member.session.token}`,
    });
    expect(home?.status).toBe(200);
    expect(await home?.text()).toContain('Home Gate');
    expect((await route('/v1/members/home'))?.status).toBe(401);
  } finally { store.close(); }
});

test('HTTP gate still denies an unrelated private path with a member cookie', async () => {
  const store = createMemberStore({ path: ':memory:' });
  try {
    const member = store.register({ sub: 'private-gate', email: 'private-gate@example.test',
      emailVerified: true, name: 'Private Gate' }, { consents: { privacy: 'v1', terms: 'v1' } });
    const membersApi = createMembersApi({ store, google: {
      redirectUri: 'https://api.example.test/v1/members/oauth/google/callback',
    } as never, successRedirectUri: 'https://app.example.test/member' });
    const response = await routeRequest(new Request('https://api.example.test/v1/private-home-gate', {
      headers: { cookie: `__Host-elanous_member_session=${member.session.token}` },
    }), { membersApi } as NexusHttpServerOpts, {} as never, null, createDevProxyRuntimeRef());
    expect(response?.status).toBe(401);
  } finally { store.close(); }
});
