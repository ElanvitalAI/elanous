import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemberStore } from './member-store.js';
import { createMembersApi } from './members-api.js';

const apiOrigin = 'https://api.example.test';
const webOrigin = 'https://app.example.test';
const at = Date.parse('2026-11-14T09:00:00.000Z');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'member-mobile-deletion-'));
  const store = createMemberStore({ path: join(dir, 'members.sqlite'), now: () => at });
  const member = store.register({ sub: 'verified-mobile-sub', email: 'mobile@example.test', emailVerified: true, name: 'Fake Mobile' },
    { consents: { privacy: 'v1', terms: 'v1' } }, new Date(at).toISOString());
  let issuerCalls = 0;
  const api = createMembersApi({ store, now: () => at,
    google: { redirectUri: apiOrigin + '/v1/members/oauth/google/callback' } as never,
    successRedirectUri: webOrigin + '/member', webOrigin,
    verifyMobileGoogleIdToken: async token => token === 'valid-fake-token' ? 'verified-mobile-sub'
      : token === 'unknown-fake-token' ? 'unknown-mobile-sub' : null,
    issueOwnerSession: () => { issuerCalls++; return {
      sessionToken: 'aps_fake-mobile-session', expiresAt: '2026-11-15T09:00:00.000Z',
    }; },
  });
  const mobile = (googleIdToken: string) => api.handle(new Request(apiOrigin + '/v1/members/app-slot/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ googleIdToken }),
  }));
  const cookie = '__Host-elanous_member_session=' + member.session.token;
  const profile = () => api.handle(new Request(apiOrigin + '/v1/members', { headers: { cookie } }));
  const deleteAccount = () => api.handle(new Request(apiOrigin + '/v1/members', {
    method: 'DELETE', headers: { origin: webOrigin, cookie },
  }));
  return { store, member, mobile, profile, deleteAccount, issuerCalls: () => issuerCalls,
    close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('mobile session entry accepts verified owner and rejects invalid or unknown subjects', async () => {
  const box = fixture();
  try {
    const invalid = await box.mobile('invalid-fake-token');
    const unknown = await box.mobile('unknown-fake-token');
    const valid = await box.mobile('valid-fake-token');
    const body = await valid?.json() as { appId?: string; sessionToken?: string; publicId?: string | null };
    const observed = { invalid: invalid?.status, unknown: unknown?.status, valid: valid?.status,
      slotMatches: body.appId === box.store.appSlotForMember(box.member.id)?.appId,
      hasSession: Boolean(body.sessionToken), issuerCalls: box.issuerCalls() };
    expect(observed).toEqual({ invalid: 401, unknown: 401, valid: 200,
      slotMatches: true, hasSession: true, issuerCalls: 1 });
  } finally { box.close(); }
});

test('deleted member must not obtain a new app session from a still-verifiable Google subject', async () => {
  const box = fixture();
  try {
    const deleted = await box.deleteAccount();
    const staleProfile = await box.profile();
    const mobile = await box.mobile('valid-fake-token');
    const observed = { deletion: deleted?.status, staleProfile: staleProfile?.status,
      mobile: mobile?.status, issuerCalls: box.issuerCalls() };
    expect(observed).toEqual({ deletion: 202, staleProfile: 401, mobile: 401, issuerCalls: 0 });
  } finally { box.close(); }
});
