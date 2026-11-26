import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemberStore } from './member-store.js';
import { createMembersApi } from './members-api.js';
import { loadNexusAppHost, resolveVerifiedMemberOwner, resolveVerifiedOwner } from '../apps/app-host.js';

// MEMBER-CONNECT-NO-MOUNT (OP 11-26 15:42): the CEO's slot app was never built, so the members host had no
// mounted app for it and `member connect` exchange failed 503 session-issuer-failed. Expected values below are
// literals, not product constants.
const apiOrigin = 'https://api.example.test';
const webOrigin = 'https://app.example.test';
const verifier = 'v'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = 's'.repeat(43);
const pollSecret = 'p'.repeat(43);

function fixture(input: { mounted: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'member-connect-unmounted-'));
  let clock = Date.parse('2026-11-26T07:00:00.000Z');
  const now = () => clock;
  const store = createMemberStore({ path: join(dir, 'members.sqlite'), now });
  const register = (sub: string) => store.register({ sub, email: sub + '@example.test', emailVerified: true, name: sub },
    { consents: { privacy: 'v1', terms: 'v1' } }, new Date(clock).toISOString());
  const member = register('unmounted-owner');
  const other = register('unmounted-other');
  let appIssuerCalls = 0;
  const api = createMembersApi({ store, now,
    google: { redirectUri: apiOrigin + '/v1/members/oauth/google/callback' } as never,
    successRedirectUri: webOrigin + '/member', webOrigin,
    // The real app host throws for an unmounted slug; a mounted one returns an app session.
    issueOwnerSession: () => {
      appIssuerCalls++;
      if (!input.mounted) throw new Error('app is not mounted or app authentication is unavailable');
      return { sessionToken: 'aps_app-owner-session', expiresAt: '2026-11-26T08:00:00.000Z' };
    },
    appMounted: () => input.mounted,
  });
  const cookie = '__Host-elanous_member_session=' + member.session.token;
  const connect = async (): Promise<{ status: number | undefined; body: Record<string, unknown> }> => {
    const started = await api.handle(new Request(apiOrigin + '/v1/members/connect/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, codeChallenge: challenge, pollSecret }),
    }));
    const start = await started!.json() as { id: string; approvalUrl: string; userCode: string };
    const page = await api.handle(new Request(start.approvalUrl, { headers: { cookie } }));
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page!.text())![1]!;
    const approved = await api.handle(new Request(start.approvalUrl, {
      method: 'POST', headers: { origin: apiOrigin, cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, userCode: start.userCode }).toString(),
    }));
    expect(approved?.status).toBe(200);
    const polled = await api.handle(new Request(apiOrigin + '/v1/members/connect/poll?id=' + start.id, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pollSecret }),
    }));
    const code = (await polled!.json() as { code: string }).code;
    const exchanged = await api.handle(new Request(apiOrigin + '/v1/members/app-slot/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, state, codeVerifier: verifier }),
    }));
    return { status: exchanged?.status, body: await exchanged!.json() as Record<string, unknown> };
  };
  const owner = (token: string, appSlug?: string) => api.handle(new Request(
    apiOrigin + '/v1/members/owner' + (appSlug ? '?appSlug=' + encodeURIComponent(appSlug) : ''),
    { headers: { authorization: 'Bearer ' + token } }));
  const issueKey = (token: string) => api.handle(new Request(apiOrigin + '/v1/member/keys', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, origin: 'https://native.example.test',
      'content-type': 'application/json' }, body: JSON.stringify({ name: 'local-relay' }) }));
  return { api, store, member, other, cookie, connect, owner, issueKey,
    appIssuerCalls: () => appIssuerCalls, advance: (ms: number) => { clock += ms; },
    close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('unmounted slot: connect exchange issues a member session that verifies the owner and self-issues the relay key', async () => {
  const box = fixture({ mounted: false });
  try {
    const exchanged = await box.connect();
    expect(exchanged.status).toBe(200);
    expect(box.appIssuerCalls()).toBe(0);
    const token = String(exchanged.body.sessionToken);
    expect(token.startsWith('aps_')).toBe(true);
    expect(exchanged.body.tokenType).toBe('Bearer');
    const appSlug = String((exchanged.body.appSlot as { appSlug: string }).appSlug);
    // Legacy null-slug slot → the 24-hex hash slug, the same value the CLI stores and re-verifies.
    expect(appSlug).toMatch(/^[a-f0-9]{24}$/);
    expect(Date.parse(String(exchanged.body.expiresAt)) - Date.parse('2026-11-26T07:00:00.000Z')).toBe(3_600_000);

    const verified = await box.owner(token, appSlug);
    expect(verified?.status).toBe(200);
    expect((await verified!.json() as { memberId: string }).memberId).toBe(box.member.id);
    expect((await box.owner(token))?.status).toBe(200);
    expect((await box.owner(token, 'someone-elses-app'))?.status).toBe(401);
    expect((await box.owner('aps_forged-session', appSlug))?.status).toBe(401);

    const key = await box.issueKey(token);
    expect(key?.status).toBe(201);
    const issued = await key!.json() as { id: string };
    expect(box.store.listMemberKeys(box.member.id).some(row => row.id === issued.id && row.name === 'local-relay')).toBe(true);
    expect(box.store.listMemberKeys(box.other.id).some(row => row.name === 'local-relay')).toBe(false);
    expect((await box.issueKey('aps_forged-session'))?.status).toBe(401);

    box.advance(3_600_000);
    expect((await box.owner(token, appSlug))?.status).toBe(401);
    expect((await box.issueKey(token))?.status).toBe(401);
  } finally { box.close(); }
});

test('unmounted slot: account deletion revokes the member connect session', async () => {
  const box = fixture({ mounted: false });
  try {
    const exchanged = await box.connect();
    const token = String(exchanged.body.sessionToken);
    const appSlug = String((exchanged.body.appSlot as { appSlug: string }).appSlug);
    expect((await box.owner(token, appSlug))?.status).toBe(200);
    const deleted = await box.api.handle(new Request(apiOrigin + '/v1/members', {
      method: 'DELETE', headers: { origin: webOrigin, cookie: box.cookie } }));
    expect(deleted?.status).toBe(202);
    expect((await box.owner(token, appSlug))?.status).toBe(401);
    expect((await box.issueKey(token))?.status).toBe(401);
  } finally { box.close(); }
});

test('mounted slot keeps the app owner session issuer', async () => {
  const box = fixture({ mounted: true });
  try {
    const exchanged = await box.connect();
    expect(exchanged.status).toBe(200);
    expect(exchanged.body.sessionToken).toBe('aps_app-owner-session');
    expect(box.appIssuerCalls()).toBe(1);
  } finally { box.close(); }
});

test('store connect session is bound to the issuing member and slot', () => {
  const box = fixture({ mounted: false });
  try {
    const slot = box.store.ensureNativeAppSlotForMember(box.member.id)!;
    const otherSlot = box.store.ensureNativeAppSlotForMember(box.other.id)!;
    expect(() => box.store.issueMemberConnectSession!(box.member.id, otherSlot.appId)).toThrow();
    const issued = box.store.issueMemberConnectSession!(box.member.id, slot.appId);
    expect(box.store.memberForConnectSession!(issued.sessionToken)).toEqual({ memberId: box.member.id, appId: slot.appId });
    expect(box.store.memberForConnectSession!('aps_' + 'x'.repeat(43))).toBeNull();
    expect(box.store.memberForConnectSession!('not-an-app-session')).toBeNull();
  } finally { box.close(); }
});

test('real app host: an unmounted slot gets the member session, a mounted slot keeps the app owner session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'member-connect-real-host-'));
  const clock = Date.parse('2026-11-26T07:00:00.000Z');
  const now = () => clock;
  const store = createMemberStore({ path: join(dir, 'members.sqlite'), now });
  const register = (sub: string) => store.register({ sub, email: sub + '@example.test', emailVerified: true, name: sub },
    { consents: { privacy: 'v1', terms: 'v1' } }, new Date(clock).toISOString());
  try {
    const mountedMember = register('real-host-mounted');
    const bareMember = register('real-host-unmounted');
    const mountedSlot = store.ensureNativeAppSlotForMember(mountedMember.id)!;
    const bareSlot = store.ensureNativeAppSlotForMember(bareMember.id)!;
    const apps = join(dir, 'apps'); const app = join(apps, mountedSlot.appSlug);
    mkdirSync(join(app, 'out'), { recursive: true });
    writeFileSync(join(app, 'out/index.html'), '<main>synthetic</main>');
    writeFileSync(join(app, 'app.yaml'), ['apiVersion: elanous.app/v0', 'slug: ' + mountedSlot.appSlug,
      'title: Synthetic', 'frontend:', '  kind: static-export', '  out: out', 'roles:',
      '  owner: { via: nexus-session }', '  public: { via: public-read }'].join('\n'));
    const { appHost } = loadNexusAppHost(apps, undefined, { dir: join(dir, 'auth'),
      databaseDirectory: join(dir, 'app-db'), key: 'synthetic-issuer-test-key-with-256-bits', now }, 'fixtureowner');
    // Same wiring as http-server.ts (issueOwnerSession · appMounted · resolvers).
    const api = createMembersApi({ store, now,
      google: { redirectUri: apiOrigin + '/v1/members/oauth/google/callback' } as never,
      successRedirectUri: webOrigin + '/member', webOrigin,
      issueOwnerSession: (slug, memberId) => appHost.issueOwnerSession(slug, memberId),
      appMounted: slug => appHost.slugs.includes(slug),
      resolveVerifiedOwner: (slug, credential, members) => resolveVerifiedOwner(appHost, slug, credential, members, 'fixtureowner'),
      resolveVerifiedMemberOwner: (credential, members) => resolveVerifiedMemberOwner(appHost, credential, members, 'fixtureowner'),
    });
    expect(appHost.slugs).toEqual([mountedSlot.appSlug]);
    const exchangeFor = async (memberId: string, appId: string) => {
      const code = 'c'.repeat(43) + memberId.slice(0, 4);
      store.createAppAuthCode!({ code, state, codeChallenge: challenge, memberId, appId,
        expiresAt: new Date(clock + 120_000).toISOString() }, new Date(clock).toISOString());
      const response = await api.handle(new Request(apiOrigin + '/v1/members/app-slot/exchange', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, state, codeVerifier: verifier }) }));
      return { status: response?.status, body: await response!.json() as { sessionToken: string } };
    };
    const owner = (token: string, slug: string) => api.handle(new Request(apiOrigin + '/v1/members/owner?appSlug=' + slug,
      { headers: { authorization: 'Bearer ' + token } }));
    const key = (token: string) => api.handle(new Request(apiOrigin + '/v1/member/keys', { method: 'POST',
      headers: { authorization: 'Bearer ' + token, origin: 'https://native.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'local-relay' }) }));

    const bare = await exchangeFor(bareMember.id, bareSlot.appId);
    expect(bare.status).toBe(200);
    expect(store.memberForConnectSession!(bare.body.sessionToken)?.memberId).toBe(bareMember.id);
    expect((await owner(bare.body.sessionToken, bareSlot.appSlug))?.status).toBe(200);
    expect((await owner(bare.body.sessionToken, mountedSlot.appSlug))?.status).toBe(401);
    expect((await key(bare.body.sessionToken))?.status).toBe(201);

    const mounted = await exchangeFor(mountedMember.id, mountedSlot.appId);
    expect(mounted.status).toBe(200);
    expect(store.memberForConnectSession!(mounted.body.sessionToken)).toBeNull();
    const verified = await owner(mounted.body.sessionToken, mountedSlot.appSlug);
    expect(verified?.status).toBe(200);
    expect((await verified!.json() as { memberId: string }).memberId).toBe(mountedMember.id);
    expect((await owner(mounted.body.sessionToken, bareSlot.appSlug))?.status).toBe(401);
    expect((await key(mounted.body.sessionToken))?.status).toBe(201);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
