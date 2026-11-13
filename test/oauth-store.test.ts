// ── OAuth token-store tests ──

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, statSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getElanousConfigDirOverride, setElanousConfigDir, resetElanousConfigDir } from '../src/elanous-config-dir.js';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  loadTokens, saveTokens, deleteTokens, listProviders,
  isExpiringSoon, expiresAtFromSeconds, authStorePath,
  reconcileCodexTokensFromMirror,
  type OAuthTokens,
} from '../src/oauth/store';

let root: string;
let priorConfigDir: string | undefined;
let priorEnv: Record<string, string | undefined>;
const fixtureEnvKeys = ['XDG_CONFIG_HOME', 'CODEX_HOME', 'ELANOUS_CODEX_ACCOUNT', 'ELANOUS_CODEX_ACCOUNT_HOME'] as const;
let cfgPath: string;
let codexHome: string;

beforeEach(() => {
  priorConfigDir = getElanousConfigDirOverride();
  priorEnv = Object.fromEntries(fixtureEnvKeys.map((key) => [key, process.env[key]]));
  root = mkdtempSync(join(tmpdir(), 'oauth-store-'));
  cfgPath = join(root, 'elanous', 'auth.json');
  codexHome = join(root, 'codex-home');
  // OAuth uses the config resolver; XDG alone leaves all cases in the preload's shared store.
  setElanousConfigDir(join(root, 'elanous'));
  delete process.env.ELANOUS_CODEX_ACCOUNT;
  delete process.env.ELANOUS_CODEX_ACCOUNT_HOME;
  process.env.XDG_CONFIG_HOME = root;
  process.env.CODEX_HOME = codexHome;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (priorConfigDir === undefined) resetElanousConfigDir();
  else setElanousConfigDir(priorConfigDir);
  for (const key of fixtureEnvKeys) {
    const value = priorEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const sampleTokens: OAuthTokens = {
  accessToken: 'acc-123',
  refreshToken: 'ref-456',
  expiresAt: Date.now() + 3600_000,
  scope: 'user:inference',
  tokenType: 'Bearer',
};

function codexIdToken(accountId: string): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${segment({ alg: 'none' })}.${segment({ chatgpt_account_id: accountId })}.signature`;
}

describe('authStorePath respects the explicit config root', () => {
  test('explicit root takes precedence over XDG_CONFIG_HOME', () => {
    process.env.XDG_CONFIG_HOME = join(root, 'unused-xdg');
    expect(authStorePath()).toBe(join(root, 'elanous', 'auth.json'));
  });
});

describe('saveTokens / loadTokens', () => {
  test('round-trip for a provider', () => {
    expect(loadTokens('anthropic', cfgPath)).toBeNull();
    saveTokens('anthropic', sampleTokens, { authMode: 'claudeai' }, cfgPath);
    const state = loadTokens('anthropic', cfgPath);
    expect(state).not.toBeNull();
    expect(state!.tokens.accessToken).toBe('acc-123');
    expect(state!.authMode).toBe('claudeai');
    expect(state!.lastRefresh).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test('multiple providers coexist', () => {
    saveTokens('anthropic', sampleTokens, {}, cfgPath);
    saveTokens('openai-codex', { ...sampleTokens, accessToken: 'cdx' }, { mirrorCodex: false }, cfgPath);
    const names = listProviders(cfgPath);
    expect(names).toContain('anthropic');
    expect(names).toContain('openai-codex');
  });

  test('file perms clamped to 0o600', () => {
    saveTokens('anthropic', sampleTokens, {}, cfgPath);
    const mode = statSync(cfgPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('malformed JSON → treated as empty store', () => {
    require('node:fs').mkdirSync(require('node:path').dirname(cfgPath), { recursive: true });
    require('node:fs').writeFileSync(cfgPath, '{not json', 'utf-8');
    expect(loadTokens('anthropic', cfgPath)).toBeNull();
    // Write still works after corruption.
    saveTokens('anthropic', sampleTokens, {}, cfgPath);
    expect(loadTokens('anthropic', cfgPath)).not.toBeNull();
  });
});

describe('deleteTokens', () => {
  test('removes provider entry', () => {
    saveTokens('anthropic', sampleTokens, {}, cfgPath);
    expect(deleteTokens('anthropic', cfgPath)).toBe(true);
    expect(loadTokens('anthropic', cfgPath)).toBeNull();
    expect(deleteTokens('anthropic', cfgPath)).toBe(false);
  });
});

describe('Codex dual-write mirror', () => {
  test('writes a Codex CLI usable ~/.codex/auth.json alongside elanous store', () => {
    const idToken = codexIdToken('cdx-account-123');
    saveTokens('openai-codex', { ...sampleTokens, idToken }, { authMode: 'chatgpt' }, cfgPath);
    const mirror = join(codexHome, 'auth.json');
    expect(existsSync(mirror)).toBe(true);
    const parsed = JSON.parse(readFileSync(mirror, 'utf-8'));
    expect(parsed).toMatchObject({
      OPENAI_API_KEY: null,
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'acc-123',
        refresh_token: 'ref-456',
        id_token: idToken,
        account_id: 'cdx-account-123',
      },
    });
    expect(parsed.last_refresh).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test('mirror preserves unknown keys when updating an existing Codex CLI file', () => {
    const mirror = join(codexHome, 'auth.json');
    mkdirSync(dirname(mirror), { recursive: true });
    writeFileSync(mirror, JSON.stringify({
      auth_mode: 'chatgpt',
      accountId: 'cdx-account-999',
      tokens: {
        id_token: 'cli-id-token',
        account_id: 'cli-account',
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        cli_owned_field: 'preserved',
      },
    }));

    saveTokens('openai-codex', { ...sampleTokens, accessToken: 'acc-NEW', refreshToken: 'ref-NEW' }, {}, cfgPath);

    const after = JSON.parse(readFileSync(mirror, 'utf-8'));
    expect(after.tokens).toEqual({
      id_token: 'cli-id-token',
      account_id: 'cli-account',
      access_token: 'acc-NEW',
      refresh_token: 'ref-NEW',
      cli_owned_field: 'preserved',
    });
    expect(after.accountId).toBe('cdx-account-999');
  });

  test('mirrorCodex:false skips the write-back', () => {
    saveTokens('openai-codex', sampleTokens, { mirrorCodex: false }, cfgPath);
    const mirror = join(codexHome, 'auth.json');
    expect(existsSync(mirror)).toBe(false);
  });

  test('other providers do not trigger mirror', () => {
    saveTokens('anthropic', sampleTokens, {}, cfgPath);
    expect(existsSync(join(codexHome, 'auth.json'))).toBe(false);
  });
});

describe('expiry helpers', () => {
  test('isExpiringSoon honors buffer', () => {
    const fresh = { tokens: { ...sampleTokens, expiresAt: Date.now() + 10 * 60_000 }, lastRefresh: 'x' };
    expect(isExpiringSoon(fresh, 5 * 60_000)).toBe(false);
    const soon = { tokens: { ...sampleTokens, expiresAt: Date.now() + 60_000 }, lastRefresh: 'x' };
    expect(isExpiringSoon(soon, 5 * 60_000)).toBe(true);
  });

  test('null expiresAt → never expires', () => {
    const forever = { tokens: { ...sampleTokens, expiresAt: null }, lastRefresh: 'x' };
    expect(isExpiringSoon(forever, 60_000)).toBe(false);
  });

  test('expiresAtFromSeconds arithmetic', () => {
    const before = Date.now();
    const exp = expiresAtFromSeconds(3600)!;
    expect(exp).toBeGreaterThanOrEqual(before + 3600_000);
    expect(expiresAtFromSeconds(undefined)).toBeNull();
    expect(expiresAtFromSeconds('x')).toBeNull();
  });
});

describe('reconcileCodexTokensFromMirror — dual-store divergence (regression for codex refresh 401)', () => {
  // Minimal `header.payload.sig` JWT carrying just an `exp` claim (seconds).
  function jwt(expSec: number): string {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'none' })}.${b64({ exp: expSec })}.sig`;
  }
  function writeMirror(accessExpSec: number, refresh: string): void {
    const path = join(codexHome, 'auth.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      tokens: { access_token: jwt(accessExpSec), refresh_token: refresh },
      last_refresh: new Date().toISOString(),
    }) + '\n');
  }
  const nowSec = () => Math.floor(Date.now() / 1000);

  test('adopts mirror tokens when the mirror is strictly fresher + persists them', () => {
    // elanous store: stale (access token already expired · dead refresh token).
    saveTokens('openai-codex', {
      accessToken: jwt(nowSec() - 3600),
      refreshToken: 'dead-refresh',
      expiresAt: Date.now() - 3600_000,
      tokenType: 'Bearer',
    }, { authMode: 'chatgpt', mirrorCodex: false });
    // Mirror (official codex CLI): fresh (valid token · rotated refresh token).
    writeMirror(nowSec() + 7 * 24 * 3600, 'live-refresh');

    const out = reconcileCodexTokensFromMirror(loadTokens('openai-codex'));
    expect(out?.tokens.refreshToken).toBe('live-refresh');
    // Persisted back to elanous's canonical store (next turn reads it fresh).
    expect(loadTokens('openai-codex')?.tokens.refreshToken).toBe('live-refresh');
  });

  test('keeps elanous tokens when elanous is fresher (no ping-pong)', () => {
    saveTokens('openai-codex', {
      accessToken: jwt(nowSec() + 7 * 24 * 3600),
      refreshToken: 'elanous-refresh',
      expiresAt: Date.now() + 7 * 24 * 3600_000,
      tokenType: 'Bearer',
    }, { authMode: 'chatgpt', mirrorCodex: false });
    writeMirror(nowSec() + 3600, 'older-mirror-refresh');

    const out = reconcileCodexTokensFromMirror(loadTokens('openai-codex'));
    expect(out?.tokens.refreshToken).toBe('elanous-refresh');
  });

  test('returns input unchanged when no mirror file exists', () => {
    const state = saveTokens('openai-codex', {
      accessToken: jwt(nowSec() - 10),
      refreshToken: 'only-elanous',
      expiresAt: Date.now() - 10_000,
      tokenType: 'Bearer',
    }, { authMode: 'chatgpt', mirrorCodex: false });
    const out = reconcileCodexTokensFromMirror(state);
    expect(out?.tokens.refreshToken).toBe('only-elanous');
  });

  test('returns input unchanged when the mirror has no usable tokens', () => {
    saveTokens('openai-codex', {
      accessToken: jwt(nowSec() - 10),
      refreshToken: 'only-elanous',
      expiresAt: Date.now() - 10_000,
      tokenType: 'Bearer',
    }, { authMode: 'chatgpt', mirrorCodex: false });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: {} }) + '\n');
    const out = reconcileCodexTokensFromMirror(loadTokens('openai-codex'));
    expect(out?.tokens.refreshToken).toBe('only-elanous');
  });
});
