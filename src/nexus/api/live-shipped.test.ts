import { beforeEach, describe, expect, test } from 'bun:test';
import { _resetLiveShippedCacheForTest, handleLiveShipped, slugFromRemote } from './live-shipped.js';

const req = (q = '') => new Request(`http://nexus.test/v1/live/shipped${q}`);
const now = Date.parse('2026-09-28T01:10:30.000Z');

describe('GET /v1/live/shipped — SHIPPED = GitHub 병합 PR 수', () => {
  beforeEach(() => _resetLiveShippedCacheForTest());

  test('owner only · counts merged PRs since the window start (minute-floored) · caches 60s', async () => {
    expect((await handleLiveShipped(req(), { authorize: () => false })).status).toBe(401);
    const calls: string[] = [];
    const deps = { authorize: () => true, now: () => now, repoSlug: async () => 'o/n', countMerged: async (slug: string, since: string) => { calls.push(`${slug} ${since}`); return 157; } };
    const body = await (await handleLiveShipped(req('?since=6h'), deps)).json();
    expect(body).toEqual({ merged: 157, since: '2026-09-27T19:10:00Z', repo: 'o/n', source: 'github' });
    const again = await (await handleLiveShipped(req('?since=6h'), deps)).json() as { cached?: boolean };
    expect(again.cached).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('failures are values, never a fake 0', async () => {
    const noRepo = await (await handleLiveShipped(req(), { authorize: () => true, now: () => now, repoSlug: async () => null })).json();
    expect(noRepo).toMatchObject({ merged: null, reason: 'no-repository' });
    const failed = await (await handleLiveShipped(req(), { authorize: () => true, now: () => now, repoSlug: async () => 'o/n', countMerged: async () => { throw new Error('rate limited'); } })).json();
    expect(failed).toMatchObject({ merged: null, reason: 'gh-failed' });
    expect((await handleLiveShipped(req('?since=nope'), { authorize: () => true })).status).toBe(400);
  });

  test('remote URL → slug', () => {
    expect(slugFromRemote('git@github.com:ElanvitalAI/elanous.git\n')).toBe('ElanvitalAI/elanous');
    expect(slugFromRemote('https://github.com/o/n')).toBe('o/n');
    expect(slugFromRemote('https://gitlab.com/o/n')).toBeNull();
  });
});
