import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveTokens } from './store.js';
import { codexLoginSuccessMessage } from '../index.js';

// AUTH1 — ~/.codex/auth.json is the Codex CLI's file: elanous login must not mix another account into it.
const jwt = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const idToken = (account: string) => jwt({ chatgpt_account_id: account });
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture(base?: { account: string; access: string; refresh: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-mirror-account-'));
  dirs.push(dir);
  const codexHome = join(dir, 'codex');
  const store = join(dir, 'auth.json');
  const mirror = join(codexHome, 'auth.json');
  if (base) {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(mirror, JSON.stringify({ OPENAI_API_KEY: null, auth_mode: 'chatgpt', tokens: { id_token: idToken(base.account), account_id: base.account, access_token: base.access, refresh_token: base.refresh }, last_refresh: '2026-10-01T00:00:00Z' }, null, 2) + '\n');
  }
  return { codexHome, store, mirror };
}
const tokens = (account?: string) => ({ accessToken: `ACCESS-${account ?? 'x'}`, refreshToken: `REFRESH-${account ?? 'x'}`, expiresAt: Date.now() + 3_600_000, ...(account ? { idToken: idToken(account) } : {}) });

describe('AUTH1 — Codex CLI mirror never mixes accounts', () => {
  test('a different account leaves the Codex CLI file byte-for-byte and says so', () => {
    const f = fixture({ account: 'acct-A', access: 'A-ACCESS', refresh: 'A-REFRESH' });
    const before = readFileSync(f.mirror, 'utf8');
    const state = saveTokens('openai-codex', tokens('acct-B'), { codexHome: f.codexHome }, f.store);
    expect(state.codexMirrorResult).toBe('skipped-different-account');
    expect(readFileSync(f.mirror, 'utf8')).toBe(before);
    expect(codexLoginSuccessMessage(state.codexMirrorResult)).toContain('different account');
  });

  test('the same account rotates access and refresh tokens as before', () => {
    const f = fixture({ account: 'acct-A', access: 'A-ACCESS', refresh: 'A-REFRESH' });
    const state = saveTokens('openai-codex', tokens('acct-A'), { codexHome: f.codexHome }, f.store);
    expect(state.codexMirrorResult).toBe('written');
    const file = JSON.parse(readFileSync(f.mirror, 'utf8'));
    expect(file.tokens.account_id).toBe('acct-A');
    expect(file.tokens.access_token).toBe('ACCESS-acct-A');
    expect(file.tokens.refresh_token).toBe('REFRESH-acct-A');
  });

  test('no Codex CLI file and an id_token creates it, as before', () => {
    const f = fixture();
    const state = saveTokens('openai-codex', tokens('acct-B'), { codexHome: f.codexHome }, f.store);
    expect(state.codexMirrorResult).toBe('written');
    expect(JSON.parse(readFileSync(f.mirror, 'utf8')).tokens.account_id).toBe('acct-B');
  });

  test('replaceDifferentCodexAccount replaces the whole identity — id_token, account_id and tokens all B', () => {
    const f = fixture({ account: 'acct-A', access: 'A-ACCESS', refresh: 'A-REFRESH' });
    const state = saveTokens('openai-codex', tokens('acct-B'), { codexHome: f.codexHome, replaceDifferentCodexAccount: true }, f.store);
    expect(state.codexMirrorResult).toBe('written');
    const file = JSON.parse(readFileSync(f.mirror, 'utf8'));
    expect(file.tokens.account_id).toBe('acct-B');
    expect(file.tokens.id_token).toBe(idToken('acct-B'));
    expect(file.tokens.access_token).toBe('ACCESS-acct-B');
    expect(JSON.stringify(file)).not.toContain('A-REFRESH');
  });

  test('our account unknown (refresh without id_token or JWT claim) keeps the rotation behaviour — tokens updated, identity kept', () => {
    const f = fixture({ account: 'acct-A', access: 'A-ACCESS', refresh: 'A-REFRESH' });
    const state = saveTokens('openai-codex', tokens(undefined), { codexHome: f.codexHome }, f.store);
    expect(state.codexMirrorResult).toBe('written');
    const file = JSON.parse(readFileSync(f.mirror, 'utf8'));
    expect(file.tokens.account_id).toBe('acct-A');
    expect(file.tokens.access_token).toBe('ACCESS-x');
  });

  test('a different account read from the access token JWT (no id_token) is still refused', () => {
    const f = fixture({ account: 'acct-A', access: 'A-ACCESS', refresh: 'A-REFRESH' });
    const before = readFileSync(f.mirror, 'utf8');
    const access = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-B' } });
    const state = saveTokens('openai-codex:team', { accessToken: access, refreshToken: 'R', expiresAt: Date.now() + 3_600_000 }, { codexHome: f.codexHome }, f.store);
    expect(state.codexMirrorResult).toBe('skipped-different-account');
    expect(readFileSync(f.mirror, 'utf8')).toBe(before);
  });
});
