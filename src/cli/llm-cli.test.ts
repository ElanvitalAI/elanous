import { afterEach, describe, expect, test } from 'bun:test';
import { llmQuery, type LlmQueryDeps } from './llm-cli.js';
import { PROVIDERS, streamLLM, type LLMMessage, type LLMOpts, type LLMProvider } from '../llm.js';
import { setUserConfigOverlay } from '../user-config.js';
import { trimToBudget } from '../tokens.js';
import { simCli } from '../ux-sim/in-process-cli.js';

describe('llmQuery', () => {
  afterEach(() => { setUserConfigOverlay(null); });
  test('ask requires a prompt and the removed ask --bare flag is rejected', async () => {
    const missingPrompt = await simCli(['ask'], { allowPaths: [['ask']] });
    expect(missingPrompt.exitCode).toBe(1);
    expect(missingPrompt.stderr).toContain("missing required argument 'text'");

    const oldFlag = await simCli(['ask', '--bare', 'question'], { allowPaths: [['ask']] });
    expect(oldFlag.exitCode).toBe(1);
    expect(oldFlag.stderr).toContain("unknown option '--bare'");

    const llmHelp = await simCli(['llm', '--help'], { allowPaths: [['llm']] });
    expect(llmHelp.exitCode).toBe(0);
    expect(llmHelp.stdout).toContain('without Elanous context, tools, or a session');
    expect(llmHelp.stdout).toContain('detect');

    const detectHelp = await simCli(['llm', 'detect', '--help'], { allowPaths: [['llm'], ['llm', 'detect']] });
    expect(detectHelp.exitCode).toBe(0);
    expect(detectHelp.stdout).toContain('이 기계에 이미 있는 구독·키');
  });
  test('forwards the unmodified text as its only message with no system prompt or tools', async () => {
    const calls: Array<{ messages: unknown; options: unknown }> = [];
    const deltas: string[] = [];
    const deps = {
      getUserConfig: () => ({ llm: { provider: 'auto', model: '' } }),
      decideProviderForConfig: (_config: unknown, _model?: string) => ({ provider: 'auto:openai-codex', model: 'codex-model', auth: 'oauth' }),
      getProviderForConfig: () => ({ name: 'openai-codex' }),
      streamLLM: async (messages: unknown, _delta: unknown, options: unknown) => {
        calls.push({ messages, options });
        (_delta as (delta: string) => void)('answer');
        (options as { onResolvedProvider: (name: string, model: string) => void }).onResolvedProvider('openai-codex', 'codex-model');
        return 'answer';
      },
      trimToBudget,
    } as unknown as LlmQueryDeps;
    const result = await llmQuery({ text: '  Hello!\n', onDelta: delta => deltas.push(delta), deps });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages).toEqual([{ role: 'user', content: '  Hello!\n' }]);
    expect(calls[0]!.options).toEqual({ initialProvider: { name: 'openai-codex' }, model: 'codex-model', usageSite: 'cli.llm', onResolvedProvider: expect.any(Function) });
    expect(result).toEqual({ provider: 'openai-codex', model: 'codex-model', reply: 'answer' });
    expect(deltas).toEqual(['answer']);
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
    } as unknown as LlmQueryDeps;
    await llmQuery({ text: 'question', provider: 'anthropic', model: 'claude-sonnet-4-5', deps });
    expect(configured).toEqual({ llm: { provider: 'anthropic', model: 'claude-sonnet-4-5', fallbackChain: ['grok'] } });
    expect(requestedModel).toBe('claude-sonnet-4-5');
    expect(streamedOptions).toEqual({
      provider: { name: 'anthropic' },
      model: 'claude-sonnet-4-5',
      usageSite: 'cli.llm',
      onResolvedProvider: expect.any(Function),
    });
  });

  test('a failed first provider falls back through the real streamLLM to a recording provider', async () => {
    // bun test selects the fake LLM by default, which replaces the injected
    // initial provider before streamLLM can fall back. Pin real selection for
    // this case only; both providers stay in-process recordings.
    const priorLlmMode = process.env.ELANOUS_LLM_MODE;
    process.env.ELANOUS_LLM_MODE = 'real';
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
      } as unknown as LlmQueryDeps;
      expect(await llmQuery({ text: 'question', deps })).toEqual({
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
      if (priorLlmMode === undefined) delete process.env.ELANOUS_LLM_MODE;
      else process.env.ELANOUS_LLM_MODE = priorLlmMode;
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
    } as unknown as LlmQueryDeps;
    await expect(llmQuery({ text: 'x'.repeat(100_000), deps })).rejects.toThrow('input exceeds the 24000-token context budget');
    expect(invoked).toBe(false);
  });

  test('recording fake provider receives only the user message through the actual streaming boundary', async () => {
    // The test/sim default answers with test-fake-llm and never calls the
    // injected provider. Select the real stream boundary so this recording
    // provider is the one that receives the user message.
    const priorLlmMode = process.env.ELANOUS_LLM_MODE;
    process.env.ELANOUS_LLM_MODE = 'real';
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
    } as unknown as LlmQueryDeps;
    let result: Awaited<ReturnType<typeof llmQuery>>;
    try {
      result = await llmQuery({ text: 'verbatim\nquestion', provider: 'local', deps });
    } finally {
      if (priorLlmMode === undefined) delete process.env.ELANOUS_LLM_MODE;
      else process.env.ELANOUS_LLM_MODE = priorLlmMode;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages).toEqual([{ role: 'user', content: 'verbatim\nquestion' }]);
    expect(calls[0]!.opts?.model).toBe('recording-model');
    expect(calls[0]!.opts?.tools).toBeUndefined();
    expect(result).toEqual({ provider: 'recording-provider', model: 'recording-model', reply: 'first second' });
  });
});
