// A real Agent runner and tool loop with a synthetic provider; no network or operating data.
import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { LLMMessage, LLMOpts, LLMProvider } from '../llm.js';
import { REQUEST_SIZE_MAX_CHARS } from '../session/request-size-guard.js';
import { AgentRegistry } from './registry.js';
import { runAgent } from './runner.js';

test('agent child bounds tool output before the next model request and wires the request guard', async () => {
  const fullOutput = `HEAD-${'x'.repeat(1_400_000)}-TAIL`;
  const registry = new AgentRegistry();
  const task = registry.register({ name: 'test-child', systemPrompt: 'Test child' }, 'Read this result');
  let calls = 0, followup: LLMMessage[] = [], seenGuard: LLMOpts['requestSizeGuard'];
  const provider: LLMProvider = {
    name: 'openai-codex', defaultModel: 'gpt-6.2-sol', available: () => true,
    async *chat() {},
    async *streamChat(messages, opts) {
      seenGuard = opts?.requestSizeGuard;
      calls++;
      if (calls === 1) { yield { type: 'tool_call', id: 'read1', name: 'Read', args: {} }; return; }
      followup = messages; yield { type: 'text', delta: 'Done.' };
    },
  };
  const events = [];
  for await (const event of runAgent(task, {
    provider, maxTurns: 2,
    tools: [{ name: 'Read', description: 'Read', parameters: { type: 'object', properties: {} } }],
    dispatchTool: async () => fullOutput,
  })) events.push(event);
  const toolResult = followup.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .find(block => block.type === 'tool_result');
  const content = toolResult?.type === 'tool_result' && typeof toolResult.content === 'string' ? toolResult.content : '';
  const savedPath = /saved to ([^\s]+) \(/.exec(content)?.[1];
  try {
    expect(calls).toBe(2);
    expect(events.some(event => event.type === 'done')).toBe(true);
    expect(seenGuard?.maxChars).toBe(REQUEST_SIZE_MAX_CHARS);
    expect(typeof seenGuard?.compactMessages).toBe('function');
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(10 * 1024);
    expect(savedPath).toBeDefined();
    expect(await Bun.file(savedPath!).text()).toBe(fullOutput);
    expect(JSON.stringify(followup).length).toBeLessThan(REQUEST_SIZE_MAX_CHARS);
  } finally { if (savedPath) rmSync(savedPath, { force: true }); }
});
