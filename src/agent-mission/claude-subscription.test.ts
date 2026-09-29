import { describe, expect, test } from 'bun:test';
import { checkClaudeSubscription } from './claude-subscription.js';

const env = {
  PATH: '/bin', HOME: '/home/test',
  ANTHROPIC_API_KEY: 'secret-key', ANTHROPIC_AUTH_TOKEN: 'secret-token',
  CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1',
  CLAUDE_CODE_USE_FOUNDRY: '1', CLAUDECODE: 'nested', CLAUDE_CODE_OAUTH_TOKEN: 'parent-session-token',
};

const response = (data: object) => ({ status: 0, stdout: JSON.stringify(data) });

describe('checkClaudeSubscription', () => {
  test('subscription login uses only the scrubbed environment and returns only status fields', () => {
    const calls: unknown[][] = [];
    const result = checkClaudeSubscription({ env, runCli: (cmd, args, opts) => {
      calls.push([cmd, args, opts]);
      return response({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'private@example.com', accessToken: 'private-token' });
    } });
    expect(calls).toEqual([['claude', ['auth', 'status', '--json'], {
      env: { PATH: '/bin', HOME: '/home/test' }, encoding: 'utf8', timeout: 5_000,
    }]]);
    expect(result).toEqual({ ok: true, authMethod: 'claude.ai', apiProvider: 'firstParty', reason: 'subscription' });
    expect(env.ANTHROPIC_API_KEY).toBe('secret-key');
  });

  test('API-key authentication is not a subscription even when logged in', () => {
    expect(checkClaudeSubscription({ env, runCli: () => response({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', email: 'private@example.com' }) }))
      .toEqual({ ok: false, authMethod: 'api_key', apiProvider: 'firstParty', reason: 'api-key' });
    expect(checkClaudeSubscription({ env, runCli: () => response({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' }) }))
      .toEqual({ ok: false, authMethod: 'claude.ai', apiProvider: 'bedrock', reason: 'api-key' });
  });

  test('logged-out status is rejected without leaking fields', () => {
    expect(checkClaudeSubscription({ env, runCli: () => response({ loggedIn: false, authMethod: null, apiProvider: null, email: 'private@example.com' }) }))
      .toEqual({ ok: false, authMethod: null, apiProvider: null, reason: 'logged-out' });
  });

  test('CLI timeout is classified without exposing stderr or credentials', () => {
    expect(checkClaudeSubscription({ env, runCli: () => ({ status: null, signal: 'SIGTERM', error: Object.assign(new Error('secret-token'), { code: 'ETIMEDOUT' }) }) }))
      .toEqual({ ok: false, authMethod: null, apiProvider: null, reason: 'timeout' });
  });

  test('a timeout thrown by an injected runner is classified', () => {
    expect(checkClaudeSubscription({ env, runCli: () => { throw Object.assign(new Error('private'), { code: 'ETIMEDOUT' }); } }))
      .toEqual({ ok: false, authMethod: null, apiProvider: null, reason: 'timeout' });
  });

  test('invalid JSON and failed CLI status fail closed', () => {
    expect(checkClaudeSubscription({ env, runCli: () => ({ status: 0, stdout: '{' }) }))
      .toEqual({ ok: false, authMethod: null, apiProvider: null, reason: 'auth-status-failed' });
    expect(checkClaudeSubscription({ env, runCli: () => ({ status: 1, stdout: '{"loggedIn":true}' }) }))
      .toEqual({ ok: false, authMethod: null, apiProvider: null, reason: 'auth-status-failed' });
    expect(checkClaudeSubscription({ env, runCli: () => ({ status: 1, stdout: '{"loggedIn":false}' }) }))
      .toEqual({ ok: false, authMethod: null, apiProvider: null, reason: 'logged-out' });
  });
});
