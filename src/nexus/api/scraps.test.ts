import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleScraps } from './scraps.js';
import type { ScrapsRouteOptions } from './scraps.js';
import { routeRequest, type NexusHttpServerOpts } from './http-server.js';
import { createMembersApi } from '../members/members-api.js';
import { createMemberStore } from '../members/member-store.js';

// Source: endpoint returns HTTP 201 on first acceptance.
const CREATED = 201;
// Source: endpoint returns HTTP 200 for an idempotent replay.
const REPLAYED = 200;
// Source: invalid request payloads return HTTP 400.
const BAD_REQUEST = 400;
// Source: missing or invalid verified member session returns HTTP 401.
const UNAUTHORIZED = 401;
// Source: extraction failures are surfaced as HTTP 502 by the scraps route.
const BAD_GATEWAY = 502;
// Source: reusing a key for a different payload returns HTTP 409.
const CONFLICT = 409;
// Source: the intake contract currently defines seven supported scrap kinds.
const SCRAP_KIND_COUNT = 7;
// Source: Nexus route tests open isolated SQLite stores and are run on shared gate pods.
const ROUTE_TEST_TIMEOUT_MS = 60_000;
setDefaultTimeout(ROUTE_TEST_TIMEOUT_MS);
const idempotencyHeaders = (key = 'request-0001') => ({ 'content-type': 'application/json', 'idempotency-key': key });

function world() {
  const instanceRoot = mkdtempSync(join(tmpdir(), 'absorb-scraps-'));
  const options: ScrapsRouteOptions = {
    instanceRoot,
    resolveOwner: async () => ({ memberId: 'member-a' }),
    extractors: {
      digestWeb: async url => ({ title: 'Article', body: 'First point. Second point.', }),
      digestX: async url => ({ title: 'Post', body: 'X text', author: 'author' }),
      youtubeTranscript: async () => ({ title: 'Video', transcript: 'Transcript text' }),
      transcribeAudio: async () => 'Voice transcript',
      extractVideoAudio: async () => 'member-a/scraps/extracted-audio',
      transcribeVideoAudio: async () => 'Video transcript',
      ocrPhoto: async () => 'Photo words',
    },
    now: () => new Date('2026-11-09T00:00:00.000Z'),
  };
  return { instanceRoot, options, close: () => rmSync(instanceRoot, { recursive: true, force: true }) };
}

describe('ABSORB /v1/scraps', () => {
  test('stores all seven kinds in the intake ledger and returns summary cards', async () => {
    const fixture = world();
    try {
      const cases = [
        { kind: 'text', source: 'flutter-share', raw: { text: 'A note about lecture capture' } },
        { kind: 'web', source: 'android-share', raw: { url: 'https://example.test/a' } },
        { kind: 'x', source: 'telegram', raw: { url: 'https://x.com/someone/status/1' } },
        { kind: 'youtube', source: 'pwa', raw: { url: 'https://youtube.com/watch?v=abcdefghijk' } },
        { kind: 'voice', source: 'android-record', raw: { mediaRef: 'scraps/voice-1' } },
        { kind: 'video', source: 'android-share', raw: { mediaRef: 'scraps/video-1' } },
        { kind: 'photo', source: 'android-share', raw: { mediaRef: 'scraps/photo-1' } },
      ];
      for (const input of cases) {
        const response = await handleScraps(new Request('http://nexus.test/v1/scraps', { method: 'POST', headers: idempotencyHeaders(`request-${input.kind}-0001`), body: JSON.stringify({ ...input, memberId: 'attacker' }) }), fixture.options);
        expect(response.status).toBe(CREATED);
        const result = await response.json() as { memberId: string; kind: string; source: string; status: string; card: { title: string; points: [string, ...string[]] } };
        expect(result.memberId).toBe('member-a');
        expect(result.kind).toBe(input.kind);
        expect(result.source).toBe(input.source);
        expect(result.status).toBe('absorbed');
        expect(result.card.title).toBeTruthy();
        expect(result.card.points[0]).toBeTruthy();
      }
      const read = await handleScraps(new Request('http://nexus.test/v1/scraps'), fixture.options);
      expect((await read.json() as { scraps: unknown[] }).scraps).toHaveLength(SCRAP_KIND_COUNT);
    } finally { fixture.close(); }
  });

  test('uses member session identity, rejects foreign media references, and reports extractor failure', async () => {
    const fixture = world();
    try {
      const foreignMedia = await handleScraps(new Request('http://nexus.test/v1/scraps', { method: 'POST', headers: idempotencyHeaders(), body: JSON.stringify({ kind: 'voice', source: 'android-record', raw: { mediaRef: 'member-b/scraps/a' } }) }), fixture.options);
      expect(foreignMedia.status).toBe(BAD_REQUEST);
      const denied = await handleScraps(new Request('http://nexus.test/v1/scraps'), { ...fixture.options, resolveOwner: async () => null });
      expect(denied.status).toBe(UNAUTHORIZED);
      const failing = await handleScraps(new Request('http://nexus.test/v1/scraps', { method: 'POST', headers: idempotencyHeaders(), body: JSON.stringify({ kind: 'photo', source: 'android-share', raw: { mediaRef: 'scraps/photo-fail' } }) }), { ...fixture.options, extractors: { ...fixture.options.extractors, ocrPhoto: async () => { throw new Error('simulated OCR outage'); } } });
      expect(failing.status).toBe(BAD_GATEWAY);
      expect((await failing.json() as { failure: { stage: string } }).failure.stage).toBe('extract');
      const replayedFailure = await handleScraps(new Request('http://nexus.test/v1/scraps', { method: 'POST', headers: idempotencyHeaders(), body: JSON.stringify({ kind: 'photo', source: 'android-share', raw: { mediaRef: 'scraps/photo-fail' } }) }), { ...fixture.options, extractors: { ...fixture.options.extractors, ocrPhoto: async () => { throw new Error('simulated OCR outage'); } } });
      expect(replayedFailure.status).toBe(BAD_GATEWAY);
      expect((await replayedFailure.json() as { status: string }).status).toBe('failed');
    } finally { fixture.close(); }
  });

  test('keeps distinct kinds and full text bodies as separate intake records', async () => {
    const fixture = world();
    try {
      const sameUrl = 'https://example.test/shared';
      const web = await handleScraps(new Request('http://nexus.test/v1/scraps', { method: 'POST', headers: idempotencyHeaders('same-url-web-001'), body: JSON.stringify({ kind: 'web', source: 'pwa', raw: { url: sameUrl } }) }), fixture.options);
      const x = await handleScraps(new Request('http://nexus.test/v1/scraps', { method: 'POST', headers: idempotencyHeaders('same-url-x-0001'), body: JSON.stringify({ kind: 'x', source: 'pwa', raw: { url: sameUrl } }) }), fixture.options);
      expect((await web.json() as { id: string }).id).not.toBe((await x.json() as { id: string }).id);
      const prefix = 'a'.repeat(200);
      const longA = await handleScraps(new Request('http://nexus.test/v1/scraps', { method: 'POST', headers: idempotencyHeaders('long-text-a-001'), body: JSON.stringify({ kind: 'text', source: 'pwa', raw: { text: `${prefix}A` } }) }), fixture.options);
      const longB = await handleScraps(new Request('http://nexus.test/v1/scraps', { method: 'POST', headers: idempotencyHeaders('long-text-b-001'), body: JSON.stringify({ kind: 'text', source: 'pwa', raw: { text: `${prefix}B` } }) }), fixture.options);
      expect((await longA.json() as { id: string }).id).not.toBe((await longB.json() as { id: string }).id);
    } finally { fixture.close(); }
  });

  test('preserves an optional voice timeline and keeps legacy scraps unchanged when it is absent', async () => {
    const fixture = world();
    try {
      const legacy = await handleScraps(new Request('http://nexus.test/v1/scraps', {
        method: 'POST', headers: idempotencyHeaders('timeline-legacy-0001'),
        body: JSON.stringify({ kind: 'voice', source: 'android-record', raw: { mediaRef: 'scraps/legacy-audio', mime: 'audio/m4a' } }),
      }), fixture.options);
      expect(legacy.status).toBe(CREATED);
      const legacyResult = await legacy.json() as { id: string; source: string };
      expect(legacyResult.source).toBe('android-record');
      const legacyList = await handleScraps(new Request('http://nexus.test/v1/scraps'), fixture.options);
      const legacyScraps = (await legacyList.json() as { scraps: { id: string; raw: { timeline?: unknown } }[] }).scraps;
      expect(legacyScraps.find(scrap => scrap.id === legacyResult.id)?.raw.timeline).toBeUndefined();

      const timeline = [
        { t: 1_250, kind: 'photo', mediaRef: 'scraps/timeline-note-0001/timeline/0.jpg', mime: 'image/jpeg' },
        { t: 3_000, kind: 'video', mediaRef: 'scraps/timeline-note-0001/timeline/1.mp4', mime: 'video/quicktime' },
      ];
      const response = await handleScraps(new Request('http://nexus.test/v1/scraps', {
        method: 'POST', headers: idempotencyHeaders('timeline-note-0001'),
        body: JSON.stringify({ kind: 'voice', source: 'flutter-record', raw: { mediaRef: 'scraps/audio-1', mime: 'audio/m4a', timeline } }),
      }), fixture.options);
      expect(response.status).toBe(CREATED);
      const result = await response.json() as { id: string };
      const expectedTimeline = [
        { t: 1_250, kind: 'photo', mediaRef: 'member-a/scraps/timeline-note-0001/timeline/0.jpg', mime: 'image/jpeg' },
        { t: 3_000, kind: 'video', mediaRef: 'member-a/scraps/timeline-note-0001/timeline/1.mp4', mime: 'video/quicktime' },
      ];
      const listed = await handleScraps(new Request('http://nexus.test/v1/scraps'), fixture.options);
      const scraps = (await listed.json() as { scraps: { id: string; raw: { timeline?: unknown } }[] }).scraps;
      expect(scraps.find(scrap => scrap.id === result.id)?.raw.timeline).toEqual(expectedTimeline);

      const emptyTimeline = await handleScraps(new Request('http://nexus.test/v1/scraps', {
        method: 'POST', headers: idempotencyHeaders('timeline-empty-0001'),
        body: JSON.stringify({ kind: 'voice', source: 'android-record', raw: { mediaRef: 'scraps/audio-empty', mime: 'audio/m4a', timeline: [] } }),
      }), fixture.options);
      expect(emptyTimeline.status).toBe(CREATED);
      const emptyResult = await emptyTimeline.json() as { id: string };
      const emptyListed = await handleScraps(new Request('http://nexus.test/v1/scraps'), fixture.options);
      const emptyScraps = (await emptyListed.json() as { scraps: { id: string; raw: { timeline?: unknown } }[] }).scraps;
      expect(emptyScraps.find(scrap => scrap.id === emptyResult.id)?.raw.timeline).toEqual([]);
    } finally { fixture.close(); }
  });

  test('preserves photo and video scraps with mixed media timelines through POST and GET', async () => {
    const fixture = world();
    try {
      for (const [kind, source, id, timeline] of [
        ['photo', 'android-share', 'timeline-photo-root', [{ t: 0, kind: 'photo', mediaRef: 'scraps/photo-main', mime: 'image/jpeg' }, { t: 4, kind: 'video', mediaRef: 'scraps/video-in-photo-note', mime: 'video/quicktime' }]],
        ['video', 'android-share', 'timeline-video-root', [{ t: 0, kind: 'video', mediaRef: 'scraps/video-main', mime: 'video/quicktime' }, { t: 2, kind: 'photo', mediaRef: 'scraps/photo-in-video-note', mime: 'image/png' }]],
      ] as const) {
        const response = await handleScraps(new Request('http://nexus.test/v1/scraps', {
          method: 'POST', headers: idempotencyHeaders(`${id}-key`),
          body: JSON.stringify({ kind, source, raw: { mediaRef: `scraps/${id}`, timeline } }),
        }), fixture.options);
        expect(response.status).toBe(CREATED);
        const created = await response.json() as { id: string };
        const expectedTimeline = timeline.map(entry => ({ ...entry, mediaRef: `member-a/${entry.mediaRef}` }));
        const listed = await handleScraps(new Request('http://nexus.test/v1/scraps'), fixture.options);
        const scraps = (await listed.json() as { scraps: { id: string; raw: { timeline?: unknown } }[] }).scraps;
        expect(scraps.find(scrap => scrap.id === created.id)?.raw.timeline).toEqual(expectedTimeline);
      }
    } finally { fixture.close(); }
  });

  test('rejects malformed note timeline items', async () => {
    const fixture = world();
    try {
      const invalidTimelines: unknown[] = [
        null,
        [{ t: -1, kind: 'voice', mediaRef: 'scraps/audio', mime: 'audio/m4a' }],
        [{ t: 0, kind: 'audio', mediaRef: 'scraps/audio', mime: 'audio/m4a' }],
        [{ t: 0, kind: 'voice', mediaRef: 'scraps/foreign/path', mime: 'audio/m4a' }],
        [{ t: 0, kind: 'voice', mediaRef: 'scraps/note/timeline/arbitrary', mime: 'audio/m4a' }],
        [{ t: 0, kind: 'voice', mediaRef: 'scraps/note/timeline/128.m4a', mime: 'audio/m4a' }],
        [{ t: 0, kind: 'voice', mediaRef: 'scraps/note/timeline/0.m4a/extra', mime: 'audio/m4a' }],
        [{ t: 0, kind: 'voice', mediaRef: 'scraps/audio', mime: 'text/plain' }],
      ];
      for (const [index, timeline] of invalidTimelines.entries()) {
        const response = await handleScraps(new Request('http://nexus.test/v1/scraps', {
          method: 'POST', headers: idempotencyHeaders(`timeline-invalid-${index.toString().padStart(4, '0')}`),
          body: JSON.stringify({ kind: 'voice', source: 'android-record', raw: { mediaRef: 'scraps/audio', mime: 'audio/m4a', timeline } }),
        }), fixture.options);
        expect(response.status).toBe(BAD_REQUEST);
      }
    } finally { fixture.close(); }
  });

  test('requires idempotency keys, replays identical requests, rejects key reuse, and stores member-scoped media refs', async () => {
    const fixture = world();
    try {
      const body = JSON.stringify({ kind: 'photo', source: 'android-share', raw: { mediaRef: 'scraps/photo-idem' } });
      const first = await handleScraps(new Request('http://nexus.test/v1/scraps', { method: 'POST', headers: idempotencyHeaders(), body }), fixture.options);
      expect(first.status).toBe(CREATED);
      const firstResult = await first.json() as { id: string; raw: { mediaRef: string } };
      expect(firstResult.raw.mediaRef).toBe('member-a/scraps/photo-idem');
      const replay = await handleScraps(new Request('http://nexus.test/v1/scraps', { method: 'POST', headers: idempotencyHeaders(), body }), fixture.options);
      expect(replay.status).toBe(REPLAYED);
      expect((await replay.json() as { id: string }).id).toBe(firstResult.id);
      const conflict = await handleScraps(new Request('http://nexus.test/v1/scraps', { method: 'POST', headers: idempotencyHeaders(), body: JSON.stringify({ kind: 'text', source: 'tui', raw: { text: 'different request' } }) }), fixture.options);
      expect(conflict.status).toBe(CONFLICT);
      const missingKey = await handleScraps(new Request('http://nexus.test/v1/scraps', { method: 'POST', body }), fixture.options);
      expect(missingKey.status).toBe(BAD_REQUEST);
    } finally { fixture.close(); }
  });

  test('routes scraps through the verified member session before assigning member scope', async () => {
    const fixture = world();
    const store = createMemberStore({ path: join(fixture.instanceRoot, 'members.sqlite') });
    const member = store.register({ sub: 'google-subject', email: 'owner@example.test', emailVerified: true, name: 'Owner' }, { consents: { privacy: 'v1', terms: 'v1' } });
    const appSessionToken = 'aps_verified-owner-session';
    const membersApi = createMembersApi({
      store,
      // Source: #36106 — the unused OAuth-start stub stays inert in this verified-owner route simulation.
      google: { redirectUri: 'https://example.test/v1/members/oauth/google/callback', start: async () => ({ authorizationUrl: 'https://accounts.example.test', state: 'unused', cookieValue: 'unused', maxAgeSeconds: 0 }), complete: async () => { throw new Error('unused'); } },
      successRedirectUri: 'https://example.test/signup/complete',
      resolveVerifiedMemberOwner: credential => credential === appSessionToken ? { memberId: member.id, userSlug: 'owner', plan: 'free', entitlements: {} } : null,
    });
    const opts = { ...({ metaApi: { noAuth: true }, membersApi, scraps: fixture.options } as unknown as NexusHttpServerOpts) };
    try {
      const response = await routeRequest(new Request('http://nexus.test/v1/scraps', {
        method: 'POST', headers: { authorization: `Bearer ${appSessionToken}`, ...idempotencyHeaders('route-request-0001') },
        body: JSON.stringify({ kind: 'text', source: 'tui', raw: { text: 'Owner note' }, memberId: 'attacker' }),
      }), opts, {} as never, null, {} as never);
      expect(response?.status).toBe(CREATED);
      expect((await response!.json() as { memberId: string }).memberId).toBe(member.id);
      const folders = await routeRequest(new Request('http://nexus.test/v1/scrap-folders', {
        headers: { authorization: `Bearer ${appSessionToken}` },
      }), opts, {} as never, null, {} as never);
      expect(folders?.status).toBe(200);
      expect(await folders!.json()).toEqual({ folders: [] });
      const voice = await routeRequest(new Request('http://nexus.test/v1/scraps', {
        method: 'POST', headers: { authorization: `Bearer ${appSessionToken}`, ...idempotencyHeaders('route-export-voice-0001') },
        body: JSON.stringify({ kind: 'voice', source: 'android-record', raw: { mediaRef: 'scraps/route-voice' } }),
      }), opts, {} as never, null, {} as never);
      expect(voice?.status).toBe(CREATED);
      const voiceId = (await voice!.json() as { id: string }).id;
      let exportWrites = 0;
      fixture.options.writeVaultFile = async () => { exportWrites++; return Response.json({ ok: true }); };
      const exportBody = JSON.stringify({ vaultId: 'configured', vaultRelativeFolder: 'Lectures' });
      const authorizedExport = await routeRequest(new Request(`http://nexus.test/v1/scraps/${voiceId}/export`, {
        method: 'POST', headers: { authorization: `Bearer ${appSessionToken}`, 'content-type': 'application/json' }, body: exportBody,
      }), opts, {} as never, null, {} as never);
      expect(authorizedExport?.status).toBe(CREATED);
      const deniedExport = await routeRequest(new Request(`http://nexus.test/v1/scraps/${voiceId}/export`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: exportBody,
      }), opts, {} as never, null, {} as never);
      expect(deniedExport?.status).toBe(UNAUTHORIZED);
      expect(exportWrites).toBe(1);
      const deniedFolders = await routeRequest(new Request('http://nexus.test/v1/scrap-folders'),
        opts, {} as never, null, {} as never);
      expect(deniedFolders?.status).toBe(UNAUTHORIZED);
      const denied = await routeRequest(new Request('http://nexus.test/v1/scraps', {
        method: 'POST', headers: { ...idempotencyHeaders('route-request-0002') }, body: JSON.stringify({ kind: 'text', source: 'tui', raw: { text: 'No bearer' } }),
      }), opts, {} as never, null, {} as never);
      expect(denied?.status).toBe(UNAUTHORIZED);
    } finally { store.close(); fixture.close(); }
  });

  test('routes scraps through the server-validated member session cookie without appSlug', async () => {
    const fixture = world();
    const store = createMemberStore({ path: join(fixture.instanceRoot, 'member-cookie.sqlite') });
    const member = store.register({ sub: 'cookie-subject', email: 'cookie@example.test', emailVerified: true, name: 'Cookie Owner' }, { consents: { privacy: 'v1', terms: 'v1' } });
    const session = store.createSession(member.id);
    const membersApi = createMembersApi({
      store,
      // Source: #36106 — the unused OAuth-start stub stays inert in this verified-member route simulation.
      google: { redirectUri: 'https://example.test/v1/members/oauth/google/callback', start: async () => ({ authorizationUrl: 'https://accounts.example.test', state: 'unused', cookieValue: 'unused', maxAgeSeconds: 0 }), complete: async () => { throw new Error('unused'); } },
      successRedirectUri: 'https://example.test/signup/complete',
    });
    const opts = { metaApi: { noAuth: true }, membersApi, scraps: fixture.options } as unknown as NexusHttpServerOpts;
    try {
      const response = await routeRequest(new Request('http://nexus.test/v1/scraps', {
        method: 'POST', headers: { cookie: `__Host-elanous_member_session=${encodeURIComponent(session.token)}`, ...idempotencyHeaders('member-cookie-001') },
        body: JSON.stringify({ kind: 'text', source: 'pwa', raw: { text: 'Cookie-authenticated member note' } }),
      }), opts, {} as never, null, {} as never);
      expect(response?.status).toBe(CREATED);
      expect((await response!.json() as { memberId: string }).memberId).toBe(member.id);
    } finally { store.close(); fixture.close(); }
  });
});
