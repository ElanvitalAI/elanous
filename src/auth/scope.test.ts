import { describe, expect, test } from 'bun:test';

import { tokenScopeAllows, type ScopedToken } from './scope.js';

const PUBLIC: ScopedToken = { token: 'public-token', scope: 'mcp-public' };

describe('mcp-public token scope', () => {
  test('permits POST /v1/mcp without a session binding', () => {
    expect(tokenScopeAllows(PUBLIC, { method: 'POST', pathname: '/v1/mcp' })).toEqual({ ok: true });
  });

  test('rejects every other HTTP method on /v1/mcp with mcp_public_scope', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']) {
      expect(tokenScopeAllows(PUBLIC, { method, pathname: '/v1/mcp' })).toEqual({
        ok: false,
        reason: 'mcp_public_scope',
      });
    }
  });

  test('rejects other paths even for POST with mcp_public_scope', () => {
    for (const pathname of [
      '/v1/mcp/',
      '/v1/mcp/tools',
      '/v1/mcp?tool=read',
      '/v1/registry/daemons',
      'mcp',
      '/v1/mcpx',
    ]) {
      expect(tokenScopeAllows(PUBLIC, { method: 'POST', pathname })).toEqual({
        ok: false,
        reason: 'mcp_public_scope',
      });
    }
  });

  test('preserves expiry rejection before the scope grant', () => {
    const expired: ScopedToken = {
      ...PUBLIC,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    };
    expect(tokenScopeAllows(expired, { method: 'POST', pathname: '/v1/mcp' })).toEqual({
      ok: false,
      reason: 'token_expired',
    });
  });

  test('leaves admin, read-only, and session decisions unchanged', () => {
    expect(tokenScopeAllows({ token: 'admin', scope: 'admin' }, {
      method: 'DELETE', pathname: '/v1/registry/daemons/x',
    })).toEqual({ ok: true });
    expect(tokenScopeAllows({ token: 'read', scope: 'read-only' }, {
      method: 'POST', pathname: '/v1/mcp',
    })).toEqual({ ok: false, reason: 'read_only_token' });
    expect(tokenScopeAllows({ token: 'session', scope: 'session', sessionId: 's1' }, {
      method: 'PUT', pathname: '/v1/registry/active-session', targetSessionId: 's2',
    })).toEqual({ ok: false, reason: 'session_mismatch' });
  });
});
