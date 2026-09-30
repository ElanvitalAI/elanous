import { expect, test } from 'bun:test';
import { createGraphApprovalsApi, graphApprovalErrorText, GraphApprovalsApiError } from './graph-approvals-api';

test('list and decisions use owner-authenticated graph endpoints', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(init?.method === 'POST' ? { graphId: 'release-loop', runId: 'run-1', decision: 'rejected' } : { items: [] }));
  }) as typeof fetch;
  const api = createGraphApprovalsApi({ baseUrl: 'http://localhost/', fetchImpl, authHeader: 'Bearer owner' });
  expect(await api.list()).toEqual({ items: [] });
  expect(await api.decide('release-loop', 'run-1', 'rejected')).toEqual({ graphId: 'release-loop', runId: 'run-1', decision: 'rejected' });
  expect(calls.map((call) => call.url)).toEqual(['http://localhost/v1/graph-approvals', 'http://localhost/v1/graph-approvals/release-loop/run-1']);
  expect(calls[1]!.init?.method).toBe('POST');
  expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({ decision: 'rejected' });
  expect((calls[1]!.init?.headers as Record<string, string>).authorization).toBe('Bearer owner');
});

test('server error codes map to single user-facing sentences', async () => {
  const unauthorized = new GraphApprovalsApiError(401, 'unauthorized');
  expect(Object.hasOwn(unauthorized, 'code')).toBe(false);
  expect(unauthorized.message).toBe('unauthorized');
  expect(graphApprovalErrorText(unauthorized)).toContain('소유자 인증');
  expect(graphApprovalErrorText(new GraphApprovalsApiError(404, 'not-found'))).toContain('찾지 못했습니다');
  expect(graphApprovalErrorText(new GraphApprovalsApiError(409, 'already-decided'))).toContain('이미 결정된');
  expect(graphApprovalErrorText(new GraphApprovalsApiError(400, 'bad_request'))).toContain('결정 내용');
  expect(graphApprovalErrorText(new TypeError('network'))).toContain('서버에 연결하지 못했습니다');
  const api = createGraphApprovalsApi({ fetchImpl: (async () => new Response('{"error":"already-decided"}', { status: 409 })) as unknown as typeof fetch });
  expect(api.decide('release-loop', 'run', 'approved')).rejects.toBeInstanceOf(GraphApprovalsApiError);
});
