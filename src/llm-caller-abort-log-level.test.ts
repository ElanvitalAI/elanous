import { expect, spyOn, test } from 'bun:test';
import { debug } from './debug/log.js';
import { streamLLM, type LLMProvider } from './llm.js';

/** WEBCHAT-SHORT-FACT-NOT-RESEARCH: a failure that is the CALLER'S own abort (the research route skipping its plan
 * call) is not a provider error — the `llm.router.error` row must not be error level; a real failure stays error. */
function failingProvider(abort?: AbortController): LLMProvider {
  return {
    name: 'abort-probe', defaultModel: 'abort-probe-model', available: () => true,
    async *chat() { yield 'unused'; },
    // eslint-disable-next-line require-yield
    async *streamChat() {
      abort?.abort(new Error('Structured route: research skipped'));
      throw new Error('Structured route: research skipped');
    },
  };
}

async function routerErrorLevels(provider: LLMProvider, signal?: AbortSignal): Promise<Array<string | undefined>> {
  const levels: Array<string | undefined> = [];
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, _data?: unknown, opts?: { level?: string }) => {
    if (category === 'llm.router.error' && event === 'streamLLM') levels.push(opts?.level);
  }) as typeof debug.log);
  try {
    await streamLLM([{ role: 'user', content: 'q' }], () => {}, { provider, ...(signal ? { signal } : {}) }).catch(() => undefined);
  } finally { log.mockRestore(); }
  return levels;
}

test('a caller-aborted stream logs llm.router.error below error level', async () => {
  const controller = new AbortController();
  expect(await routerErrorLevels(failingProvider(controller), controller.signal)).toEqual(['info']);
});

test('a genuine provider failure (no caller abort) stays error level', async () => {
  expect(await routerErrorLevels(failingProvider())).toEqual(['error']);
});
