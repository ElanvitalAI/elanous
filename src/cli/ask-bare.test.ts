import { afterEach, describe, expect, test } from 'bun:test';
import { askBare, type AskBareDeps } from './ask-bare.js';
import { PROVIDERS, streamLLM, type LLMMessage, type LLMOpts, type LLMProvider } from '../llm.js';
import { setUserConfigOverlay } from '../user-config.js';
import { trimToBudget } from '../tokens.js';

describe('askBare', () => {
  afterEach(() => { setUserConfigOverlay(null); });
  test('forwards the unmodified text as its only message with no system prompt or tools', async () => {
    const calls: Array<{ messages: unknown; options: unknown }> = [];
    const deps = {
      getUserConfig: () => ({ llm: { provider: 'auto', model: '' } }),
      decideProviderForConfig: (_config: unknown, _model?: string) => ({ provider: 'auto:openai-codex', model: 'codex-model', auth: 'oauth' }),
      getProviderForConfig: () => ({ name: 'openai-codex' }),
      streamLLM: async (messages: unknown, _delta: unknown, options: unknown) => {
        calls.push({ messages, options });
        (options as { onResolvedProvider: (name: string, model: string) => void }).onResolvedProvider('openai-codex', 'codex-model');
        return 'answer';
      },
      trimToBudget,
    } as unknown as AskBareDeps;
    const result = await askBare({ text: '  Hello!\n', deps });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages).toEqual([{ role: 'user', content: '  Hello!\n' }]);
    expect(calls[0]!.options).toEqual({ initialProvider: { name: 'openai-codex' }, model: 'codex-model', onResolvedProvider: expect.any(Function) });
    expect(result).toEqual({ provider: 'openai-codex', model: 'codex-model', reply: 'answer' });
  });

  test('passes provider and model overrides into the same provider decision', async () => {
    let configured: unknown;
    let requestedModel: unknown;
    let streamedOptions: unknown;
    const deps = {
      getUserConfig: () => ({ llm: { provider: 'auto', model: 'old-model', fallbackChain: ['grok'] } }),
      decideProviderForConfig: (config: unknown, model?: string) => {
        configured = config;
        requestedModel = model;
        return { provider: 'anthropic', model: 'claude-sonnet-4-5', auth: 'apikey' };
      },
      getProviderForConfig: () => ({ name: 'anthropic' }),
      streamLLM: async (_messages: unknown, _onChunk: unknown, options: unknown) => {
        streamedOptions = options;
        return 'ok';
      },
      trimToBudget,
    } as unknown as AskBareDeps;
    await askBare({ text: 'question', provider: 'anthropic', model: 'claude-sonnet-4-5', deps });
    expect(configured).toEqual({ llm: { provider: 'anthropic', model: 'claude-sonnet-4-5', fallbackChain: ['grok'] } });
    expect(requestedModel).toBe('claude-sonnet-4-5');
    expect(streamedOptions).toEqual({
      provider: { name: 'anthropic' },
      model: 'claude-sonnet-4-5',
      onResolvedProvider: expect.any(Function),
    });
  });

  test('a failed first provider falls back through the real streamLLM to a recording provider', async () => {
    const originalGrok = PROVIDERS.grok;
    const calls: Array<{ provider: string; messages: LLMMessage[]; opts: LLMOpts | undefined }> = [];
    const fallbackProvider = {
      name: 'grok', defaultModel: 'grok-4.6', available: () => true,
      async *streamChat(messages: LLMMessage[], opts?: LLMOpts) {
        calls.push({ provider: 'grok', messages, opts });
        yield { type: 'text' as const, delta: 'fallback answer' };
      },
    } as LLMProvider;
    const firstProvider = {
      name: 'openai-codex', defaultModel: 'gpt-5.6-terra', available: () => true,
      async *streamChat(messages: LLMMessage[]) {
        calls.push({ provider: 'openai-codex', messages, opts: undefined });
        throw new Error('429 usage_limit_reached');
        yield { type: 'text' as const, delta: '' };
      },
    } as LLMProvider;
    PROVIDERS.grok = fallbackProvider;
    setUserConfigOverlay(cfg => ({ ...cfg, llm: { ...cfg.llm, provider: 'auto', fallbackChain: ['codex-rotate', 'grok'] } }));
    try {
      const deps = {
        getUserConfig: () => ({ llm: { provider: 'auto', model: '' } }),
        decideProviderForConfig: () => ({ provider: 'auto:openai-codex', model: 'gpt-5.6-terra', auth: 'oauth' }),
        getProviderForConfig: () => firstProvider,
        streamLLM,
        trimToBudget,
      } as unknown as AskBareDeps;
      expect(await askBare({ text: 'question', deps })).toEqual({
        provider: 'grok', model: 'grok-4.6', reply: 'fallback answer',
      });
      expect(calls.map(call => call.provider)).toEqual(['openai-codex', 'grok']);
      expect(calls.map(call => call.messages)).toEqual([
        [{ role: 'user', content: 'question' }],
        [{ role: 'user', content: 'question' }],
      ]);
      expect(calls[1]!.opts?.tools).toBeUndefined();
    } finally {
      PROVIDERS.grok = originalGrok!;
    }
  });

  test('rejects an oversized single message before the fake provider is called', async () => {
    let invoked = false;
    const deps = {
      getUserConfig: () => ({ llm: { provider: 'local', model: 'recording-model' } }),
      decideProviderForConfig: () => ({ provider: 'local', model: 'recording-model', auth: 'local' }),
      getProviderForConfig: () => ({ name: 'recording-provider' }),
      streamLLM: async () => { invoked = true; return 'unexpected'; },
      trimToBudget,
    } as unknown as AskBareDeps;
    await expect(askBare({ text: 'x'.repeat(100_000), deps })).rejects.toThrow('input exceeds the 24000-token context budget');
    expect(invoked).toBe(false);
  });

  test('recording fake provider receives only the user message through the actual streaming boundary', async () => {
    const calls: Array<{ messages: LLMMessage[]; opts: LLMOpts | undefined }> = [];
    const fakeProvider = {
      name: 'recording-provider',
      defaultModel: 'recording-model',
      available: () => true,
      async *streamChat(messages: LLMMessage[], opts?: LLMOpts) {
        calls.push({ messages, opts });
        yield { type: 'text' as const, delta: 'first ' };
        yield { type: 'text' as const, delta: 'second' };
      },
    } as LLMProvider;
    const deps = {
      getUserConfig: () => ({ llm: { provider: 'local', model: 'recording-model' } }),
      decideProviderForConfig: () => ({ provider: 'local', model: 'recording-model', auth: 'local' }),
      getProviderForConfig: () => fakeProvider,
      streamLLM,
      trimToBudget,
    } as unknown as AskBareDeps;
    const result = await askBare({ text: 'verbatim\nquestion', provider: 'local', deps });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages).toEqual([{ role: 'user', content: 'verbatim\nquestion' }]);
    expect(calls[0]!.opts?.model).toBe('recording-model');
    expect(calls[0]!.opts?.tools).toBeUndefined();
    expect(result).toEqual({ provider: 'recording-provider', model: 'recording-model', reply: 'first second' });
  });
});
