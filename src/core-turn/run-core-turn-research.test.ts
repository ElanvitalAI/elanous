import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { LLMToolSpec } from '../llm.js';
import * as llmModule from '../llm.js';
import * as surfaceModule from '../session-runtime/index.js';
import * as deferredModule from '../session-runtime/tier-flip.js';
import { runCoreTurn } from './run-core-turn.js';

const tool: LLMToolSpec = {
  name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: {} },
};
const signal = new AbortController().signal;

beforeEach(() => {
  spyOn(llmModule, 'streamLLMWithTools').mockResolvedValue('done');
  spyOn(surfaceModule, 'resolveSessionSurfaceProfile').mockReturnValue({
    id: 'chat', selectionReason: 'test', baselineContexts: [], defaultFamilies: [], conditionalFamilies: [],
  } as unknown as ReturnType<typeof surfaceModule.resolveSessionSurfaceProfile>);
  spyOn(deferredModule, 'applyDeferredTools').mockImplementation((messages, tools) => ({
    messages: [...messages], tools: [...tools],
    stats: {
      activeCount: tools.length, deferredCount: 0, warmPreloaded: [], injected: false,
      deferredNames: [], unhydratableNames: [], unhydratableCount: 0,
    },
  } as unknown as ReturnType<typeof deferredModule.applyDeferredTools>));
});

afterEach(() => mock.restore());

test('uses shared research-turn intent in chat surface and injects Bloom evidence', async () => {
  const request = 'compare bond yield changes';
  let calls = 0;
  let researchTurn: boolean | undefined;
  let injected = '';
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, _handlers, options) => {
    researchTurn = options?.researchTurn;
    const message = messages.find((item) => item.role === 'system'
      && typeof item.content === 'string' && item.content.includes('<bloom-research>'));
    injected = typeof message?.content === 'string' ? message.content : '';
    return 'done';
  });
  await runCoreTurn({
    sessionId: 'research-chat-surface',
    messages: [{ role: 'user', content: request }],
    tools: [tool], dispatchTool: async () => null, signal, userText: request,
  }, { runResearch: async (text) => {
    calls += 1;
    expect(text).toBe(request);
    return { ok: true, output: 'Counterevidence: yields can fall when inflation expectations decline.' };
  } });

  expect(calls).toBe(1);
  expect(researchTurn).toBe(true);
  expect(injected).toContain('Counterevidence');
});

test('does not invoke the Bloom research pipeline for a non-research TUI turn', async () => {
  let calls = 0;
  await runCoreTurn({
    sessionId: 'ordinary-chat-turn',
    messages: [{ role: 'user', content: 'Say hello.' }],
    tools: [tool], dispatchTool: async () => null, signal, userText: 'Say hello.',
  }, { runResearch: async () => {
    calls += 1;
    return { ok: true, output: 'unexpected evidence' };
  } });
  expect(calls).toBe(0);
});
