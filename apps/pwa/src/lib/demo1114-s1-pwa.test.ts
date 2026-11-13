import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleScraps } from '../../../../src/nexus/api/scraps';
import { saveSharedScraps, type SavedScrapReceipt, type ShareFetch } from './share-scraps';
import type { SharedPayload } from './share-target-store';

test('Scene 1 shared article saves once and reopens with the same member-scoped ID', async () => {
  const instanceRoot = mkdtempSync(join(tmpdir(), 'demo1114-s1-pwa-'));
  const payload: SharedPayload = {
    id: 'scene1-share', title: '축제·콘서트 티켓 대란, 접속 폭주로 예매 실패',
    text: '동시 접속·중복 예매·공정 대기열 검토', url: 'https://example.test/ticket-rush',
    files: [], fileKeys: [], combinedText: '',
  };
  const methods: string[] = [];
  const receipts: SavedScrapReceipt[] = [];
  const options = {
    instanceRoot,
    resolveOwner: async () => ({ memberId: 'member-scene1' }),
    extractors: { digestWeb: async () => ({ title: payload.title, body: payload.text }) },
  };
  const fetcher: ShareFetch = async (input, init) => {
    const request = new Request(String(input), init);
    if (new URL(request.url).pathname === '/v1/members') return Response.json({ member: { id: 'member-scene1' } });
    methods.push(request.method);
    return handleScraps(request, options);
  };
  try {
    const result = await saveSharedScraps(payload, {
      baseUrl: 'https://nexus.example.test', fetcher,
      onSaved: (_key, receipt) => { receipts.push(receipt); },
    });
    expect(result).toEqual({ saved: ['링크'], failed: [] });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ kind: 'web', raw: { text: expect.stringContaining(payload.title), url: payload.url } });
    const reopened = await fetcher(new URL('https://nexus.example.test/v1/scraps'), { credentials: 'include' });
    expect(reopened.status).toBe(200);
    const list = await reopened.json() as { scraps: Array<{ id: string; raw: { text: string; url: string } }> };
    expect(list.scraps).toHaveLength(1);
    expect(list.scraps[0]).toMatchObject({ id: receipts[0]?.id, raw: { text: expect.stringContaining(payload.title), url: payload.url } });
    expect(methods).toEqual(['POST', 'GET']);
  } finally {
    rmSync(instanceRoot, { recursive: true, force: true });
  }
});
