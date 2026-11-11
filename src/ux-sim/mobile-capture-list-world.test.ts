import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestAbsorbScrap } from '../intake-plane/items.js';
import { handleScraps } from '../nexus/api/scraps.js';
import { routeRequest, type NexusHttpServerOpts } from '../nexus/api/http-server.js';
import { createMembersApi } from '../nexus/members/members-api.js';
import { createMemberStore } from '../nexus/members/member-store.js';
import { createFakeAndroidApiClient } from './fake-android-client.js';

function seed(root: string, memberId: string): void {
  for (const [kind, text, createdAt] of [
    ['text', '강의 메모', '2026-11-10T03:00:00.000Z'],
    ['voice', '녹음한 강의', '2026-11-10T02:00:00.000Z'],
    ['web', '검색한 기사', '2026-11-10T01:00:00.000Z'],
  ] as const) {
    ingestAbsorbScrap(root, {
      schema: 'absorb/v0', memberId, kind, source: 'android-share',
      raw: kind === 'voice' ? { text, mediaRef: `${memberId}/scraps/lecture.m4a`, mime: 'audio/mp4' }
        : kind === 'web' ? { text, url: 'https://example.test/lecture' } : { text },
      status: 'absorbed', createdAt,
    }, `capture-${kind}-001`, createdAt);
  }
}

test('Android world reads the complete owner-scoped scraps list for local filters', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mobile-capture-list-'));
  try {
    seed(root, 'member-a');
    seed(root, 'member-b');
    const android = createFakeAndroidApiClient((request) => handleScraps(request, {
      instanceRoot: root, extractors: {} as never,
      resolveOwner: async (candidate) => candidate.headers.get('authorization') === 'Bearer aps_member-a'
        ? { memberId: 'member-a' } : candidate.headers.get('authorization') === 'Bearer aps_member-b'
          ? { memberId: 'member-b' } : null,
    }));
    const own = await android.request({ method: 'GET', path: '/v1/scraps', bearer: 'aps_member-a' });
    expect(own.status).toBe(200);
    const rows = (own.body as { scraps: Array<{ kind: string; memberId: string; raw: { text?: string } }> }).scraps;
    expect(rows.map((item) => item.kind).sort()).toEqual(['text', 'voice', 'web']);
    expect(rows.every((item) => item.memberId === 'member-a')).toBe(true);
    expect(rows.filter((item) => item.kind === 'voice').map((item) => item.raw.text)).toEqual(['녹음한 강의']);
    const denied = await android.request({ method: 'GET', path: '/v1/scraps' });
    expect(denied.status).toBe(401);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('actual Nexus route requires a verified member session for the Android list source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mobile-capture-route-'));
  const store = createMemberStore({ path: join(root, 'members.sqlite') });
  try {
    const member = store.register({ sub: 'capture-owner', email: 'capture@example.test', emailVerified: true, name: 'Capture Owner' },
      { consents: { privacy: 'v1', terms: 'v1' } });
    const session = store.createSession(member.id);
    seed(root, member.id);
    const membersApi = createMembersApi({ store,
      google: { redirectUri: 'https://example.test/v1/members/oauth/google/callback',
        // 출처: .rules/30-harness/testing-gates.md R-TST36; 이 미호출 OAuth fixture의 0은 동작 임계값이 아니다.
        start: async () => ({ authorizationUrl: 'https://accounts.example.test', state: 'unused', cookieValue: 'unused', maxAgeSeconds: 0 }),
        complete: async () => { throw new Error('unused'); } },
      successRedirectUri: 'https://example.test/signup/complete',
    });
    const opts = { metaApi: { noAuth: true }, membersApi, scraps: { instanceRoot: root, extractors: {} } } as unknown as NexusHttpServerOpts;
    const authenticated = await routeRequest(new Request('http://nexus.test/v1/scraps', {
      headers: { cookie: `__Host-elanous_member_session=${encodeURIComponent(session.token)}` },
    }), opts, {} as never, null, {} as never);
    expect(authenticated?.status).toBe(200);
    expect((await authenticated!.json() as { scraps: Array<{ memberId: string }> }).scraps)
      .toHaveLength(3);
    const denied = await routeRequest(new Request('http://nexus.test/v1/scraps'), opts, {} as never, null, {} as never);
    expect(denied?.status).toBe(401);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
