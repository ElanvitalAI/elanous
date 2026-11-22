// #38293 REVIEW-1 shouldFix 2 — session chat marks the SOURCE of its output cap (src/session/chat.ts tool turn · plain
// turn). Without that line a chat role default would silently stop continuing on `length`. This drives the REAL runTurn
// and the REAL streamLLM / streamLLMWithTools with a fake provider (no API calls): role default → exactly one
// continuation (2 provider requests); caller maxTokens → exactly 1 request and finishReason 'length' reported.
import type { LLMToolSpec } from '../llm/tool-spec.js';
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMOpts, LLMProvider } from '../llm.js';
import * as actualLlm from '../llm.js';
import * as actualMemory from '../memory.js';
import * as actualSurfaceEvents from '../domains/surface-events.js';
import * as actualUserIntent from '../user-intent/index.js';
import { resetAutoCompactStateForTest } from '../compact/auto-state.js';
import { createSession } from './index.js';

let activeProvider: LLMProvider | undefined;
const spies = [
  spyOn(actualMemory, 'buildMemoryInjection').mockReturnValue({ block: '', tokens: 0, injectedIds: [] }),
  spyOn(actualMemory, 'buildMemoryInjectionLLM').mockResolvedValue({ block: '', tokens: 0, injectedIds: [] }),
  spyOn(actualSurfaceEvents, 'openSurfaceEventsDb').mockImplementation(() => ({ close() {} } as never)),
  spyOn(actualSurfaceEvents, 'recallEvents').mockReturnValue([]),
  spyOn(actualUserIntent, 'userIntentLogger').mockImplementation(() => ({ emit: () => null } as never)),
  spyOn(actualLlm, 'getProviderForConfig').mockImplementation(() => activeProvider as LLMProvider),
];
afterAll(() => { for (const spy of spies) spy.mockRestore(); });

const { runTurn } = await import('./chat.js');

let sessionRoot = '';
let previousMode: string | undefined;
beforeEach(() => {
  sessionRoot = mkdtempSync(join(tmpdir(), 'elanous-chat-length-'));
  process.env.ELANOUS_SESSION_ROOT = sessionRoot;
  previousMode = process.env.ELANOUS_LLM_MODE;
  process.env.ELANOUS_LLM_MODE = 'real';
});
afterEach(() => {
  resetAutoCompactStateForTest();
  activeProvider = undefined;
  rmSync(sessionRoot, { recursive: true, force: true });
  delete process.env.ELANOUS_SESSION_ROOT;
  if (previousMode === undefined) delete process.env.ELANOUS_LLM_MODE;
  else process.env.ELANOUS_LLM_MODE = previousMode;
});

/** First reply is cut at length; a continuation (if any) stops. */
function lengthCutProvider() {
  const calls: Array<{ maxTokens?: number }> = [];
  const provider: LLMProvider = {
    name: 'test-provider', defaultModel: 'test-model', available: () => true,
    async *chat() { yield ''; },
    async *streamChat(_messages, opts = {}) {
      calls.push({ maxTokens: opts.maxTokens });
      yield { type: 'text', delta: calls.length === 1 ? 'first ' : 'second' } as const;
      yield { type: 'finish', reason: calls.length === 1 ? 'length' : 'stop' } as const;
    },
  };
  activeProvider = provider;
  return { provider, calls };
}
const tool = (name: string): LLMToolSpec => ({ name, description: `${name} test tool`, parameters: { type: 'object', properties: {} } });

async function chatTurn(provider: LLMProvider, tools: LLMToolSpec[] | undefined, llmOpts?: LLMOpts) {
  const session = createSession({ provider: provider.name, model: provider.defaultModel, source: 'tui' });
  return runTurn({
    userConfig: { chat: {}, llm: { provider: provider.name, model: provider.defaultModel,
      memoryJudge: { enabled: false, crossRecall: false } } } as never,
    sessionId: session.id, userText: 'Explain the direct provider path', systemPrompt: 'base prompt',
    skipMemoryInjection: true, provider,
    ...(tools ? { tools, dispatchTool: async () => ({ ok: true }) } : {}),
    ...(llmOpts ? { llmOpts } : {}),
  });
}

describe('session chat · length continuation follows the source of the cap', () => {
  const paths: Array<[string, LLMToolSpec[] | undefined]> = [
    ['plain turn (streamLLM)', undefined],
    ['tool turn (streamLLMWithTools)', [tool('Read')]],
    ['terminal turn (terminal.llmOpts)', [tool('PtyShellStart')]],
  ];
  for (const [label, tools] of paths) {
    test(`${label}: role default continues once — exactly 2 provider requests`, async () => {
      const { provider, calls } = lengthCutProvider();
      const result = await chatTurn(provider, tools);
      expect(calls).toHaveLength(2);
      expect(result.text).toContain('second');
    });

    test(`${label}: caller maxTokens stops — exactly 1 request, finishReason length`, async () => {
      const { provider, calls } = lengthCutProvider();
      const result = await chatTurn(provider, tools, { maxTokens: 512 }); // Source: #36714 (caller output cap)
      expect(calls).toHaveLength(1);
      expect(calls[0]!.maxTokens).toBe(512);
      expect(result.text).not.toContain('second');
      expect(result.finishReason).toBe('length');
    });
  }
});
