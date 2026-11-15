import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemberStore } from './member-store.js';
import { createMembersApi } from './members-api.js';
import { loadNexusAppHost, resolveVerifiedMemberOwner } from '../apps/app-host.js';

test('native key self-issue binds a real expiring app owner, never a supplied member or cookie fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'member-key-app-session-'));
  let clock = Date.parse('2026-11-15T00:00:00Z');
  const now = () => clock;
  const store = createMemberStore({ path: join(root, 'members.sqlite'), now });
  const register = (name: string) => store.register({ sub: name, email: name + '@example.test', emailVerified: true, name },
    { consents: { privacy: 'v1', terms: 'v1' } });
  const owner = register('synthetic-owner'); const other = register('synthetic-other');
  const slot = store.ensureNativeAppSlotForMember(owner.id)!;
  const apps = join(root, 'apps'); const app = join(apps, slot.appSlug);
  mkdirSync(join(app, 'out'), { recursive: true });
  writeFileSync(join(app, 'out/index.html'), '<main>synthetic</main>');
  writeFileSync(join(app, 'app.yaml'), [ 'apiVersion: elanous.app/v0', 'slug: ' + slot.appSlug,
    'title: Synthetic', 'frontend:', '  kind: static-export', '  out: out', 'roles:',
    '  owner: { via: nexus-session }', '  public: { via: public-read }' ].join('\n'));
  const { appHost } = loadNexusAppHost(apps, undefined, { dir: join(root, 'auth'),
    databaseDirectory: join(root, 'app-db'), key: 'synthetic-issuer-test-key-with-256-bits', now }, 'fixtureowner');
  const session = appHost.issueOwnerSession(slot.appSlug, owner.id);
  const api = createMembersApi({ store, now,
    google: { redirectUri: 'https://api.example.test/v1/members/oauth/google/callback' } as never,
    successRedirectUri: 'https://web.example.test/complete', webOrigin: 'https://web.example.test',
    resolveVerifiedMemberOwner: (token, members) => resolveVerifiedMemberOwner(appHost, token, members, 'fixtureowner') });
  const issue = (headers: Record<string, string>, body: unknown = { name: 'local-relay' }, method = 'POST') => api.handle(
    new Request('https://api.example.test/v1/member/keys', { method,
      headers: { ...headers, 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) }));
  const bearer = { authorization: 'Bearer ' + session.sessionToken, origin: 'https://native.example.test' };
  try {
    const beforeOther = store.listMemberKeys(other.id);
    expect((await issue({ authorization: 'Bearer aps_forged' }))?.status).toBe(401);
    expect((await issue({ authorization: 'Bearer aps_forged', cookie: '__Host-elanous_member_session=' + owner.session.token }))?.status).toBe(401);
    expect((await issue({ ...bearer, cookie: '__Host-elanous_member_session=' + other.session.token }))?.status).toBe(401);
    expect((await issue(bearer, { name: 'local-relay', memberId: other.id }))?.status).toBe(400);
    expect((await issue({ cookie: '__Host-elanous_member_session=' + owner.session.token, origin: 'https://evil.example.test' }))?.status).toBe(403);
    expect((await issue(bearer, undefined, 'GET'))?.status).toBe(401);
    const response = await issue(bearer);
    expect(response?.status).toBe(201);
    const issued = await response!.json();
    expect(store.listMemberKeys(owner.id).some(key => key.id === issued.id && key.name === 'local-relay')).toBe(true);
    expect(store.listMemberKeys(other.id)).toEqual(beforeOther);
    clock = Date.parse(session.expiresAt);
    expect((await issue(bearer))?.status).toBe(401);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
