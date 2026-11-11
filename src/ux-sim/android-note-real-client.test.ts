import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAndroidApiClient } from './fake-android-client.js';
import { handleScraps } from '../nexus/api/scraps.js';

interface AndroidNoteFixture {
  method: 'POST';
  path: string;
  authorization: string;
  idempotencyKey: string;
  body: unknown;
}

const fixturePath = process.env.ANDROID_NOTE_BODY_FIXTURE;
const fixtureAvailable = Boolean(fixturePath && existsSync(fixturePath) && statSync(fixturePath).size);

test.skipIf(!fixtureAvailable)('passes the actual Android NoteViewModel request through the real member-scoped scraps API', async () => {
    const fixture = JSON.parse(readFileSync(fixturePath!, 'utf8')) as AndroidNoteFixture;
    expect(fixture.method).toBe('POST');
    expect(fixture.path).toBe('/v1/scraps');
    expect(fixture.authorization).toBe('Bearer aps_member-a');
    expect(fixture.idempotencyKey).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
    const postedRaw = (fixture.body as { raw: { text: string; mediaRef: string; mime: string; timeline: unknown[] } }).raw;
    const noteId = /^scraps\/([^/]+)\/timeline\/0\.m4a$/.exec(postedRaw.mediaRef)?.[1];
    expect(noteId).toBe(fixture.idempotencyKey);

    const instanceRoot = mkdtempSync(join(tmpdir(), 'android-note-real-client-'));
    try {
      const android = createFakeAndroidApiClient((request) => handleScraps(request, {
        instanceRoot,
        resolveOwner: async (candidate) => candidate.headers.get('authorization') === fixture.authorization
          ? { memberId: 'member-a' }
          : candidate.headers.get('authorization') === 'Bearer aps_member-b' ? { memberId: 'member-b' } : null,
        extractors: { transcribeAudio: async () => '강의에서 관측과 판단의 차이를 설명했습니다.' },
        now: () => new Date('2026-11-10T00:00:00.000Z'),
      }));

      const created = await android.request({
        method: fixture.method,
        path: fixture.path,
        bearer: 'aps_member-a',
        idempotencyKey: fixture.idempotencyKey,
        body: fixture.body,
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ status: 'absorbed' });

      const owned = await android.request({ method: 'GET', path: '/v1/scraps', bearer: 'aps_member-a' });
      const scraps = (owned.body as { scraps: Array<{ raw: Record<string, unknown> }> }).scraps;
      expect(scraps).toHaveLength(1);
      expect(scraps[0]?.raw).toMatchObject({
        text: postedRaw.text,
        mediaRef: `member-a/scraps/${noteId}/timeline/0.m4a`,
        mime: 'audio/mp4',
        timeline: [
          { t: 0, kind: 'voice', mediaRef: `member-a/scraps/${noteId}/timeline/0.m4a`, mime: 'audio/mp4' },
          { t: 1_250, kind: 'photo', mediaRef: `member-a/scraps/${noteId}/timeline/1.jpg`, mime: 'image/jpeg' },
        ],
      });

      const foreign = await android.request({ method: 'GET', path: '/v1/scraps', bearer: 'aps_member-b' });
      expect((foreign.body as { scraps: unknown[] }).scraps).toEqual([]);
      expect(android.requests.map(({ method, path }) => [method, path])).toEqual([
        ['POST', '/v1/scraps'], ['GET', '/v1/scraps'], ['GET', '/v1/scraps'],
      ]);
    } finally {
      rmSync(instanceRoot, { recursive: true, force: true });
    }
});
