import { expect, test } from 'bun:test';
import { createGraphApprovalsApi, graphApprovalErrorText, GraphApprovalsApiError, needsConnectToken, CONNECT_TOKEN_SETTINGS_HREF } from './graph-approvals-api';

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
  // TXT2 — the pairing sentence names the action and the exact settings field (the link is CONNECT_TOKEN_SETTINGS_HREF).
  expect(graphApprovalErrorText(unauthorized)).toContain('승인하려면 이 기기를 데몬에 연결해야 합니다');
  expect(graphApprovalErrorText(new GraphApprovalsApiError(403, 'pairing-required'), 'save')).toContain('초안을 저장하려면');
  expect(graphApprovalErrorText(new GraphApprovalsApiError(403, 'pairing-required'), 'save')).toContain('설정 › 데몬 연결 › 연결 토큰 칸');
  expect(graphApprovalErrorText(new GraphApprovalsApiError(401, 'unauthorized'), 'list')).toContain('목록을 보려면');
  expect(graphApprovalErrorText(new GraphApprovalsApiError(403, 'pairing-required'))).not.toContain('페어링');
  expect(needsConnectToken(new GraphApprovalsApiError(403, 'pairing-required'))).toBe(true);
  expect(needsConnectToken(new GraphApprovalsApiError(409, 'already-decided'))).toBe(false);
  expect(CONNECT_TOKEN_SETTINGS_HREF).toBe('/app/settings/#bearer-token');
  expect(graphApprovalErrorText(new GraphApprovalsApiError(404, 'not-found'))).toContain('찾지 못했습니다');
  expect(graphApprovalErrorText(new GraphApprovalsApiError(409, 'already-decided'))).toContain('이미 결정된');
  expect(graphApprovalErrorText(new GraphApprovalsApiError(400, 'bad_request'))).toContain('결정 내용');
  expect(graphApprovalErrorText(new TypeError('network'))).toContain('서버에 연결하지 못했습니다');
  const api = createGraphApprovalsApi({ fetchImpl: (async () => new Response('{"error":"already-decided"}', { status: 409 })) as unknown as typeof fetch });
  expect(api.decide('release-loop', 'run', 'approved')).rejects.toBeInstanceOf(GraphApprovalsApiError);
});
