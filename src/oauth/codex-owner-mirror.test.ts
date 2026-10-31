import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFreshCodexAuthState } from './codex.js';
import { CODEX_OWNER_MIRROR_RELATIVE_PATH, CODEX_OWNER_MIRROR_REQUIRED, codexOwnerMirrorAuthPath, isCodexTokenOwnerHost, readCodexOwnerAccessMirror } from './codex-owner-mirror.js';

const oldEnv = {
  xdg: process.env.XDG_CONFIG_HOME,
  state: process.env.ELANOUS_STATE_DIR,
  source: process.env.ELANOUS_STATE_DIR_SOURCE,
  account: process.env.ELANOUS_CODEX_ACCOUNT,
  runId: process.env.ELANOUS_RUN_ID,
  accessOnly: process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY,
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
const writeMirror = (path: string, accessToken: string, expiresAt: number, refreshToken = '', refreshSnake = '') => writeFileSync(path, JSON.stringify({
  version: 1,
  providers: { 'openai-codex': { authMode: 'chatgpt', tokens: {
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
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("remote direct Codex uses the owner's access-only mirror", () => {
  test('default owner mirror path follows the resolved state root', () => {
    const { path } = fixture();
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
});
