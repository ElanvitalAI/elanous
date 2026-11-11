import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemberStore } from '../members/member-store.js';
import { createMembersApi } from '../members/members-api.js';
import type { GoogleSignin } from '../members/google-signin.js';
import { loadNexusAppHost } from '../apps/app-host.js';
import { createVerifiedAbsorbBriefingsAppRoute } from './briefings-api.js';

const REDIRECT = 'https://api.example.test/v1/members/oauth/google/callback';

test('briefings appRoute resolves its owner through the real /v1/members/owner HTTP handler', async () => {
  const root = mkdtempSync(join(tmpdir(), 'briefings-owner-integration-'));
  const appsDir = join(root, 'apps');
  mkdirSync(appsDir, { recursive: true });
  const nowMs = Date.parse('2026-11-14T01:00:00.000Z');
  const now = () => nowMs;
  const members = createMemberStore({ path: ':memory:', now });
  // 출처: #36116 integration fixture event code is intentionally single-use.
  members.provisionEventCode({ code: 'ABSORB-TEST', maxUses: 1 });
  const profile = members.register({ sub: 'absorb-owner-google', email: 'owner@example.test', emailVerified: true, name: 'Owner' },
    { consents: { privacy: 'privacy-v1', terms: 'terms-v1' }, eventCode: 'ABSORB-TEST' }, new Date(nowMs).toISOString());
  const slot = members.appSlotForMember(profile.id);
  if (!slot) throw new Error('member app slot was not created');
  const appDir = join(appsDir, slot.appSlug);
  mkdirSync(join(appDir, 'out'), { recursive: true });
  writeFileSync(join(appDir, 'app.yaml'), `apiVersion: elanous.app/v0\nslug: ${slot.appSlug}\ntitle: Briefings\nfrontend:\n  kind: static-export\n  out: out\nroles:\n  owner: { via: nexus-session }\n`);
  writeFileSync(join(appDir, 'out', 'index.html'), '<main>briefings</main>');
  const loaded = loadNexusAppHost(appsDir, undefined, {
    dir: join(root, 'app-auth'), databaseDirectory: join(root, 'app-databases'),
    key: 'briefings-owner-integration-key-with-256-bits', now,
  });
  const session = loaded.appHost.issueOwnerSession(slot.appSlug, profile.id);
  const membersApi = createMembersApi({
    store: members,
    google: { redirectUri: REDIRECT } as GoogleSignin,
    successRedirectUri: 'https://app.example.test/signup/complete',
    now,
    resolveVerifiedOwner: (appSlug, credential, memberStore) => loaded.appHost.resolveVerifiedOwner(appSlug, credential, memberStore, 'kaist-demo'),
  });
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: async (request) => await membersApi.handle(request) ?? new Response('not found', { status: 404 }),
  });
  const briefingRoot = join(root, 'state');
  mkdirSync(join(briefingRoot, 'intake'), { recursive: true });
  const briefing = { id: 'brief-owned', memberId: profile.id, day: '2026-11-14', trigger: 'daily', topics: [], todos: [], suggestionIds: [], llm: { provider: 'none' }, createdAt: new Date(nowMs).toISOString() };
  writeFileSync(join(briefingRoot, 'intake', 'absorb-brief.jsonl'), `${JSON.stringify(briefing)}\n`);

  try {
    const route = createVerifiedAbsorbBriefingsAppRoute({ root: briefingRoot, endpointOrigin: () => server.url.origin });
    const response = await route(new Request(`http://nexus.test/v1/briefings/brief-owned?appSlug=${slot.appSlug}`, {
      headers: { authorization: `Bearer ${session.sessionToken}` },
    }));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(briefing);

    const wrongApp = await route(new Request('http://nexus.test/v1/briefings/brief-owned?appSlug=another-app', {
      headers: { authorization: `Bearer ${session.sessionToken}` },
    }));
    expect(wrongApp?.status).toBe(401);
  } finally {
    server.stop(true);
    loaded.appHost.close();
    members.close();
    rmSync(root, { recursive: true, force: true });
  }
});
