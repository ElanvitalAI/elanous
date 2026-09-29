import { describe, expect, test } from 'bun:test';
import { createMergeApprovalsApi, MergeApprovalsApiError } from './merge-approvals-api';

function fixture(status = 200, body: unknown = { items: [] }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, api: createMergeApprovalsApi({ baseUrl: 'http://localhost/', authHeader: 'Bearer owner', fetchImpl }) };
}

describe('merge approvals PWA client', () => {
  test('list, direct-link detail and guarded merge call the shared REST path', async () => {
    const f = fixture();
    expect(await f.api.list()).toEqual({ items: [] });
    await f.api.get(9);
    await f.api.merge(9, 'aaa');
    expect(f.calls.map((call) => call.url)).toEqual([
      'http://localhost/v1/approvals/merges', 'http://localhost/v1/approvals/merges/9',
      'http://localhost/v1/approvals/merges/9/merge',
    ]);
    expect(f.calls[2]!.init?.method).toBe('POST');
    expect(JSON.parse(f.calls[2]!.init?.body as string)).toEqual({ headSha: 'aaa' });
    expect((f.calls[2]!.init?.headers as Record<string, string>).authorization).toBe('Bearer owner');
  });

  test('daemon client carries configured owner credentials to the REST endpoint', async () => {
    // 실제 DaemonClient 로 보낸다 — 승인 버튼이 머지를 일으키므로 «소유자 토큰이 실제로 실리는가»를 요청 수신 지점(fetch)에서 본다.
    const { DaemonClient } = await import('./daemon-client');
    const seen: Array<{ url: string; method?: string; headers: Record<string, string>; body?: string }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), method: init?.method, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body as string | undefined });
      return new Response(JSON.stringify({ merged: true, number: 7 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    try {
      const client = new DaemonClient({ baseUrl: 'http://localhost:31415', token: 'owner-token', provider: 'anthropic' });
      const api = createMergeApprovalsApi({ client });
      expect(await api.merge(7, 'aaa')).toEqual({ merged: true, number: 7 });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe('http://localhost:31415/v1/approvals/merges/7/merge');
      expect(seen[0]!.method).toBe('POST');
      expect(seen[0]!.headers.authorization).toBe('Bearer owner-token');
      expect(JSON.parse(seen[0]!.body!)).toEqual({ headSha: 'aaa' });
      // 토큰이 없는 기기에서는 헤더를 지어내지 않는다(서버가 401 로 막고 PWA 가 설정 안내를 띄운다).
      seen.length = 0;
      await createMergeApprovalsApi({ client: new DaemonClient({ baseUrl: 'http://localhost:31415', token: '', provider: 'anthropic' }) }).merge(7, 'aaa');
      expect(seen[0]!.headers.authorization).toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('conflict reason reaches the caller for display', async () => {
    const f = fixture(409, { error: 'head-changed', reason: '본 뒤에 PR 머리가 바뀌었습니다.' });
    try { await f.api.merge(1, 'aaa'); expect.unreachable(); }
    catch (error) {
      expect(error).toBeInstanceOf(MergeApprovalsApiError);
      expect((error as MergeApprovalsApiError).status).toBe(409);
      expect((error as Error).message).toBe('본 뒤에 PR 머리가 바뀌었습니다.');
    }
  });
});

describe('approval error text says the cause and the next step', () => {
  test('401 → missing owner token, with a link to settings', async () => {
    const { approvalErrorText, MergeApprovalsApiError } = await import('./merge-approvals-api');
    const out = approvalErrorText(new MergeApprovalsApiError(401, 'unauthorized'), 'x');
    expect(out.text).toContain('소유자 토큰');
    // Where to get it, not just that it is missing (대표 16:1x — the terminal banner said «붙이면» but not «어디서»).
    expect(out.text).toContain('Connect token');
    expect(out.text).toContain('Bearer token');
    // Plain full-page link to the Bearer token field (the settings panel focuses it on this hash).
    expect(out.href).toBe('/app/settings/#bearer-token');
  });
  test('gh-failed names the daemon side and keeps the first reason line', async () => {
    const { approvalErrorText, MergeApprovalsApiError } = await import('./merge-approvals-api');
    const out = approvalErrorText(new MergeApprovalsApiError(502, 'gh-failed', 'HTTP 502: bad gateway\nmore'), 'x');
    expect(out.text).toContain('GitHub');
    expect(out.text).toContain('HTTP 502: bad gateway');
    expect(out.text).not.toContain('more');
  });
  test('unknown repo points at the config key; network errors say the daemon was unreachable', async () => {
    const { approvalErrorText, MergeApprovalsApiError } = await import('./merge-approvals-api');
    expect(approvalErrorText(new MergeApprovalsApiError(503, 'approvals-repo-unknown'), 'x').text).toContain('intake.approvals.repo');
    expect(approvalErrorText(new TypeError('Failed to fetch'), 'x').text).toContain('데몬에 닿지 못했습니다');
  });
  test('a server reason is shown as is; an unknown code keeps status and code', async () => {
    const { approvalErrorText, MergeApprovalsApiError } = await import('./merge-approvals-api');
    expect(approvalErrorText(new MergeApprovalsApiError(403, 'label-missing', '아이디어 승인 라벨이 없습니다.'), 'x').text).toBe('아이디어 승인 라벨이 없습니다.');
    expect(approvalErrorText(new MergeApprovalsApiError(500, 'boom'), '목록 실패').text).toBe('목록 실패 (500 boom)');
  });
});
