import { expect, test } from 'bun:test';
import {
  attachFinalAnswerSupplement,
  streamLLMWithTools,
  type FinalAnswerSupplementAttachment,
  type FinalAnswerSupplementAttachmentRequest,
  type LLMProvider,
  type LLMToolSpec,
} from '../src/llm.js';

const noopTool: LLMToolSpec = {
  name: 'noop',
  description: 'does nothing',
  parameters: { type: 'object', properties: {} },
};

function fakeProvider(finalAnswer: string): LLMProvider {
  return {
    name: 'fake-final-answer',
    defaultModel: 'fake-model',
    available: () => true,
    async *chat() { yield finalAnswer; },
    async *streamChat() {
      yield { type: 'text', delta: finalAnswer };
    },
  };
}

test('attachFinalAnswerSupplement appends the supplement after the final answer text', () => {
  const provider: FinalAnswerSupplementAttachment = () => '검증 보충: 최신성 확인';
  const out = attachFinalAnswerSupplement(
    { onAppendFinalAnswerSupplement: provider },
    { answer: 'the answer', finalText: 'the answer' },
  );
  expect(out).toBe('the answer\n\n검증 보충: 최신성 확인');
});

test('attachFinalAnswerSupplement keeps the final answer unchanged when the handler yields nothing', () => {
  for (const supplement of [undefined, null, '', '   '] as const) {
    const out = attachFinalAnswerSupplement(
      { onAppendFinalAnswerSupplement: () => supplement },
      { answer: 'the answer', finalText: 'the answer' },
    );
    expect(out).toBe('the answer');
  }
});

test('attachFinalAnswerSupplement keeps the final answer unchanged when the option is omitted', () => {
  const out = attachFinalAnswerSupplement({}, { answer: 'the answer', finalText: 'the answer' });
  expect(out).toBe('the answer');
});

test('onAppendFinalAnswerSupplement is invoked after the final answer and its text is appended to the output', async () => {
  const requests: FinalAnswerSupplementAttachmentRequest[] = [];
  const supplements: { answer: string; supplement: string; finalText: string }[] = [];
  const finalTexts: string[] = [];
  const calls: unknown[][] = [];
  const result = await streamLLMWithTools(
    [{ role: 'user', content: 'question' }],
    {
      dispatchTool: async () => 'ok',
      onText: (_delta, full) => { calls.push([_delta, full]); finalTexts.push(full); },
      onFinalAnswerSupplement: (info) => supplements.push(info),
      onAppendFinalAnswerSupplement: (req) => {
        requests.push(req);
        return '\n루프 마감 문구';
      },
    },
    { provider: fakeProvider('the answer'), tools: [noopTool] },
  );
  expect(requests).toEqual([{ answer: 'the answer', finalText: 'the answer' }]);
  expect(result).toBe('the answer\n\n루프 마감 문구');
  expect(supplements).toEqual([
    { answer: 'the answer', supplement: '루프 마감 문구', finalText: 'the answer\n\n루프 마감 문구' },
  ]);
  // the appended supplement was streamed to the final answer output
  expect(finalTexts).toContain('the answer\n\n루프 마감 문구');
});

test('omitting onAppendFinalAnswerSupplement preserves prior final-answer behavior', async () => {
  const supplements: { answer: string; supplement: string; finalText: string }[] = [];
  const finalTexts: string[] = [];
  const result = await streamLLMWithTools(
    [{ role: 'user', content: 'question' }],
    {
      dispatchTool: async () => 'ok',
      onText: (_delta, full) => finalTexts.push(full),
      onFinalAnswerSupplement: (info) => supplements.push(info),
    },
    { provider: fakeProvider('the answer'), tools: [noopTool] },
  );
  expect(result).toBe('the answer');
  expect(supplements).toEqual([]);
  expect(finalTexts).toEqual(['the answer']);
});