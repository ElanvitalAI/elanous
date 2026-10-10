import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listChecklist } from '../release-loop/checklist.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { lookupLlmTierSpec } from '../model-tier/llm-tier-map.js';
import { clearSessionTierOverride, setSessionTierOverride } from '../model-tier/session-override.js';
import type { RunTurnOpts, RunTurnResult } from '../session/chat.js';
import { makeElanousAgentRunTurn } from './monad-agent-turn.js';

const tierSessionId = 'telegram-explicit-tier-test';
const tempDirs: string[] = [];
afterEach(() => {
  clearSessionTierOverride(tierSessionId);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.ELANOUS_STATE_DIR;
  resetElanousConfigDir();
});

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

describe('empty final answer after tool calls', () => {
  const toolOnlyResult = (): RunTurnResult => ({
    text: '', provider: 'fake', model: 'fake-model', usedTokens: 1, droppedMessages: 0, memoryIds: [], meta: {} as never,
  });
  const emptyAnswerEvents = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter((call) => call[0] === 'agent.turn' && call[1] === 'empty-answer');

  test('a tool-only turn is observed once and the retry turn supplies the answer from the tool results', async () => {
    const spy = spyOn(debug, 'log');
    try {
      const prompts: string[] = [];
      const toolCounts: number[] = [];
      const result = await makeElanousAgentRunTurn(config, 'telegram', async (opts) => {
        prompts.push(opts.userText);
        toolCounts.push(opts.tools?.length ?? 0);
        if (prompts.length === 1) {
          opts.onToolCall?.({ id: 't1', name: 'Read', args: {} });
          opts.onToolResult?.({ id: 't1', name: 'Read', result: { content: 'RELEASE-READY-42' } });
          return toolOnlyResult();
        }
        return { ...toolOnlyResult(), text: '발행 준비는 끝났습니다.' };
      })({ userConfig: config, sessionId: 'empty-answer-session', userText: '발행 준비 상태?' });
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain('발행 준비 상태?');
      expect(prompts[1]).toContain('RELEASE-READY-42');
      expect(toolCounts[1]).toBe(0);
      expect(result.text).toContain('발행 준비는 끝났습니다.');
      expect(emptyAnswerEvents(spy)).toHaveLength(1);
      expect(emptyAnswerEvents(spy)[0]![2]).toMatchObject({ surface: 'telegram', toolCalls: 1, recovered: true });
    } finally {
      spy.mockRestore();
    }
  });

  test('when the retry is empty too the user gets a failure sentence, not just the footer', async () => {
    const spy = spyOn(debug, 'log');
    try {
      let calls = 0;
      const deltas: string[] = [];
      const result = await makeElanousAgentRunTurn(config, 'telegram', async (opts) => {
        calls++;
        opts.onToolCall?.({ id: `t${calls}`, name: 'Read', args: {} });
        return toolOnlyResult();
      })({ userConfig: config, sessionId: 'empty-answer-session', userText: 'question', onDelta: (delta) => deltas.push(delta) });
      expect(calls).toBe(2);
      expect(result.text).toContain('답을 만들지 못했다 — 툴 1개 실행');
      expect(result.text).toContain('elanous');
      expect(result.text.trim().startsWith('답')).toBe(false);
      expect(deltas).toEqual([]);
      expect(emptyAnswerEvents(spy)).toHaveLength(1);
      expect(emptyAnswerEvents(spy)[0]![2]).toMatchObject({ toolCalls: 1, recovered: false });
    } finally {
      spy.mockRestore();
    }
  });

  test('a /cancel that lands during the retry turn answers as cancelled, not with the retry text', async () => {
    const controller = new AbortController();
    let calls = 0;
    const result = await makeElanousAgentRunTurn(config, 'telegram', async (opts) => {
      calls++;
      if (calls === 1) {
        opts.onToolCall?.({ id: 't1', name: 'Read', args: {} });
        return toolOnlyResult();
      }
      controller.abort();
      return { ...toolOnlyResult(), text: 'retry answer' };
    })({ userConfig: config, sessionId: 'empty-answer-session', userText: 'question', signal: controller.signal });
    expect(calls).toBe(2);
    expect(result.text).toContain('/cancel');
    expect(result.text.includes('retry answer')).toBe(false);
    expect(result.text.includes('답을 만들지 못했다')).toBe(false);
  });

  test('a retry that throws still ends in the failure sentence', async () => {
    let calls = 0;
    const result = await makeElanousAgentRunTurn(config, 'telegram', async (opts) => {
      calls++;
      if (calls > 1) throw new Error('llm down');
      opts.onToolCall?.({ id: 't1', name: 'Read', args: {} });
      return toolOnlyResult();
    })({ userConfig: config, sessionId: 'empty-answer-session', userText: 'question' });
    expect(result.text).toContain('답을 만들지 못했다 — 툴 1개 실행');
  });

  test('turns with text after the tool, a cancelled turn, an empty no-tool turn and a non-Telegram surface never start a retry', async () => {
    const spy = spyOn(debug, 'log');
    try {
      let calls = 0;
      const normal = await makeElanousAgentRunTurn(config, 'telegram', (opts) => { calls++; return fakeTurn(opts); })({
        userConfig: config, sessionId: 'empty-answer-session', userText: 'question',
      });
      expect(calls).toBe(1);
      expect(normal.text.startsWith('Final answer.\n\n')).toBe(true);
      const controller = new AbortController();
      controller.abort();
      const cancelled = await makeElanousAgentRunTurn(config, 'telegram', async (opts) => {
        calls++;
        opts.onToolCall?.({ id: 't1', name: 'Read', args: {} });
        return toolOnlyResult();
      })({ userConfig: config, sessionId: 'empty-answer-session', userText: 'question', signal: controller.signal });
      expect(calls).toBe(2);
      expect(cancelled.text).toContain('/cancel');
      const noTool = await makeElanousAgentRunTurn(config, 'telegram', async () => { calls++; return toolOnlyResult(); })({
        userConfig: config, sessionId: 'empty-answer-session', userText: 'question',
      });
      expect(calls).toBe(3);
      expect(noTool.text.includes('답을 만들지 못했다')).toBe(false);
      const discord = await makeElanousAgentRunTurn(config, 'discord', async (opts) => {
        calls++;
        opts.onToolCall?.({ id: 't1', name: 'Read', args: {} });
        return toolOnlyResult();
      })({ userConfig: config, sessionId: 'empty-answer-session', userText: 'question' });
      expect(calls).toBe(4);
      expect(discord.text.includes('답을 만들지 못했다')).toBe(false);
      expect(emptyAnswerEvents(spy)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

test('telegram messenger passes verified owner and the originating confirmation channel through its real tool dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-messenger-'));
  tempDirs.push(root);
  setElanousConfigDir(root);
  process.env.ELANOUS_STATE_DIR = root;
  let asked = 0;
  const channel = { name: 'telegram', request: async () => { asked++; return true; }, cancel: () => {} };
  const args = { action: 'add-item', version: '0.2.11', id: 'MESSENGER', title: '텔레그램' };
  const seen: unknown[] = [];
  const fake = async (opts: RunTurnOpts): Promise<RunTurnResult> => {
    seen.push(await opts.dispatchTool!('release_change', args));
    return { text: 'ok', provider: 'fake', model: 'fake-model', usedTokens: 1, droppedMessages: 0, memoryIds: [], meta: {} as never };
  };
  const turn = makeElanousAgentRunTurn(config, 'telegram', fake);
  await turn({ userConfig: config, sessionId: 'owner-session', userText: '칸 추가',
    verifiedOwner: { id: 'telegram:123' }, hitlConfirmChannel: channel });
  expect(asked).toBe(1);
  expect(seen[0]).toContain('변경했습니다');
  expect(listChecklist('0.2.11').items[0]?.updatedBy).toBe('telegram:123');
  await turn({ userConfig: config, sessionId: 'not-owner', userText: '칸 추가', hitlConfirmChannel: channel });
  expect(seen[1]).toContain('오너');
  expect(asked).toBe(1);
  expect(listChecklist('0.2.11').items).toHaveLength(1);
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
