import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { spawn, type SpawnOptions } from 'node:child_process';
import { RequestError } from '@agentclientprotocol/sdk';
import { AcpAgent, AcpAuthRequiredError } from './client.js';
import { ACP_BACKENDS } from './backend-registry.js';
import { claudeBackend } from '../agent-mission/driver.js';
import { debug } from '../debug/log.js';

// A real stdio ACP peer: exercises initialize, session/new, and the vendor notification.
const peer = `
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      if (process.env.ANTHROPIC_API_KEY) process.stderr.write('billing key was inherited\\n');
      if (message.params.clientCapabilities.auth?.terminal !== true) {
        process.stderr.write('terminal auth was not advertised\\n');
      }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: 'claude-login', name: 'Claude Login' }]
      } }) + '\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: '_auth/status_update',
        params: { authStatus: { kind: 'account', email: 'x@y' } } }) + '\\n');
    } else if (message.method === 'session/new') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
        ...(process.env.ACP_TEST_AUTH_REQUIRED === '1' && process.env.ACP_TEST_AUTH_STAGE !== 'prompt'
          ? { error: { code: -32000, message: 'Authentication required' } }
          : { result: { sessionId: 'logged-in-session', configOptions: [
              { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'claude-sonnet',
                options: [{ value: 'claude-sonnet', name: 'Sonnet' }, { value: 'claude-opus', name: 'Opus' }] },
              { id: 'effort', name: 'Effort', type: 'select', currentValue: 'high',
                options: [{ value: 'high', name: 'High' }] }
            ] } }) }) + '\\n');
    } else if (message.method === 'session/set_config_option') {
      if (message.params.configId !== 'model' || message.params.value !== 'claude-opus') {
        process.stderr.write('wrong model config request\\n');
      }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { configOptions: [
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'claude-opus',
          options: [{ value: 'claude-sonnet', name: 'Sonnet' }, { value: 'claude-opus', name: 'Opus' }] }
      ] } }) + '\\n');
    } else if (message.method === 'session/set_model') {
      process.stderr.write('legacy set_model was called\\n');
    } else if (message.method === 'session/prompt') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
        ...(process.env.ACP_TEST_AUTH_REQUIRED === '1'
          ? { error: { code: -32000, message: 'Authentication required' } }
          : { result: { stopReason: 'end_turn' } }) }) + '\\n');
    } else if (message.method === 'authenticate') {
      process.stderr.write('authenticate was called\\n');
    }
  }
});
`;

const claude = ACP_BACKENDS.claude!;
const original = { command: claude.command, args: claude.args };
let logSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  claude.command = original.command;
  claude.args = original.args;
  logSpy?.mockRestore();
});

async function startPeer(authRequired: boolean, authStage: 'session' | 'prompt' = 'session') {
  claude.command = 'bun';
  claude.args = ['-e', peer];
  const logs: string[] = [];
  const events: Array<{ category: string; event: string; data: unknown }> = [];
  logSpy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    events.push({ category, event, data });
  });
  const agent = new AcpAgent({ backendId: 'claude', cwd: process.cwd(),
    env: { ACP_TEST_AUTH_REQUIRED: authRequired ? '1' : '0', ACP_TEST_AUTH_STAGE: authStage,
      ANTHROPIC_API_KEY: 'billing-key-must-be-scrubbed' },
    log: message => logs.push(message) });
  await agent.start();
  return { agent, logs, events };
}

describe('Claude ACP subscription authentication', () => {
  test('spawn injection receives a key-free Claude environment and one value-free auth-source event', async () => {
    const billingKeys = claudeBackend.scrubEnv!;
    expect(billingKeys).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']);
    const before = Object.fromEntries(billingKeys.map(key => [key, process.env[key]]));
    const secret = 'billing-secret-should-never-be-logged';
    const calls: Array<{ command: string; env: NodeJS.ProcessEnv }> = [];
    const events: Array<{ category: string; event: string; data: unknown }> = [];
    const spawnChild = ((command: string, _args: readonly string[], options: SpawnOptions) => {
      calls.push({ command, env: { ...options.env } });
      return spawn(process.execPath, ['-e', peer], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    }) as typeof spawn;
    for (const key of billingKeys) process.env[key] = secret;
    logSpy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      events.push({ category, event, data });
    });
    const agent = new AcpAgent({ backendId: 'claude', cwd: process.cwd(), spawnChild, log: () => {} });
    try {
      await agent.start();
      expect(await agent.newSession()).toBe('logged-in-session');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.command).toContain('claude');
      for (const key of billingKeys) expect(calls[0]!.env).not.toHaveProperty(key);
      expect(events.filter(entry => entry.category === 'acp.claude' && entry.event === 'auth-source'))
        .toEqual([{ category: 'acp.claude', event: 'auth-source',
          data: { apiKeyPresent: false, source: 'subscription' } }]);
      expect(JSON.stringify(events)).not.toContain(secret);
    } finally {
      await agent.stop();
      for (const key of billingKeys) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
      }
    }
  });

  test('injected post-scrub billing authentication refuses launch; test mode records but does not block', async () => {
    const priorNodeEnv = process.env.NODE_ENV;
    const priorTestHome = process.env.ELANOUS_TEST_HOME;
    const events: Array<{ category: string; event: string; data: unknown }> = [];
    let launches = 0;
    const spawnChild = ((_command: string, _args: readonly string[], options: SpawnOptions) => {
      launches++;
      return spawn(process.execPath, ['-e', peer], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    }) as typeof spawn;
    logSpy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      events.push({ category, event, data });
    });
    const agent = new AcpAgent({ backendId: 'claude', cwd: process.cwd(), spawnChild, log: () => {} });
    Object.assign(agent, { env: { ANTHROPIC_AUTH_TOKEN: 'post-scrub-injected-secret' } });
    try {
      delete process.env.NODE_ENV;
      delete process.env.ELANOUS_TEST_HOME;
      await expect(agent.start()).rejects.toThrow('ACP Claude refused: billing authentication environment remains after scrub');
      expect(launches).toBe(0);
      expect(events.filter(entry => entry.category === 'acp.claude' && entry.event === 'auth-source'))
        .toEqual([{ category: 'acp.claude', event: 'auth-source',
          data: { apiKeyPresent: true, source: 'billing-env' } }]);
      expect(JSON.stringify(events)).not.toContain('post-scrub-injected-secret');

      process.env.NODE_ENV = 'test';
      await agent.start();
      expect(launches).toBe(1);
      await agent.stop();
      delete process.env.NODE_ENV;
      process.env.ELANOUS_TEST_HOME = '/tmp/acp-claude-test-home';
      await agent.start();
      expect(launches).toBe(2);
      expect(events.filter(entry => entry.category === 'acp.claude' && entry.event === 'auth-source')).toHaveLength(3);
    } finally {
      await agent.stop();
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
      if (priorTestHome === undefined) delete process.env.ELANOUS_TEST_HOME;
      else process.env.ELANOUS_TEST_HOME = priorTestHome;
    }
  });
  test('auth-required session/new ends with a login hint, without calling authenticate', async () => {
    const { agent, logs, events } = await startPeer(true);
    try {
      await expect(agent.newSession()).rejects.toBeInstanceOf(AcpAuthRequiredError);
      await expect(agent.newSession()).rejects.toThrow('claude /login');
      expect(events).toContainEqual({ category: 'acp.client', event: 'auth-required',
        data: { backendId: 'claude', methods: ['claude-login'] } });
      expect(logs.filter(line => line.startsWith('stderr:'))).toEqual([]);
      expect(JSON.stringify(events)).not.toContain('x@y');
      expect(logs.filter(line => !line.startsWith('spawning ')).join(' ')).not.toContain('x@y');
      expect(events).toContainEqual({ category: 'acp.client', event: 'auth-status',
        data: { backendId: 'claude', kind: 'account' } });
      expect(events.find(e => e.event === 'spawn')?.data).toMatchObject({
        scrubbedBillingEnv: ['ANTHROPIC_API_KEY'], authEnvPresent: false,
      });
    } finally {
      await agent.stop();
    }
  });

  test('local subscription login method also surfaces the manual login hint', async () => {
    const { agent, logs } = await startPeer(true);
    try {
      Object.assign(agent, { authMethods: ['claude-ai-login'] });
      await expect(agent.newSession()).rejects.toBeInstanceOf(AcpAuthRequiredError);
      expect(logs.filter(line => line.startsWith('stderr:'))).toEqual([]);
    } finally {
      await agent.stop();
    }
  });

  test('a session that opens before login is checked surfaces prompt authRequired', async () => {
    const { agent, events, logs } = await startPeer(true, 'prompt');
    try {
      const sessionId = await agent.newSession();
      await expect(agent.prompt(sessionId, [{ type: 'text', text: 'hello' }], () => {}))
        .rejects.toBeInstanceOf(AcpAuthRequiredError);
      expect(events).toContainEqual({ category: 'acp.client', event: 'auth-required',
        data: { backendId: 'claude', methods: ['claude-login'] } });
      expect(logs.filter(line => line.startsWith('stderr:'))).toEqual([]);
    } finally {
      await agent.stop();
    }
  });

  test('an already authenticated peer opens a session without authenticate', async () => {
    const { agent, logs } = await startPeer(false);
    try {
      expect(await agent.newSession()).toBe('logged-in-session');
      expect(logs.filter(line => line.startsWith('stderr:'))).toEqual([]);
    } finally {
      await agent.stop();
    }
  });

  test('Claude model selection uses configOptions and session/set_config_option', async () => {
    const { agent, logs, events } = await startPeer(false);
    try {
      const sessionId = await agent.newSession();
      expect(agent.getSessionModels(sessionId)).toEqual({ currentModelId: 'claude-sonnet',
        availableModels: [{ modelId: 'claude-sonnet', name: 'Sonnet' }, { modelId: 'claude-opus', name: 'Opus' }] });
      expect(await agent.selectSessionModel(sessionId, 'opus')).toEqual({ modelId: 'claude-opus', name: 'Opus' });
      expect(agent.getSessionModels(sessionId)?.currentModelId).toBe('claude-opus');
      expect(await agent.selectSessionModel(sessionId, 'opus')).toEqual({ modelId: 'claude-opus', name: 'Opus' });
      expect(logs.filter(line => line.startsWith('stderr:'))).toEqual([]);
      expect(events.filter(e => e.event === 'frame' && JSON.stringify(e.data).includes('session/set_config_option')).length)
        .toBeGreaterThan(0);
    } finally {
      await agent.stop();
    }
  });

  test('non-Claude peers retain the legacy model selection extension', async () => {
    const agent = new AcpAgent({ backendId: 'grok', cwd: process.cwd(), log: () => {} });
    const calls: Array<{ method: string; params: unknown }> = [];
    Object.assign(agent, { connection: {
      newSession: async () => ({ sessionId: 'grok-session', models: { currentModelId: 'grok-default',
        availableModels: [{ modelId: 'grok-default', name: 'Default' }, { modelId: 'grok-fast', name: 'Fast' }] } }),
      extMethod: async (method: string, params: unknown) => { calls.push({ method, params }); },
    } });
    const sessionId = await agent.newSession();
    expect(await agent.selectSessionModel(sessionId, 'fast')).toEqual({ modelId: 'grok-fast', name: 'Fast' });
    expect(calls).toEqual([{ method: 'session/set_model', params: { sessionId, modelId: 'grok-fast' } }]);
    expect(agent.getSessionModels(sessionId)?.currentModelId).toBe('grok-fast');
  });

  test('non-Claude backends keep the original authentication error', async () => {
    const agent = new AcpAgent({ backendId: 'grok', cwd: process.cwd(), log: () => {} });
    const failure = RequestError.authRequired();
    Object.assign(agent, { connection: { newSession: async () => { throw failure; } }, authMethods: ['claude-login'] });
    await expect(agent.newSession()).rejects.toBe(failure);
  });
});
