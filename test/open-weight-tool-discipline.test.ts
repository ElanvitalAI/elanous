import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  CODEX_TOOL_DISCIPLINE, GROK_TOOL_DISCIPLINE, OPEN_WEIGHT_TOOL_DISCIPLINE,
  familyMaxTurnsKey, resolveFamilyMaxTurns, selectIntentClassificationMessages, streamLLMWithTools,
  usesLongReasoningIdle,
} from '../src/llm';
import type { LLMMessage, LLMProvider } from '../src/llm';

function capturingProvider() {
  const captured: LLMMessage[][] = [];
  const provider: LLMProvider = {
    name: 'capturing',
    defaultModel: 'd',
    available: () => true,
    async *streamChat(messages) {
      captured.push(messages.map(message => ({ ...message })));
      yield { type: 'text', delta: 'done' } as const;
    },
    async *chat() {},
  };
  return { provider, firstTurn: () => captured[0] ?? [] };
}

async function runWithCapture(model: string) {
  const { provider, firstTurn } = capturingProvider();
  const input: LLMMessage[] = [{ role: 'system', content: 'caller system' }, { role: 'user', content: 'go' }];
  let completed: LLMMessage[] | undefined;
  await streamLLMWithTools(input, {
    onText() {},
    dispatchTool: async () => 'ok',
    onTurnComplete: history => { completed = history; },
  }, {
    provider, tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
    maxTurns: 2, model,
  });
  return { transmitted: firstTurn(), completed, input };
}

describe('open-weight tool discipline', () => {
  test('GLM, Kimi and Qwen transmit the exact independent discipline first', async () => {
    for (const model of [
      'openrouter/z-ai/glm-5.3', 'openrouter/moonshotai/kimi-k3',
      'openrouter/qwen/qwen3.8-flash',
    ]) {
      const { transmitted, completed, input } = await runWithCapture(model);
      expect(transmitted).toEqual([{ role: 'system', content: OPEN_WEIGHT_TOOL_DISCIPLINE }, ...input]);
      expect(completed).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }]);
      expect(input).toEqual([{ role: 'system', content: 'caller system' }, { role: 'user', content: 'go' }]);
    }
  });

  test('native and local families do not receive the open-weight discipline', async () => {
    for (const model of ['gpt-5.6-terra', 'grok-4.6', 'local:gemma-4-26b-a4b-it', 'claude-opus-4-8']) {
      const { transmitted } = await runWithCapture(model);
      expect(transmitted.some(message => message.content === OPEN_WEIGHT_TOOL_DISCIPLINE)).toBe(false);
    }
  });

  test('intent classification filters only the exact injected system content', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: OPEN_WEIGHT_TOOL_DISCIPLINE },
      { role: 'system', content: `${OPEN_WEIGHT_TOOL_DISCIPLINE} ` },
      { role: 'user', content: 'go' },
    ];
    expect(selectIntentClassificationMessages(messages)).toEqual(messages.slice(1));
    expect(OPEN_WEIGHT_TOOL_DISCIPLINE.split('\n')[0]).toBe('[open-weight tool-use discipline]');
    expect(OPEN_WEIGHT_TOOL_DISCIPLINE).toContain('도구 호출이 하나 이상');
    expect(OPEN_WEIGHT_TOOL_DISCIPLINE).toContain('JSON');
    expect(OPEN_WEIGHT_TOOL_DISCIPLINE).toContain('평문');
  });

  test('existing codex and grok bytes remain unchanged', () => {
    expect(createHash('sha256').update(CODEX_TOOL_DISCIPLINE, 'utf8').digest('hex')).toBe('b8623476f31f08d5e1269d7ad5edb4f922c0d820a9cfaccbe41f9756d7151d97');
    expect(createHash('sha256').update(GROK_TOOL_DISCIPLINE, 'utf8').digest('hex')).toBe('49ada854d200fe9355c03f4726a0bc7efb853f9d30d6454f72a7bd15f891ab20');
  });

  test('idle cap and turn budget treat open-weight exactly like other (review r2)', () => {
    for (const provider of [undefined, 'openrouter', 'grok']) {
      expect(usesLongReasoningIdle('open-weight', provider)).toBe(usesLongReasoningIdle('other', provider));
      expect(resolveFamilyMaxTurns('open-weight', provider)).toBe(resolveFamilyMaxTurns('other', provider));
    }
    expect(familyMaxTurnsKey('open-weight')).toBe('default');
    expect(familyMaxTurnsKey('open-weight')).toBe(familyMaxTurnsKey('other'));
  });
});
