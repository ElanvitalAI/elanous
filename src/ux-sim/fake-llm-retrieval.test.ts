import { expect, test } from 'bun:test';
import { testFakeLlmProvider } from './fake-llm.js';

test('fake AgentOutput uses the taskId typed in the current human turn', async () => {
  const before = process.env.ELANOUS_TEST_FAKE_LLM_TOOL_CALL;
  try {
    process.env.ELANOUS_TEST_FAKE_LLM_TOOL_CALL = JSON.stringify({ when: 'retrieve result', name: 'AgentOutput', args: { taskId: '$humanTaskId', block: false } });
    expect(await Array.fromAsync(testFakeLlmProvider.streamChat!([{ role: 'user', content: 'retrieve result taskId=task-123' }])))
      .toMatchObject([{ type: 'tool_call', name: 'AgentOutput', args: { taskId: 'task-123', block: false } }]);
    expect(await Array.fromAsync(testFakeLlmProvider.streamChat!([{ role: 'user', content: 'retrieve result' }])))
      .toEqual([{ type: 'text', delta: '[test-fake-llm] OK' }]);
  } finally {
    if (before === undefined) delete process.env.ELANOUS_TEST_FAKE_LLM_TOOL_CALL; else process.env.ELANOUS_TEST_FAKE_LLM_TOOL_CALL = before;
  }
});
