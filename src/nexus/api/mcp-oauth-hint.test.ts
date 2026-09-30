import { describe, expect, it } from 'bun:test';
import { routeRequest, type NexusHttpServerOpts } from './http-server.js';

// 🅢 09-28(대표 승인): Claude Code → HTTP MCP 가 «Dynamic Client Registration rejected (HTTP 405)» 로 멈췄다.
// 토큰 없는 `/v1/mcp` 401 → OAuth 시도 → 기본 `POST /register` → 405. 이제 두 자리가 «할 일»을 말한다.
describe('MCP OAuth 안내 — 실제 라우터', () => {
  const opts = { metaApi: { bearerToken: 'owner-secret' } } as NexusHttpServerOpts;
  const server = { requestIP: () => ({ address: '203.0.113.1' }) } as any;
  const ref = { get: () => null } as any;
  const post = (path: string, headers: Record<string, string> = {}) => new Request(`http://remote.invalid${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
  });

  it('토큰 없는 /v1/mcp 는 401 ⊕ WWW-Authenticate(Bearer · OAuth 안 씀) ⊕ 등록 안내', async () => {
    const res = (await routeRequest(post('/v1/mcp'), opts, server, null, ref))!;
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer realm="elanous"');
    expect(res.headers.get('www-authenticate')).toContain('does not use OAuth');
    const body = await res.json() as { hint?: string };
    expect(body.hint).toContain('elanous mcp serve');
    expect(body.hint).not.toContain('owner-secret');
    // 포트를 짐작하지 않는다 — 요청이 닿은 origin 을 그대로 안내한다.
    expect(body.hint).toContain('http://remote.invalid/v1/mcp');
    expect(body.hint).not.toContain('31415');
  });

  it('OAuth 동적 등록(POST /register)은 405 가 아니라 RFC 7591 오류 ⊕ 할 일', async () => {
    const res = (await routeRequest(post('/register'), opts, server, null, ref))!;
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; error_description: string };
    expect(body.error).toBe('invalid_client_metadata');
    expect(body.error_description).toContain('Authorization');
    expect(body.error_description).toContain('~/.elanous/acp-token');
    expect(body.error_description).toContain('http://remote.invalid/v1/mcp');
  });

  it('다른 경로의 401 은 그대로(안내는 /v1/mcp 에만)', async () => {
    const res = (await routeRequest(post('/v1/tasks'), opts, server, null, ref))!;
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });
});
