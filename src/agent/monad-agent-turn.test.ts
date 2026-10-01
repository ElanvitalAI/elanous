import { afterEach, describe, expect, test } from 'bun:test';
import { lookupLlmTierSpec } from '../model-tier/llm-tier-map.js';
import { clearSessionTierOverride, setSessionTierOverride } from '../model-tier/session-override.js';
import type { RunTurnOpts, RunTurnResult } from '../session/chat.js';
import { makeElanousAgentRunTurn } from './monad-agent-turn.js';

const tierSessionId = 'telegram-explicit-tier-test';
afterEach(() => clearSessionTierOverride(tierSessionId));

const config = {
  llm: { provider: 'fake', model: 'fake-model' },
  finance: { enabled: false },
} as never;

function fakeTurn(opts: RunTurnOpts): Promise<RunTurnResult> {
  opts.onDelta?.('Before the tool. ');
  opts.onToolCall?.({ id: 'fake', name: 'Read', args: {} });
  opts.onToolResult?.({ id: 'fake', name: 'Read', result: { ok: true } });
  opts.onDelta?.('Final ');
  opts.onDelta?.('answer.');
  return Promise.resolve({
    text: 'Before the tool. Final answer.',
    provider: 'fake', model: 'fake-model', usedTokens: 1, droppedMessages: 0,
    memoryIds: [], meta: {} as never,
  });
}

describe('shared messenger agent final answer', () => {
  for (const surface of ['telegram', 'discord'] as const) {
    test(`${surface} displays the last assistant message after a fake tool call`, async () => {
      const deltas: string[] = [];
      const calls: string[] = [];
      const result = await makeElanousAgentRunTurn(config, surface, fakeTurn)({
        userConfig: config, sessionId: 'fake-session', userText: 'question',
        onDelta: (delta) => deltas.push(delta),
        onToolCall: (call) => calls.push(call.name),
      });
      expect(result.text).toContain('Final answer.');
      expect(result.text).not.toContain('Before the tool.');
      expect(deltas.join('')).toBe('Before the tool. Final answer.');
      expect(calls).toEqual(['Read']);
    });
  }

  test('an empty message after a tool call does not display the pre-tool answer', async () => {
    const result = await makeElanousAgentRunTurn(config, 'discord', async (opts) => {
      opts.onDelta?.('Before the tool.');
      opts.onToolCall?.({ id: 'fake', name: 'Read', args: {} });
      return {
        text: 'Before the tool.', provider: 'fake', model: 'fake-model',
        usedTokens: 1, droppedMessages: 0, memoryIds: [], meta: {} as never,
      };
    })({ userConfig: config, sessionId: 'fake-session', userText: 'question' });
    expect(result.text).not.toContain('Before the tool.');
    expect(result.text).toContain('elanous');
  });

  test('no-tool turn keeps its returned answer and footer', async () => {
    const result = await makeElanousAgentRunTurn(config, 'telegram', async (opts) => {
      opts.onDelta?.('Plain answer.');
      return {
        text: 'Plain answer.', provider: 'fake', model: 'fake-model',
        usedTokens: 1, droppedMessages: 0, memoryIds: [], meta: {} as never,
      };
    })({ userConfig: config, sessionId: 'fake-session', userText: 'question' });
    expect(result.text).toContain('Plain answer.');
    expect(result.text).toContain('elanous');
  });
});

describe('messenger codex model precedence', () => {
  const codex = {
    llm: { provider: 'openai-codex', model: 'configured-model', routePolicy: { mode: 'codex-first' } },
    finance: { enabled: false },
  } as never;
  const capture = async (opts: RunTurnOpts): Promise<RunTurnResult> => ({
    text: 'ok', model: opts.llmOpts?.model ?? 'configured-model', provider: 'openai-codex',
    usedTokens: 1, droppedMessages: 0, memoryIds: [], meta: {} as never,
  });

  test('telegram respects explicit session tier over codex route selection', async () => {
    setSessionTierOverride(tierSessionId, { llm: 'budget', rationale: 'user choice' });
    const seen: string[] = [];
    const result = await makeElanousAgentRunTurn(codex, 'telegram', (async (opts: RunTurnOpts) => {
      seen.push(opts.llmOpts?.model ?? '');
      return capture(opts);
    }) as typeof import('../session/chat.js').runTurn)({
      userConfig: codex, sessionId: tierSessionId, userText: 'make a deep plan',
    });
    const expected = lookupLlmTierSpec('openai-codex', 'budget').model;
    expect(seen).toEqual([expected]);
    expect(result.model).toBe(expected);
  });

  test('telegram respects configured tier without a session override', async () => {
    const configured = {
      llm: { provider: 'openai-codex', model: 'configured-model', routePolicy: { mode: 'codex-first' } },
      finance: { enabled: false }, modelTier: { llm: 'budget' },
    } as never;
    let model: string | undefined;
    await makeElanousAgentRunTurn(configured, 'telegram', (async (opts: RunTurnOpts) => {
      model = opts.llmOpts?.model;
      return capture(opts);
    }) as typeof import('../session/chat.js').runTurn)({
      userConfig: configured, sessionId: tierSessionId, userText: 'make a deep plan',
    });
    expect(model).toBe(lookupLlmTierSpec('openai-codex', 'budget').model);
  });

  test('codex routing remains when there is no explicit tier, while a caller pin wins', async () => {
    const seen: string[] = [];
    const wrapped = makeElanousAgentRunTurn(codex, 'telegram', (async (opts: RunTurnOpts) => {
      seen.push(opts.llmOpts?.model ?? '');
      return capture(opts);
    }) as typeof import('../session/chat.js').runTurn);
    const opts = { userConfig: codex, sessionId: tierSessionId, userText: 'make a deep plan' };
    await wrapped(opts);
    expect(seen[0]).toBe(lookupLlmTierSpec('openai-codex', 'best').model);
    setSessionTierOverride(tierSessionId, { llm: 'budget', rationale: 'user choice' });
    await wrapped({ ...opts, llmOpts: { model: 'caller-pin' } });
    expect(seen[1]).toBe('caller-pin');
  });
});
