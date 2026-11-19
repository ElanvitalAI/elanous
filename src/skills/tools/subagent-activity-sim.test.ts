import { expect, test } from 'bun:test';
import { dispatchAgent } from './agent.js';
import { globalAgentRegistry } from '../../agent/registry.js';
import { watchCapsuleDone } from '../../repl/index.js';
import { CAPSULE_FRAME_PREFIX, parseCapsuleFrame } from '../../turn-capsule/capsule-frame.js';
import type { CapsuleEvent } from '../../turn-capsule/contract.js';
import type { LLMProvider } from '../../llm.js';

// SUBAGENT-ACTIVITY-VISIBLE (0.3.30 P0 · supersedes the red draft #38556): a background agent's activity reaches its parent
// as folded capsule frames — not as the foreground `onChildToolCall` rows, which carry tool arguments. Real path:
// dispatchAgent (background) → B3 #38681 registry tool starts (name + ordinal) → B1 watchCapsuleDone → the frame wire the
// Next TUI reads (`ELANOUS_TUI_CAPSULE\t…`). The TUI's folded line is the wiring slice (entry.ts lease · TC-H-CC-2).
test('a background agent shows up to its parent as folded progress frames and one done frame — no arguments', async () => {
  const sessionId = 'subagent-activity';
  const lines: string[] = [];
  // The chat child's bridge learns a background task id from the Agent tool result (repl/index.ts backgroundTaskIds) —
  // `background` flips back on completion, so the done frame is matched through this set.
  const knownBackground = new Set<string>();
  const watch = watchCapsuleDone(sessionId, globalAgentRegistry, knownBackground, (line) => { lines.push(line); });
  let turn = 0;
  const provider: LLMProvider = {
    name: 'fake', defaultModel: 'fake', available: () => true,
    async *streamChat() {
      if (turn++ === 0) {
        yield { type: 'tool_call', id: 'call-1', name: 'Bash', args: { command: 'echo private-example-token' } };
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
      parentSessionId: sessionId,
      resolveAgentDef: () => ({ name: 'general-purpose', systemPrompt: 'work', tools: ['Bash'] }),
      hostTools: [{ name: 'Bash', description: 'shell', parameters: { type: 'object' } }],
      dispatchTool: async () => 'tool output private-example-token',
    });
    knownBackground.add(result.taskId!);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('agent did not finish')), 5000);
      const done = globalAgentRegistry.onTaskDone((task) => {
        if (task.id !== result.taskId) return;
        clearTimeout(timer); done.dispose(); resolve();
      });
      if (globalAgentRegistry.get(result.taskId)?.finishedAt) { clearTimeout(timer); done.dispose(); resolve(); }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = lines.map((line) => {
      expect(line.startsWith(CAPSULE_FRAME_PREFIX) && line.endsWith('\n')).toBe(true);
      return parseCapsuleFrame(line.slice(CAPSULE_FRAME_PREFIX.length).trimEnd(), sessionId);
    }) as CapsuleEvent[];
    expect(events.map((event) => [event.type, event.capsuleId === result.taskId, event.type === 'capsule-progress' ? event.line : event.status]))
      .toEqual([
        ['capsule-progress', true, 'inspect task · started'],
        ['capsule-progress', true, 'inspect task · #1 Bash'],
        ['capsule-done', true, 'ok'],
      ]);
    expect(lines.join('')).not.toContain('private-example-token');
  } finally {
    watch.dispose();
    if (previous === undefined) delete process.env.ELANOUS_LLM_MODE;
    else process.env.ELANOUS_LLM_MODE = previous;
    globalAgentRegistry.clear();
  }
});
