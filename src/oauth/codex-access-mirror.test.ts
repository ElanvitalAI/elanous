import { describe, expect, test } from 'bun:test';
import { createCodexAccessMirror } from './codex-access-mirror.js';

function token(exp: number): string {
  return `header.${Buffer.from(JSON.stringify({ exp }), 'utf8').toString('base64url')}.signature`;
}

describe('createCodexAccessMirror', () => {
  test('keeps the usable access token and clears refresh authority in both deployed files', () => {
    const accessToken = token(1_800_000_000);
    const mirror = createCodexAccessMirror({ account: 'team', store: {
      version: 4,
      providers: { 'openai-codex:team': { tokens: { accessToken: 'old', refreshToken: 'secret', expiresAt: 1 }, authMode: 'oauth', lastRefresh: 'yesterday' } },
    }, codexAuth: { auth_mode: 'chatgpt', tokens: { access_token: accessToken, id_token: 'id-token', refresh_token: 'secret', account_id: 'acct' }, metadata: 'kept' } });

    expect(mirror.expiresAt).toBe(1_800_000_000_000);
    const elanous = JSON.parse(mirror.elanousAuth);
    const codex = JSON.parse(mirror.codexAuth);
    expect(elanous.providers['openai-codex'].tokens).toMatchObject({ accessToken, expiresAt: mirror.expiresAt, refreshToken: '' });
    expect(elanous.providers['openai-codex'].tokens).toMatchObject({ refreshToken: '', refresh_token: '' });
    expect(codex.tokens).toMatchObject({ access_token: accessToken, id_token: 'id-token', refresh_token: '' });
    expect(codex.auth_mode).toBe('chatgpt');
    expect(codex.metadata).toBe('kept');
    expect(mirror.elanousAuth).not.toContain('secret');
    expect(mirror.codexAuth).not.toContain('secret');
  });

  test('rejects missing access credentials instead of creating an empty mirror', () => {
    expect(() => createCodexAccessMirror({ account: 'default', store: { providers: { 'openai-codex': { tokens: {} } } },
      codexAuth: { tokens: {} } })).toThrow('access token');
  });

  test('does not synthesize Codex auth_mode from store metadata for Pod callers', () => {
    const accessToken = token(1_800_000_000);
    const mirror = createCodexAccessMirror({ account: 'default', store: {
      providers: { 'openai-codex': { tokens: { accessToken }, authMode: 'chatgpt' } },
    }, codexAuth: { tokens: { access_token: accessToken } } });
    expect(JSON.parse(mirror.codexAuth).auth_mode).toBeUndefined();
    expect(JSON.parse(mirror.elanousAuth).providers['openai-codex'].authMode).toBe('chatgpt');
  });

  test('preserves a declared source mode; the remote-parent installer owns its chatgpt-only gate', () => {
    const accessToken = token(1_800_000_000);
    const mirror = createCodexAccessMirror({ account: 'default', store: {
      providers: { 'openai-codex': { authMode: 'chatgpt', tokens: { accessToken } } },
    }, codexAuth: { auth_mode: 'oauth', tokens: { access_token: accessToken } } });
    expect(JSON.parse(mirror.codexAuth).auth_mode).toBe('oauth');
  });
});
