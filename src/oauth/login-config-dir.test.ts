import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { authStorePath, loadTokens } from './store.js';
import { loginWithCodex, CODEX_DEVICE_USERCODE_URL, CODEX_DEVICE_TOKEN_URL, CODEX_OAUTH_TOKEN_URL } from './codex.js';

const roots: string[] = [];
afterEach(() => { resetElanousConfigDir(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('device login and auth loading share an explicit config dir', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-login-root-'));
  roots.push(root);
  setElanousConfigDir(root);
  const calls: string[] = [];
  await loginWithCodex({ mirrorCodex: false, sleepImpl: async () => {}, pollIntervalMs: 0,
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === CODEX_DEVICE_USERCODE_URL) return Response.json({ device_auth_id: 'device', user_code: 'code' });
      if (url === CODEX_DEVICE_TOKEN_URL) return Response.json({ authorization_code: 'authorization', code_verifier: 'verifier' });
      if (url === CODEX_OAUTH_TOKEN_URL) return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 });
      throw new Error('unexpected login request');
    }) as typeof fetch,
  });
  expect(calls).toEqual([CODEX_DEVICE_USERCODE_URL, CODEX_DEVICE_TOKEN_URL, CODEX_OAUTH_TOKEN_URL]);
  expect(authStorePath()).toBe(join(root, 'auth.json'));
  expect(existsSync(join(root, 'auth.json'))).toBe(true);
  expect(loadTokens('openai-codex')?.tokens.accessToken).toBe('fixture-access');
  expect(readFileSync(join(root, 'auth.json'), 'utf8')).toContain('openai-codex');
});

test('empty config dir uses valid same-user default auth for first turn', () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-login-fallback-'));
  roots.push(root);
  const script = `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { setElanousConfigDir } from ${JSON.stringify(join(import.meta.dir, '../elanous-config-dir.ts'))};
    import { readCodexOwnerMirrorForRun } from ${JSON.stringify(join(import.meta.dir, 'codex.ts'))};
    const home = process.env.HOME;
    mkdirSync(join(home, '.elanous'), { recursive: true });
    writeFileSync(join(home, '.elanous', 'auth.json'), JSON.stringify({ version: 1, providers: {
      'openai-codex': { authMode: 'chatgpt', accountUuid: 'account-1', chatGPT: { accountId: 'account-1' },
        tokens: { accessToken: 'fallback-access', refreshToken: 'fallback-refresh', expiresAt: Date.now() + 3600000 }, lastRefresh: '' }
    } }), { mode: 0o600 });
    setElanousConfigDir(join(home, 'isolated'));
    const result = readCodexOwnerMirrorForRun();
    if (result.state.tokens.accessToken !== 'fallback-access') throw new Error('fallback auth not used');
    const path = join(home, '.elanous', 'auth.json');
    const mismatch = JSON.parse(await Bun.file(path).text());
    mismatch.providers['openai-codex'].chatGPT.accountId = 'different-account';
    writeFileSync(path, JSON.stringify(mismatch));
    let refused = false;
    try { readCodexOwnerMirrorForRun(); } catch { refused = true; }
    if (!refused) throw new Error('mismatched account accepted');
    process.stdout.write('first-turn-auth-ok');
  `;
  const result = Bun.spawnSync(['bun', '-e', script], { env: { ...process.env, HOME: root }, stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain('first-turn-auth-ok');
});

test('explicit owner mirror selects and reads the same named account', () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-login-mirror-'));
  roots.push(root);
  const script = `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { setElanousConfigDir } from ${JSON.stringify(join(import.meta.dir, '../elanous-config-dir.ts'))};
    import { readCodexOwnerMirrorForRun } from ${JSON.stringify(join(import.meta.dir, 'codex.ts'))};
    const home = process.env.HOME;
    const mirror = join(home, 'owner-mirror.json');
    writeFileSync(mirror, JSON.stringify({ version: 1, providers: {
      'openai-codex:team': { source: 'mirror', authMode: 'chatgpt', codexHome: join(home, 'team'),
        accountUuid: 'team-id', tokens: { accessToken: 'team-access', refreshToken: '', refresh_token: '',
          expiresAt: Date.now() + 3600000 }, lastRefresh: '' }
    } }), { mode: 0o600 });
    setElanousConfigDir(join(home, 'empty-instance'));
    const result = readCodexOwnerMirrorForRun(mirror);
    if (result.storeKey !== 'openai-codex:team' || result.state.tokens.accessToken !== 'team-access')
      throw new Error('selected account and mirror token diverged');
    process.stdout.write('mirror-account-ok');
  `;
  const result = Bun.spawnSync(['bun', '-e', script], {
    env: { ...process.env, HOME: root, ELANOUS_CODEX_ACCOUNT: 'team', ELANOUS_REMOTE_CODEX_ACCESS_ONLY: '1' },
    stdout: 'pipe', stderr: 'pipe',
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain('mirror-account-ok');
});
