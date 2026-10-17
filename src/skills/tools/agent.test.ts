// TUI-AGENT-CAPS (core) — subagent ceiling helpers: turn clamp, one-level
// nest strip, background fan-out ceiling + live count. Fan-out enforcement
// in dispatchAgent is the follow-up cell TUI-AGENT-CAPS-WIRING.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  AGENT_TOOL_BACKGROUND_FANOUT_CEILING,
  AGENT_TOOL_DEFAULT_MAX_TURNS,
  AGENT_TOOL_TURNS_CEILING,
  countLiveBackgroundFanout,
  dispatchAgent,
  resolveAgentToolMaxTurns,
  stripAgentToolForOneLevelNesting,
} from './agent.js';
import { globalAgentRegistry } from '../../agent/registry.js';
import type { AgentDefinition } from '../../agent/types.js';
import type { LLMProvider, LLMStreamEvent, LLMToolSpec } from '../../llm.js';

function fakeProvider(turns: LLMStreamEvent[][]): LLMProvider {
  let call = 0;
  const p: LLMProvider = {
    name: 'fake',
    defaultModel: 'fake-model',
    available: () => true,
    async *streamChat() {
      const events = turns[call++] ?? [];
      for (const ev of events) yield ev;
    },
    async *chat(messages, opts) {
      for await (const ev of p.streamChat!(messages, opts)) {
        if (ev.type === 'text') yield ev.delta;
      }
    },
  };
  return p;
}

const stubDef: AgentDefinition = {
  name: 'value-investor',
  systemPrompt: 'You are Margaret Chen.',
  tools: ['Bash'],
};

beforeEach(() => {
  globalAgentRegistry.clear();
});
afterEach(() => {
  globalAgentRegistry.clear();
});

describe('Agent-tool cap helpers', () => {
  test('turn ceiling constants match the documented defaults', () => {
    expect(AGENT_TOOL_DEFAULT_MAX_TURNS).toBe(20);
    expect(AGENT_TOOL_TURNS_CEILING).toBe(50);
    expect(AGENT_TOOL_BACKGROUND_FANOUT_CEILING).toBe(8);
  });

  test('resolveAgentToolMaxTurns defaults, honours, and clamps', () => {
    expect(resolveAgentToolMaxTurns(undefined)).toBe(AGENT_TOOL_DEFAULT_MAX_TURNS);
    expect(resolveAgentToolMaxTurns(7)).toBe(7);
    expect(resolveAgentToolMaxTurns(9999)).toBe(AGENT_TOOL_TURNS_CEILING);
    expect(resolveAgentToolMaxTurns(0)).toBe(1);
    expect(resolveAgentToolMaxTurns(Number.NaN)).toBe(AGENT_TOOL_DEFAULT_MAX_TURNS);
    expect(resolveAgentToolMaxTurns('20')).toBe(AGENT_TOOL_DEFAULT_MAX_TURNS);
  });

  test('stripAgentToolForOneLevelNesting drops Agent and keeps the rest', () => {
    const tools: LLMToolSpec[] = [
      { name: 'Bash', description: 'b', parameters: { type: 'object' } },
      { name: 'Agent', description: 'a', parameters: { type: 'object' } },
      { name: 'Read', description: 'r', parameters: { type: 'object' } },
    ];
    expect(stripAgentToolForOneLevelNesting(tools).map(t => t.name)).toEqual(['Bash', 'Read']);
  });

  test('countLiveBackgroundFanout ignores foreground and terminal tasks', () => {
    expect(countLiveBackgroundFanout([
      { background: true, state: 'running' },
      { background: true, state: 'pending' },
      { background: true, state: 'done' },
      { background: true, state: 'error' },
      { background: true, state: 'aborted' },
      { background: false, state: 'running' },
      { state: 'running' },
    ])).toBe(2);
  });
});

describe('dispatchAgent — helpers on the existing path', () => {
  test('max_turns still clamps through resolveAgentToolMaxTurns', async () => {
    const provider = fakeProvider([[{ type: 'text', delta: 'k' }]]);
    const over = await dispatchAgent(
      { description: 'd', prompt: 'p', max_turns: 9999 },
      { provider, resolveAgentDef: () => stubDef },
    );
    expect(over.maxTurns).toBe(AGENT_TOOL_TURNS_CEILING);
    const def = await dispatchAgent(
      { description: 'd2', prompt: 'p2' },
      { provider: fakeProvider([[{ type: 'text', delta: 'k' }]]), resolveAgentDef: () => stubDef },
    );
    expect(def.maxTurns).toBe(AGENT_TOOL_DEFAULT_MAX_TURNS);
  });

  test('child tool list is stripped of Agent (one-level nest)', async () => {
    let childToolNames: string[] = [];
    const provider: LLMProvider = {
      name: 'capture',
      defaultModel: 'd',
      available: () => true,
      async *streamChat(_m, opts) {
        childToolNames = (opts?.tools ?? []).map(t => t.name);
        yield { type: 'text', delta: 'done' };
      },
      async *chat() {},
    };
    const hostTools: LLMToolSpec[] = [
      { name: 'Bash', description: 'b', parameters: { type: 'object' } },
      { name: 'Read', description: 'r', parameters: { type: 'object' } },
      { name: 'Agent', description: 'a', parameters: { type: 'object' } },
    ];
    const def: AgentDefinition = { ...stubDef, tools: ['Bash', 'Read', 'Agent'] };
    await dispatchAgent(
      { description: 'd', prompt: 'p' },
      { provider, hostTools, resolveAgentDef: () => def },
    );
    expect(childToolNames).toContain('Bash');
    expect(childToolNames).toContain('Read');
    expect(childToolNames).not.toContain('Agent');
  });
});
