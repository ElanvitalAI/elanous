import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexHealthCredential, isCodexUnauthorized, recordCodexUnauthorized } from './codex-account-health.js';
import { saveTokens } from './store.js';

test('a rejected grant is excluded until login replaces its refresh token', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-health-'));
  try {
    const store = join(root, 'auth.json');
    saveTokens('openai-codex:team', { accessToken: 'access', refreshToken: 'revoked-secret', expiresAt: null },
      { mirrorCodex: false }, store);
    recordCodexUnauthorized(store, 'openai-codex:team', 'revoked-secret');
    expect(isCodexUnauthorized(store, 'openai-codex:team', 'revoked-secret')).toBe(true);
    expect(isCodexUnauthorized(store, 'openai-codex:team', 'new-secret')).toBe(false);
    expect(isCodexUnauthorized(store, 'openai-codex:other', 'revoked-secret')).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an access-only mirror is identified by its access token without persisting token bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-access-health-'));
  try {
    const store = join(root, 'auth.json');
    const first = codexHealthCredential({ refreshToken: '', accessToken: 'first-access-only' });
    saveTokens('openai-codex:team', { accessToken: first, refreshToken: '', expiresAt: null },
      { mirrorCodex: false }, store);
    recordCodexUnauthorized(store, 'openai-codex:team', first);
    expect(isCodexUnauthorized(store, 'openai-codex:team', first)).toBe(true);
    expect(isCodexUnauthorized(store, 'openai-codex:team', codexHealthCredential({ refreshToken: '', accessToken: 'replacement-access' }))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('late rejection from an old credential cannot overwrite the replacement rejection', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-late-health-'));
  try {
    const store = join(root, 'auth.json');
    const key = 'openai-codex:team';
    saveTokens(key, { accessToken: 'old-access', refreshToken: 'old-grant', expiresAt: null },
      { mirrorCodex: false }, store);
    recordCodexUnauthorized(store, key, 'old-grant');
    saveTokens(key, { accessToken: 'new-access', refreshToken: 'new-grant', expiresAt: null },
      { mirrorCodex: false }, store);
    recordCodexUnauthorized(store, key, 'new-grant');
    recordCodexUnauthorized(store, key, 'old-grant');
    expect(isCodexUnauthorized(store, key, 'new-grant')).toBe(true);
    expect(isCodexUnauthorized(store, key, 'old-grant')).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a default-root credential rejection is visible when rotation starts from the config root', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-health-roots-'));
  try {
    const configStore = join(root, 'config', 'auth.json');
    const defaultStore = join(root, 'default', 'auth.json');
    const key = 'openai-codex';
    const grant = 'default-root-grant';
    saveTokens(key, { accessToken: 'access', refreshToken: grant, expiresAt: null },
      { mirrorCodex: false }, defaultStore);
    recordCodexUnauthorized(defaultStore, key, grant);
    expect(isCodexUnauthorized(configStore, key, grant, defaultStore)).toBe(true);
    expect(isCodexUnauthorized(configStore, key, 'replacement', defaultStore)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
