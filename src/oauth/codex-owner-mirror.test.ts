import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFreshCodexAuthState } from './codex.js';
import { debug } from '../debug/log.js';
import '../llm.js';
import { collectCodexMirrorCredentials, CODEX_OWNER_MIRROR_RELATIVE_PATH, CODEX_OWNER_MIRROR_REQUIRED, codexOwnerMirrorAuthPath, isCodexTokenOwnerHost, readCodexOwnerAccessMirror } from './codex-owner-mirror.js';

const oldEnv = {
  xdg: process.env.XDG_CONFIG_HOME,
  state: process.env.ELANOUS_STATE_DIR,
  source: process.env.ELANOUS_STATE_DIR_SOURCE,
  account: process.env.ELANOUS_CODEX_ACCOUNT,
  runId: process.env.ELANOUS_RUN_ID,
  accessOnly: process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY,
  remoteMirrorPath: process.env.ELANOUS_REMOTE_CODEX_MIRROR_PATH,
  codexHome: process.env.CODEX_HOME,
  bunTest: process.env.BUN_TEST,
  testRunner: process.env.ELANOUS_TEST_RUNNER,
  nodeEnv: process.env.NODE_ENV,
};
const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-owner-mirror-'));
  roots.push(root);
  process.env.XDG_CONFIG_HOME = root;
  process.env.ELANOUS_STATE_DIR = join(root, 'state');
  delete process.env.ELANOUS_STATE_DIR_SOURCE;
  delete process.env.ELANOUS_CODEX_ACCOUNT;
  delete process.env.ELANOUS_RUN_ID;
  process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY = '1';
  mkdirSync(join(root, 'state', 'remote-parent-credentials', 'cli-mirror'), { recursive: true });
  return { root, path: join(root, 'state', CODEX_OWNER_MIRROR_RELATIVE_PATH) };
};
const jwt = (exp: number) => `e30.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.sig`;
const writeMirror = (path: string, accessToken: string, expiresAt: number, refreshToken = '', refreshSnake = '', authMode = 'chatgpt') => writeFileSync(path, JSON.stringify({
  version: 1,
  providers: { 'openai-codex': { authMode, tokens: {
    accessToken, refreshToken, refresh_token: refreshSnake, expiresAt, tokenType: 'Bearer',
  } } },
}));

afterEach(() => {
  for (const [key, value] of Object.entries({ XDG_CONFIG_HOME: oldEnv.xdg, ELANOUS_STATE_DIR: oldEnv.state,
    ELANOUS_STATE_DIR_SOURCE: oldEnv.source, ELANOUS_CODEX_ACCOUNT: oldEnv.account, ELANOUS_RUN_ID: oldEnv.runId })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (oldEnv.accessOnly === undefined) delete process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY;
  else process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY = oldEnv.accessOnly;
  if (oldEnv.remoteMirrorPath === undefined) delete process.env.ELANOUS_REMOTE_CODEX_MIRROR_PATH;
  else process.env.ELANOUS_REMOTE_CODEX_MIRROR_PATH = oldEnv.remoteMirrorPath;
  for (const [key, value] of Object.entries({ CODEX_HOME: oldEnv.codexHome, BUN_TEST: oldEnv.bunTest,
    ELANOUS_TEST_RUNNER: oldEnv.testRunner, NODE_ENV: oldEnv.nodeEnv })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("remote direct Codex uses the owner's access-only mirror", () => {
  test('default owner mirror path follows the resolved state root', () => {
    const { path } = fixture();
    expect(codexOwnerMirrorAuthPath()).toBe(path);
  });

  test('a standalone machine uses its valid local Codex login without an owner mirror', async () => {
    const { root } = fixture();
    delete process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY;
    delete process.env.BUN_TEST;
    delete process.env.ELANOUS_TEST_RUNNER;
    process.env.NODE_ENV = 'production';
    const home = join(root, 'codex-home');
    mkdirSync(home, { recursive: true });
    process.env.CODEX_HOME = home;
    const expiresAt = Math.floor(Date.now() / 1000 + 3600) * 1000;
    const accessToken = jwt(expiresAt / 1000);
    writeFileSync(join(home, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: accessToken, refresh_token: 'local-refresh-token', account_id: 'local-account' },
    }));

    const state = await loadFreshCodexAuthState({
      fetchImpl: (async () => { throw new Error('local unexpired login must not refresh'); }) as unknown as typeof fetch,
    });

    expect(state?.tokens.accessToken).toBe(accessToken);
    expect(state?.tokens.refreshToken).toBe('local-refresh-token');
  });

  test('access-only seats still require the owner mirror even when a local Codex file exists', async () => {
    const { root } = fixture();
    const home = join(root, 'codex-home');
    mkdirSync(home, { recursive: true });
    process.env.CODEX_HOME = home;
    const expiresAt = Math.floor(Date.now() / 1000 + 3600) * 1000;
    writeFileSync(join(home, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: jwt(expiresAt / 1000), refresh_token: 'local-refresh-token', account_id: 'local-account' },
    }));

    await expect(loadFreshCodexAuthState()).rejects.toThrow('reason=missing-file');
  });

  test('remote child uses the parent-installed mirror when its isolated state root differs', async () => {
    const { path: derivedPath, root } = fixture();
    const parentMirrorRoot = join(root, 'pod-home', '.elanous');
    const parentMirror = join(parentMirrorRoot, CODEX_OWNER_MIRROR_RELATIVE_PATH);
    mkdirSync(join(parentMirrorRoot, 'remote-parent-credentials', 'cli-mirror'), { recursive: true, mode: 0o700 });
    const exp = Math.floor(Date.now() / 1000 + 3600) * 1000;
    writeMirror(parentMirror, jwt(exp / 1000), exp);
    process.env.ELANOUS_REMOTE_CODEX_MIRROR_PATH = parentMirror;

    const pathLog = spyOn(debug, 'log').mockImplementation(() => {});
    expect(codexOwnerMirrorAuthPath()).toBe(parentMirror);
    expect(parentMirror).not.toBe(derivedPath);
    const pathEvent = pathLog.mock.calls.find(([category, event]) => category === 'llm.codex' && event === 'owner-mirror-path-compared');
    expect(pathEvent?.[2]).toMatchObject({ source: 'remote-explicit', explicitPathAccepted: true });
    expect(pathEvent?.[2]).not.toHaveProperty('path');
    pathLog.mockRestore();
    const state = await loadFreshCodexAuthState();
    expect(state?.tokens.accessToken).toBe(jwt(exp / 1000));
  });

  test('remote Codex provider availability checks the access-only mirror', async () => {
    const { root } = fixture();
    const mirrorPath = join(root, 'pod-home', '.elanous', CODEX_OWNER_MIRROR_RELATIVE_PATH);
    mkdirSync(join(root, 'pod-home', '.elanous', 'remote-parent-credentials', 'cli-mirror'), { recursive: true });
    const exp = Math.floor(Date.now() / 1000 + 3600) * 1000;
    writeMirror(mirrorPath, jwt(exp / 1000), exp);
    process.env.ELANOUS_REMOTE_CODEX_MIRROR_PATH = mirrorPath;
    const { _explainAndLogFallbackCandidatesForTest, codexOAuthAvailable } = await import('../llm.js');
    expect(codexOAuthAvailable()).toBe(true);
    expect(_explainAndLogFallbackCandidatesForTest([], ['codex-rotate'])).toContain('openai-codex');
  });

  test('remote mirror override is ignored outside access-only children', () => {
    const { path, root } = fixture();
    process.env.ELANOUS_REMOTE_CODEX_MIRROR_PATH = join(root, 'parent', CODEX_OWNER_MIRROR_RELATIVE_PATH);
    delete process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY;
    expect(codexOwnerMirrorAuthPath()).toBe(path);
  });

  test('owner host defaults to mbp and accepts the configured machine identity', () => {
    expect(isCodexTokenOwnerHost({ llm: {}, hq: { hostName: 'mbp' } } as never, 'unknown')).toBe(true);
    expect(isCodexTokenOwnerHost({ llm: { codexTokenOwnerHost: 'mbp' }, hq: { hostName: 'MBP.local' } } as never, 'unknown')).toBe(true);
    expect(isCodexTokenOwnerHost({ llm: {}, hq: { hostName: 'node-b' } } as never, 'MacStudioB1')).toBe(false);
  });

  test('fresh access-only snapshot is returned without invoking refresh', async () => {
    const { path } = fixture();
    const exp = Math.floor(Date.now() / 1000 + 3600) * 1000;
    writeMirror(path, jwt(exp / 1000), exp);
    let refreshCalls = 0;
    const state = await loadFreshCodexAuthState({ ownerMirrorPath: path,
      fetchImpl: (async () => { refreshCalls++; throw new Error('unexpected refresh'); }) as unknown as typeof fetch });
    expect(state?.tokens.accessToken).toBe(jwt(exp / 1000));
    expect(state?.tokens.refreshToken).toBe('');
    expect(refreshCalls).toBe(0);
  });

  test('missing and expired snapshots fail with the owner re-mirror instruction', () => {
    const { path } = fixture();
    expect(() => readCodexOwnerAccessMirror('openai-codex', { path })).toThrow(CODEX_OWNER_MIRROR_REQUIRED);
    writeMirror(path, jwt(Math.floor(Date.now() / 1000 + 3600)), Date.now() + 60 * 60_000, 'present', 'present');
    expect(() => readCodexOwnerAccessMirror('openai-codex', { path })).toThrow(CODEX_OWNER_MIRROR_REQUIRED);
    const exp = Math.floor(Date.now() / 1000 - 1) * 1000;
    writeMirror(path, jwt(exp / 1000), exp);
    expect(() => readCodexOwnerAccessMirror('openai-codex', { path })).toThrow(CODEX_OWNER_MIRROR_REQUIRED);
  });

  test('mirror rejection reports a distinct reason without exposing token or raw path', () => {
    const { path, root } = fixture();
    const eventLog = spyOn(debug, 'log');
    const expectReason = (reason: string) => {
      try { readCodexOwnerAccessMirror('openai-codex', { path }); }
      catch (error) {
        expect((error as Error).message).toContain(`reason=${reason}`);
        expect((error as Error).message).toContain('storeKey=openai-codex');
        expect((error as Error).message).toMatch(/rootSha256=[a-f0-9]{16}/);
        expect((error as Error).message).not.toContain(root);
        expect((error as Error).message).not.toContain('secret');
        const event = eventLog.mock.calls.find(([category, name, data]) => category === 'llm.codex'
          && name === 'owner-mirror-rejected' && (data as { reason?: string } | undefined)?.reason === reason);
        expect(event?.[2]).toMatchObject({ reason, storeKey: 'openai-codex' });
        expect(event?.[2]).not.toHaveProperty('path');
        return;
      }
      throw new Error(`expected mirror rejection: ${reason}`);
    };

    expectReason('missing-file');
    writeFileSync(path, '{');
    expectReason('invalid-json');
    rmSync(path);
    mkdirSync(path);
    expectReason('read-error');
    rmSync(path, { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, providers: {} }));
    expectReason('no-access');
    writeMirror(path, jwt(Math.floor(Date.now() / 1000 + 3600)), Date.now() + 60 * 60_000, '', '', 'api');
    expectReason('authMode');
    writeMirror(path, '', Date.now() + 60 * 60_000);
    expectReason('no-access');
    writeFileSync(path, JSON.stringify({ version: 1, providers: { 'openai-codex': {
      authMode: 'chatgpt', tokens: { accessToken: jwt(Math.floor(Date.now() / 1000 + 3600)), expiresAt: Date.now() + 60 * 60_000 },
    } } }));
    expectReason('refresh-missing');
    writeMirror(path, jwt(Math.floor(Date.now() / 1000 + 3600)), Date.now() + 60 * 60_000, 'refresh', '');
    expectReason('refresh-not-empty');
    writeMirror(path, jwt(Math.floor(Date.now() / 1000 - 1)), Date.now() - 1000);
    expectReason('expiry');
    eventLog.mockRestore();
  });
});

describe('collectCodexMirrorCredentials (REMOTE-MIRROR-SKIP-UNUSABLE 11-05)', () => {
  class Expiring extends Error { constructor(readonly account: string, readonly hoursLeft: number) { super(`openai-codex:${account} expiring`); } }

  test('an expiring default does not drop the fresh team and third mirrors', () => {
    const logs: unknown[][] = [];
    const spy = spyOn(debug, 'log').mockImplementation((...args: unknown[]) => { logs.push(args); });
    try {
      const { mirrors, skipped } = collectCodexMirrorCredentials(['default', 'team', 'third'], (name) => {
        if (name === 'default') throw new Expiring(name, 0.4);
        return { elanousAuth: `e-${name}`, codexAuth: `c-${name}` };
      });
      expect(mirrors.map((m) => m.account)).toEqual(['team', 'third']);
      expect(mirrors[0]).toEqual({ account: 'team', elanousAuth: 'e-team', codexAuth: 'c-team' });
      expect(skipped).toEqual([{ account: 'default', reason: 'access-expiring' }]);
      expect(logs.some((a) => a[0] === 'llm.codex' && a[1] === 'owner-mirror-push-skipped')).toBe(true);
    } finally { spy.mockRestore(); }
  });

  test('other credential errors are skipped as credential-unavailable', () => {
    const { mirrors, skipped } = collectCodexMirrorCredentials(['team', 'third'], (name) => {
      if (name === 'team') throw new Error('auth_mode must be explicitly chatgpt');
      return { v: name };
    });
    expect(mirrors).toEqual([{ v: 'third', account: 'third' }]);
    expect(skipped).toEqual([{ account: 'team', reason: 'credential-unavailable' }]);
  });

  test('nothing shippable is still an error that names each reason', () => {
    expect(() => collectCodexMirrorCredentials(['default'], (name) => { throw new Expiring(name, 1); }))
      .toThrow('default=access-expiring');
  });
});
