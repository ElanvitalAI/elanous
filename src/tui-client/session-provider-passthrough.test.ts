import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { streamLLMWithTools } from '../llm.js';
import { AgentRegistry } from '../agent/registry.js';
import type { AgentDefinition } from '../agent/types.js';
import { reloadUserConfig, resetUserConfig, userConfigPath } from '../user-config.js';
import { withRealProviderFakeFetchDevice } from '../ux-sim/fake-fetch.js';
import { sessionProviderChildEnv } from './session-provider.js';

// HARNESS-CHILD-PROVIDER-PASSTHROUGH (0.3.28): a GLM seat (`--provider glm --model glm-5`) whose saved
// config is openai-codex streamed every main-turn and Agent request to chatgpt.com/backend-api/codex
// (goal-loop core path and Agent runner both resolve the provider from user config).
// The REPL child now carries the session choice as the per-run env override; this file asserts on the
// request host that both a provider-less main-turn stream and an Agent child actually hit.

test('sessionProviderChildEnv names the session choice and stays empty without one', () => {
  expect(sessionProviderChildEnv(undefined)).toEqual({ env: {}, key: '' });
  expect(sessionProviderChildEnv({ provider: 'glm', model: 'glm-5' })).toEqual({
    env: { ELANOUS_LLM_PROVIDER: 'glm', ELANOUS_LLM_MODEL: 'glm-5' }, key: 'glm/glm-5',
  });
  const defaulted = sessionProviderChildEnv({ provider: 'glm' });
  expect(defaulted.env.ELANOUS_LLM_PROVIDER).toBe('glm');
  expect(defaulted.key.startsWith('glm/')).toBe(true);
});

test('in a glm session the main turn and an Agent child both request the GLM endpoint, not Codex', async () => {
  const envKeys = ['HOME', 'ELANOUS_CONFIG_DIR', 'ELANOUS_STATE_DIR', 'ELANOUS_STATE_DIR_SOURCE', 'XDG_CONFIG_HOME',
    'ELANOUS_LLM_PROVIDER', 'ELANOUS_LLM_MODEL', 'ZAI_API_KEY'] as const;
  const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const savedConfigDir = getElanousConfigDirOverride();
  const home = mkdtempSync(join(tmpdir(), 'session-provider-passthrough-'));
  const logs = spyOn(debug, 'log');
  try {
    process.env.HOME = home;
    process.env.ELANOUS_CONFIG_DIR = home;
    process.env.ELANOUS_STATE_DIR = home;
    process.env.ELANOUS_STATE_DIR_SOURCE = 'test';
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    setElanousConfigDir(home);
    delete process.env.ELANOUS_LLM_PROVIDER;
    delete process.env.ELANOUS_LLM_MODEL;
    // The seat's saved config is Codex; only the session choice says GLM.
    const configPath = userConfigPath();
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ llm: { provider: 'openai-codex', model: 'gpt-6-sol' } }));
    expect(reloadUserConfig().llm.provider).toBe('openai-codex');

    Object.assign(process.env, sessionProviderChildEnv({ provider: 'glm', model: 'glm-5' }).env);
    process.env.ZAI_API_KEY = 'test-zai-key';
    expect(reloadUserConfig().llm.provider).toBe('glm');

    const attempts: Array<{ host: string; path: string; model?: string }> = [];
    const respond = (request: { url: string; body: string | null }): Response => {
      const url = new URL(request.url);
      const body = JSON.parse(request.body ?? '{}') as { model?: string };
      attempts.push({ host: url.hostname, path: url.pathname, ...(body.model ? { model: body.model } : {}) });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Done. Hello from the mock.' } }] })}\n\ndata: [DONE]\n\n`, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    };
    await withRealProviderFakeFetchDevice([
      { url: '/api/coding/paas/v4/chat/completions', method: 'POST', response: respond },
      { url: '/backend-api/codex/responses', method: 'POST', response: respond },
    ], async () => {
      // Main turn: the goal-loop/core path calls streamLLMWithTools without a provider.
      await streamLLMWithTools([{ role: 'user', content: 'hi' }], {
        onText: () => {}, dispatchTool: async () => ({}),
      }, { tools: [] });
      const mainTurnAttempts = attempts.length;
      expect(attempts).not.toHaveLength(0);

      // Agent child: spawned without a pinned provider, exactly like the TUI Agent tool.
      const handle = new AgentRegistry().spawn({
        definition: { name: 'passthrough-probe', systemPrompt: 'Answer briefly.' } as AgentDefinition,
        prompt: 'Say hello.',
        tools: [],
      });
      for await (const _event of handle.events) { /* drain */ }
      expect(attempts.length).toBeGreaterThan(mainTurnAttempts);
    });

    expect(attempts.every((attempt) => attempt.host === 'api.z.ai' && attempt.path === '/api/coding/paas/v4/chat/completions')).toBe(true);
    expect(attempts.some((attempt) => attempt.host === 'chatgpt.com')).toBe(false);
    const resolves = logs.mock.calls.filter((call) => call[0] === 'child.provider' && call[1] === 'resolve').map((call) => call[2]);
    expect(resolves).toContainEqual(expect.objectContaining({
      mode: 'passthrough', kind: 'agent', parentProvider: 'glm', parentModel: 'glm-5', childProvider: 'glm', source: 'session-env',
    }));
  } finally {
    logs.mockRestore();
    if (savedConfigDir === undefined) resetElanousConfigDir();
    else setElanousConfigDir(savedConfigDir);
    for (const key of envKeys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetUserConfig();
    rmSync(home, { recursive: true, force: true });
  }
});
