import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDevProxyRuntimeRef } from '../nexus/api/admin-dev-proxy.js';
import { routeRequest } from '../nexus/api/http-server.js';
import { loadNexusAppHost } from '../nexus/apps/app-host.js';
import { createAppAuth } from '../nexus/apps/app-auth.js';
import { createGoogleSignin } from '../nexus/members/google-signin.js';
import { createMemberStore } from '../nexus/members/member-store.js';
import { createMembersApi } from '../nexus/members/members-api.js';
import { googleMobileSubjectFromClaims } from '../nexus/members/members-api.js';
import { publicAppAddress } from '../nexus/apps/console-address.js';
import { createFakeGoogleOAuthWorld, FAKE_GOOGLE_ISSUER } from './fake-google-oauth.js';

const CLIENT_ID = 'member-client-test';
const REDIRECT = 'https://api.example.test/v1/members/oauth/google/callback';
const APP_AUTH_KEY = 'google-oauth-app-db-e2e-test-signing-key-with-256-bits';

const appManifest = (slug: string, ownerVia = 'nexus-session') => `apiVersion: elanous.app/v0
slug: ${slug}
title: ${slug}
frontend:
  kind: static-export
  out: out
tables:
  notes:
    columns:
      id: { type: text, primary: true }
      title: { type: text }
roles:
  owner: { via: ${ownerVia} }
  member: { via: share-link }
rpc:
  list:
    sql: SELECT id, title FROM notes ORDER BY id
    params: {}
    allow: [owner, member]
  add:
    sql: INSERT INTO notes (id, title) VALUES (:id, :title)
    params: { id: { type: text }, title: { type: text } }
    allow: [owner, member]
`;

function writeApp(appsDir: string, slug: string, ownerVia?: string): void {
  const appDir = join(appsDir, slug);
  const outDir = join(appDir, 'out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(appDir, 'app.yaml'), appManifest(slug, ownerVia));
  writeFileSync(join(outDir, 'index.html'), `<main>${slug}</main>`);
}

async function appRequest(
  appHost: ReturnType<typeof loadNexusAppHost>['appHost'],
  slug: string,
  path: string,
  options: { method?: string; cookie?: string; authorization?: string; body?: unknown; native?: boolean } = {},
): Promise<Response> {
  const origin = `http://${slug}.app.localhost`;
  return (await appHost.handle(new Request(`${origin}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      host: `${slug}.app.localhost`,
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(options.body !== undefined ? { ...(!options.native ? { origin } : {}), 'content-type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })))!;
}

test('SIM-MOBILE-OWNER-SESSION resolves Google subject to its app slot and issues an app-scoped bearer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mobile-owner-session-sim-'));
  const appsDir = join(root, 'apps');
  mkdirSync(appsDir);
  let nowMs = Date.parse('2026-11-14T01:00:00.000Z');
  const now = () => nowMs;
  const members = createMemberStore({ path: ':memory:', now });
  // Source: #92140 requires one member app-slot path, so the fixture admits one event-code signup.
  members.provisionEventCode({ code: 'KAIST-SIM', maxUses: 2 });
  const googleWorld = createFakeGoogleOAuthWorld({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    identity: { sub: 'google-subject-mobile', email: 'mobile@example.test', emailVerified: true, name: 'Mobile Member' },
  });
  const google = createGoogleSignin({
    clientId: async () => CLIENT_ID,
    clientSecret: async () => 'fake-google-client-secret',
    stateEncryptionKey: async () => 'test-only-state-encryption-key-with-256-bits',
    redirectUri: REDIRECT,
    store: members,
    fetch: googleWorld.fetch,
    now,
    authorizationEndpoint: `${FAKE_GOOGLE_ISSUER}/o/oauth2/v2/auth`,
    tokenEndpoint: `${FAKE_GOOGLE_ISSUER}/token`,
    userinfoEndpoint: `${FAKE_GOOGLE_ISSUER}/userinfo`,
  });
  let appHost: ReturnType<typeof loadNexusAppHost>['appHost'] | undefined;
  const membersApi = createMembersApi({
    store: members, google, successRedirectUri: 'https://app.example.test/signup/complete', now,
    verifyMobileGoogleIdToken: async token => token === 'sim-google-id-token' ? 'google-subject-mobile'
      : token === 'sim-other-google-id-token' ? 'google-subject-other' : null,
    issueOwnerSession: (appSlug, memberId) => appHost!.issueOwnerSession(appSlug, memberId),
    resolveVerifiedOwner: (appSlug, credential, store) => appHost!.resolveVerifiedOwner(appSlug, credential, store, 'kaist-demo'),
    publicAppUrl: slot => appHost?.slugs.includes(slot.appSlug)
      ? `${publicAppAddress({ appSlug: slot.appSlug, userSlug: 'kaist-demo' })}/` : null,
  });
  let loaded: ReturnType<typeof loadNexusAppHost> | undefined;

  try {
    const start = await membersApi.handle(new Request('https://api.example.test/v1/members', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://app.example.test' },
      body: JSON.stringify({ consents: { privacy: 'privacy-v1', terms: 'terms-v1' }, eventCode: 'KAIST-SIM' }),
    }));
    expect(start?.status).toBe(201);
    const stateCookie = start!.headers.get('set-cookie')!.split(';', 1)[0]!;
    const { authorizationUrl } = await start!.json() as { authorizationUrl: string };
    const callback = googleWorld.authorize(authorizationUrl);
    const completed = await membersApi.handle(new Request(
      `https://api.example.test/v1/members/oauth/google/callback?code=${callback.code}&state=${callback.state}`,
      { headers: { cookie: stateCookie } },
    ));
    expect(completed?.status).toBe(303);
    const profile = await membersApi.handle(new Request('https://api.example.test/v1/members', {
      headers: { cookie: completed!.headers.get('set-cookie')!.split(';', 1)[0]! },
    }));
    let { appSlot } = await profile!.json() as { appSlot: { appId: string; appSlug: string; url: string | null } };
    expect(appSlot.appId).toMatch(/^kaist-[a-f0-9]{24}$/);
    expect(appSlot.appSlug).toMatch(/^[a-f0-9]{24}$/);
    expect(appSlot.url).toBeNull();

    const otherMember = members.register({ sub: 'google-subject-other', email: 'other@example.test', emailVerified: true, name: 'Other Member' },
      { consents: { privacy: 'privacy-v1', terms: 'terms-v1' }, eventCode: 'KAIST-SIM' }, new Date(now()).toISOString());
    const otherSlot = members.appSlotForMember(otherMember.id)!;
    expect(otherSlot.appSlug).toMatch(/^[a-f0-9]{24}$/);
    expect(otherSlot.appSlug).not.toBe(appSlot.appSlug);

    writeApp(appsDir, appSlot.appSlug);
    writeApp(appsDir, otherSlot.appSlug);
    writeApp(appsDir, 'other-app');
    writeApp(appsDir, 'share-link-owner', 'share-link');
    loaded = loadNexusAppHost(appsDir, undefined, {
      dir: join(root, 'app-auth'), databaseDirectory: join(root, 'app-databases'), key: APP_AUTH_KEY, now,
    });
    appHost = loaded.appHost;
    expect(loaded.issues).toEqual([]);
    const publishedProfile = await membersApi.handle(new Request('https://api.example.test/v1/members', {
      headers: { cookie: completed!.headers.get('set-cookie')!.split(';', 1)[0]! },
    }));
    ({ appSlot } = await publishedProfile!.json() as { appSlot: typeof appSlot });
    expect(appSlot.url).toBe(`https://${appSlot.appSlug}--kaist-demo.elanous.app/`);
    expect(() => appHost!.issueOwnerSession('share-link-owner', 'member-mobile')).toThrow('owner role is not available through a member session');

    const invalid = await membersApi.handle(new Request('https://api.example.test/v1/members/app-slot/session', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ googleIdToken: 'invalid' }),
    }));
    expect(invalid?.status).toBe(401);
    const spoofed = await membersApi.handle(new Request('https://api.example.test/v1/members/app-slot/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ googleIdToken: 'sim-google-id-token', appId: 'other-app', role: 'owner', memberId: 'spoofed' }),
    }));
    expect(spoofed?.status).toBe(400);
    const issued = await membersApi.handle(new Request('https://api.example.test/v1/members/app-slot/session', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ googleIdToken: 'sim-google-id-token' }),
    }));
    expect(issued?.status).toBe(200);
    const session = await issued!.json() as { appId: string; sessionToken: string; tokenType: string; expiresAt: string };
    expect(session).toMatchObject({ appId: appSlot.appId, tokenType: 'Bearer' });
    expect(session.sessionToken).toMatch(/^aps_/);
    expect(Date.parse(session.expiresAt)).toBeGreaterThan(nowMs);
    const verifiedOwner = await membersApi.handle(new Request(`https://api.example.test/v1/members/owner?appSlug=${appSlot.appSlug}`, {
      headers: { authorization: `Bearer ${session.sessionToken}` },
    }));
    expect(verifiedOwner?.status).toBe(200);
    expect(await verifiedOwner!.json()).toEqual({ memberId: members.memberForGoogleSub('google-subject-mobile')!.id,
      userSlug: 'kaist-demo', plan: 'free', entitlements: {} });

    const otherIssued = await membersApi.handle(new Request('https://api.example.test/v1/members/app-slot/session', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ googleIdToken: 'sim-other-google-id-token' }),
    }));
    expect(otherIssued?.status).toBe(200);
    const otherSession = await otherIssued!.json() as { appId: string; sessionToken: string };
    expect(otherSession.appId).toBe(otherSlot.appId);
    const crossSlot = await appRequest(appHost, otherSlot.appSlug, '/__rpc/list', {
      method: 'POST', authorization: `Bearer ${session.sessionToken}`, native: true, body: { params: {} },
    });
    expect(crossSlot.status).toBe(401);
    const otherOwner = await appHost.resolveVerifiedOwner(otherSlot.appSlug, otherSession.sessionToken, members, 'kaist-demo');
    expect(otherOwner).toMatchObject({ memberId: otherMember.id, userSlug: 'kaist-demo', plan: 'free', entitlements: {} });

    const shareLink = appHost.issueInvitation(appSlot.appSlug, 'share-inviter', undefined, 'member');
    const shareAccepted = await appRequest(appHost, appSlot.appSlug,
      `/__auth/accept?token=${encodeURIComponent(shareLink.token)}`);
    const shareCookieValue = shareAccepted.headers.get('set-cookie')!.split(';', 1)[0]!.split('=').slice(1).join('=');
    const shareLinkAsBearer = await appRequest(appHost, appSlot.appSlug, '/__rpc/list', {
      method: 'POST', authorization: `Bearer ${shareCookieValue}`, native: true, body: { params: {} },
    });
    expect(shareLinkAsBearer.status).toBe(401);

    const added = await appRequest(appHost, appSlot.appSlug, '/__rpc/add', {
      method: 'POST', authorization: `Bearer ${session.sessionToken}`, native: true, body: { params: { id: 'mobile-note', title: 'owner session' } },
    });
    expect(added.status).toBe(200);
    const read = await appRequest(appHost, appSlot.appSlug, '/__rpc/list', {
      method: 'POST', authorization: `Bearer ${session.sessionToken}`, native: true, body: { params: {} },
    });
    expect(await read.json()).toEqual({ rows: [{ id: 'mobile-note', title: 'owner session' }] });

    const noCookieNative = await appRequest(appHost, appSlot.appSlug, '/__rpc/list', {
      method: 'POST', authorization: `Bearer ${session.sessionToken}`, cookie: 'untrusted=1', native: true, body: { params: {} },
    });
    expect(noCookieNative.status).toBe(401);
    const revoker = createAppAuth({ dir: join(root, 'app-auth', appSlot.appSlug), key: APP_AUTH_KEY, now });
    expect(revoker.revokeSession(session.sessionToken)).toBe(true);
    const revoked = await appRequest(appHost, appSlot.appSlug, '/__rpc/list', {
      method: 'POST', authorization: `Bearer ${session.sessionToken}`, native: true, body: { params: {} },
    });
    expect(revoked.status).toBe(401);
    const reissued = await membersApi.handle(new Request('https://api.example.test/v1/members/app-slot/session', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ googleIdToken: 'sim-google-id-token' }),
    }));
    const secondSession = await reissued!.json() as { sessionToken: string };
    const crossApp = await appRequest(appHost, 'other-app', '/__rpc/list', {
      method: 'POST', authorization: `Bearer ${secondSession.sessionToken}`, native: true, body: { params: {} },
    });
    expect(crossApp.status).toBe(401);
    nowMs += 60 * 60_000 + 1;
    const expired = await appRequest(appHost, appSlot.appSlug, '/__rpc/list', {
      method: 'POST', authorization: `Bearer ${secondSession.sessionToken}`, native: true, body: { params: {} },
    });
    expect(expired.status).toBe(401);
  } finally {
    loaded?.appHost.close();
    members.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('mobile Google ID token claims require issuer, native audience, expiry, and subject', () => {
  const audiences = ['android-client.apps.googleusercontent.com', 'flutter-client.apps.googleusercontent.com'];
  const valid = { iss: 'https://accounts.google.com', aud: audiences[0], exp: 2_000_000_000, sub: 'google-subject' };
  expect(googleMobileSubjectFromClaims(valid, audiences, 1_900_000_000_000)).toBe('google-subject');
  expect(googleMobileSubjectFromClaims({ ...valid, iss: 'https://evil.example' }, audiences, 1_900_000_000_000)).toBeNull();
  expect(googleMobileSubjectFromClaims({ ...valid, aud: 'web-client.apps.googleusercontent.com' }, audiences, 1_900_000_000_000)).toBeNull();
  expect(googleMobileSubjectFromClaims({ ...valid, exp: 1_899_999_999 }, audiences, 1_900_000_000_000)).toBeNull();
  expect(googleMobileSubjectFromClaims({ ...valid, sub: '' }, audiences, 1_900_000_000_000)).toBeNull();
});

test('SIM-APP-GOOGLE-OAUTH-APP-DB-E2E follows Google callback into isolated app database RPCs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'google-oauth-app-db-e2e-'));
  const appsDir = join(root, 'apps');
  mkdirSync(appsDir);
  writeApp(appsDir, 'voice-note');
  writeApp(appsDir, 'private-journal');

  const now = () => Date.parse('2026-11-09T01:00:00.000Z');
  const members = createMemberStore({ path: ':memory:', now });
  const googleWorld = createFakeGoogleOAuthWorld({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    identity: { sub: 'google-subject-e2e', email: 'member@example.test', emailVerified: true, name: 'E2E Member' },
  });
  const google = createGoogleSignin({
    clientId: async () => CLIENT_ID,
    clientSecret: async () => 'fake-google-client-secret',
    stateEncryptionKey: async () => 'test-only-state-encryption-key-with-256-bits',
    redirectUri: REDIRECT,
    store: members,
    fetch: googleWorld.fetch,
    now,
    authorizationEndpoint: `${FAKE_GOOGLE_ISSUER}/o/oauth2/v2/auth`,
    tokenEndpoint: `${FAKE_GOOGLE_ISSUER}/token`,
    userinfoEndpoint: `${FAKE_GOOGLE_ISSUER}/userinfo`,
  });
  const membersApi = createMembersApi({
    store: members,
    google,
    successRedirectUri: 'https://app.example.test/signup/complete',
    now,
  });
  const loaded = loadNexusAppHost(appsDir, undefined, {
    dir: join(root, 'app-auth'),
    databaseDirectory: join(root, 'app-databases'),
    key: APP_AUTH_KEY,
    now,
  });

  try {
    expect(loaded.issues).toEqual([]);
    const start = await membersApi.handle(new Request('https://api.example.test/v1/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://app.example.test' },
      body: JSON.stringify({ consents: { privacy: 'privacy-v1', terms: 'terms-v1' } }),
    }));
    expect(start?.status).toBe(201);
    const stateCookie = start!.headers.get('set-cookie')!.split(';', 1)[0]!;
    expect(stateCookie).toContain('__Host-elanous_member_oauth_state=');
    const { authorizationUrl } = await start!.json() as { authorizationUrl: string };
    const callback = googleWorld.authorize(authorizationUrl);
    const callbackUrl = `https://api.example.test/v1/members/oauth/google/callback?code=${callback.code}&state=${callback.state}`;

    const completed = await routeRequest(
      new Request(callbackUrl, { headers: { cookie: stateCookie } }),
      { membersApi } as never,
      {} as never,
      null,
      createDevProxyRuntimeRef(),
    );
    expect(completed?.status).toBe(303);
    expect(completed?.headers.get('location')).toBe('https://app.example.test/signup/complete');
    const memberCookie = completed!.headers.get('set-cookie')!.split(';', 1)[0]!;
    expect(memberCookie).toContain('__Host-elanous_member_session=');

    const profile = await membersApi.handle(new Request('https://api.example.test/v1/members', {
      headers: { cookie: memberCookie },
    }));
    expect(profile?.status).toBe(200);
    const profileBody = await profile!.json() as { member: { id: string; email: string } };
    expect(profileBody.member).toMatchObject({ email: 'member@example.test' });
    expect(profileBody.member.id).toBeTruthy();
    expect(JSON.stringify(profileBody)).not.toContain('fake-google-access');

    const invitation = loaded.appHost.issueInvitation('voice-note', profileBody.member.id, undefined, 'member');
    const accepted = await appRequest(loaded.appHost, 'voice-note',
      `/__auth/accept?token=${encodeURIComponent(invitation.token)}`);
    expect(accepted.status).toBe(303);
    const appCookie = accepted.headers.get('set-cookie')!.split(';', 1)[0]!;
    const appAuthReader = createAppAuth({
      dir: join(root, 'app-auth', 'voice-note'),
      key: APP_AUTH_KEY,
      now,
    });
    expect(appAuthReader.getSessionRecord(appCookie)).toMatchObject({
      appSlug: 'voice-note',
      invitedBy: profileBody.member.id,
    });

    const write = await appRequest(loaded.appHost, 'voice-note', '/__rpc/add', {
      method: 'POST', cookie: appCookie, body: { params: { id: 'note-1', title: 'signed-in note' } },
    });
    expect(write.status).toBe(200);
    const read = await appRequest(loaded.appHost, 'voice-note', '/__rpc/list', {
      method: 'POST', cookie: appCookie, body: { params: {} },
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ rows: [{ id: 'note-1', title: 'signed-in note' }] });

    const crossTenant = await appRequest(loaded.appHost, 'private-journal', '/__rpc/list', {
      method: 'POST', cookie: appCookie, body: { params: {} },
    });
    expect(crossTenant.status).toBe(401);

    const secondInvitation = loaded.appHost.issueInvitation('private-journal', profileBody.member.id, undefined, 'member');
    const secondAccepted = await appRequest(loaded.appHost, 'private-journal',
      `/__auth/accept?token=${encodeURIComponent(secondInvitation.token)}`);
    expect(secondAccepted.status).toBe(303);
    const secondCookie = secondAccepted.headers.get('set-cookie')!.split(';', 1)[0]!;
    const secondAppRead = await appRequest(loaded.appHost, 'private-journal', '/__rpc/list', {
      method: 'POST', cookie: secondCookie, body: { params: {} },
    });
    expect(secondAppRead.status).toBe(200);
    expect(await secondAppRead.json()).toEqual({ rows: [] });
  } finally {
    loaded.appHost.close();
    members.close();
    rmSync(root, { recursive: true, force: true });
  }
});
