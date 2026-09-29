import { describe, expect, test, spyOn } from 'bun:test';
import type { LLMMessage, LLMOpts, LLMProvider } from '../llm.js';
import { probeProvider } from './provider-probe.js';

function fakeProvider(chat: LLMProvider['chat']): LLMProvider {
  return { name: 'fixture', defaultModel: 'fixture-model', available: () => true, chat };
}

describe('probeProvider', () => {
  test('requests exactly one tool-free turn with the probe prompt and 16-token maximum', async () => {
    const calls: Array<{ messages: LLMMessage[]; opts: LLMOpts | undefined }> = [];
    const provider = fakeProvider(async function* (messages, opts) {
      calls.push({ messages, opts });
      yield 'sensitive response';
    });
    const result = await probeProvider(provider);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages).toEqual([{ role: 'user', content: 'Reply with OK.' }]);
    expect(calls[0]?.opts).toMatchObject({ model: 'fixture-model', maxTokens: 16, tools: [], toolChoice: 'none' });
    expect(calls[0]?.opts?.signal).toBeInstanceOf(AbortSignal);
    expect(result.success).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.model).toBe('fixture-model');
    expect(Object.keys(result).sort()).toEqual(['durationMs', 'model', 'success']);
    expect(JSON.stringify(result)).not.toContain('sensitive response');
  });

  test('an empty response fails without exposing response content', async () => {
    const result = await probeProvider(fakeProvider(async function* () { yield ''; }));
    expect(result).toMatchObject({ success: false, model: 'fixture-model', error: 'empty response' });
    expect(Object.keys(result).sort()).toEqual(['durationMs', 'error', 'model', 'success']);
  });

  test('provider errors never expose credentials or raw exception text', async () => {
    const result = await probeProvider(fakeProvider(async function* () {
      throw new Error('Authorization failed: key=secret-value');
    }));
    expect(result).toMatchObject({ success: false, model: 'fixture-model', error: 'probe failed' });
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  test('uses a 30-second deadline by default', async () => {
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout');
    try {
      const result = await probeProvider(fakeProvider(async function* () { yield 'OK'; }));
      expect(result.success).toBe(true);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test('configurable deadline aborts a hung turn and returns a safe timeout', async () => {
    let signal: AbortSignal | undefined;
    let calls = 0;
    const provider = fakeProvider(async function* (_messages, opts) {
      calls++;
      signal = opts?.signal;
      await new Promise<void>(() => {});
      yield 'unreachable';
    });
    const started = performance.now();
    const result = await probeProvider(provider, { timeoutMs: 15 });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(calls).toBe(1);
    expect(signal?.aborted).toBe(true);
    expect(result).toMatchObject({ success: false, model: 'fixture-model', error: 'timeout' });
    expect(Object.keys(result).sort()).toEqual(['durationMs', 'error', 'model', 'success']);
  });
});
