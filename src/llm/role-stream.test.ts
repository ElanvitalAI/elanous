import { expect, spyOn, test } from 'bun:test';
import { getUserConfig } from '../user-config.js';
import type { LLMMessage, LLMOpts, LLMProvider } from '../llm.js';
import { debug } from '../debug/log.js';
import { streamRoleLlm } from './role-stream.js';
import { streamLLM } from '../llm.js';

const fakeProvider: LLMProvider = {
  name: 'openai', defaultModel: 'default', available: () => true,
  async *chat() {},
};
// Source: fixed test value used to verify that streamRoleLlm preserves call options.
const TEST_MAX_TOKENS = 123;

test('streamRoleLlm resolves role model and provider together before dispatch', async () => {
  const config = getUserConfig();
  const calls: Array<{ model?: string; provider?: LLMProvider; usageRole?: string; maxTokens?: number }> = [];
  const text = await streamRoleLlm('planning', [{ role: 'user', content: 'plan' }], () => {}, { maxTokens: TEST_MAX_TOKENS }, {
    getConfig: () => config,
    resolveRoleLlm: (role, options) => {
      expect(role).toBe('planning');
      expect(options.config).toBe(config);
      return { model: 'role-planning-model', provider: 'openai', source: 'config-role' };
    },
    getProviderForConfig: (resolvedConfig, model) => {
      expect(resolvedConfig.llm.provider).toBe('openai');
      expect(resolvedConfig.llm.model).toBe('role-planning-model');
      expect(model).toBe('role-planning-model');
      return fakeProvider;
    },
    streamLLM: async (_messages: LLMMessage[], _onChunk: (delta: string, all: string) => void, options: LLMOpts & { provider?: LLMProvider } = {}) => {
      calls.push({ model: options.model, provider: options.provider, usageRole: options.usageRole, maxTokens: options.maxTokens });
      return 'answer';
    },
  });

  expect(text).toBe('answer');
  expect(calls).toEqual([{ model: 'role-planning-model', provider: fakeProvider, usageRole: 'planning', maxTokens: TEST_MAX_TOKENS }]);
});

test('streamRoleLlm dispatches the configured Solar Pro 4 OpenRouter model under its role', async () => {
  const config = {
    ...getUserConfig(),
    roleLlm: { planning: { provider: 'openrouter' as const, model: 'openrouter/upstage/solar-pro4' } },
  };
  const calls: Array<{ provider: string; model?: string; usageRole?: string }> = [];
  const logs: Array<{ category: string; event: string; data: unknown }> = [];
  const previousLlmMode = process.env.ELANOUS_LLM_MODE;
  process.env.ELANOUS_LLM_MODE = 'real';
  const logSpy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if ((category === 'llm.router' && event === 'streamLLM') || (category === 'llm.role' && event === 'outside-role')) logs.push({ category, event, data });
  });
  const fakeOpenRouterWithTrace: LLMProvider = {
    name: 'openrouter', defaultModel: 'openrouter/upstage/solar-pro4', available: () => true,
    async *chat(_messages, options) {
      calls.push({ provider: 'openrouter', model: options?.model, usageRole: options?.usageRole });
      yield 'answer';
    },
  };
  try {
    const answer = await streamRoleLlm('planning', [{ role: 'user', content: 'draft' }], () => {}, {
      config, usageSite: 'role-stream-test',
    }, {
    getProviderForConfig: (resolvedConfig, model) => {
      expect(resolvedConfig.llm.provider).toBe('openrouter');
      expect(model).toBe('openrouter/upstage/solar-pro4');
      return fakeOpenRouterWithTrace;
    },
    });

    expect(answer).toBe('answer');
    expect(calls).toEqual([{ provider: 'openrouter', model: 'openrouter/upstage/solar-pro4', usageRole: 'planning' }]);
    expect(logs.map((entry) => entry.data)).toContainEqual(expect.objectContaining({
      provider: 'openrouter', model: 'openrouter/upstage/solar-pro4',
    }));
    expect(logs.filter((entry) => entry.event === 'outside-role')).toEqual([]);
  } finally {
    logSpy.mockRestore();
    if (previousLlmMode === undefined) delete process.env.ELANOUS_LLM_MODE;
    else process.env.ELANOUS_LLM_MODE = previousLlmMode;
  }
});

test('role model override resolves an OpenRouter pin through planning', async () => {
  const config = getUserConfig();
  const model = 'openrouter/upstage/solar-pro4';
  const calls: Array<{ model?: string; role?: string }> = [];
  await streamRoleLlm('planning', [{ role: 'user', content: 'plan' }], () => {}, { roleModelOverride: model }, {
    getConfig: () => config,
    resolveRoleLlm: (_role, options) => {
      expect(options.overrides?.planning).toEqual({ model, provider: 'openrouter' });
      return { model, provider: 'openrouter', source: 'flag' };
    },
    getProviderForConfig: (resolvedConfig) => {
      expect(resolvedConfig.llm.provider).toBe('openrouter');
      return fakeProvider;
    },
    streamLLM: async (_messages, _onChunk, options = {}) => {
      calls.push({ model: options.model, role: options.usageRole });
      return 'ok';
    },
  });
  expect(calls).toEqual([{ model, role: 'planning' }]);
});

test('configured role provider is retained when its model belongs to another public family', async () => {
  const config = { ...getUserConfig(), roleLlm: { planning: { provider: 'bedrock' as const, model: 'claude-sonnet-5-5' } } };
  await streamRoleLlm('planning', [{ role: 'user', content: 'plan' }], () => {}, { config }, {
    resolveRoleLlm: (_role, options) => {
      expect(options.overrides).toBeUndefined();
      return { model: 'claude-sonnet-5-5', provider: 'bedrock', source: 'config-role' };
    },
    getProviderForConfig: (resolvedConfig) => {
      expect(resolvedConfig.llm.provider).toBe('bedrock');
      return fakeProvider;
    },
    streamLLM: async () => 'ok',
  });
});

test('a direct stream without a role emits an outside-role warning', async () => {
  const warnings: unknown[] = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'llm.role' && event === 'outside-role') warnings.push(data);
  });
  const prior = process.env.ELANOUS_LLM_MODE;
  process.env.ELANOUS_LLM_MODE = 'real';
  try {
    await streamLLM([{ role: 'user', content: 'hello' }], () => {}, { provider: fakeProvider, model: 'direct-model', usageSite: 'role-warning-test' });
    expect(warnings).toContainEqual(expect.objectContaining({ model: 'direct-model', site: 'role-warning-test' }));
  } finally {
    log.mockRestore();
    if (prior === undefined) delete process.env.ELANOUS_LLM_MODE;
    else process.env.ELANOUS_LLM_MODE = prior;
  }
});
