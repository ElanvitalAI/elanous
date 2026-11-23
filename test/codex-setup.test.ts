// ── Codex 1-point setup tests ──
//
// Exercises runCodexSetup with a scriptedIO + mocked fetch so the OAuth
// device-code path completes instantly. Verifies:
//   - mode=apikey writes config.llm.apiKey + model
//   - mode=oauth completes the device flow + picks a model + clears stale apiKey
//   - mode=skip still lets the user pick a model (leaves apiKey untouched)
//   - custom model id path works
//   - markComplete=false leaves onboarding.completed false

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodexSetup } from '../src/codex/setup';
import { scriptedIO } from '../src/onboarding';
import { buildUserConfig } from '../src/user-config';
import {
  CODEX_DEVICE_USERCODE_URL, CODEX_DEVICE_TOKEN_URL, CODEX_OAUTH_TOKEN_URL,
} from '../src/oauth/codex';
import { loadTokens } from '../src/oauth/store';
import { CODEX_MODELS } from '../src/codex/models';

let root: string;
let cfgPath: string;
let priorStateDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-setup-'));
  cfgPath = join(root, 'config.json');
  // Isolate OAuth store. The test preload pins one process-wide ELANOUS_STATE_DIR,
  // and authStorePath() follows it ahead of XDG — so each test needs its own,
  // or tokens saved by one test make the next one see «already signed in».
  priorStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  process.env.XDG_CONFIG_HOME = root;
  process.env.CODEX_HOME = join(root, 'codex-home');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = priorStateDir;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.CODEX_HOME;
});

describe('runCodexSetup — apikey mode', () => {
  test('picks mode 2, writes apiKey + recommended model', async () => {
    const io = scriptedIO([
      '2',                // auth mode: apikey
      'sk-proj-xxxxxxx',  // api key
      '',                 // model picker default → recommended
    ]);
    const r = await runCodexSetup({ io, path: cfgPath });
    expect(r.authMode).toBe('apikey');
    expect(r.config.llm.provider).toBe('openai-codex');
    expect(r.config.llm.apiKey).toBe('sk-proj-xxxxxxx');
    const rec = CODEX_MODELS.find(m => m.recommended)!;
    expect(r.model).toBe(rec.id);
    expect(r.config.onboarding.completed).toBe(true);

    // Reload from disk to prove persistence
    const reloaded = buildUserConfig(cfgPath);
    expect(reloaded.llm.model).toBe(rec.id);
    expect(reloaded.llm.apiKey).toBe('sk-proj-xxxxxxx');
  });

  test('apikey mode + explicit model pick by index', async () => {
    const io = scriptedIO([
      '2',                // apikey
      'sk-key',
      '1',                // first model
    ]);
    const r = await runCodexSetup({ io, path: cfgPath });
    expect(r.model).toBe(CODEX_MODELS[0].id);
  });
});

describe('runCodexSetup — oauth-keep (bugfix: reuse existing tokens)', () => {
  test('existing tokens + user says Y → NO device flow, NO fetch call', async () => {
    // Seed existing tokens
    const { saveTokens } = await import('../src/oauth/store');
    saveTokens('openai-codex', {
      accessToken: 'EXISTING-A',
      refreshToken: 'EXISTING-R',
      expiresAt: Date.now() + 3600_000,
    }, { authMode: 'chatgpt', mirrorCodex: false });

    let fetchCalled = false;
    const fetchImpl: any = async () => { fetchCalled = true; return { status: 500, json: async () => ({}) }; };

    const io = scriptedIO([
      '',         // Keep? default Y
      '',         // model picker: default → recommended
    ]);
    const r = await runCodexSetup({ io, path: cfgPath, fetchImpl });
    expect(r.authMode).toBe('oauth-keep');
    expect(fetchCalled).toBe(false);
    // Tokens untouched
    const { loadTokens } = await import('../src/oauth/store');
    expect(loadTokens('openai-codex')?.tokens.accessToken).toBe('EXISTING-A');
    // config.apiKey cleared (OAuth wins)
    expect(r.config.llm.apiKey).toBeUndefined();
    expect(r.config.llm.provider).toBe('openai-codex');
  });

  test('existing tokens + user says n → device flow runs', async () => {
    const { saveTokens } = await import('../src/oauth/store');
    saveTokens('openai-codex', {
      accessToken: 'OLD',
      refreshToken: 'OLD-R',
      expiresAt: Date.now() + 3600_000,
    }, { authMode: 'chatgpt', mirrorCodex: false });

    let fetchCalled = 0;
    const fetchImpl: any = async (url: string) => {
      fetchCalled++;
      if (url.includes('/deviceauth/usercode')) {
        return { status: 200, json: async () => ({ ok: true, user_code: 'X', device_auth_id: 'D' }) };
      }
      if (url.includes('/deviceauth/token')) {
        return { status: 200, json: async () => ({ ok: true, authorization_code: 'AC', code_verifier: 'CV' }) };
      }
      if (url.includes('/oauth/token')) {
        return { status: 200, json: async () => ({ ok: true, access_token: 'NEW', refresh_token: 'NEW-R', expires_in: 3600 }) };
      }
      return { status: 500, json: async () => ({}) };
    };

    const io = scriptedIO([
      'n',        // decline keep
      '1',        // mode: fresh oauth
      '',         // model default
    ]);
    const r = await runCodexSetup({
      io, path: cfgPath, fetchImpl,
      sleepImpl: async () => {}, pollIntervalMs: 1,
      mirrorCodex: false,
    });
    expect(r.authMode).toBe('oauth');
    expect(fetchCalled).toBeGreaterThan(0);
  });
});

describe('runCodexSetup — oauth mode', () => {
  test('completes device flow with stubbed fetch, clears stale apiKey', async () => {
    let turn = 0;
    const fetchImpl: any = async (url: string) => {
      if (url === CODEX_DEVICE_USERCODE_URL) {
        return { status: 200, json: async () => ({ ok: true, result: null, user_code: 'X-123', device_auth_id: 'D1' }) };
      }
      if (url === CODEX_DEVICE_TOKEN_URL) {
        turn++;
        if (turn < 2) return { status: 403, json: async () => ({}) };
        return { status: 200, json: async () => ({ authorization_code: 'AC', code_verifier: 'CV' }) };
      }
      if (url === CODEX_OAUTH_TOKEN_URL) {
        return { status: 200, json: async () => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, token_type: 'Bearer' }) };
      }
      return { status: 500, json: async () => ({}) };
    };
    // oauth-codex wraps the response in { ok, result } shape — we need
    // to return the server payload directly for json(), which the fetch
    // helper destructures. Match the shape:
    const realFetch: any = async (url: string, init: any) => {
      const r = await fetchImpl(url, init);
      return {
        status: r.status,
        json: async () => {
          const body = await r.json();
          // oauth-codex postJson expects raw body, so pass through
          if (body.ok != null && 'result' in body) {
            // For userCode path, return the raw shape (not wrapped)
            return body;
          }
          return body;
        },
      };
    };
    // Seed initial config so onboarding.version is 0 etc.
    const initial = buildUserConfig(cfgPath);
    initial.llm.apiKey = 'stale-key';  // should be cleared by oauth mode

    const io = scriptedIO([
      '1',   // auth mode: oauth
      '',    // model default
    ]);
    const r = await runCodexSetup({
      io, path: cfgPath, initial,
      fetchImpl: realFetch,
      sleepImpl: async () => { /* zero-sleep */ },
      pollIntervalMs: 1,
      mirrorCodex: false,
    });
    expect(r.authMode).toBe('oauth');
    expect(r.config.llm.apiKey).toBeUndefined();
    expect(loadTokens('openai-codex')?.tokens.accessToken).toBe('AT');
  });
});

describe('runCodexSetup — skip mode', () => {
  test('skip leaves apiKey unchanged, model still picked', async () => {
    const initial = buildUserConfig(cfgPath);
    initial.llm.apiKey = 'existing-key';
    const io = scriptedIO([
      '3',   // skip
      '1',   // first model
    ]);
    const r = await runCodexSetup({ io, path: cfgPath, initial });
    expect(r.authMode).toBe('skip');
    expect(r.config.llm.apiKey).toBe('existing-key');
    expect(r.model).toBe(CODEX_MODELS[0].id);
  });
});

describe('runCodexSetup — custom model', () => {
  test('picker option N+1 accepts an arbitrary model id', async () => {
    const customId = 'gpt-5.5-preview-future';
    const io = scriptedIO([
      '2',                              // apikey
      'sk-k',
      `${CODEX_MODELS.length + 1}`,     // custom option
      customId,                         // enter the id
    ]);
    const r = await runCodexSetup({ io, path: cfgPath });
    expect(r.model).toBe(customId);
  });

  test('custom option + empty id → falls back to recommended', async () => {
    const io = scriptedIO([
      '2', 'sk',
      `${CODEX_MODELS.length + 1}`,
      '',                               // empty custom id
    ]);
    const r = await runCodexSetup({ io, path: cfgPath });
    const rec = CODEX_MODELS.find(m => m.recommended)!;
    expect(r.model).toBe(rec.id);
  });
});

describe('markComplete opt-out', () => {
  test('markComplete: false leaves onboarding.completed=false', async () => {
    const io = scriptedIO(['2', 'sk', '']);
    const r = await runCodexSetup({ io, path: cfgPath, markComplete: false });
    expect(r.config.onboarding.completed).toBe(false);
  });
});
