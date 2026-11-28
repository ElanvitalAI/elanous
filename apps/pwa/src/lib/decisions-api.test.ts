import { expect, test } from 'bun:test';
import { decide, listOpenDecisions, listBoardNotices, replyToBoardNotice } from './decisions-api';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test('open decisions retain the expanded card material without altering original fields', async () => {
  const item = { id: 'D-1', title: '결정', situation: '상황', options: [{ id: 'a', label: '진행', consequence: '결과' }],
    recommendation: { option: 'a', why: '이유' }, raisedAt: '2026-10-04T00:00:00Z', dueAt: '2026-10-05T00:00:00Z',
    scqa: { s: '긴 상황'.repeat(60), c: '문제' }, category: 'money', irreversible: true, raisedBy: { agent: 'OP' },
    crossCheckSkipped: '미확인', pendingQuestion: '전체 질문' };
  const client = { fetchResponse: async (path: string) => { expect(path).toBe('/v1/decisions?status=open'); return json({ decisions: [item] }); } };
  expect(await listOpenDecisions(client)).toEqual([item]);
});

test('decide with three args preserves the original request body, optional note is sent only when present', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = { fetchResponse: async (path: string, init?: RequestInit) => { calls.push({ path, init }); return json({ decidedAt: '2026-10-05T00:00:00Z' }); } };
  await decide(client, 'D/1', 'a');
  expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ choice: 'a' });
  expect(calls[0]!.path).toBe('/v1/decisions/D%2F1/decide');
  expect(calls[0]!.init?.method).toBe('POST');
  expect(await decide(client, 'D/1', 'b', '의견')).toEqual({ decidedAt: '2026-10-05T00:00:00Z' });
  expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ choice: 'b', note: '의견' });
});

test('notice transport reads CEO notices and replies to their ID without changing decision requests', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const notice = { id: 7, from: 'TC', to: 'CEO', body: '조율 채널 요약', createdAt: '2026-10-07T00:00:00Z' };
  const client = { fetchResponse: async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return init ? json({ reply: { ...notice, from: 'CEO', to: 'TC', body: '확인' } }, 201) : json({ notices: [notice] });
  } };
  expect(await listBoardNotices(client)).toEqual([notice]);
  expect(await replyToBoardNotice(client, 7, '확인')).toMatchObject({ from: 'CEO', to: 'TC', body: '확인' });
  expect(calls.map(call => call.path)).toEqual(['/v1/ops-board/notices', '/v1/ops-board/notices']);
  expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ noticeId: 7, body: '확인' });
});

test('list and decide expose status on failed reads/writes', async () => {
  const client = { fetchResponse: async () => json({ error: 'failure' }, 409) };
  expect(listOpenDecisions(client)).rejects.toThrow('decisions list failed: 409');
  expect(decide(client, 'id', 'a')).rejects.toThrow('decision failed: 409');
});

test('an irreversible card asks once more (428 confirm token): confirm → second POST carries the token · cancel → nothing decided', async () => {
  for (const answer of [true, false]) {
    const bodies: unknown[] = [];
    const asked: string[] = [];
    const client = { fetchResponse: async (_path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { confirmToken?: string };
      bodies.push(body);
      return body.confirmToken ? json({ decidedAt: '2026-11-28T05:00:00Z' }) : json({ error: 'confirm-required', confirmToken: 'c0ffee', message: 'A) Publish — this cannot be undone. Decide this?' }, 428);
    } };
    const run = decide(client, 'D-20261128-01', 'a', undefined, (message) => { asked.push(message); return answer; });
    if (answer) expect(await run).toEqual({ decidedAt: '2026-11-28T05:00:00Z' });
    else await expect(run).rejects.toThrow('decision cancelled');
    expect(asked).toEqual(['A) Publish — this cannot be undone. Decide this?']);
    expect(bodies).toEqual(answer ? [{ choice: 'a' }, { choice: 'a', confirmToken: 'c0ffee' }] : [{ choice: 'a' }]);
  }
});
