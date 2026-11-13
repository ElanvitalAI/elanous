import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleScraps, type ScrapsRouteOptions } from '../nexus/api/scraps.js';

const root = mkdtempSync(join(tmpdir(), 'voice-note-folder-world-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('recording date, timeline and logical folder survive member-scoped API reload', async () => {
  const options: ScrapsRouteOptions = {
    instanceRoot: root,
    resolveOwner: async () => ({ memberId: 'member-a' }),
    extractors: { transcribeAudio: async () => '강의 전사' },
    now: () => new Date('2026-11-12T02:00:00.000Z'),
  };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => handleScraps(new Request(`http://nexus.test${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  }), options);
  const folder = await post('/v1/scrap-folders', { name: '강의록' });
  expect(folder.status).toBe(201);
  const { id: folderId } = await folder.json() as { id: string };
  const note = await post('/v1/scraps', { kind: 'voice', source: 'android-record', folderId,
    raw: { text: '강의 요약', mediaRef: 'scraps/lecture-audio', mime: 'audio/mp4',
      recordedAt: '2026-11-11T15:30:00.000Z', recordedTimeZone: 'Asia/Seoul',
      timeline: [{ t: 0, kind: 'voice', mediaRef: 'scraps/lecture-audio', mime: 'audio/mp4' },
        { t: 1200, kind: 'photo', mediaRef: 'scraps/lecture-photo', mime: 'image/jpeg' },
        { t: 1800, kind: 'marker', label: '중요' }] } },
    { 'idempotency-key': 'voice-world-0001' });
  expect(note.status).toBe(201);
  const saved = await note.json() as { id: string; raw: { recordedDate: string; timeline: unknown[] }; folderId: string };
  expect(saved).toMatchObject({ folderId, raw: { recordedDate: '2026-11-12' } });
  expect(saved.raw.timeline).toHaveLength(3);
  const listed = await handleScraps(new Request('http://nexus.test/v1/scraps'), options);
  expect((await listed.json() as { scraps: { id: string; folderId: string }[] }).scraps.find(item => item.id === saved.id)?.folderId).toBe(folderId);
  const foreign = await handleScraps(new Request('http://nexus.test/v1/scrap-folders'), {
    ...options, resolveOwner: async () => ({ memberId: 'member-b' }),
  });
  expect(await foreign.json()).toEqual({ folders: [] });
  const move = await handleScraps(new Request(`http://nexus.test/v1/scraps/${saved.id}/folder`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folderId: null }),
  }), options);
  expect(move.status).toBe(200);
  expect(await move.json()).toMatchObject({ folderId: null, raw: { timeline: saved.raw.timeline } });
  const foreignMove = await handleScraps(new Request(`http://nexus.test/v1/scraps/${saved.id}/folder`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folderId }),
  }), { ...options, resolveOwner: async () => ({ memberId: 'member-b' }) });
  expect(foreignMove.status).toBe(404);
  const classDate = await handleScraps(new Request(`http://nexus.test/v1/scraps/${saved.id}/class-date`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ classDate: '2026-11-10' }),
  }), options);
  expect(classDate.status).toBe(200);
  expect(await classDate.json()).toMatchObject({ raw: { recordedDate: '2026-11-12', classDate: '2026-11-10' } });
  const invalidDate = await handleScraps(new Request(`http://nexus.test/v1/scraps/${saved.id}/class-date`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ classDate: '2026-02-30' }),
  }), options);
  expect(invalidDate.status).toBe(400);
});
