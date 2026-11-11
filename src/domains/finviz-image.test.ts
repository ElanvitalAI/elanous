import { test, expect, describe, spyOn } from 'bun:test';
import { captureFinvizMapImageUrl } from './finviz-image.js';

describe('captureFinvizMapImageUrl', () => {
  test('키 없음 → null(스킵)', async () => {
    expect(await captureFinvizMapImageUrl(undefined)).toBeNull();
    expect(await captureFinvizMapImageUrl('   ')).toBeNull();
  });

  test('fetcher 성공 → PNG URL', async () => {
    const url = await captureFinvizMapImageUrl('key', async (k, u) => {
      expect(k).toBe('key');
      expect(u).toContain('finviz.com/map');
      return 'https://storage.googleapis.com/firecrawl/shot.png';
    });
    expect(url).toContain('shot.png');
  });

  test('fetcher 실패(throw/null) → null(fail-soft)', async () => {
    expect(await captureFinvizMapImageUrl('key', async () => { throw new Error('firecrawl down'); })).toBeNull();
    expect(await captureFinvizMapImageUrl('key', async () => null)).toBeNull();
  });

  // 회귀 가드(2026-07-09) — firecrawl v2 기본 2일 캐시로 stale 히트맵 발송된 사건.
  // 기본 fetcher가 반드시 maxAge:0(캐시 무시·fresh)로 호출해야 함.
  test('기본 fetch 요청이 screenshot을 강제 새로 받아 오래된 캐시를 쓰지 않는다', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetcher = spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ success: true, data: { screenshot: 'https://example.test/fresh.png' } });
    });
    try {
      expect(await captureFinvizMapImageUrl('scoped-key')).toBe('https://example.test/fresh.png');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toMatchObject({ formats: ['screenshot'], maxAge: 0 }); // Source: 내부 문서 `PLAN-community-buzz-surveillance-2026-07-09` § Firecrawl cache; zero disables stale cache.
    } finally { fetcher.mockRestore(); }
  });
});
