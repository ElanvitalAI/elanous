// AGENT-STEER — a parent corrects a running subagent, resumes a finished one, and gets the addressable names
// back for an unknown target. A real registry + runner + tool loop with a synthetic provider; no network.
// Expectations are literals (rule 11): the correction text, names and marker are written out.
import { afterEach, describe, expect, test } from 'bun:test';
import type { LLMMessage, LLMProvider } from '../llm.js';
import { AgentRegistry } from './registry.js';
import { dispatchAgentSend } from './agent-send-tool.js';
import { clearAgentSteerInbox, parseAgentSlash } from './agent-steer.js';
import { BackgroundJobStatus } from '../tui/chat/background-job-status.js';
import { PinnedAgents } from '../tui/chat/pinned-agents.js';

afterEach(() => clearAgentSteerInbox());

// 출처: #40036 — room for the first request, one tool round and the corrected step; the fake provider uses ≤3.
const TURN_BUDGET = 4;
const READ_TOOL = [{ name: 'Read', description: 'Read', parameters: { type: 'object', properties: {} } }];

function textOf(messages: readonly LLMMessage[]): string {
  return messages.map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('steer a running subagent', () => {
  test('a correction sent while the child runs a tool is in its very next model request', async () => {
    const registry = new AgentRegistry();
    const requests: LLMMessage[][] = [];
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => { releaseTool = resolve; });
    let toolStarted = false;
    const provider: LLMProvider = {
      name: 'openai-codex', defaultModel: 'gpt-6.2-sol', available: () => true,
      async *chat() {},
      async *streamChat(messages) {
        requests.push([...messages]);
        if (requests.length === 1) { yield { type: 'tool_call', id: 'r1', name: 'Read', args: {} }; return; }
        yield { type: 'text', delta: 'Switched to plan B.' };
      },
    };
    const handle = registry.spawn({
      definition: { name: 'general-purpose', systemPrompt: 'Child.' }, prompt: 'Do plan A.', label: 'scout',
      parentSessionId: 'sess-1', provider, maxTurns: TURN_BUDGET, tools: READ_TOOL,
      dispatchTool: async () => { toolStarted = true; await toolGate; return 'file body'; },
    });
    const drained = (async () => { for await (const _ of handle.events) { /* run */ } })();
    await until(() => toolStarted);
    const sent = dispatchAgentSend({ to: 'scout', body: 'Drop plan A. Do plan B.' }, { registry, requester: 'sess-1' });
    expect(sent.ok).toBe(true);
    expect(sent.delivered).toBe('steer');
    expect(sent.corrections).toBe(1);
    releaseTool();
    await drained;
    expect(requests.length).toBe(2);
    expect(textOf(requests[0]!)).not.toContain('Drop plan A. Do plan B.');
    expect(textOf(requests[0]!)).toContain('the latest instruction wins');
    const last = requests[1]![requests[1]!.length - 1]!;
    expect(last.role).toBe('user');
    expect(textOf([last])).toContain('[correction from parent · the latest instruction wins]\nDrop plan A. Do plan B.');
    expect(handle.task.result).toBe('Switched to plan B.');
  });

  test('a correction that lands during the final answer becomes one more step, not lost', async () => {
    const registry = new AgentRegistry();
    const requests: LLMMessage[][] = [];
    let releaseAnswer!: () => void;
    const answerGate = new Promise<void>((resolve) => { releaseAnswer = resolve; });
    const provider: LLMProvider = {
      name: 'openai-codex', defaultModel: 'gpt-6.2-sol', available: () => true,
      async *chat() {},
      async *streamChat(messages) {
        requests.push([...messages]);
        if (requests.length === 1) { await answerGate; yield { type: 'text', delta: 'Plan A report.' }; return; }
        yield { type: 'text', delta: 'Plan C report.' };
      },
    };
    const handle = registry.spawn({
      definition: { name: 'general-purpose', systemPrompt: 'Child.' }, prompt: 'Report plan A.', label: 'writer',
      provider, maxTurns: TURN_BUDGET,
    });
    const drained = (async () => { for await (const _ of handle.events) { /* run */ } })();
    await until(() => requests.length === 1);
    expect(dispatchAgentSend({ to: 'writer', body: 'Report plan C instead.' }, { registry }).ok).toBe(true);
    releaseAnswer();
    await drained;
    expect(requests.length).toBe(2);
    expect(textOf(requests[1]!)).toContain('Report plan C instead.');
    expect(handle.task.result).toBe('Plan C report.');
  });
});

describe('resume a finished subagent', () => {
  test('the resumed run keeps every prior message and adds the new body', async () => {
    const registry = new AgentRegistry();
    const requests: LLMMessage[][] = [];
    const provider: LLMProvider = {
      name: 'openai-codex', defaultModel: 'gpt-6.2-sol', available: () => true,
      async *chat() {},
      async *streamChat(messages) {
        requests.push([...messages]);
        yield { type: 'text', delta: requests.length === 1 ? 'First answer: 42.' : 'Second answer: 43.' };
      },
    };
    const handle = registry.spawn({
      definition: { name: 'general-purpose', systemPrompt: 'Child.' }, prompt: 'Count the files.', label: 'counter',
      parentSessionId: 'sess-1', provider, maxTurns: TURN_BUDGET,
    });
    for await (const _ of handle.events) { /* run */ }
    expect(handle.task.state).toBe('done');
    const sent = dispatchAgentSend({ to: 'counter', body: 'Now count only .ts files.' }, { registry, requester: 'sess-1' });
    expect(sent.delivered).toBe('resume');
    await until(() => requests.length === 2 && handle.task.state === 'done');
    const resumed = textOf(requests[1]!);
    expect(resumed).toContain('Count the files.');
    expect(resumed).toContain('First answer: 42.');
    expect(resumed).toContain('Now count only .ts files.');
    expect(handle.task.result).toBe('Second answer: 43.');
    expect(handle.task.background).toBe(true);
    expect(handle.task.corrections).toBe(1);
  });
});

describe('unknown target', () => {
  test('the error names the addressable agents; a foreign session sees none', () => {
    const registry = new AgentRegistry();
    const task = registry.register({ name: 'general-purpose', systemPrompt: 'Child.' }, 'x', { id: 'abcd1234-0000' });
    task.label = 'scout';
    task.parentSessionId = 'sess-1';
    const miss = dispatchAgentSend({ to: 'ghost', body: 'hi' }, { registry, requester: 'sess-1' });
    expect(miss.ok).toBe(false);
    expect(miss.output).toBe("AgentSend: no agent named 'ghost'. Addressable: scout (pending · abcd1234)");
    const foreign = dispatchAgentSend({ to: 'scout', body: 'hi' }, { registry, requester: 'sess-2' });
    expect(foreign.output).toBe("AgentSend: no agent named 'scout'. Addressable: (none)");
  });
});

describe('/agent slash and the status marker', () => {
  test('parse', () => {
    expect(parseAgentSlash('/agent scout use plan B')).toEqual({ to: 'scout', body: 'use plan B' });
    expect(parseAgentSlash('/agent "bg probe" stop after step 2')).toEqual({ to: 'bg probe', body: 'stop after step 2' });
    expect(parseAgentSlash('/agent scout')).toBeNull();
    expect(parseAgentSlash('/agent')).toBeNull();
    expect(parseAgentSlash('/agents scout x')).toBeNull();
  });

  test('roster line carries «✉ n corrections» and /agent resolves by label', () => {
    const jobs = new BackgroundJobStatus('sess-1');
    expect(jobs.accept(JSON.stringify({ sessionId: 'sess-1', promised: false, running: 1, pending: 0, tasks: [
      { id: 'aaaa1111', label: 'bg probe', state: 'running', corrections: 2 },
      { id: 'bbbb2222', label: 'scout', state: 'done', corrections: 1 },
      { id: 'cccc3333', label: 'idle', state: 'running' },
    ] }))).toBe(true);
    expect(jobs.taskLines()).toEqual([
      'aaaa1111 · bg probe · running · ✉ 2 corrections',
      'bbbb2222 · scout · done · ✉ 1 correction',
      'cccc3333 · idle · running',
    ]);
    expect(jobs.resolveAgent('bg-probe')?.id).toBe('aaaa1111');
    expect(jobs.resolveAgent('bg probe')?.id).toBe('aaaa1111');
    expect(jobs.resolveAgent('bbbb')?.id).toBe('bbbb2222');
    expect(jobs.resolveAgent('ghost')).toBeNull();
  });
});

test('the pinned agent line (#40033) carries «✉ n corrections»', () => {
  const at = Date.parse('2026-11-25T07:00:00.000Z');
  const agents = new PinnedAgents('sess-1');
  agents.accept({ type: 'capsule-progress', capsuleId: 'c1', kind: 'agent', sessionId: 'sess-1', at, line: 'surveyor · started' });
  agents.accept({ type: 'capsule-progress', capsuleId: 'c2', kind: 'agent', sessionId: 'sess-1', at, line: 'writer · started' });
  const corrections = (id: string) => (id === 'c1' ? 3 : undefined);
  expect(agents.compose([], at + 5_000, () => false, corrections)).toEqual([
    '🤖 background 2',
    '   🤖 surveyor · running 5s · ✉ 3 corrections',
    '   🤖 writer · running 5s',
  ]);
});
