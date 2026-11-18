// #36714 contract, restored: a CALLER output cap bounds the whole logical request (no automatic length continuation);
// a role default — no caller cap, or one its source marks `maxTokensExplicit: false` (session chat) — continues once.
// The stop is never silent: the caller sees finishReason 'length' and `output-limit-stopped` is logged.
// Fake provider only (no API calls).
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { debug } from './debug/log.js';
import { streamLLM, streamLLMWithTools, type LLMOpts, type LLMProvider } from './llm.js';

let oldMode: string | undefined;
let stopped: Array<{ category: string; data: Record<string, unknown> }> = [];
beforeEach(() => {
  oldMode = process.env.ELANOUS_LLM_MODE;
  process.env.ELANOUS_LLM_MODE = 'real';
  stopped = [];
  spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (event === 'output-limit-stopped') stopped.push({ category, data: (data ?? {}) as Record<string, unknown> });
  }) as typeof debug.log);
});
afterEach(() => {
  if (oldMode === undefined) delete process.env.ELANOUS_LLM_MODE;
  else process.env.ELANOUS_LLM_MODE = oldMode;
  mock.restore();
});

/** First reply is cut at length, the second (a continuation, if any) stops. */
function lengthCutProvider() {
  const calls: Array<{ maxTokens?: number; maxTokensExplicit?: boolean }> = [];
  const provider: LLMProvider = {
    name: 'test-caller-cap', defaultModel: 'grok-4.6', available: () => true,
    chat: async function* () { yield ''; },
    streamChat: async function* (_messages, opts) {
      calls.push({ maxTokens: opts?.maxTokens, maxTokensExplicit: opts?.maxTokensExplicit });
      yield { type: 'text', delta: calls.length === 1 ? 'first ' : 'second' };
      yield { type: 'finish', reason: calls.length === 1 ? 'length' : 'stop' };
    },
  };
  return { provider, calls };
}
const tools = [{ name: 'Lookup', description: 'lookup', parameters: { type: 'object' as const, properties: {} } }];
const handlers = () => ({ onText: () => {}, dispatchTool: async () => ({}) });
const CALLER_CAP: LLMOpts = { maxTokens: 1_024 }; // Source: #38265 (the early-answer cap)
/** session/chat.ts shape: a role-default number whose source marks it not explicit. */
const ROLE_DEFAULT: LLMOpts = { maxTokens: 8_192, maxTokensExplicit: false }; // Source: #36714 (long-answer role budget)

test('streamLLM: a caller maxTokens stops at length — exactly 1 request, finishReason length, stop logged', async () => {
  const { provider, calls } = lengthCutProvider();
  const reasons: string[] = [];
  const answer = await streamLLM([{ role: 'user', content: 'q' }], () => {}, {
    ...CALLER_CAP, provider, onFinishReason: (reason) => reasons.push(reason),
  });
  expect(answer).toBe('first ');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.maxTokens).toBe(CALLER_CAP.maxTokens);
  expect(reasons).toEqual(['length']);
  expect(stopped).toEqual([expect.objectContaining({ category: 'llm', data: expect.objectContaining({ reason: 'caller-cap' }) })]);
});

test('streamLLMWithTools (tools): a caller maxTokens stops at length — exactly 1 request, finishReason length', async () => {
  const { provider, calls } = lengthCutProvider();
  const reasons: string[] = [];
  const answer = await streamLLMWithTools([{ role: 'user', content: 'q' }], handlers(), {
    ...CALLER_CAP, provider, tools, maxTurns: 2, // Source: #36522
    onFinishReason: (reason) => reasons.push(reason),
  });
  expect(answer).toContain('first');
  expect(answer).not.toContain('second');
  expect(calls).toHaveLength(1);
  expect(reasons).toContain('length');
  expect(stopped).toEqual([expect.objectContaining({ category: 'llm.stream', data: expect.objectContaining({ reason: 'caller-cap' }) })]);
});

test('streamLLMWithTools (no tools → streamLLM delegation): a caller maxTokens also stops at 1 request', async () => {
  const { provider, calls } = lengthCutProvider();
  await streamLLMWithTools([{ role: 'user', content: 'q' }], handlers(), { ...CALLER_CAP, provider, tools: [] });
  expect(calls).toHaveLength(1);
  expect(stopped.map(entry => entry.category)).toEqual(['llm']);
});

test('the chat role default (maxTokensExplicit: false) still continues once, on both paths', async () => {
  const plain = lengthCutProvider();
  expect(await streamLLM([{ role: 'user', content: 'q' }], () => {}, { ...ROLE_DEFAULT, provider: plain.provider })).toBe('first second');
  expect(plain.calls).toHaveLength(2);
  const withTools = lengthCutProvider();
  const answer = await streamLLMWithTools([{ role: 'user', content: 'q' }], handlers(), {
    ...ROLE_DEFAULT, provider: withTools.provider, tools, maxTurns: 2, // Source: #36522
  });
  expect(answer).toBe('first second');
  expect(withTools.calls).toHaveLength(2);
  expect(stopped).toEqual([]);
  // #38293 review r1: the provider layer never continues on its own too — every request it sees marks its cap explicit,
  // so one cut answer is at most 2 requests (not 4).
  for (const call of [...plain.calls, ...withTools.calls]) expect(call.maxTokensExplicit).toBe(true);
});
