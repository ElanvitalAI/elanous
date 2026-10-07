import { expect, test } from 'bun:test';
import { decide, listOpenDecisions } from './decisions-api';

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

test('list and decide expose status on failed reads/writes', async () => {
  const client = { fetchResponse: async () => json({ error: 'failure' }, 409) };
  expect(listOpenDecisions(client)).rejects.toThrow('decisions list failed: 409');
  expect(decide(client, 'id', 'a')).rejects.toThrow('decision failed: 409');
});
