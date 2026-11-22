import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { setUserConfigOverlay } from '../user-config/reader.js';
import { detectProviders } from '../llm/provider-detect.js';
import { _setRotationConfigReaderForTesting, _resetCodexRotationPinForTesting, _setCodexAccountOutboundSenderForTesting } from './codex-account-store.js';
import { loadFreshCodexAuthState } from './codex.js';
import { saveTokens } from './store.js';

// ⛔ 계약 독립 리터럴(REVIEW-2 mustFix): 미러 경로는 codexOwnerMirrorAuthPath() 제품 함수에서
// 유도하지 않는다. 제품이 경로 계약(remote-parent-credentials/cli-mirror/auth.json)을
// 바꾸면 이 시험이 RED 가 되어야 한다 — 제품값을 그대로 기대하면 변이에 둔감해진다
// (REVIEW-2 변이 시험 원문: wrong-mirror 변이에도 기존 6 pass — mbp review2-39532-63082).
const OWNER_MIRROR_CONTRACT = ['remote-parent-credentials', 'cli-mirror', 'auth.json'] as const;
function contractMirrorPath(stateRoot: string): string {
  return join(stateRoot, ...OWNER_MIRROR_CONTRACT);
}

const roots: string[] = [];
const envKeys = ['ELANOUS_REMOTE_CODEX_ACCESS_ONLY', 'ELANOUS_REMOTE_CODEX_MIRROR_PATH', 'ELANOUS_CODEX_ACCOUNT', 'ELANOUS_RUN_ID', 'ELANOUS_TEST_HOME', 'HOME', 'CODEX_HOME'] as const;
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
function setupTestUniverseCleanup(expiry = Date.now() + 3_600_000, account?: string) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-mirror-121272-'));
  roots.push(root);
  _setCodexAccountOutboundSenderForTesting(() => true);
  // ⛔ 시험 우주를 실제 호스트에서 못 박는다 — homedir() 는 HOME 을 따라가므로 이걸 안 걸면
  // prodInstanceRoot()/defaultCodexHome() 이 실제 ~/.elanous·~/.codex 를 보고, 시험 결과가
  // 호스트 토큰의 신선도에 좌우된다(2026-11-22 실측: 11-21 갱신 이후 3 fail 로 뒤집힘).
  process.env.HOME = root;
  process.env.CODEX_HOME = join(root, 'codex-home');
  setElanousConfigDir(join(root, 'state'));
  delete process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY;
  delete process.env.ELANOUS_REMOTE_CODEX_MIRROR_PATH;
  delete process.env.ELANOUS_CODEX_ACCOUNT;
  delete process.env.ELANOUS_RUN_ID;
  delete process.env.ELANOUS_TEST_HOME;
  if (account !== undefined) process.env.ELANOUS_CODEX_ACCOUNT = account;
  setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, codexTokenOwnerHost: undefined }, hq: { ...config.hq, hostName: 'fixture-owner' } }));
  const home = join(root, 'third');
  mkdirSync(home, { recursive: true });
  // 계약 독립 경로로 우주를 세운다(위 OWNER_MIRROR_CONTRACT 주석 참조) — 제품 함수에서 유도하지 않는다.
  const stateRoot = join(root, 'state');
  const path = contractMirrorPath(stateRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, providers: {
    'openai-codex:third': { source: 'mirror', authMode: 'chatgpt', codexHome: home,
      tokens: { accessToken: 'synthetic-third', refreshToken: '', refresh_token: '', expiresAt: expiry } },
  } }), { mode: 0o600 });
  return { root, path };
}
afterEach(() => {
  _resetCodexRotationPinForTesting(); _setRotationConfigReaderForTesting(null); _setCodexAccountOutboundSenderForTesting(null); setUserConfigOverlay(null); resetElanousConfigDir();
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('owner discovery and explicit third load the same access-only mirror', async () => {
  const { root, path } = setupTestUniverseCleanup(undefined, 'third');
  _setRotationConfigReaderForTesting(() => ({ llm: { codexAccountOrder: ['third'] } } as never));
  const detected = await detectProviders({ authStore: path, env: { HOME: root, PATH: '' }, home: root,
    isFile: async () => false, isDirectory: async () => false, access: async () => false });
  expect(detected.some((p) => p.provider === 'openai-codex')).toBe(true);
  let selected: string[] = [];
  const state = await loadFreshCodexAuthState({ onSelectedAccount: (key, store) => { selected = [key, store]; },
    fetchImpl: (async () => { throw new Error('refresh forbidden'); }) as unknown as typeof fetch });
  expect(Boolean(state)).toBe(true);
  expect(selected).toEqual(['openai-codex:third', path]);
});

test('owner does not use an expired third snapshot or refresh it', async () => {
  setupTestUniverseCleanup(Date.now() - 1000, 'third');
  let refreshed = false;
  const state = await loadFreshCodexAuthState({ fetchImpl: (async () => { refreshed = true; throw new Error('refresh forbidden'); }) as unknown as typeof fetch });
  expect(state).toBeNull();
  expect(refreshed).toBe(false);
});

test('owner does not bind another named snapshot to third', async () => {
  const { path } = setupTestUniverseCleanup(undefined, 'third');
  writeFileSync(path, JSON.stringify({ version: 1, providers: {
    'openai-codex:team': { source: 'mirror', authMode: 'chatgpt', tokens: {
      accessToken: 'synthetic-team', refreshToken: '', refresh_token: '', expiresAt: Date.now() + 3_600_000,
    } },
  } }), { mode: 0o600 });
  expect(await loadFreshCodexAuthState()).toBeNull();
});


test('default explicitly allowed selects default from owner store', async () => {
  const { root } = setupTestUniverseCleanup(undefined, 'default');
  const store = join(root, 'state', 'auth.json');
  mkdirSync(dirname(store), { recursive: true });
  saveTokens('openai-codex', { accessToken: 'synthetic-default', refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 3600000 }, { authMode: 'chatgpt', mirrorCodex: false }, store);
  let selected: string[] = [];
  const state = await loadFreshCodexAuthState({ onSelectedAccount: (key, path) => { selected = [key, path]; } });
  expect(state?.tokens.accessToken).toBe('synthetic-default');
  expect(selected).toEqual(['openai-codex', store]);
});

test('default credential present: implicit run never falls back to default', async () => {
  const { root, path } = setupTestUniverseCleanup();
  // default credential EXISTS in the local store — the leak condition OP #126383 describes.
  const store = join(root, 'state', 'auth.json');
  mkdirSync(dirname(store), { recursive: true });
  saveTokens('openai-codex', { accessToken: 'synthetic-default', refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 3600000 }, { authMode: 'chatgpt', mirrorCodex: false }, store);
  _setRotationConfigReaderForTesting(() => ({ llm: { codexAccountOrder: ['third'] } } as never));
  // implicit run: no ELANOUS_CODEX_ACCOUNT (setup() already deleted it)
  let selected: string[] = [];
  const state = await loadFreshCodexAuthState({ onSelectedAccount: (key, storePath) => { selected = [key, storePath]; },
    fetchImpl: (async () => { throw new Error('refresh forbidden'); }) as unknown as typeof fetch });
  expect(state?.tokens.accessToken).toBe('synthetic-third');
  expect(selected).toEqual(['openai-codex:third', path]);
  expect(state?.tokens.accessToken).not.toBe('synthetic-default');
});

test('default explicitly excluded: implicit run chooses allowed third from mirror', async () => {
  const { path } = setupTestUniverseCleanup(); // mirror allowlist has third only; default credential is absent
  _setRotationConfigReaderForTesting(() => ({ llm: { codexAccountOrder: ['third'] } } as never));
  let selected: string[] = [];
  const state = await loadFreshCodexAuthState({ onSelectedAccount: (key, store) => { selected = [key, store]; },
    fetchImpl: (async () => { throw new Error('refresh forbidden'); }) as unknown as typeof fetch });
  expect(state?.tokens.accessToken).toBe('synthetic-third');
  expect(selected).toEqual(['openai-codex:third', path]);
});
