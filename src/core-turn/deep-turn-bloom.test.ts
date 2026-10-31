import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { LLMToolSpec } from '../llm.js';
import * as llmModule from '../llm.js';
import { runCoreTurn } from './run-core-turn.js';
import {
  buildDeepBloomInstruction, buildResearchBloom45Directive, selectDeepBloom,
} from './deep-turn-bloom.js';

afterEach(() => mock.restore());

describe('default deep Bloom frame', () => {
  it('selects research, analysis/evaluation, and high effort while leaving light turns unchanged', () => {
    expect(selectDeepBloom('latest bond outlook', { researchIntent: true })).toEqual({ apply: true, reason: 'research-intent' });
    expect(selectDeepBloom('채권 금리의 원인을 분석하고 대안을 평가해줘')).toEqual({ apply: true, reason: 'deep-question' });
    expect(selectDeepBloom('Walk through the issue', { reasoningEffort: 'xhigh' })).toEqual({ apply: true, reason: 'high-reasoning-effort' });
    for (const text of ['안녕하세요', 'What is the capital of France?', 'Translate this sentence']) {
      expect(selectDeepBloom(text, { reasoningEffort: 'max' })).toEqual({ apply: false, reason: 'lightweight' });
    }
    expect(selectDeepBloom('Tell me a simple fact')).toEqual({ apply: false, reason: 'no-deep-signal' });
  });

  it('builds a same-call private prompt from existing Bloom 4/5 cells and the exemplar bank', async () => {
    const result = await buildDeepBloomInstruction('채권 금리 전망', 'deep-question');
    expect(result).toMatchObject({ apply: true, reason: 'deep-question', levels: [4, 5], questionCount: 4 });
    expect(result.prompt).toContain('analyze/conceptual');
    expect(result.prompt).toContain('evaluate/metacognitive');
    expect(result.prompt).toContain('3–5 short questions');
    expect(result.prompt).toContain('Bloom exemplar examples');
    expect(result.exemplarLevels).toEqual([4, 5]);
  });

  it('asks the research ladder for distinct analysis and criteria-based evaluation axes', async () => {
    const prompt = await buildResearchBloom45Directive();
    expect(prompt).toContain('level 4 (analyze/conceptual)');
    expect(prompt).toContain('level 5 (evaluate/metacognitive)');
    expect(prompt).toContain('counterargument');
  });

  it('injects the private frame into the same first LLM call and forwards reasoning effort', async () => {
    let sentMessages: Array<{ role: string; content: unknown }> = [];
    let sentEffort: string | undefined;
    const tool: LLMToolSpec = { name: 'Read', description: 'Read', parameters: { type: 'object', properties: {} } };
    spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, _handlers, options) => {
      sentMessages = messages.map(({ role, content }) => ({ role, content }));
      sentEffort = options?.reasoningEffort;
      return 'answer';
    });
    await runCoreTurn({
      sessionId: 'deep-bloom-integration',
      userText: '이 소프트웨어 구조의 원인을 분석하고 대안을 평가해줘',
      messages: [{ role: 'user', content: '이 소프트웨어 구조의 원인을 분석하고 대안을 평가해줘' }],
      tools: [tool], dispatchTool: async () => null, signal: new AbortController().signal,
      reasoningEffort: 'high',
    });
    const system = sentMessages.filter((message) => message.role === 'system').map((message) => String(message.content)).join('\n');
    expect(system).toContain('3–5 short questions');
    expect(system).toContain('evaluate/metacognitive');
    expect(sentEffort).toBe('high');
  });
});
