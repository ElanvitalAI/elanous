import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAbsorbBriefingsAppRoute, createAbsorbBriefingRepository, createBriefingsApi, type BriefingApiRecord } from './briefings-api.js';

const record: BriefingApiRecord = { id: 'brief-a', memberId: 'member-a', day: '2026-11-09', topics: [{ title: '학습', scrapIds: ['s-text', 's-web', 's-x', 's-youtube', 's-voice', 's-video', 's-photo'], summary: '요약' }], todos: [], suggestionIds: [], createdAt: '2026-11-09T00:00:00.000Z' };

describe('owner-scoped briefings API', () => {
  const api = createBriefingsApi({ ownerForRequest: () => 'member-a', getByDay: (owner, day) => owner === record.memberId && day === record.day ? record : null, getById: (owner, id) => owner === record.memberId && id === record.id ? record : null });
  test('serves requested day and detail for the authenticated owner', async () => {
    const byDay = (await api(new Request('http://nexus/v1/briefings?day=2026-11-09')))!;
    const byId = (await api(new Request('http://nexus/v1/briefings/brief-a')))!;
    expect((await byDay.json()).briefings.map((briefing: BriefingApiRecord) => briefing.id)).toEqual(['brief-a']);
    expect((await byId.json()).memberId).toBe('member-a');
  });
  test('ignores caller memberId and prevents cross-owner reads', async () => {
    const privateApi = createBriefingsApi({ ownerForRequest: () => 'member-b', getByDay: () => record, getById: () => record });
    const response = (await privateApi(new Request('http://nexus/v1/briefings/brief-a?memberId=member-a')))!;
    expect(response.status).toBe(404);
  });
  test('rejects unauthenticated or malformed day requests', async () => {
    const unauth = createBriefingsApi({ ownerForRequest: () => null, getByDay: () => record, getById: () => record });
    const unauthorized = (await unauth(new Request('http://nexus/v1/briefings/brief-a')))!;
    const malformed = (await api(new Request('http://nexus/v1/briefings?day=tomorrow')))!;
    expect(unauthorized.status).toBe(401);
    expect(malformed.status).toBe(400);
  });

  test('reads ABSORB-2 JSONL records through the registered appRoute and scopes by session owner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'briefings-api-'));
    try {
      mkdirSync(join(root, 'intake'), { recursive: true });
      writeFileSync(join(root, 'intake', 'absorb-brief.jsonl'), [
        JSON.stringify({ ...record, trigger: 'daily', llm: { provider: 'none' } }),
        JSON.stringify({ ...record, id: 'brief-b', memberId: 'member-b', trigger: 'daily', llm: { provider: 'none' } }),
        JSON.stringify({ id: 'suggest-1', memberId: 'member-a', briefingId: 'brief-a', appId: 'app-a', title: 'suggestion', evidenceScrapIds: ['photo-1'], state: 'proposed' }),
        '{bad json',
      ].join('\n'));
      const repository = createAbsorbBriefingRepository(root);
      expect(repository.getByDay('member-a', record.day)?.id).toBe('brief-a');
      const route = createAbsorbBriefingsAppRoute({ root, ownerForRequest: (request) => request.headers.get('x-session-owner') });
      const own = await route(new Request('http://nexus/v1/briefings/brief-a', { headers: { 'x-session-owner': 'member-a' } }));
      const cross = await route(new Request('http://nexus/v1/briefings/brief-b', { headers: { 'x-session-owner': 'member-a' } }));
      expect(own?.status).toBe(200);
      expect(cross?.status).toBe(404);
      expect((await own?.json() as BriefingApiRecord).memberId).toBe('member-a');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
