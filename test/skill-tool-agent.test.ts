// ── Agent tool (P1 — Task spawn for skills) ──
//
// Covers buildAgentTool spec shape + dispatchAgent end-to-end behaviour
// using a fake provider so no network / real LLM is required.
//
// Key invariants under test:
//   - Tool spec: required params, name, description mentions "spawn"
//   - Resolution: known agent → that def; unknown → general-purpose
//                 fallback; missing entirely → inline FALLBACK
//   - Recursion guard: child tool list strips Agent itself
//   - Abort: parent signal cancels the spawned task
//   - Budget: max_turns clamped to ceiling, default = 20
//   - Debug: agent.spawn / agent.done events emit when debug enabled

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  buildAgentTool, dispatchAgent, AGENT_TOOL_DEFAULT_MAX_TURNS, applySpawnToolFilter, subagentHonorsModelAllow,
} from '../src/skills/tools/agent';
import { globalAgentRegistry } from '../src/agent/registry';
import type { AgentDefinition } from '../src/agent/types';
import type { LLMProvider, LLMStreamEvent, LLMToolSpec } from '../src/llm';
import { debug } from '../src/debug/log';

// ── Fakes ──

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

function hangingProvider(): LLMProvider {
  async function hang(opts: { signal?: AbortSignal } | undefined): Promise<never> {
    return new Promise<never>((_, reject) => {
      const sig = opts?.signal;
      const err = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (!sig) return;
      if (sig.aborted) { reject(err()); return; }
      sig.addEventListener('abort', () => reject(err()), { once: true });
    });
  }
  return {
    name: 'hang',
    defaultModel: 'hang',
    available: () => true,
    async *streamChat(_m, opts) { await hang(opts); },
    async *chat(_m, opts) { await hang(opts); },
  };
}

const stubDef: AgentDefinition = {
  name: 'value-investor',
  systemPrompt: 'You are Margaret Chen.',
  tools: ['Bash'],
};

beforeEach(() => {
  globalAgentRegistry.clear();
  debug.disable();
});
afterEach(() => {
  globalAgentRegistry.clear();
  debug.disable();
});

// ── Spec shape ──

describe('buildAgentTool', () => {
  test('returns LLMToolSpec with expected fields', () => {
    const spec = buildAgentTool();
    expect(spec.name).toBe('Agent');
    expect(spec.description).toMatch(/sub-agent|context window|spawn|delegate/i);
    expect(spec.parameters.type).toBe('object');
    const props = spec.parameters.properties as Record<string, unknown>;
    expect(props.description).toBeDefined();
    expect(props.prompt).toBeDefined();
    expect(props.subagent_type).toBeDefined();
    expect(props.max_turns).toBeDefined();
    expect(spec.parameters.required).toEqual(['description', 'prompt']);
  });

  test('mentions parallel spawn pattern in description', () => {
    const spec = buildAgentTool();
    expect(spec.description.toLowerCase()).toMatch(/parallel|fan out|same turn|N times/);
  });

  test('explains tool_filter inheritance and over-narrowing risk', () => {
    const spec = buildAgentTool();
    const props = spec.parameters.properties as Record<string, any>;
    const description = props.tool_filter.description as string;
    expect(description).toMatch(/inherits the parent.*full tool registry/i);
    expect(description).toMatch(/allow.*ignored unless the user explicitly enabled/i);
  });
});

// ── Validation ──

describe('dispatchAgent — input validation', () => {
  test('throws when description is missing', async () => {
    await expect(
      dispatchAgent({ prompt: 'hi' }),
    ).rejects.toThrow(/description is required/);
  });

  test('throws when prompt is missing', async () => {
    await expect(
      dispatchAgent({ description: 'work' }),
    ).rejects.toThrow(/prompt is required/);
  });

  test('throws when description is empty string', async () => {
    await expect(
      dispatchAgent({ description: '   ', prompt: 'hi' }),
    ).rejects.toThrow(/description is required/);
  });
});

// ── Resolution ──

describe('dispatchAgent — agent resolution', () => {
  test('uses requested agent when resolver returns it', async () => {
    const provider = fakeProvider([[{ type: 'text', delta: 'OK Margaret here.' }]]);
    const result = await dispatchAgent(
      { description: 'analyze', prompt: 'What about Samsung?', subagent_type: 'value-investor' },
      { provider, resolveAgentDef: (n) => (n === 'value-investor' ? stubDef : undefined) },
    );
    expect(result.agent).toBe('value-investor');
    expect(result.output).toBe('OK Margaret here.');
  });

  test('falls back to general-purpose when subagent_type unknown', async () => {
    const gp: AgentDefinition = { name: 'general-purpose', systemPrompt: 'GP system' };
    const provider = fakeProvider([[{ type: 'text', delta: 'gp result' }]]);
    const result = await dispatchAgent(
      { description: 'do', prompt: 'p', subagent_type: 'nonexistent-agent-xyz' },
      { provider, resolveAgentDef: (n) => (n === 'general-purpose' ? gp : undefined) },
    );
    expect(result.agent).toBe('general-purpose');
    expect(result.output).toBe('gp result');
  });

  test('uses inline FALLBACK_GENERAL_PURPOSE when both resolves miss', async () => {
    const provider = fakeProvider([[{ type: 'text', delta: 'inline fallback' }]]);
    const result = await dispatchAgent(
      { description: 'd', prompt: 'p' },
      { provider, resolveAgentDef: () => undefined },
    );
    expect(result.agent).toBe('general-purpose');
    expect(result.output).toBe('inline fallback');
  });

  test('parent-supplied model arg is ignored (no schema field)', async () => {
    // Sub-agent model is not parent-selectable — the `model` parameter
    // was removed from the Agent tool schema. A parent LLM that passes
    // `model` anyway must be ignored: the sub-agent uses its definition's
    // model, or inherits the parent provider's default.
    let capturedModel: string | undefined;
    const provider: LLMProvider = {
      name: 'capture',
      defaultModel: 'd',
      available: () => true,
      async *streamChat(_m, opts) {
        capturedModel = opts?.model;
        yield { type: 'text', delta: 'k' };
      },
      async *chat(_m, opts) {
        capturedModel = opts?.model;
        yield 'k';
      },
    };
    const hostTools: LLMToolSpec[] = [
      { name: 'Bash', description: 'b', parameters: { type: 'object' } },
    ];
    await dispatchAgent(
      { description: 'd', prompt: 'p', model: 'gpt-special' } as any,
      {
        provider,
        hostTools,
        resolveAgentDef: () => ({ ...stubDef, tools: ['Bash'], model: 'def-model' }),
      },
    );
    expect(capturedModel).toBe('def-model');
  });
});

// ── Recursion guard ──

describe('dispatchAgent — Agent tool stripped from child', () => {
  test('child sees host tools minus Agent', async () => {
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
    // Allowlist all so filterAgentTools doesn't drop everything.
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

// ── Wave 5 E1 — per-spawn tool_filter (registry isolation) ──

describe('dispatchAgent — tool_filter (Wave 5 E1 · 사람이 좁히기를 켠 경우 · ELANOUS_SUBAGENT_HONOR_ALLOW=1)', () => {
  // SUBAGENT-NO-NARROWING — 아래 좁히기 계약은 «명시 켬»에서만 산다. 기본(끔)은 다음 describe.
  let prevHonor: string | undefined;
  beforeEach(() => { prevHonor = process.env.ELANOUS_SUBAGENT_HONOR_ALLOW; process.env.ELANOUS_SUBAGENT_HONOR_ALLOW = '1'; });
  afterEach(() => { if (prevHonor === undefined) delete process.env.ELANOUS_SUBAGENT_HONOR_ALLOW; else process.env.ELANOUS_SUBAGENT_HONOR_ALLOW = prevHonor; });
  function captureProvider(): { provider: LLMProvider; names: () => string[] } {
    let toolNames: string[] = [];
    const provider: LLMProvider = {
      name: 'capture',
      defaultModel: 'd',
      available: () => true,
      async *streamChat(_m, opts) {
        toolNames = (opts?.tools ?? []).map((t) => t.name);
        yield { type: 'text', delta: 'done' };
      },
      async *chat() {},
    };
    return { provider, names: () => toolNames };
  }

  const tools: LLMToolSpec[] = [
    { name: 'Bash', description: '', parameters: { type: 'object' } },
    { name: 'Read', description: '', parameters: { type: 'object' } },
    { name: 'Edit', description: '', parameters: { type: 'object' } },
    { name: 'WebFetch', description: '', parameters: { type: 'object' } },
    { name: 'Agent', description: '', parameters: { type: 'object' } },
  ];
  const def: AgentDefinition = {
    ...stubDef,
    tools: ['Bash', 'Read', 'Edit', 'WebFetch', 'Agent'],
  };

  test('allow narrows the child tool set to the listed names', async () => {
    const cap = captureProvider();
    await dispatchAgent(
      { description: 'd', prompt: 'p', tool_filter: { allow: ['Read'] } },
      { provider: cap.provider, hostTools: tools, resolveAgentDef: () => def },
    );
    expect(cap.names()).toEqual(['Read']);
  });

  test('records available, remaining, and removed tools for a narrow filter', async () => {
    const cap = captureProvider();
    debug.enable();
    debug.clear();
    await dispatchAgent(
      { description: 'd', prompt: 'p', tool_filter: { allow: ['Read'] } },
      { provider: cap.provider, hostTools: tools, resolveAgentDef: () => def },
    );
    const text = debug.tail(20).join('\n');
    expect(text).toContain('[agent.spawn] tool-filter');
    expect(text).toContain('"available":4');
    expect(text).toContain('"remaining":1');
    expect(text).toContain('"removed":3');
  });

  test('deny removes specific tools from the child tool set', async () => {
    const cap = captureProvider();
    await dispatchAgent(
      { description: 'd', prompt: 'p', tool_filter: { deny: ['Bash', 'WebFetch'] } },
      { provider: cap.provider, hostTools: tools, resolveAgentDef: () => def },
    );
    expect(cap.names().sort()).toEqual(['Edit', 'Read']);
  });

  test('allow + deny compose — deny wins the conflict', async () => {
    const cap = captureProvider();
    await dispatchAgent(
      {
        description: 'd',
        prompt: 'p',
        tool_filter: { allow: ['Read', 'Edit', 'Bash'], deny: ['Bash'] },
      },
      { provider: cap.provider, hostTools: tools, resolveAgentDef: () => def },
    );
    expect(cap.names().sort()).toEqual(['Edit', 'Read']);
  });

  // SUBAGENT-TOOLS-EMPTY (대표 10-22 «서브에이전트에 제약이 생기지 않게»): 빈 allow 는 «좁히기 없음» = 전부 상속.
  test('empty allow array = no narrowing — the child inherits every tool', async () => {
    const cap = captureProvider();
    await dispatchAgent(
      { description: 'd', prompt: 'p', tool_filter: { allow: [] } },
      { provider: cap.provider, hostTools: tools, resolveAgentDef: () => def },
    );
    expect(cap.names().sort()).toEqual(['Bash', 'Edit', 'Read', 'WebFetch']);
  });

  test('allow with only unknown names (name mismatch) is ignored with a warning — not 49→0', async () => {
    const cap = captureProvider();
    debug.enable();
    debug.clear();
    await dispatchAgent(
      { description: 'd', prompt: 'p', tool_filter: { allow: ['read_file', 'shell', 'grep'] } },
      { provider: cap.provider, hostTools: tools, resolveAgentDef: () => def },
    );
    expect(cap.names().sort()).toEqual(['Bash', 'Edit', 'Read', 'WebFetch']);
    const text = debug.tail(20).join('\n');
    expect(text).toContain('"allowIgnored":"no-known-names"');
    expect(text).toContain('"unknownAllow":["read_file","shell","grep"]');
  });

  test('deny with only unknown names is ignored but logged at warn level (a typo must not pass silently)', async () => {
    const cap = captureProvider();
    debug.enable();
    debug.clear();
    await dispatchAgent(
      { description: 'd', prompt: 'p', tool_filter: { deny: ['bash_tool'] } },
      { provider: cap.provider, hostTools: tools, resolveAgentDef: () => def },
    );
    expect(cap.names().sort()).toEqual(['Bash', 'Edit', 'Read', 'WebFetch']);
    const row = debug.events().find((e) => e.category === 'agent.spawn' && e.event === 'tool-filter');
    expect(row?.level).toBe('warn');
    expect(JSON.stringify(row?.data)).toContain('"unknownDeny":["bash_tool"]');
  });

  test('allow mixing known and unknown names narrows to the known ones only', async () => {
    const cap = captureProvider();
    await dispatchAgent(
      { description: 'd', prompt: 'p', tool_filter: { allow: ['Read', 'read_file'] } },
      { provider: cap.provider, hostTools: tools, resolveAgentDef: () => def },
    );
    expect(cap.names()).toEqual(['Read']);
  });

  test('a filter that would leave 0 tools is refused (NOT SPAWNED · no provider call)', async () => {
    let called = false;
    const provider: LLMProvider = {
      name: 'capture', defaultModel: 'd', available: () => true,
      async *streamChat() { called = true; yield { type: 'text', delta: 'x' }; },
      async *chat() {},
    };
    const r = await dispatchAgent(
      { description: 'd', prompt: 'p', tool_filter: { deny: ['Bash', 'Read', 'Edit', 'WebFetch'] } },
      { provider, hostTools: tools, resolveAgentDef: () => def },
    );
    expect(called).toBe(false);
    expect(r.taskId).toBe('no-tools-refused');
    expect(r.output).toContain('NOT SPAWNED');
    expect(r.output).toContain('0 of 4 tools');
  });

  test('default general-purpose spawn keeps Read and the shell tool (반례)', async () => {
    const cap = captureProvider();
    const host: LLMToolSpec[] = [
      { name: 'Read', description: '', parameters: { type: 'object' } },
      { name: 'RunShell', description: '', parameters: { type: 'object' } },
      { name: 'Grep', description: '', parameters: { type: 'object' } },
      { name: 'Agent', description: '', parameters: { type: 'object' } },
    ];
    await dispatchAgent(
      { description: 'd', prompt: 'p', tool_filter: { allow: ['Read', 'Bash'] } },
      { provider: cap.provider, hostTools: host, resolveAgentDef: () => ({ ...stubDef, tools: ['Read', 'RunShell', 'Grep', 'Agent'] }) },
    );
    expect(cap.names()).toEqual(['Read']);
    await dispatchAgent(
      { description: 'd2', prompt: 'p2' },
      { provider: cap.provider, hostTools: host, resolveAgentDef: () => ({ ...stubDef, tools: ['Read', 'RunShell', 'Grep', 'Agent'] }) },
    );
    expect(cap.names()).toEqual(expect.arrayContaining(['Read', 'RunShell']));
  });

  test('omitted tool_filter keeps the pre-filter behaviour (Agent stripped only)', async () => {
    const cap = captureProvider();
    await dispatchAgent(
      { description: 'd', prompt: 'p' },
      { provider: cap.provider, hostTools: tools, resolveAgentDef: () => def },
    );
    expect(cap.names()).toContain('Bash');
    expect(cap.names()).toContain('Read');
    expect(cap.names()).not.toContain('Agent');
  });

  test('malformed tool_filter (non-object) is ignored — graceful', async () => {
    const cap = captureProvider();
    await dispatchAgent(
      { description: 'd', prompt: 'p', tool_filter: 'oops' as unknown as never },
      { provider: cap.provider, hostTools: tools, resolveAgentDef: () => def },
    );
    expect(cap.names()).toContain('Read'); // no narrowing applied
  });
});

// ── Budget ──

describe('dispatchAgent — max_turns budget', () => {
  test('default budget is AGENT_TOOL_DEFAULT_MAX_TURNS', async () => {
    const provider = fakeProvider([[{ type: 'text', delta: 'k' }]]);
    const r = await dispatchAgent(
      { description: 'd', prompt: 'p' },
      { provider, resolveAgentDef: () => stubDef },
    );
    expect(r.maxTurns).toBe(AGENT_TOOL_DEFAULT_MAX_TURNS);
  });

  test('caller-supplied max_turns honoured', async () => {
    const provider = fakeProvider([[{ type: 'text', delta: 'k' }]]);
    const r = await dispatchAgent(
      { description: 'd', prompt: 'p', max_turns: 7 },
      { provider, resolveAgentDef: () => stubDef },
    );
    expect(r.maxTurns).toBe(7);
  });

  test('max_turns clamped to ceiling (50)', async () => {
    const provider = fakeProvider([[{ type: 'text', delta: 'k' }]]);
    const r = await dispatchAgent(
      { description: 'd', prompt: 'p', max_turns: 9999 },
      { provider, resolveAgentDef: () => stubDef },
    );
    expect(r.maxTurns).toBe(50);
  });

  test('max_turns clamped to floor (1)', async () => {
    const provider = fakeProvider([[{ type: 'text', delta: 'k' }]]);
    const r = await dispatchAgent(
      { description: 'd', prompt: 'p', max_turns: 0 },
      { provider, resolveAgentDef: () => stubDef },
    );
    expect(r.maxTurns).toBe(1);
  });
});

// ── Abort ──

describe('dispatchAgent — abort propagation', () => {
  test('parent signal aborts the spawned task', async () => {
    const provider = hangingProvider();
    const ctrl = new AbortController();
    const promise = dispatchAgent(
      { description: 'd', prompt: 'p' },
      { provider, signal: ctrl.signal, resolveAgentDef: () => stubDef },
    );
    // Give the runner a tick to register the abort listener.
    await new Promise(r => setTimeout(r, 5));
    ctrl.abort();
    await expect(promise).rejects.toThrow(/aborted/);
  });

  test('pre-aborted signal aborts immediately', async () => {
    const provider = hangingProvider();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      dispatchAgent(
        { description: 'd', prompt: 'p' },
        { provider, signal: ctrl.signal, resolveAgentDef: () => stubDef },
      ),
    ).rejects.toThrow(/aborted/);
  });
});

// ── Result shape ──

describe('dispatchAgent — result shape', () => {
  test('returns AgentToolResult fields', async () => {
    const provider = fakeProvider([[{ type: 'text', delta: 'hello world' }]]);
    const r = await dispatchAgent(
      { description: 'salutation', prompt: 'say hi' },
      { provider, resolveAgentDef: () => stubDef },
    );
    expect(r.output).toBe('hello world');
    expect(r.agent).toBe('value-investor');
    expect(r.maxTurns).toBe(AGENT_TOOL_DEFAULT_MAX_TURNS);
    expect(typeof r.taskId).toBe('string');
    expect(r.taskId.length).toBeGreaterThan(0);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── Debug instrumentation ──

describe('dispatchAgent — debug events', () => {
  test('emits agent.spawn and agent.done when debug enabled', async () => {
    const provider = fakeProvider([[{ type: 'text', delta: 'ok' }]]);
    debug.enable();
    debug.clear();
    await dispatchAgent(
      { description: 'span', prompt: 'p' },
      { provider, resolveAgentDef: () => stubDef },
    );
    const lines = debug.tail(20);
    const text = lines.join('\n');
    expect(text).toContain('[agent.spawn]');
    expect(text).toContain('[agent.done]');
    expect(text).toContain('value-investor');
  });

  test('emits agent.error on failure', async () => {
    const failingProvider: LLMProvider = {
      name: 'fail',
      defaultModel: 'd',
      available: () => true,
      async *streamChat() {
        throw new Error('boom');
      },
      async *chat() { throw new Error('boom'); },
    };
    debug.enable();
    debug.clear();
    await expect(
      dispatchAgent(
        { description: 'd', prompt: 'p' },
        { provider: failingProvider, resolveAgentDef: () => stubDef },
      ),
    ).rejects.toThrow();
    const lines = debug.tail(20);
    expect(lines.join('\n')).toContain('[agent.error]');
  });

  test('agent.tool fires for each child tool call', async () => {
    // Two-turn provider: turn 1 emits a tool_call, turn 2 emits text.
    const provider = fakeProvider([
      [{ type: 'tool_call', id: '1', name: 'Bash', args: { command: 'echo hi' } }],
      [{ type: 'text', delta: 'final' }],
    ]);
    const def: AgentDefinition = { ...stubDef, tools: ['Bash'] };
    debug.enable();
    debug.clear();
    await dispatchAgent(
      { description: 'd', prompt: 'p' },
      {
        provider,
        resolveAgentDef: () => def,
        hostTools: [{ name: 'Bash', description: 'b', parameters: { type: 'object' } }],
        dispatchTool: async () => 'tool ok',
      },
    );
    const lines = debug.tail(30);
    expect(lines.join('\n')).toContain('[agent.tool]');
  });
});

// ── onChildToolCall plumbing (Phase F1b) ──
//
// Sub-agent tool activity renders as `  ⎿ Bash(cmd)` lines nested
// under the parent's `⏺ Agent(desc)` header. The callback fires
// ONCE per child tool_call event (not tool_result) — so the log
// pane shows live progress as the sub-agent works.

describe('dispatchAgent — onChildToolCall callback', () => {
  test('invoked once per child tool_call with name+args+callIdx', async () => {
    const events: Array<{ name: string; args: Record<string, unknown>; callIdx: number }> = [];
    const provider = fakeProvider([
      [
        { type: 'tool_call', id: '1', name: 'Bash', args: { command: 'ls' } },
        { type: 'tool_call', id: '2', name: 'Read', args: { file_path: '/a' } },
      ],
      [{ type: 'text', delta: 'done' }],
    ]);
    const def: AgentDefinition = { ...stubDef, tools: ['Bash', 'Read'] };
    await dispatchAgent(
      { description: 'd', prompt: 'p' },
      {
        provider,
        resolveAgentDef: () => def,
        hostTools: [
          { name: 'Bash', description: 'b', parameters: { type: 'object' } },
          { name: 'Read', description: 'r', parameters: { type: 'object' } },
        ],
        dispatchTool: async () => 'ok',
        onChildToolCall: (ev) => events.push(ev),
      },
    );
    expect(events).toHaveLength(2);
    expect(events[0]!.name).toBe('Bash');
    expect(events[0]!.callIdx).toBe(1);
    expect(events[0]!.args).toEqual({ command: 'ls' });
    expect(events[1]!.name).toBe('Read');
    expect(events[1]!.callIdx).toBe(2);
  });

  test('errors in callback do not kill the sub-agent run', async () => {
    const provider = fakeProvider([
      [{ type: 'tool_call', id: '1', name: 'Bash', args: {} }],
      [{ type: 'text', delta: 'survived' }],
    ]);
    const def: AgentDefinition = { ...stubDef, tools: ['Bash'] };
    const r = await dispatchAgent(
      { description: 'd', prompt: 'p' },
      {
        provider,
        resolveAgentDef: () => def,
        hostTools: [{ name: 'Bash', description: 'b', parameters: { type: 'object' } }],
        dispatchTool: async () => 'ok',
        onChildToolCall: () => { throw new Error('renderer exploded'); },
      },
    );
    expect(r.output).toBe('survived');
  });

  test('absent callback — no crash, streaming unchanged', async () => {
    const provider = fakeProvider([
      [{ type: 'tool_call', id: '1', name: 'Bash', args: {} }],
      [{ type: 'text', delta: 'ok' }],
    ]);
    const def: AgentDefinition = { ...stubDef, tools: ['Bash'] };
    const r = await dispatchAgent(
      { description: 'd', prompt: 'p' },
      {
        provider,
        resolveAgentDef: () => def,
        hostTools: [{ name: 'Bash', description: 'b', parameters: { type: 'object' } }],
        dispatchTool: async () => 'ok',
      },
    );
    expect(r.output).toBe('ok');
  });
});

// ── onDone plumbing (Phase F1c) ──
//
// Fires once when the sub-agent finishes with { toolCount, durationMs,
// outputChars, promptChars } — used by the log-pane renderer to emit
// the `  ⎿ Done (N tool uses · X tokens · Ys)` summary line.

describe('dispatchAgent — onDone callback', () => {
  test('fires once with correct toolCount and outputChars', async () => {
    let summary: any = null;
    const provider = fakeProvider([
      [
        { type: 'tool_call', id: '1', name: 'Bash', args: {} },
        { type: 'tool_call', id: '2', name: 'Bash', args: {} },
      ],
      [{ type: 'text', delta: 'final output here' }],
    ]);
    const def: AgentDefinition = { ...stubDef, tools: ['Bash'] };
    await dispatchAgent(
      { description: 'd', prompt: 'my-prompt' },
      {
        provider,
        resolveAgentDef: () => def,
        hostTools: [{ name: 'Bash', description: 'b', parameters: { type: 'object' } }],
        dispatchTool: async () => 'ok',
        onDone: (s) => { summary = s; },
      },
    );
    expect(summary).not.toBeNull();
    expect(summary.toolCount).toBe(2);
    expect(summary.outputChars).toBe('final output here'.length);
    expect(summary.promptChars).toBe('my-prompt'.length);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('renderer errors in onDone do not kill the return value', async () => {
    const provider = fakeProvider([[{ type: 'text', delta: 'ok' }]]);
    const r = await dispatchAgent(
      { description: 'd', prompt: 'p' },
      {
        provider,
        resolveAgentDef: () => stubDef,
        onDone: () => { throw new Error('renderer boom'); },
      },
    );
    expect(r.output).toBe('ok');
  });

  test('dedup short-circuit path does NOT fire onDone (returns stub synchronously)', async () => {
    // The dedup stub in dispatchAgent short-circuits BEFORE the sub-agent
    // runs — no tool count / duration to report. onDone must not fire on
    // that path (or the log pane would show a Done line without ever
    // having shown the ⎿ Bash(...) children).
    const { SessionCache } = await import('../src/session/cache');
    const sessionCache = new SessionCache();
    let called = 0;
    const provider = fakeProvider([[{ type: 'text', delta: 'first' }]]);

    await dispatchAgent(
      { description: 'd', prompt: 'same-prompt' },
      { provider, resolveAgentDef: () => stubDef, sessionCache, onDone: () => called++ },
    );
    // First call ran normally → onDone fired.
    expect(called).toBe(1);

    // Second call with identical prompt → dedup hit → stub returned.
    // onDone should NOT fire again.
    await dispatchAgent(
      { description: 'd', prompt: 'same-prompt' },
      { provider, resolveAgentDef: () => stubDef, sessionCache, onDone: () => called++ },
    );
    expect(called).toBe(1);
  });
});

// ── Dedup cascade threshold (debug-only) ──
//
// Prior to session 16 iter, crossing DEDUP_CASCADE_HALT_THRESHOLD
// swapped the dedup stub's note for a big "===== DEDUP CASCADE HALT
// =====" block. Observed behavior (log/debug-20260415144418.log):
// parent LLMs ignored the HALT message and kept spawning regardless,
// while the block injected ~500 chars of history noise per hit × 6+
// hits. Removed the escalation. The counter + debug event remain
// (forensics value); the stub text is identical before and after
// threshold.

describe('dispatchAgent — dedup stub text is invariant', () => {
  test('first hit: normal stub with "DIFFERENT persona" note', async () => {
    const { SessionCache } = await import('../src/session/cache');
    const sessionCache = new SessionCache();
    const provider = fakeProvider([
      [{ type: 'text', delta: 'first-run' }],
    ]);
    await dispatchAgent(
      { description: 'd', prompt: 'identical' },
      { provider, resolveAgentDef: () => stubDef, sessionCache },
    );
    const r = await dispatchAgent(
      { description: 'd', prompt: 'identical' },
      { provider, resolveAgentDef: () => stubDef, sessionCache },
    );
    expect(r.taskId).toBe('dedup');
    expect(r.output).toContain('DUPLICATE CALL');
    expect(r.output).toContain('DIFFERENT persona');
    expect(r.output).not.toContain('CASCADE HALT');
  });

  test('post-threshold hits (interleaved keys) still get normal stub — no HALT', async () => {
    // Interleave between two distinct prompts so we DON'T trigger the
    // consecutive-block path — that one throws. This test asserts the
    // cumulative-hit path (which used to promote to "CASCADE HALT")
    // still returns the plain "DIFFERENT persona" stub after the
    // HALT message removal.
    const { SessionCache, DEDUP_CASCADE_HALT_THRESHOLD } = await import('../src/session/cache');
    const sessionCache = new SessionCache();
    const provider = fakeProvider([
      [{ type: 'text', delta: 'a' }],
      [{ type: 'text', delta: 'b' }],
    ]);
    await dispatchAgent(
      { description: 'dA', prompt: 'pA' },
      { provider, resolveAgentDef: () => stubDef, sessionCache },
    );
    await dispatchAgent(
      { description: 'dB', prompt: 'pB' },
      { provider, resolveAgentDef: () => stubDef, sessionCache },
    );
    let lastOutput = '';
    for (let i = 0; i < DEDUP_CASCADE_HALT_THRESHOLD + 1; i++) {
      const prompt = i % 2 === 0 ? 'pA' : 'pB';
      const r = await dispatchAgent(
        { description: prompt === 'pA' ? 'dA' : 'dB', prompt },
        { provider, resolveAgentDef: () => stubDef, sessionCache },
      );
      lastOutput = r.output;
      expect(r.output).not.toContain('CASCADE HALT');
      expect(r.output).toContain('DIFFERENT persona');
    }
    expect(sessionCache.totalHits).toBeGreaterThan(DEDUP_CASCADE_HALT_THRESHOLD);
    expect(lastOutput).toContain('DUPLICATE CALL');
  });

  test('crossing cumulative threshold emits agent.dedup cascade-threshold debug event', async () => {
    const { SessionCache, DEDUP_CASCADE_HALT_THRESHOLD } = await import('../src/session/cache');
    const sessionCache = new SessionCache();
    const provider = fakeProvider([
      [{ type: 'text', delta: 'x' }],
      [{ type: 'text', delta: 'y' }],
    ]);
    debug.enable();
    debug.clear();
    // Two distinct prompts seeded.
    await dispatchAgent(
      { description: 'dA', prompt: 'pA' },
      { provider, resolveAgentDef: () => stubDef, sessionCache },
    );
    await dispatchAgent(
      { description: 'dB', prompt: 'pB' },
      { provider, resolveAgentDef: () => stubDef, sessionCache },
    );
    // Alternate hits across both keys → cumulative totalHits climbs
    // without consecutiveHits ever reaching block threshold.
    for (let i = 0; i < DEDUP_CASCADE_HALT_THRESHOLD + 1; i++) {
      const prompt = i % 2 === 0 ? 'pA' : 'pB';
      await dispatchAgent(
        { description: prompt === 'pA' ? 'dA' : 'dB', prompt },
        { provider, resolveAgentDef: () => stubDef, sessionCache },
      );
    }
    const tail = debug.tail(40).join('\n');
    expect(tail).toContain('cascade-threshold');
  });
});

// ── Consecutive-dedup runtime block ──
//
// Observed failure (log/debug-20260415151315.log): gpt-5.4 re-issued
// the IDENTICAL Agent spawn / Read call 12 times in a row, ignoring
// every soft dedup stub returned as a string. Runtime now throws after
// N consecutive same-key hits so the tool_result carries is_error=true,
// which breaks the reflex loop more reliably than a soft stub.

describe('dispatchAgent — consecutive-dedup runtime block', () => {
  test('Nth consecutive identical spawn throws', async () => {
    const { SessionCache, CONSECUTIVE_DEDUP_BLOCK_THRESHOLD } = await import('../src/session/cache');
    const sessionCache = new SessionCache();
    const provider = fakeProvider([
      [{ type: 'text', delta: 'first' }],
    ]);
    // Seed the cache.
    await dispatchAgent(
      { description: 'd', prompt: 'p' },
      { provider, resolveAgentDef: () => stubDef, sessionCache },
    );
    // Re-spawn up to (threshold-1) times — each returns a soft stub.
    for (let i = 0; i < CONSECUTIVE_DEDUP_BLOCK_THRESHOLD - 1; i++) {
      const r = await dispatchAgent(
        { description: 'd', prompt: 'p' },
        { provider, resolveAgentDef: () => stubDef, sessionCache },
      );
      expect(r.output).toContain('DUPLICATE CALL');
    }
    // The Nth consecutive hit throws.
    await expect(
      dispatchAgent(
        { description: 'd', prompt: 'p' },
        { provider, resolveAgentDef: () => stubDef, sessionCache },
      ),
    ).rejects.toThrow(/RUNTIME BLOCKED/);
  });

  test('alternating between two keys does NOT trigger the block', async () => {
    // Consecutive counter resets on each distinct key hit — a parent
    // juggling two deduped calls must stay under the threshold
    // indefinitely (soft stub always).
    const { SessionCache, CONSECUTIVE_DEDUP_BLOCK_THRESHOLD } = await import('../src/session/cache');
    const sessionCache = new SessionCache();
    const provider = fakeProvider([
      [{ type: 'text', delta: 'a' }],
      [{ type: 'text', delta: 'b' }],
    ]);
    await dispatchAgent(
      { description: 'dA', prompt: 'pA' },
      { provider, resolveAgentDef: () => stubDef, sessionCache },
    );
    await dispatchAgent(
      { description: 'dB', prompt: 'pB' },
      { provider, resolveAgentDef: () => stubDef, sessionCache },
    );
    // Alternate threshold*3 times — should never throw.
    for (let i = 0; i < CONSECUTIVE_DEDUP_BLOCK_THRESHOLD * 3; i++) {
      const prompt = i % 2 === 0 ? 'pA' : 'pB';
      const r = await dispatchAgent(
        { description: prompt === 'pA' ? 'dA' : 'dB', prompt },
        { provider, resolveAgentDef: () => stubDef, sessionCache },
      );
      expect(r.output).toContain('DUPLICATE CALL');
    }
  });
});

describe('SUBAGENT-NO-NARROWING — 기본은 모델이 넘긴 allow 를 무시하고 deny 만 반영', () => {
  const host: LLMToolSpec[] = ['Bash', 'Read', 'Edit', 'WebFetch', 'Grep', 'Glob', 'Write', 'ListDir', 'RunShell', 'WebSearch', 'Agent']
    .map((name) => ({ name, description: '', parameters: { type: 'object' } }));
  const def: AgentDefinition = { ...stubDef, tools: host.map((t) => t.name) };
  let prevHonor: string | undefined;
  beforeEach(() => { prevHonor = process.env.ELANOUS_SUBAGENT_HONOR_ALLOW; delete process.env.ELANOUS_SUBAGENT_HONOR_ALLOW; });
  afterEach(() => { if (prevHonor === undefined) delete process.env.ELANOUS_SUBAGENT_HONOR_ALLOW; else process.env.ELANOUS_SUBAGENT_HONOR_ALLOW = prevHonor; });
  function capture() {
    let names: string[] = [];
    const provider: LLMProvider = {
      name: 'capture', defaultModel: 'd', available: () => true,
      async *streamChat(_m, opts) { names = (opts?.tools ?? []).map((t) => t.name); yield { type: 'text', delta: 'done' }; },
      async *chat() {},
    };
    return { provider, names: () => names };
  }

  test('반례(10-22 n8n 실물 49→9): 아는 이름 allow 를 줘도 자식은 메인 도구 전부를 받는다 · 관측 model-allow-ignored', async () => {
    const cap = capture();
    await dispatchAgent(
      { description: 'd', prompt: 'p', tool_filter: { allow: ['Read', 'Bash'] } },
      { provider: cap.provider, hostTools: host, resolveAgentDef: () => def },
    );
    expect(cap.names().sort()).toEqual(host.map((t) => t.name).filter((n) => n !== 'Agent').sort());
    const r = applySpawnToolFilter(host, { allow: ['Read', 'Bash'] });
    expect(r.allowIgnored).toBe('model-allow-ignored');
    expect(r.tools.length).toBe(host.length);
  });

  test('deny 는 그대로 반영된다(allow 와 함께 와도)', async () => {
    const cap = capture();
    await dispatchAgent(
      { description: 'd', prompt: 'p', tool_filter: { allow: ['Read'], deny: ['WebFetch', 'Write'] } },
      { provider: cap.provider, hostTools: host, resolveAgentDef: () => def },
    );
    expect(cap.names()).not.toContain('WebFetch');
    expect(cap.names()).not.toContain('Write');
    expect(cap.names()).toContain('Bash');
    expect(cap.names()).toContain('Grep');
  });

  test('켬 판정은 명시 값만 — 빈 값·0·false 는 끔', () => {
    expect(subagentHonorsModelAllow({})).toBe(false);
    expect(subagentHonorsModelAllow({ ELANOUS_SUBAGENT_HONOR_ALLOW: '0' })).toBe(false);
    expect(subagentHonorsModelAllow({ ELANOUS_SUBAGENT_HONOR_ALLOW: 'false' })).toBe(false);
    expect(subagentHonorsModelAllow({ ELANOUS_SUBAGENT_HONOR_ALLOW: '1' })).toBe(true);
    expect(applySpawnToolFilter(host, { allow: ['Read'] }, { honorAllow: true }).tools.map((t) => t.name)).toEqual(['Read']);
  });
});
