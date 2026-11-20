/** OP #114563 (RES 61266: synthesis 36.9 s for a ≈3,000-token answer to a «three lines» request): the web-turn final
 * synthesis carries an output-token cap derived from the budget reserve, scaled down when research overran, and the user's
 * explicit format request wins over deep-continuation structure. Expected values are derived from the exported constants. */
import type { LLMToolSpec } from '../llm/tool-spec.js';
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';

import * as llmModule from '../llm.js';
import * as surfaceModule from '../session-runtime/index.js';
import * as deferredModule from '../session-runtime/tier-flip.js';
import {
  RESEARCH_NO_PROCESS_NARRATION_RULE, RESEARCH_SYNTHESIS_MAX_OUTPUT_TOKENS, RESEARCH_SYNTHESIS_MIN_OUTPUT_TOKENS, RESEARCH_SYNTHESIS_TOKENS_PER_SECOND,
  RESEARCH_TURN_BUDGET_MS, RESEARCH_TURN_SYNTHESIS_RESERVE_MS, RESEARCH_USER_FORMAT_PRECEDENCE_RULE,
  resolveResearchSynthesisMaxOutputTokens,
} from './research-policy.js';
import { runCoreTurn } from './run-core-turn.js';

const tool: LLMToolSpec = { name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: {} } };

beforeEach(() => {
  spyOn(surfaceModule, 'resolveSessionSurfaceProfile').mockReturnValue({
    id: 'chat', selectionReason: 'test', baselineContexts: [], defaultFamilies: [], conditionalFamilies: [],
  } as unknown as ReturnType<typeof surfaceModule.resolveSessionSurfaceProfile>);
  spyOn(deferredModule, 'applyDeferredTools').mockImplementation((messages, tools) => ({
    messages: [...messages], tools: [...tools],
    stats: { activeCount: tools.length, deferredCount: 0, warmPreloaded: [], injected: false, deferredNames: [], unhydratableNames: [], unhydratableCount: 0 },
  } as unknown as ReturnType<typeof deferredModule.applyDeferredTools>));
});
afterEach(() => mock.restore());

async function runResearchSynthesis(researchTakesMs: number) {
  const request = 'compare bond yield changes';
  let clock = 1_000_000;
  const calls: Array<{ maxTokens?: number; maxTokensExplicit?: boolean; rules: string }> = [];
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, _handlers, options) => {
    calls.push({
      ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options?.maxTokensExplicit !== undefined ? { maxTokensExplicit: options.maxTokensExplicit } : {}),
      rules: messages.filter(item => item.role === 'system' && typeof item.content === 'string').map(item => item.content as string).join('\n'),
    });
    return calls.length === 1 ? 'initial answer' : 'evidence-reconciled answer';
  });
  await runCoreTurn({
    sessionId: 'synthesis-cap', messages: [{ role: 'user', content: request }],
    tools: [tool], dispatchTool: async () => null, signal: new AbortController().signal, userText: request,
  }, {
    now: () => clock,
    runResearch: async () => { clock += researchTakesMs; return { ok: true, output: 'Counterevidence: yields can fall.' }; },
  });
  return calls;
}

test('the cap is the synthesis reserve at the observed speed, with a named floor', () => {
  expect(RESEARCH_SYNTHESIS_MAX_OUTPUT_TOKENS).toBe(RESEARCH_SYNTHESIS_TOKENS_PER_SECOND * (RESEARCH_TURN_SYNTHESIS_RESERVE_MS / 1_000));
  expect(RESEARCH_SYNTHESIS_MIN_OUTPUT_TOKENS < RESEARCH_SYNTHESIS_MAX_OUTPUT_TOKENS).toBe(true);
  expect(resolveResearchSynthesisMaxOutputTokens({})).toBe(RESEARCH_SYNTHESIS_MAX_OUTPUT_TOKENS);
  expect(resolveResearchSynthesisMaxOutputTokens({ budgetMs: Number.POSITIVE_INFINITY, researchElapsedMs: 0 })).toBe(RESEARCH_SYNTHESIS_MAX_OUTPUT_TOKENS);
  expect(resolveResearchSynthesisMaxOutputTokens({ budgetMs: RESEARCH_TURN_BUDGET_MS, researchElapsedMs: 0 })).toBe(RESEARCH_SYNTHESIS_MAX_OUTPUT_TOKENS);
  expect(resolveResearchSynthesisMaxOutputTokens({ budgetMs: RESEARCH_TURN_BUDGET_MS, researchElapsedMs: RESEARCH_TURN_BUDGET_MS * 2 })).toBe(RESEARCH_SYNTHESIS_MIN_OUTPUT_TOKENS);
});

test('a research synthesis passes the output cap (explicit, so no auto-continuation) and the user-format rule', async () => {
  const calls = await runResearchSynthesis(0);
  expect(calls.length).toBe(2);
  expect(calls[1]!.maxTokens).toBe(RESEARCH_SYNTHESIS_MAX_OUTPUT_TOKENS);
  expect(calls[1]!.maxTokensExplicit).toBe(true);
  expect(calls[1]!.rules).toContain(RESEARCH_USER_FORMAT_PRECEDENCE_RULE);
  expect(calls[1]!.rules).toContain(RESEARCH_NO_PROCESS_NARRATION_RULE);
  expect(calls[0]!.maxTokens).toBeUndefined();
});

test('the cap scales down when research overran into the synthesis reserve', async () => {
  const calls = await runResearchSynthesis(RESEARCH_TURN_BUDGET_MS - RESEARCH_TURN_SYNTHESIS_RESERVE_MS / 2);
  expect(calls[1]!.maxTokens).toBe(RESEARCH_SYNTHESIS_MAX_OUTPUT_TOKENS / 2);
  const overran = await runResearchSynthesis(RESEARCH_TURN_BUDGET_MS * 2);
  expect(overran[1]!.maxTokens).toBe(RESEARCH_SYNTHESIS_MIN_OUTPUT_TOKENS);
});

test('a non-research turn carries no synthesis cap', async () => {
  const request = 'hello there';
  const seen: Array<number | undefined> = [];
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, _handlers, options) => { seen.push(options?.maxTokens); return 'hi'; });
  await runCoreTurn({
    sessionId: 'plain', messages: [{ role: 'user', content: request }],
    tools: [tool], dispatchTool: async () => null, signal: new AbortController().signal, userText: request,
  }, {});
  expect(seen.some(() => true)).toBe(true);
  expect(seen.every(value => value === undefined)).toBe(true);
});

test('the format-precedence rule keeps source links and the 미확인 label outside the requested length (JUD #114615)', () => {
  expect(RESEARCH_USER_FORMAT_PRECEDENCE_RULE).toContain('source links and the 미확인 label are not part of the requested length');
  expect(RESEARCH_USER_FORMAT_PRECEDENCE_RULE).toContain('one short sources line outside it');
});
