import { test, expect } from 'bun:test';
import { rmSync } from 'node:fs';
import { streamLLMWithTools, type LLMMessage, type LLMProvider } from './llm.js';
import { truncateOutput } from './output-truncation.js';

async function getFollowupToolResult(providerName: string, model: string, inlineLimitBytes: number, repeatCount = 12_000) {
  const fullOutput = `HEAD-${'🙂'.repeat(repeatCount)}-TAIL`;
  let calls = 0;
  let followupMessages: LLMMessage[] = [];
  let callbackOutput: unknown;
  const provider: LLMProvider = {
    name: providerName,
    defaultModel: model,
    available: () => true,
    async *chat() { yield 'unused'; },
    async *streamChat(messages, opts) {
      calls++;
      if (calls === 1) {
        yield { type: 'tool_call', id: `large-output-${providerName}`, name: opts?.tools?.[0]?.name ?? 'Read', args: {} };
        return;
      }
      followupMessages = messages;
      yield { type: 'text', delta: 'done' };
    },
  };

  await streamLLMWithTools(
    [{ role: 'user', content: 'read the large result' }],
    {
      onText() {},
      onToolResult: (call) => { callbackOutput = call.result; },
      dispatchTool: async () => fullOutput,
    },
    {
      provider,
      model,
      tools: [{ name: 'Read', description: 'read', parameters: { type: 'object', properties: {} } }],
      toolResultInlineLimitBytes: inlineLimitBytes,
      maxTurns: 2,
    },
  );

  const toolResult = followupMessages
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .find((block) => block.type === 'tool_result');
  const content = toolResult?.type === 'tool_result' && typeof toolResult.content === 'string' ? toolResult.content : '';
  return { content, fullOutput, callbackOutput };
}

test('core-turn tool result cap spills full UTF-8 output and sends bounded head/tail to the next request', async () => {
  const { content, fullOutput, callbackOutput } = await getFollowupToolResult(
    'tool-result-cap-contract-test', 'test-model',
    10 * 1024,
  );
  const savedPath = /saved to ([^\s]+) \(/.exec(content)?.[1];
  try {
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(10 * 1024);
    expect(content.startsWith('HEAD-')).toBe(true);
    expect(content.endsWith('-TAIL')).toBe(true);
    expect(content).toContain('elided — saved to');
    expect(content).toContain('Use Read tool');
    expect(savedPath).toBeDefined();
    expect(await Bun.file(savedPath!).text()).toBe(fullOutput);
    expect(callbackOutput).toBe(fullOutput);
  } finally {
    if (savedPath) rmSync(savedPath, { force: true });
  }
});

test('Codex core-turn tool result cap uses the 10 KB ceiling', async () => {
  const { content, fullOutput } = await getFollowupToolResult(
    'openai-codex', 'gpt-5.6-terra',
    50 * 1024,
  );
  const savedPath = /saved to ([^\s]+) \(/.exec(content)?.[1];
  try {
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(10 * 1024);
    expect(content.startsWith('HEAD-')).toBe(true);
    expect(content.endsWith('-TAIL')).toBe(true);
    expect(savedPath).toBeDefined();
    expect(await Bun.file(savedPath!).text()).toBe(fullOutput);
  } finally {
    if (savedPath) rmSync(savedPath, { force: true });
  }
});

test('core-turn tool result cap also bounds the 50 KB general-provider path', async () => {
  const { content, fullOutput } = await getFollowupToolResult(
    'tool-result-cap-50k-contract-test', 'test-model', 50 * 1024, 30_000,
  );
  const savedPath = /saved to ([^\s]+) \(/.exec(content)?.[1];
  try {
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(50 * 1024);
    expect(content.startsWith('HEAD-')).toBe(true);
    expect(content.endsWith('-TAIL')).toBe(true);
    expect(savedPath).toBeDefined();
    expect(await Bun.file(savedPath!).text()).toBe(fullOutput);
  } finally {
    if (savedPath) rmSync(savedPath, { force: true });
  }
});

test('image-bearing tool results keep the image block and cap only oversized metadata text', async () => {
  const fullMetadata = `HEAD-${'🙂'.repeat(12_000)}-TAIL`;
  let calls = 0;
  let followupMessages: LLMMessage[] = [];
  const fullResult = { mediaType: 'image/png', dataB64: 'AQID', description: fullMetadata };
  const provider: LLMProvider = {
    name: 'image-result-cap-contract-test',
    defaultModel: 'test-model',
    available: () => true,
    async *chat() { yield 'unused'; },
    async *streamChat(messages, opts) {
      calls++;
      if (calls === 1) {
        yield { type: 'tool_call', id: 'image-result-cap', name: opts?.tools?.[0]?.name ?? 'Screenshot', args: {} };
        return;
      }
      followupMessages = messages;
      yield { type: 'text', delta: 'done' };
    },
  };
  await streamLLMWithTools(
    [{ role: 'user', content: 'inspect image' }],
    { onText() {}, dispatchTool: async () => fullResult },
    {
      provider,
      model: 'test-model',
      tools: [{ name: 'Screenshot', description: 'capture', parameters: { type: 'object', properties: {} } }],
      toolResultInlineLimitBytes: 10 * 1024,
      maxTurns: 2,
    },
  );
  const toolResult = followupMessages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .find((block) => block.type === 'tool_result');
  const content = toolResult?.type === 'tool_result' && Array.isArray(toolResult.content) ? toolResult.content : [];
  const image = content.find((block) => block.type === 'image');
  const text = content.find((block) => block.type === 'text');
  const savedPath = text?.type === 'text' ? /saved to ([^\s]+) \(/.exec(text.text)?.[1] : undefined;
  try {
    expect(image).toMatchObject({ type: 'image', mediaType: 'image/png', base64: 'AQID' });
    expect(text?.type === 'text' ? Buffer.byteLength(text.text, 'utf8') : Infinity).toBeLessThanOrEqual(10 * 1024);
    expect(text?.type === 'text' ? text.text.startsWith('{"description":"HEAD-') : false).toBe(true);
    expect(text?.type === 'text' ? text.text : '').toContain('elided — saved to');
    expect(savedPath).toBeDefined();
    expect(await Bun.file(savedPath!).text()).toBe(JSON.stringify({ description: fullMetadata }));
  } finally {
    if (savedPath) rmSync(savedPath, { force: true });
  }
});

test('truncateOutput rejects a spill limit too small to include the recovery path', () => {
  expect(() => truncateOutput('x'.repeat(1000), { toolName: 'tiny-limit', inlineLimit: 32 })).toThrow(RangeError);
});
