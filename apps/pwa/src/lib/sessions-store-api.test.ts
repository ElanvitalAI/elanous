/**
 * SessionsStoreApi.fork wire 계약 (PWA 파리티 P2 · 2026-07-12).
 *
 * beforeUser 유무에 따른 POST body 구성만 검증 — 서버측 파싱/검증은
 * `src/nexus/api/sessions-store.test.ts` 소관.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { DaemonClient } from './daemon-client';
import { SessionsStoreApi, resolveSessionPrefix } from './sessions-store-api';
import { createFakeFetchDevice, type FakeFetchDevice } from '../test-devices/fake-fetch';

interface FetchCall { url: string; method?: string; body?: string; contentType?: string }

let calls: FetchCall[] = [];
let fakeFetch: FakeFetchDevice | undefined;

beforeEach(() => {
  calls = [];
  fakeFetch = createFakeFetchDevice([{
    url: '/v1/sessions/store/abc/fork',
    method: 'POST',
    response: (request) => {
      const headers = new Headers(request.headers);
    calls.push({
      url: request.url,
      method: request.method,
      body: request.body ?? undefined,
      contentType: headers.get('content-type') ?? undefined,
    });
      return Response.json({ ok: true, id: 'forked-id' });
    },
  }]);
});
afterEach(() => { fakeFetch?.restore(); fakeFetch = undefined; });

function makeApi(): SessionsStoreApi {
  return new SessionsStoreApi(new DaemonClient({
    baseUrl: 'http://localhost:31415',
    token: '',
    provider: 'anthropic',
  }));
}

describe('resolveSessionPrefix — id prefix resolve (P3)', () => {
  const SESSIONS = [
    { id: 'elanous-session-12' },
    { id: 'elanous-session-129' },
    { id: 'http-1752300000-abcd' },
  ];

  it('유일 일치 → one + id (대소문자 무시)', () => {
    expect(resolveSessionPrefix(SESSIONS, 'HTTP-1752')).toEqual({ kind: 'one', id: 'http-1752300000-abcd' });
    expect(resolveSessionPrefix(SESSIONS, 'elanous-session-129')).toEqual({ kind: 'one', id: 'elanous-session-129' });
  });

  it('복수 일치 → ambiguous + count (더 긴 입력 유도)', () => {
    expect(resolveSessionPrefix(SESSIONS, 'elanous-session-12')).toEqual({ kind: 'ambiguous', count: 2 });
  });

  it('0건 / 빈 prefix → none', () => {
    expect(resolveSessionPrefix(SESSIONS, 'ghost')).toEqual({ kind: 'none' });
    expect(resolveSessionPrefix(SESSIONS, '  ')).toEqual({ kind: 'none' });
  });
});

describe('SessionsStoreApi.fork', () => {
  it('beforeUser 생략 → body 없는 풀카피 POST (하위호환)', async () => {
    await makeApi().fork('abc');
    expect(calls[0]!.url).toBe('http://localhost:31415/v1/sessions/store/abc/fork');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toBeUndefined();
  });

  it('beforeUser=N → JSON body + content-type 동봉 (타임트래블)', async () => {
    await makeApi().fork('abc', { beforeUser: 3 });
    expect(calls[0]!.body).toBe(JSON.stringify({ beforeUser: 3 }));
    expect(calls[0]!.contentType).toBe('application/json');
  });
});
