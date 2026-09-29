import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectProviders, type ProviderDetectDeps } from './provider-detect.js';

const auth = (providers: Record<string, unknown>) => JSON.stringify({ version: 1, providers });
const tokens = (expiresAt?: number) => ({ tokens: { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: expiresAt ?? null } });

function fixture(files: Record<string, string>, env: NodeJS.ProcessEnv = {}) {
  const reads: string[] = [];
  const checks: string[] = [];
  const deps: ProviderDetectDeps = {
    env: { HOME: '/isolated', PATH: '/empty', ...env },
    home: '/isolated', authStore: '/isolated/.elanous/auth.json',
    now: () => 1_000,
    readFile: async (path: string) => { reads.push(path); if (!(path in files)) throw new Error('unreadable-secret'); return files[path]!; },
    access: async (path: string) => { checks.push(path); return path === '/tools/ollama'; },
    isFile: async (path: string) => path === '/tools/ollama' || path in files,
    isDirectory: async () => false,
    runCli: async () => { throw new Error('CLI not installed'); },
  };
  return { reads, checks, deps };
}

describe('detectProviders read-only discovery', () => {
  test('Claude CLI status identifies a logged-in agent without handling subscription secrets', async () => {
    const f = fixture({}, { PATH: '/tools' });
    f.deps.access = async (path) => path === '/tools/claude';
    f.deps.isFile = async (path) => path === '/tools/claude';
    const calls: unknown[] = [];
    f.deps.runCli = async (args, options) => {
      calls.push([args, options]);
      return JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', secret: 'never-expose-me' });
    };
    const result = await detectProviders(f.deps);
    expect(calls).toEqual([
      [['auth', 'status', '--json'], { timeoutMs: 5_000, env: { HOME: '/isolated', PATH: '/tools' } }],
      [['auth', 'status', '--json'], { timeoutMs: 5_000, env: { HOME: '/isolated', PATH: '/tools' } }],
    ]);
    expect(result).toMatchObject([{ provider: 'claude-code', auth: 'agent-cli', source: 'claude-auth-status', available: true,
      agent: { cli: 'claude', loggedIn: true, storedLoggedIn: true, method: 'claude.ai', via: 'claude-auth-status' } }]);
    expect(JSON.stringify(result)).not.toContain('never-expose-me');
  });

  test('Claude status distinguishes a session-only token from stored login with a sanitized second environment', async () => {
    const f = fixture({}, {
      PATH: '/tools', CLAUDE_CODE_OAUTH_TOKEN: 'session-secret', CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'entry-secret', CLAUDE_CODE_SESSION_ID: 'session-id-secret',
      CLAUDE_CODE_SESSION_EXTRA: 'extra-secret', ANTHROPIC_AUTH_TOKEN: 'preserved-secret',
    });
    f.deps.access = async (path) => path === '/tools/claude';
    f.deps.isFile = async (path) => path === '/tools/claude';
    const calls: Array<{ args: string[]; options: { timeoutMs: number; env: NodeJS.ProcessEnv } }> = [];
    f.deps.runCli = async (args, options) => {
      calls.push({ args, options });
      return JSON.stringify({ loggedIn: Boolean(options.env.CLAUDE_CODE_OAUTH_TOKEN || options.env.ANTHROPIC_AUTH_TOKEN), authMethod: 'oauth_token' });
    };
    const result = await detectProviders(f.deps);
    expect(calls).toHaveLength(2);
    expect(calls.every(({ args, options }) =>
      JSON.stringify(args) === JSON.stringify(['auth', 'status', '--json']) && options.timeoutMs === 5_000)).toBe(true);
    expect(calls[0]?.options.env).toEqual({
      HOME: '/isolated', PATH: '/tools', CLAUDE_CODE_OAUTH_TOKEN: 'session-secret', CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'entry-secret', CLAUDE_CODE_SESSION_ID: 'session-id-secret',
      CLAUDE_CODE_SESSION_EXTRA: 'extra-secret', ANTHROPIC_AUTH_TOKEN: 'preserved-secret',
    });
    expect(calls[1]?.options.env).toEqual({ HOME: '/isolated', PATH: '/tools' });
    expect(f.deps.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('session-secret');
    expect(f.deps.env?.ANTHROPIC_AUTH_TOKEN).toBe('preserved-secret');
    expect(result).toMatchObject([{ provider: 'claude-code', available: true,
      agent: { loggedIn: true, storedLoggedIn: false, method: 'oauth_token' } }]);
    expect(JSON.stringify(result)).not.toContain('session-secret');
    expect(JSON.stringify(result)).not.toContain('preserved-secret');
  });

  test('ANTHROPIC_AUTH_TOKEN alone is not a stored Claude login', async () => {
    const f = fixture({}, { PATH: '/tools', ANTHROPIC_AUTH_TOKEN: 'session-secret' });
    f.deps.access = async (path) => path === '/tools/claude';
    f.deps.isFile = async (path) => path === '/tools/claude';
    const statusEnvs: NodeJS.ProcessEnv[] = [];
    f.deps.runCli = async (args, options) => {
      expect(args).toEqual(['auth', 'status', '--json']);
      statusEnvs.push(options.env);
      return JSON.stringify({ loggedIn: Boolean(options.env.ANTHROPIC_AUTH_TOKEN), authMethod: 'oauth_token' });
    };
    const result = await detectProviders(f.deps);
    expect(statusEnvs).toEqual([
      { HOME: '/isolated', PATH: '/tools', ANTHROPIC_AUTH_TOKEN: 'session-secret' },
      { HOME: '/isolated', PATH: '/tools' },
    ]);
    expect(result).toMatchObject([{ provider: 'claude-code', available: true,
      agent: { loggedIn: true, storedLoggedIn: false, method: 'oauth_token' } }]);
    expect(JSON.stringify(result)).not.toContain('session-secret');
  });

  test('ANTHROPIC_API_KEY alone can authenticate Claude CLI but is not a stored Claude login', async () => {
    const f = fixture({}, { PATH: '/tools', ANTHROPIC_API_KEY: 'api-secret' });
    f.deps.access = async (path) => path === '/tools/claude';
    f.deps.isFile = async (path) => path === '/tools/claude';
    const statusEnvs: NodeJS.ProcessEnv[] = [];
    f.deps.runCli = async (args, options) => {
      expect(args).toEqual(['auth', 'status', '--json']);
      statusEnvs.push(options.env);
      return JSON.stringify({ loggedIn: Boolean(options.env.ANTHROPIC_API_KEY), authMethod: 'api_key' });
    };
    const result = await detectProviders(f.deps);
    expect(statusEnvs).toEqual([
      { HOME: '/isolated', PATH: '/tools', ANTHROPIC_API_KEY: 'api-secret' },
      { HOME: '/isolated', PATH: '/tools' },
    ]);
    expect(result).toMatchObject([
      { provider: 'claude-code', available: true,
        agent: { loggedIn: true, storedLoggedIn: false, method: 'api_key' } },
      { provider: 'anthropic', auth: 'apikey', source: 'env:ANTHROPIC_API_KEY' },
    ]);
    expect(f.deps.env?.ANTHROPIC_API_KEY).toBe('api-secret');
    expect(JSON.stringify(result)).not.toContain('api-secret');
  });

  test('stored Claude status is independently reported even when the current status is invalid', async () => {
    const f = fixture({}, { PATH: '/tools', CLAUDECODE: '1' });
    f.deps.access = async (path) => path === '/tools/claude';
    f.deps.isFile = async (path) => path === '/tools/claude';
    f.deps.runCli = async (_args, options) => options.env.CLAUDECODE
      ? '{invalid-json-secret' : JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' });
    const result = await detectProviders(f.deps);
    expect(result).toMatchObject([{ provider: 'claude-code', source: 'path:claude', available: false,
      agent: { loggedIn: null, storedLoggedIn: true, via: 'path:claude' } }]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('Claude CLI timeout and invalid JSON leave login unknown but retain the agent', async () => {
    for (const response of ['timeout', 'invalid-json', 'invalid-status']) {
      const f = fixture({}, { PATH: '/tools' });
      f.deps.access = async (path) => path === '/tools/claude';
      f.deps.isFile = async (path) => path === '/tools/claude';
      f.deps.runCli = async () => {
        if (response === 'timeout') throw new Error('timeout-secret');
        return response === 'invalid-json' ? '{invalid-json-secret' : '{"loggedIn":"yes","authMethod":"claude.ai"}';
      };
      const result = await detectProviders(f.deps);
      expect(result).toMatchObject([{ provider: 'claude-code', auth: 'agent-cli', source: 'path:claude', available: false,
        agent: { loggedIn: null, via: 'path:claude' } }]);
      expect(JSON.stringify(result)).not.toContain('secret');
    }
  });

  test('failed Claude status uses verified file and env evidence instead of claiming auth status', async () => {
    const f = fixture({ '/isolated/.claude/.credentials.json': 'subscription-secret' },
      { PATH: '/tools', CLAUDE_CODE_OAUTH_TOKEN: 'env-secret' });
    f.deps.access = async (path) => path === '/tools/claude';
    f.deps.isFile = async (path) => path === '/tools/claude' || path === '/isolated/.claude/.credentials.json';
    f.deps.runCli = async () => { throw new Error('status-secret'); };
    const result = await detectProviders(f.deps);
    expect(result).toMatchObject([{ provider: 'claude-code', source: 'credentials-file', available: false,
      agent: { loggedIn: null, via: 'path:claude, credentials-file, env:CLAUDE_CODE_OAUTH_TOKEN' } }]);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(f.reads).not.toContain('/isolated/.claude/.credentials.json');
  });

  test('a hung Claude status dependency keeps an unknown agent and does not block discovery', async () => {
    const f = fixture({}, { PATH: '/tools', OPENAI_API_KEY: 'direct-secret' });
    f.deps.access = async (path) => path === '/tools/claude';
    f.deps.isFile = async (path) => path === '/tools/claude';
    f.deps.runCli = async () => new Promise<string>(() => {});
    const start = performance.now();
    const result = await detectProviders(f.deps);
    expect(performance.now() - start).toBeLessThan(3_500);
    expect(result).toMatchObject([{ provider: 'claude-code', auth: 'agent-cli', source: 'path:claude', available: false,
      agent: { loggedIn: null, via: 'path:claude' } }, { provider: 'openai', auth: 'apikey' }]);
    expect(JSON.stringify(result)).not.toContain('direct-secret');
  }, 4_000);

  test('Claude credentials are checked for existence only, including CLAUDE_CONFIG_DIR, and never become Anthropic API access', async () => {
    const f = fixture({ '/custom/claude/.credentials.json': JSON.stringify({ claudeAiOauth: { refreshToken: 'refresh-secret' } }) },
      { PATH: '', CLAUDE_CONFIG_DIR: '/custom/claude' });
    let statusCalls = 0;
    f.deps.runCli = async () => { statusCalls++; throw new Error('must not query status without Claude'); };
    const result = await detectProviders(f.deps);
    expect(statusCalls).toBe(0);
    expect(result).toMatchObject([{ provider: 'claude-code', auth: 'agent-cli', source: 'credentials-file', available: false,
      agent: { loggedIn: null, via: 'credentials-file' } }]);
    expect(result.some((row) => row.provider === 'anthropic')).toBe(false);
    expect(f.reads).not.toContain('/custom/claude/.credentials.json');
    expect(JSON.stringify(result)).not.toContain('refresh-secret');
  });

  test('Claude OAuth token env presence is agent evidence only; Anthropic API key remains direct', async () => {
    const f = fixture({}, { PATH: '', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret', ANTHROPIC_AUTH_TOKEN: 'auth-secret', ANTHROPIC_API_KEY: 'api-secret' });
    const result = await detectProviders(f.deps);
    expect(result).toMatchObject([{ provider: 'claude-code', auth: 'agent-cli', source: 'env:CLAUDE_CODE_OAUTH_TOKEN', agent: { loggedIn: null,
      via: 'env:CLAUDE_CODE_OAUTH_TOKEN, env:ANTHROPIC_AUTH_TOKEN' } },
    { provider: 'anthropic', auth: 'apikey', source: 'env:ANTHROPIC_API_KEY' }]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('CLAUDE_CODE_OAUTH_TOKEN alone reports its name, never its value or an Anthropic direct candidate', async () => {
    const f = fixture({}, { PATH: '', CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token-secret' });
    const result = await detectProviders(f.deps);
    expect(result).toMatchObject([{ provider: 'claude-code', auth: 'agent-cli', source: 'env:CLAUDE_CODE_OAUTH_TOKEN', available: false,
      agent: { cli: 'claude', loggedIn: null, via: 'env:CLAUDE_CODE_OAUTH_TOKEN' } }]);
    expect(result.some((row) => row.provider === 'anthropic')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('subscription-token-secret');
  });

  test('empty subscription environment variables do not establish a Claude agent candidate', async () => {
    const empty = fixture({}, { PATH: '', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_AUTH_TOKEN: '   ' });
    expect(await detectProviders(empty.deps)).toEqual([]);
    const present = fixture({}, { PATH: '', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_AUTH_TOKEN: 'auth-secret' });
    const result = await detectProviders(present.deps);
    expect(result).toMatchObject([{ provider: 'claude-code', source: 'env:ANTHROPIC_AUTH_TOKEN',
      agent: { loggedIn: null, via: 'env:ANTHROPIC_AUTH_TOKEN' } }]);
    expect(JSON.stringify(result)).not.toContain('auth-secret');
  });

  test('Antigravity requires both agy on PATH and the install directory', async () => {
    const f = fixture({}, { PATH: '/tools' });
    f.deps.access = async (path) => path === '/tools/agy';
    f.deps.isFile = async (path) => path === '/tools/agy';
    f.deps.isDirectory = async (path) => path === '/isolated/.gemini/antigravity-cli';
    expect(await detectProviders(f.deps)).toMatchObject([{ provider: 'antigravity', auth: 'agent-cli', source: 'agy-install',
      available: true, agent: { cli: 'agy', loggedIn: null, via: 'install-dir' } }]);
    f.deps.isDirectory = async () => false;
    expect(await detectProviders(f.deps)).toEqual([]);
  });

  test('reads canonical OAuth, CLI mirrors, API env and PATH; returns only source names, ordered by preference', async () => {
    const f = fixture({
      '/isolated/.elanous/auth.json': auth({ 'openai-codex:team': tokens(), anthropic: tokens() }),
      '/isolated/.codex/auth.json': JSON.stringify({ tokens: { access_token: 'codex-secret', refresh_token: 'refresh' } }),
      '/isolated/.claude/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'claude-secret', refreshToken: 'refresh' } }),
      '/isolated/.gemini/oauth_creds.json': JSON.stringify({ access_token: 'gemini-secret', refresh_token: 'refresh' }),
      '/isolated/.grok/auth.json': JSON.stringify({ 'https://auth.x.ai::client': { key: 'grok-secret', expires_at: '2099-01-01' } }),
    }, { OPENAI_API_KEY: 'openai-secret', OPENROUTER_API_KEY: 'router-secret', GROK_API_KEY: 'xai-secret', PATH: '/tools' });
    const result = await detectProviders(f.deps);
    expect(result.map(({ provider, auth, source }) => [provider, auth, source])).toEqual([
      ['claude-code', 'agent-cli', 'credentials-file'],
      ['openai-codex', 'oauth', 'elanous-auth'],
      ['anthropic', 'oauth', 'elanous-auth'],
      ['grok', 'oauth', 'grok-auth'],
      ['gemini', 'oauth', 'gemini-auth'],
      ['openrouter', 'apikey', 'env:OPENROUTER_API_KEY'],
      ['openai', 'apikey', 'env:OPENAI_API_KEY'],
      ['ollama', 'local', 'path:ollama'],
    ]);
    expect(result.find((entry) => entry.provider === 'claude-code')).toMatchObject({ available: false, agent: { loggedIn: null, via: 'credentials-file' } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(f.reads).toContain('/isolated/.codex/auth.json');
    expect(f.reads).not.toContain('/isolated/.claude/.credentials.json');
    expect(f.checks).toEqual(['/tools/ollama', '/tools/claude', '/tools/agy']);
  });

  test('Elanous OAuth wins over earlier Codex read regardless of completion order', async () => {
    let releaseElanous!: () => void;
    let codexCompleted = false;
    const elanousGate = new Promise<void>((resolve) => { releaseElanous = resolve; });
    const f = fixture({
      '/isolated/.elanous/auth.json': auth({ 'openai-codex:team': tokens() }),
      '/isolated/.codex/auth.json': JSON.stringify({ tokens: { access_token: 'codex-secret', refresh_token: 'refresh' } }),
    }, { PATH: '' });
    const readFile = f.deps.readFile!;
    f.deps.readFile = async (path: string) => {
      if (path === '/isolated/.elanous/auth.json') await elanousGate;
      const content = await readFile(path);
      if (path === '/isolated/.codex/auth.json') {
        codexCompleted = true;
        releaseElanous();
      }
      return content;
    };
    const result = await detectProviders(f.deps);
    expect(codexCompleted).toBe(true);
    expect(result.map(({ provider, source }) => [provider, source])).toEqual([['openai-codex', 'elanous-auth']]);
  });

  test('respects CODEX_HOME and XDG_CONFIG_HOME, rejects corrupt and expired credentials without leaking values', async () => {
    const f = fixture({
      '/xdg/elanous/auth.json': auth({ anthropic: { tokens: { accessToken: 'expired-secret', expiresAt: 999 } } }),
      '/custom/codex/auth.json': JSON.stringify({ tokens: { access_token: 'codex-secret', refresh_token: 'refresh' } }),
      '/isolated/.gemini/oauth_creds.json': '{invalid-secret',
    }, { XDG_CONFIG_HOME: '/xdg', CODEX_HOME: '/custom/codex', OPENROUTER_API_KEY: '    ', PATH: '' });
    const result = await detectProviders(f.deps);
    expect(result.map(({ provider }) => provider)).toEqual(['openai-codex']);
    expect(f.reads).toContain('/xdg/elanous/auth.json');
    expect(f.reads).toContain('/custom/codex/auth.json');
    expect(f.reads).not.toContain('/isolated/.elanous/auth.json');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('OPENAI_API_KEY alone is OpenAI API access, not Codex OAuth', async () => {
    const f = fixture({}, { OPENAI_API_KEY: 'openai-only-secret', PATH: '' });
    const result = await detectProviders(f.deps);
    expect(result.map(({ provider }) => provider)).toEqual(['openai']);
    expect(JSON.stringify(result)).not.toContain('openai-only-secret');
  });

  test('expired key-only Grok store is excluded using the injected clock; a refresh credential remains usable', async () => {
    const path = '/isolated/.grok/auth.json';
    const expired = fixture({ [path]: JSON.stringify({ 's::c': { key: 'expired-secret', expires_at: '2000-01-01' } }) }, { PATH: '' });
    expired.deps.now = () => Date.parse('2026-09-27T00:00:00Z');
    expect((await detectProviders(expired.deps)).map(({ provider }) => provider)).not.toContain('grok');

    const renewable = fixture({ [path]: JSON.stringify({ 's::c': { key: 'expired-secret', expires_at: '2000-01-01', refresh_token: 'renewable-secret' } }) }, { PATH: '' });
    renewable.deps.now = expired.deps.now;
    const result = await detectProviders(renewable.deps);
    expect(result.map(({ provider, source }) => [provider, source])).toEqual([['grok', 'grok-auth']]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('never waits longer than three seconds for an injected file dependency that hangs', async () => {
    const start = performance.now();
    const result = await detectProviders({
      env: { HOME: '/isolated', PATH: '', OPENROUTER_API_KEY: 'do-not-echo' },
      home: '/isolated', authStore: '/isolated/.elanous/auth.json',
      readFile: () => new Promise<string>(() => {}),
      access: async () => false,
    });
    expect(performance.now() - start).toBeLessThan(3_500);
    expect(result.map((entry) => entry.provider)).toEqual(['openrouter']);
    expect(JSON.stringify(result)).not.toContain('do-not-echo');
  }, 4_000);

  test('an executable PATH directory named ollama is not a local provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provider-detect-'));
    try {
      await mkdir(join(root, 'ollama'), { mode: 0o755 });
      const result = await detectProviders({
        env: { HOME: '/isolated', PATH: root },
        home: '/isolated', authStore: '/isolated/.elanous/auth.json',
        readFile: async () => '{}',
      });
      expect(result).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('injected PATH file check rejects directories even when access succeeds', async () => {
    const result = await detectProviders({
      env: { HOME: '/isolated', PATH: '/tools' },
      home: '/isolated', authStore: '/isolated/.elanous/auth.json', readFile: async () => '{}',
      access: async () => true,
      isFile: async () => false,
    });
    expect(result).toEqual([]);
  });

  test('a hung PATH access cannot delay an executable found in another directory', async () => {
    const start = performance.now();
    const result = await detectProviders({
      env: { HOME: '/isolated', PATH: '/blocked:/tools' },
      home: '/isolated', authStore: '/isolated/.elanous/auth.json',
      readFile: async () => '{}',
      access: (path) => path === '/blocked/ollama'
        ? new Promise<boolean>(() => {})
        : Promise.resolve(path === '/tools/ollama'),
      isFile: async (path) => path === '/tools/ollama',
    });
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(result.map(({ provider, source }) => [provider, source])).toEqual([['ollama', 'path:ollama']]);
  }, 4_000);

  test('injected clock prevents candidates discovered after the deadline while retaining early env evidence', async () => {
    let time = 0;
    const result = await detectProviders({
      env: { HOME: '/isolated', PATH: '', OPENROUTER_API_KEY: 'hidden' },
      home: '/isolated', authStore: '/isolated/.elanous/auth.json', now: () => time,
      readFile: async (path) => {
        time = 3_001;
        return path.endsWith('/.codex/auth.json')
          ? JSON.stringify({ tokens: { access_token: 'late-secret', refresh_token: 'refresh' } })
          : '{}';
      },
      access: async () => false,
    });
    expect(result.map((entry) => entry.provider)).toEqual(['openrouter']);
  });
});
