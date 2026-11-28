// KEYS-PROACTIVE-REFRESH — the REAL codex CLI against a synthetic test universe: fake JWTs in a temp CODEX_HOME and a local fake
// OAuth server (the CLI's CODEX_REFRESH_TOKEN_URL_OVERRIDE). No real credential is read, sent or printed. Expectations are
// literals (rule 11). Skipped only where the codex CLI is not installed.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexAuthMeta, credentialId, refreshAdvanced, refreshCodexHome, refreshDue, reloginCard, unrefreshedSoon } from './index.js';

// 출처: graphs/loop-agents/guardian/agent.yaml key_refresh_timeout_sec (45 s)
const refreshTimeoutMs = 45 * 1000;
const hasCodex = Bun.spawnSync(['codex', '--version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
const root = mkdtempSync(join(tmpdir(), 'key-refresh-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(c)}.sig`;
const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-sim', chatgpt_plan_type: 'team', chatgpt_user_id: 'u-sim', user_id: 'u-sim' }, email: 'sim@example.invalid' };

function home(name: string, o: { expInH: number; refreshedDaysAgo: number; refreshToken?: string | null }): string {
  const h = join(root, name); mkdirSync(h, { recursive: true });
  const exp = Math.floor(Date.now() / 1000) + o.expInH * 3600;
  writeFileSync(join(h, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { id_token: jwt({ ...claims, exp }), access_token: jwt({ ...claims, exp }), ...(o.refreshToken === null ? {} : { refresh_token: o.refreshToken ?? 'sim-rt-1' }), account_id: 'acct-sim' },
    last_refresh: new Date(Date.now() - o.refreshedDaysAgo * 86_400_000).toISOString() }));
  return h;
}

describe('kit/credential-keeper — pure rules (literal)', () => {
  const T = Date.parse('2026-11-28T03:00:00.000Z');
  const P = { beforeH: 48, afterDays: 7 };
  test.each([
    ['exp 20 h · refreshed 1 d', T + 20 * 3_600_000, '2026-11-27T03:00:00.000Z', 'access 20.0h left < 48h'],
    ['exp 4 d · refreshed 8 d', T + 96 * 3_600_000, '2026-11-20T03:00:00.000Z', 'last refresh 8.0d ago > 7d'],
    ['exp 4 d · refreshed 2 d', T + 96 * 3_600_000, '2026-11-26T03:00:00.000Z', null],
  ] as const)('%s → %s', (_n, exp, last, want) => {
    expect(refreshDue({ provider: 'codex-home:team:x', expiresAt: exp, lastRefresh: last, home: '/h', refreshable: true }, T, P)).toBe(want);
  });
  test('no home / access-only copy → never due · ids · KPI · verify · card steps', () => {
    expect(refreshDue({ provider: 'grok', expiresAt: T, lastRefresh: null }, T, P)).toBe(null);
    expect(refreshDue({ provider: 'x', expiresAt: T, lastRefresh: null, home: '/h', refreshable: false }, T, P)).toBe(null);
    expect([credentialId({ provider: 'openai-codex:team' }), credentialId({ provider: 'codex-home:team:.codex-team-owner' })]).toEqual(['oauth:openai-codex:team', 'codex-home:team:.codex-team-owner']);
    expect(unrefreshedSoon([{ provider: 'a', expiresAt: T + 47 * 3_600_000, lastRefresh: null }, { provider: 'b', expiresAt: T + 49 * 3_600_000, lastRefresh: null }, { provider: 'c', expiresAt: null, lastRefresh: null }], T, 48).map(c => c.provider)).toEqual(['a']);
    expect(refreshAdvanced({ before: { lastRefresh: '2026-11-20T00:00:00Z', expiresAt: null }, after: { lastRefresh: '2026-11-20T00:00:00Z', expiresAt: null } })).toBe(false);
    expect(refreshAdvanced({ before: { lastRefresh: '2026-11-20T00:00:00Z', expiresAt: null }, after: { lastRefresh: '2026-11-28T00:00:00Z', expiresAt: null } })).toBe(true);
    const card = reloginCard('codex-home:third:.codex-third-owner', '/Users/x/.codex-third-owner', 'access 5.0h left < 48h', 'not advanced', 'owner-host');
    expect(card.category).toBe('secret');
    expect(card.scqa.a).toContain('1) owner-host 에서 CODEX_HOME=/Users/x/.codex-third-owner codex login');
    expect(card.options.map(o => o.key)).toEqual(['a', 'b']);
  });
  test('auth meta: exp from the access JWT · refresh token presence · never a value', () => {
    // exp 1796176551 = 2026-12-02T01:55:51.000Z (literal)
    const auth = JSON.stringify({ last_refresh: '2026-11-22T01:55:51.779682Z', tokens: { access_token: `h.${Buffer.from('{"exp":1796176551}').toString('base64url')}.s`, refresh_token: 'rt-x' } });
    expect(codexAuthMeta('/h/', p => { expect(p).toBe('/h/auth.json'); return auth; })).toEqual({ connected: true, expiresAt: 1796176551000, lastRefresh: '2026-11-22T01:55:51.779682Z', refreshable: true });
    expect(JSON.stringify(codexAuthMeta('/h', () => auth))).not.toContain('rt-x');
  });
});

describe.skipIf(!hasCodex)('열쇠지기 key-refresh — the codex CLI\'s own refresh, verified on disk', () => {
  let grants = 0; let issuedExp = 0;
  const server = Bun.serve({ port: 0, fetch: async (req) => {
    const body = await req.text();
    if (!body.includes('refresh_token')) return new Response('no', { status: 400 });
    grants++;
    const exp = Math.floor(Date.now() / 1000) + 240 * 3600; issuedExp = exp;
    return Response.json({ id_token: jwt({ ...claims, exp }), access_token: jwt({ ...claims, exp }), refresh_token: `sim-rt-${grants + 1}` });
  } });
  afterAll(() => server.stop(true));
  const env = { ...process.env, CODEX_REFRESH_TOKEN_URL_OVERRIDE: `http://127.0.0.1:${server.port}/oauth/token` };

  test('access 20 h left · refreshed 1 day ago → the grant runs, last_refresh advances, exp moves ~10 days out', async () => {
    const h = home('near-expiry', { expInH: 20, refreshedDaysAgo: 1 });
    const before = JSON.parse(readFileSync(join(h, 'auth.json'), 'utf8')) as { last_refresh: string };
    const r = await refreshCodexHome(h, { env, timeoutMs: refreshTimeoutMs });
    expect(r.ok).toBe(true);
    expect(grants).not.toBe(0);
    expect(r.before.lastRefresh).toBe(before.last_refresh);
    expect(refreshAdvanced(r)).toBe(true);
    expect(r.after.expiresAt).toBe(issuedExp * 1000);
    expect(JSON.stringify(r)).not.toContain('sim-rt-');
  }, 40_000);

  test('a home without a refresh token (access-only copy) is not touched — not refreshed, says why', async () => {
    const h = home('access-only', { expInH: 5, refreshedDaysAgo: 3, refreshToken: null });
    const g0 = grants;
    const r = await refreshCodexHome(h, { env, timeoutMs: refreshTimeoutMs });
    expect(r.ok).toBe(false);
    expect(r.line).toBe('no refresh token in this home (access-only copy) — refresh its owner home');
    expect(grants).toBe(g0);
  }, 40_000);

  test('the auth server refuses → not refreshed (last_refresh unchanged) — the pulse raises the card', async () => {
    const h = home('refused', { expInH: 10, refreshedDaysAgo: 9 });
    const r = await refreshCodexHome(h, { env: { ...process.env, CODEX_REFRESH_TOKEN_URL_OVERRIDE: 'http://127.0.0.1:9/oauth/token' }, timeoutMs: refreshTimeoutMs });
    expect(r.ok).toBe(false);
    expect(r.after.lastRefresh).toBe(r.before.lastRefresh);
    expect(r.line.endsWith('(not advanced)')).toBe(true);
  }, 40_000);
});
