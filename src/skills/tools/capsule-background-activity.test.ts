import { expect, test } from 'bun:test';
import { dispatchAgent } from './agent.js';
import { globalAgentRegistry } from '../../agent/registry.js';
import { debug } from '../../debug/log.js';
import type { LLMProvider } from '../../llm.js';

test('background agent reports its tool step and completion to its parent', async () => {
  const steps: string[] = [];
  const exposedArgs: unknown[] = [];
  const subscription = globalAgentRegistry.onToolCall((event) => { steps.push(`${event.tool} ${event.callIdx}`); exposedArgs.push(event.args); });
  let turn = 0;
  const provider: LLMProvider = {
    name: 'fake', defaultModel: 'fake', available: () => true,
    async *streamChat() {
      if (turn++ === 0) {
        yield { type: 'tool_call', id: 'call-1', name: 'Bash', args: { command: 'private-example-token' } };
        yield { type: 'turn_end', endTurn: false };
      } else yield { type: 'text', delta: 'done' };
    },
    async *chat() {},
  };
  const previous = process.env.ELANOUS_LLM_MODE;
  process.env.ELANOUS_LLM_MODE = 'real';
  try {
    const result = await dispatchAgent({ description: 'inspect task', prompt: 'inspect', run_in_background: true }, {
      provider,
      resolveAgentDef: () => ({ name: 'general-purpose', systemPrompt: 'work', tools: ['Bash'] }),
      hostTools: [{ name: 'Bash', description: 'shell', parameters: { type: 'object' } }],
      dispatchTool: async () => 'hello',
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('agent did not finish')), 5000);
      const subscription = globalAgentRegistry.onTaskDone((task) => {
        if (task.id !== result.taskId) return;
        clearTimeout(timer); subscription.dispose(); resolve();
      });
      if (globalAgentRegistry.get(result.taskId)?.finishedAt) { clearTimeout(timer); subscription.dispose(); resolve(); }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(steps).toEqual(['Bash 1']);
    expect(exposedArgs).toEqual([{}]);
    expect(debug.events(100).filter((event) => event.category === 'turn-life' && event.event === 'capsule-tool-start' && (event.data as { capsuleId?: string } | undefined)?.capsuleId === result.taskId).map((event) => event.data)).toEqual([{ capsuleId: result.taskId, callIdx: 1, tool: 'Bash' }]);

  } finally {
    if (previous === undefined) delete process.env.ELANOUS_LLM_MODE;
    else process.env.ELANOUS_LLM_MODE = previous;
    subscription.dispose();
    globalAgentRegistry.clear();
  }
});
