import { expect, test } from 'bun:test';
import { classifyIntakeFrontRoute } from './front-route-classifier.js';
import type { StreamLlmFn } from './runtime-callables.js';

const input = '글의 목적이 모호함';
const roleCalls: string[] = [];
const resolveRoleProvider = (role: string) => {
  roleCalls.push(role);
  return { provider: { name: 'stub' }, model: 'test-model' };
};
const reply = (response: string): StreamLlmFn => async (_messages, _onChunk, opts) => {
  expect(opts?.provider?.name).toBe('stub');
  expect(opts?.model).toBe('test-model');
  expect(opts?.usageRole).toBe('classify');
  return response;
};

test('high-confidence graph response retains the classifier decision and uses classify exactly once', async () => {
  roleCalls.length = 0;
  const result = await classifyIntakeFrontRoute(input, {
    resolveRoleProvider,
    streamLLM: reply('{"track":"graph","confidence":0.8,"reason":"x"}'),
  });
  expect(result).toEqual({ track: 'graph', confidence: 0.8, reason: 'x', decidedBy: 'classifier' });
  expect(roleCalls).toEqual(['classify']);
});

test('low confidence folds to human with original confidence and track', async () => {
  const result = await classifyIntakeFrontRoute(input, {
    resolveRoleProvider,
    streamLLM: reply('{"track":"graph","confidence":0.3,"reason":"x"}'),
  });
  expect(result).toEqual({
    track: 'ask-human', confidence: 0.3, reason: 'classifier-low-confidence:graph', decidedBy: 'classifier',
  });
});

test('invalid track folds to human', async () => {
  const result = await classifyIntakeFrontRoute(input, {
    resolveRoleProvider,
    streamLLM: reply('{"track":"deploy","confidence":0.9,"reason":"x"}'),
  });
  expect(result).toMatchObject({ track: 'ask-human', confidence: 0, decidedBy: 'classifier' });
  expect(result.reason.startsWith('classifier-failed:')).toBe(true);
});

test('non-JSON response folds to human', async () => {
  const result = await classifyIntakeFrontRoute(input, {
    resolveRoleProvider, streamLLM: reply('이건 JSON 아님'),
  });
  expect(result).toMatchObject({ track: 'ask-human', confidence: 0, decidedBy: 'classifier' });
  expect(result.reason.startsWith('classifier-failed:')).toBe(true);
});

test('thrown LLM call folds to human', async () => {
  const result = await classifyIntakeFrontRoute(input, {
    resolveRoleProvider,
    streamLLM: async () => { throw new Error('private input must not be logged'); },
  });
  expect(result).toMatchObject({ track: 'ask-human', confidence: 0, decidedBy: 'classifier' });
  expect(result.reason.startsWith('classifier-failed:')).toBe(true);
  expect(result.reason).not.toContain('private input');
});

test('invalid confidence folds to human, while the injected threshold controls low confidence', async () => {
  for (const confidence of [-1, 1.1, '0.9', null]) {
    const result = await classifyIntakeFrontRoute(input, {
      resolveRoleProvider,
      streamLLM: reply(JSON.stringify({ track: 'graph', confidence, reason: 'x' })),
    });
    expect(result).toMatchObject({ track: 'ask-human', confidence: 0, decidedBy: 'classifier' });
    expect(result.reason.startsWith('classifier-failed:')).toBe(true);
  }
  const result = await classifyIntakeFrontRoute(input, {
    resolveRoleProvider,
    minConfidence: 0.2,
    streamLLM: reply('{"track":"graph","confidence":0.3,"reason":"x"}'),
  });
  expect(result).toEqual({ track: 'graph', confidence: 0.3, reason: 'x', decidedBy: 'classifier' });
});

test('a fenced or prefaced JSON reply is still read — real models wrap JSON', async () => {
  const fenced = await classifyIntakeFrontRoute(input, {
    resolveRoleProvider,
    streamLLM: reply('```json\n{"track":"absorb","confidence":0.9,"reason":"x"}\n```'),
  });
  expect(fenced).toEqual({ track: 'absorb', confidence: 0.9, reason: 'x', decidedBy: 'classifier' });
  const prefaced = await classifyIntakeFrontRoute(input, {
    resolveRoleProvider,
    streamLLM: reply('분류 결과: {"track":"tasks","confidence":0.7,"reason":"x"}'),
  });
  expect(prefaced.track).toBe('tasks');
});
