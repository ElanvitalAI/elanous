// ── AgentOutput tool · unit tests ──
//
// ROADMAP-agent-surface-deferred-tools Wave 1 · W1.1.
// Covers: not_found / terminal-immediate / not_ready / block+wait /
// block+timeout / truncation.

import { describe, expect, spyOn, test } from 'bun:test';

import {
  AGENT_OUTPUT_TEXT_CAP_BYTES,
  DEFAULT_AGENT_OUTPUT_TIMEOUT_MS,
  MAX_AGENT_OUTPUT_TIMEOUT_MS,
  buildAgentOutputTool,
  dispatchAgentOutput,
} from '../src/agent/agent-output-tool.js';
import { AgentRegistry, globalAgentRegistry } from '../src/agent/registry.js';
import type { AgentDefinition, AgentTask } from '../src/agent/types.js';
import { debug } from '../src/debug/log.js';
import { agentOutputRuntime } from '../src/tool-runtime/agent-output-runtime.js';
import { streamLLMWithTools, type LLMProvider } from '../src/llm.js';

function def(): AgentDefinition {
  return { name: 'output-test', systemPrompt: '' };
}

function reg(): AgentRegistry { return new AgentRegistry(); }

function markDone(task: AgentTask, result: string, registry: AgentRegistry): void {
  task.state = 'done';
  task.result = result;
  task.startedAt = task.startedAt ?? Date.now() - 100;
  task.finishedAt = Date.now();
  registry.notifyTaskDone(task);
}

function markError(task: AgentTask, message: string, registry: AgentRegistry): void {
  task.state = 'error';
  task.error = message;
  task.startedAt = task.startedAt ?? Date.now() - 100;
  task.finishedAt = Date.now();
  registry.notifyTaskDone(task);
}

describe('AgentOutput tool', () => {
  /** The 1800s stream-total boundary a caller might pass; the tool must clamp it (A207). */
  const STREAM_TOTAL_TIMEOUT_MS = 30 * 60_000; // 출처: #38137 stream total-timeout boundary
  test('buildAgentOutputTool returns a well-formed LLMToolSpec', () => {
    // A5 계약 문구(20261118-92460 한 갈래): 신규 단일 문구를 독립 리터럴로 단언 — 7필드 전체 대조는 a5-model-contract.test.ts 담당.
    const spec = buildAgentOutputTool();
    expect(spec.name).toBe('AgentOutput');
    expect(spec.description).toContain('background AgentTask');
    expect(spec.parameters.required).toEqual(['taskId']);
    const props = spec.parameters.properties as Record<string, {
      type: string;
      description: string;
    }>;
    expect(props['taskId']?.type).toBe('string');
    expect(props['block']?.type).toBe('boolean');
    expect(props['timeoutMs']?.type).toBe('number');
    expect(spec.description).toContain('finish this turn — the result arrives on its own as a new turn event (<task-notification> for follow-up, one chat line for supplement)');
    expect(spec.description).toContain('Do not loop on this tool waiting for completion');
    expect(props['timeoutMs']?.description).toContain('Upper bound on one blocking peek when block=true');
    expect(props['timeoutMs']?.description).toContain('this is a status check, not a wait for the result');
    expect(spec.description).not.toMatch(/\d+ms/);
    expect(props['timeoutMs']?.description).not.toMatch(/\d+ms/);
  });

  test('missing taskId returns not_found', async () => {
    const r = await dispatchAgentOutput({}, { registry: reg() });
    expect(r.retrievalStatus).toBe('not_found');
    expect(r.taskId).toBe('');
    expect(r.output).toContain('missing');
  });

  test('unknown taskId returns not_found', async () => {
    const r = await dispatchAgentOutput(
      { taskId: 'no-such-id' },
      { registry: reg() },
    );
    expect(r.retrievalStatus).toBe('not_found');
    expect(r.taskId).toBe('no-such-id');
  });

  test('terminal task (done) returns success immediately', async () => {
    const registry = reg();
    const t = registry.register(def(), 'prompt');
    markDone(t, 'final answer text', registry);

    const r = await dispatchAgentOutput({ taskId: t.id }, { registry });
    expect(r.retrievalStatus).toBe('success');
    expect(r.state).toBe('done');
    expect(r.text).toBe('final answer text');
    expect(r.durationMs).toBeGreaterThan(0);
    expect(r.taskElapsedMs).toBeUndefined();
    expect(r.truncated).toBeUndefined();
  });

  test('terminal task (error) returns success with error payload', async () => {
    const registry = reg();
    const t = registry.register(def(), 'prompt');
    markError(t, 'boom', registry);

    const r = await dispatchAgentOutput({ taskId: t.id }, { registry });
    expect(r.retrievalStatus).toBe('success');
    expect(r.state).toBe('error');
    expect(r.error).toBe('boom');
    expect(r.isError).toBe(true);
  });

  test('terminal AgentOutput failure reaches the real tool-loop doom detector', async () => {
    const registry = reg();
    const task = registry.register(def(), 'image wait');
    markError(task, 'ImagePullBackOff while waiting for image', registry);
    let providerTurns = 0;
    let dispatches = 0;
    const provider: LLMProvider = {
      name: 'agent-output-late-failure-test', defaultModel: 'test-model', available: () => true,
      async *chat() {},
      async *streamChat(_messages, opts) {
        providerTurns++;
        const name = opts?.tools?.find((tool) => tool.name === 'AgentOutput')?.name ?? 'AgentOutput';
        yield { type: 'tool_call', id: `agent-output-${providerTurns}`, name, args: { taskId: task.id } };
      },
    };
    const logSpy = spyOn(debug, 'log');
    try {
      await streamLLMWithTools([{ role: 'user', content: 'check the managed run' }], {
        onText() {},
        dispatchTool: async (_name, args) => {
          dispatches++;
          return dispatchAgentOutput(args, { registry });
        },
      }, {
        provider, model: 'test-model', tools: [buildAgentOutputTool()], maxTurns: 5,
      });
      expect(dispatches).toBe(2);
      expect(logSpy.mock.calls.some((call) => call[0] === 'llm.tool-loop.retry' && call[1] === 'doom-loop-detected')).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  test('terminal task (aborted) returns success state=aborted', async () => {
    const registry = reg();
    const t = registry.register(def(), 'prompt');
    t.state = 'aborted';
    t.finishedAt = Date.now();
    registry.notifyTaskDone(t);

    const r = await dispatchAgentOutput({ taskId: t.id }, { registry });
    expect(r.retrievalStatus).toBe('success');
    expect(r.state).toBe('aborted');
  });

  test('records one retrieval line per call with taskId and distinct outcomes', async () => {
    const registry = reg();
    const done = registry.register(def(), 'done prompt');
    markDone(done, 'final answer text', registry);
    const running = registry.register(def(), 'running prompt');
    running.state = 'running';
    debug.disable();
    debug.clear();

    await dispatchAgentOutput({ taskId: done.id }, { registry });
    await dispatchAgentOutput({ taskId: running.id }, { registry });

    const lines = debug.tail(20).filter(line => line.includes('[agent.output]') && line.includes('retrieve'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(done.id);
    expect(lines[0]).toContain('"retrievalStatus":"success"');
    expect(lines[1]).toContain(running.id);
    expect(lines[1]).toContain('"retrievalStatus":"not_ready"');
  });

  test('running task, block=false, returns not_ready', async () => {
    const registry = reg();
    const t = registry.register(def(), 'prompt');
    t.state = 'running';

    const r = await dispatchAgentOutput({ taskId: t.id }, { registry });
    expect(r.retrievalStatus).toBe('not_ready');
    expect(r.state).toBe('running');
  });

  test('running task, block=true, resolves when task transitions to done', async () => {
    const registry = reg();
    const t = registry.register(def(), 'prompt');
    t.state = 'running';

    const pending = dispatchAgentOutput(
      { taskId: t.id, block: true, timeoutMs: 5_000 },
      { registry },
    );

    // Flip to done on the next microtask so the listener fires.
    setTimeout(() => markDone(t, 'streamed answer', registry), 10);

    const r = await pending;
    expect(r.retrievalStatus).toBe('success');
    expect(r.state).toBe('done');
    expect(r.text).toBe('streamed answer');
  });

  test('aborting the parent turn stops waiting but leaves the background task running', async () => {
    const registry = reg();
    const task = registry.register(def(), 'slow child');
    task.state = 'running';
    task.startedAt = Date.now();
    let listenerDisposed = false;
    let timerDisposed = false;
    const subscribe = registry.onTaskDone.bind(registry);
    registry.onTaskDone = (listener) => {
      const subscription = subscribe(listener);
      return { dispose: () => { listenerDisposed = true; subscription.dispose(); } };
    };
    const controller = new AbortController();
    const pending = dispatchAgentOutput(
      { taskId: task.id, block: true, timeoutMs: DEFAULT_AGENT_OUTPUT_TIMEOUT_MS },
      { registry, signal: controller.signal, setTimer: () => ({ dispose: () => { timerDisposed = true; } }) },
    );

    controller.abort(new Error('seat turn wall-clock cap reached'));
    const r = await pending;

    expect(r).toMatchObject({ retrievalStatus: 'interrupted', state: 'running', taskId: task.id });
    expect(registry.get(task.id)?.state).toBe('running');
    expect(listenerDisposed).toBe(true);
    expect(timerDisposed).toBe(true);
    markDone(task, 'finished in background', registry);
    expect(await dispatchAgentOutput({ taskId: task.id }, { registry })).toMatchObject({
      retrievalStatus: 'success', state: 'done', text: 'finished in background',
    });
  });

  test('ToolRuntime forwards the parent turn signal to the blocking wait', async () => {
    globalAgentRegistry.clear();
    try {
      const task = globalAgentRegistry.register(def(), 'runtime slow child');
      task.state = 'running';
      const controller = new AbortController();
      const pending = agentOutputRuntime.run(
        { taskId: task.id, block: true, timeoutMs: DEFAULT_AGENT_OUTPUT_TIMEOUT_MS },
        { surface: 'tui', signal: controller.signal },
      );
      controller.abort();
      await expect(pending).resolves.toMatchObject({ retrievalStatus: 'interrupted', state: 'running' });
      expect(globalAgentRegistry.get(task.id)?.state).toBe('running');
    } finally {
      globalAgentRegistry.clear();
    }
  });

  test('running task, block=true, timeout reports task elapsed time and retry guidance', async () => {
    const registry = reg();
    const t = registry.register(def(), 'prompt');
    t.state = 'running';
    t.startedAt = 10_000;

    // Inject a synchronous-fire timer so the test doesn't wait real ms.
    let firedCb: (() => void) | null = null;
    const fakeTimer = {
      setTimer(cb: () => void, _ms: number) {
        firedCb = cb;
        return { dispose: () => { firedCb = null; } };
      },
    };

    const pending = dispatchAgentOutput(
      { taskId: t.id, block: true, timeoutMs: 30 },
      { registry, setTimer: fakeTimer.setTimer, now: () => 100_000 },
    );

    // Fire the injected timer to simulate timeout elapse.
    expect(firedCb).not.toBeNull();
    firedCb!();

    const r = await pending;
    expect(r.retrievalStatus).toBe('timeout');
    expect(r.state).toBe('running');
    expect(r.taskElapsedMs).toBe(90_000);
    expect(r.durationMs).toBeUndefined();
    expect(r.output).toContain('timeout after 0ms');
    expect(r.output).toContain('task elapsed 90000ms');
    // 20261118-92460 한 갈래: 폴링 재호출 힌트 → 신규 waitHint 리터럴(스펙 우선).
    expect(r.output).toContain('end your turn — the result arrives on its own as a new turn event (<task-notification>)');
  });

  test('timeout leaves task elapsed time absent when start time is unavailable', async () => {
    const registry = reg();
    const t = registry.register(def(), 'prompt');
    t.state = 'running';
    let firedCb: (() => void) | null = null;
    const fakeTimer = {
      setTimer(cb: () => void, _ms: number) {
        firedCb = cb;
        return { dispose: () => { firedCb = null; } };
      },
    };

    const pending = dispatchAgentOutput(
      { taskId: t.id, block: true, timeoutMs: 30 },
      { registry, setTimer: fakeTimer.setTimer, now: () => 100_000 },
    );
    firedCb!();

    const r = await pending;
    expect(r.retrievalStatus).toBe('timeout');
    expect(r.taskElapsedMs).toBeUndefined();
    expect(r.output).toContain('task elapsed unavailable (start time unavailable)');
  });

  test('same taskId can be called again to continue waiting after a timeout', async () => {
    const registry = reg();
    const t = registry.register(def(), 'prompt');
    t.state = 'running';
    const callbacks: Array<() => void> = [];
    const fakeTimer = {
      setTimer(cb: () => void, _ms: number) {
        callbacks.push(cb);
        return { dispose: () => undefined };
      },
    };

    const first = dispatchAgentOutput(
      { taskId: t.id, block: true, timeoutMs: 30 },
      { registry, setTimer: fakeTimer.setTimer },
    );
    callbacks.shift()!();
    expect((await first).retrievalStatus).toBe('timeout');

    const second = dispatchAgentOutput(
      { taskId: t.id, block: true, timeoutMs: 30 },
      { registry, setTimer: fakeTimer.setTimer },
    );
    markDone(t, 'retrieved after retry', registry);
    const r = await second;
    expect(r.retrievalStatus).toBe('success');
    expect(r.text).toBe('retrieved after retry');
  });

  test('text payload over cap is truncated and flagged', async () => {
    const registry = reg();
    const t = registry.register(def(), 'prompt');
    const big = 'A'.repeat(AGENT_OUTPUT_TEXT_CAP_BYTES + 100);
    markDone(t, big, registry);

    const r = await dispatchAgentOutput({ taskId: t.id }, { registry });
    expect(r.retrievalStatus).toBe('success');
    expect(r.truncated).toBe(true);
    expect(r.text?.length).toBe(AGENT_OUTPUT_TEXT_CAP_BYTES);
  });

  test('default timeout constant matches the public contract', () => {
    expect(DEFAULT_AGENT_OUTPUT_TIMEOUT_MS).toBe(30_000);
  });

  test('a blocking wait above the hard cap is clamped so one call cannot hold the turn to the stream total timeout (A207)', async () => {
    const registry = reg();
    const t = registry.register(def(), 'prompt');
    t.state = 'running';
    const waits: number[] = [];
    const pending = dispatchAgentOutput(
      { taskId: t.id, block: true, timeoutMs: STREAM_TOTAL_TIMEOUT_MS },
      {
        registry,
        setTimer: (cb, ms) => {
          waits.push(ms);
          return { dispose: () => undefined };
        },
      },
    );
    expect(waits).toEqual([MAX_AGENT_OUTPUT_TIMEOUT_MS]);
    expect(MAX_AGENT_OUTPUT_TIMEOUT_MS).toBe(30_000);
    markDone(t, 'still running after the cap', registry);
    const r = await pending;
    expect(r.retrievalStatus).toBe('success');
    expect(r.text).toBe('still running after the cap');
  });

  test('the clamped wait times out, then the same taskId can be read again (A207)', async () => {
    const registry = reg();
    const t = registry.register(def(), 'prompt');
    t.state = 'running';
    t.startedAt = 10_000;
    const callbacks: Array<() => void> = [];
    const waits: number[] = [];
    const timer = {
      setTimer(cb: () => void, ms: number) {
        waits.push(ms);
        callbacks.push(cb);
        return { dispose: () => undefined };
      },
    };
    const first = dispatchAgentOutput(
      { taskId: t.id, block: true, timeoutMs: STREAM_TOTAL_TIMEOUT_MS },
      { registry, setTimer: timer.setTimer, now: () => 40_000 },
    );
    expect(waits).toEqual([MAX_AGENT_OUTPUT_TIMEOUT_MS]);
    callbacks.shift()!();
    const timedOut = await first;
    expect(timedOut.retrievalStatus).toBe('timeout');
    expect(timedOut.state).toBe('running');
    expect(timedOut.taskElapsedMs).toBe(30_000);
    expect(timedOut.output).toContain('timeout after 0ms');
    expect(timedOut.output).toContain('task elapsed 30000ms');
    // 20261118-92460 한 갈래: waitHint 교체로 신규 리터럴로 갱신(스펙 우선) — 시험명의 «같은 taskId 재독기» 동작 자체는 그대로 아래에서 증명.
    expect(timedOut.output).toContain('end your turn — the result arrives on its own as a new turn event (<task-notification>)');

    const second = dispatchAgentOutput(
      { taskId: t.id, block: true, timeoutMs: STREAM_TOTAL_TIMEOUT_MS },
      { registry, setTimer: timer.setTimer, now: () => 50_000 },
    );
    markDone(t, 'retrieved after the cap', registry);
    const again = await second;
    expect(again.retrievalStatus).toBe('success');
    expect(again.text).toBe('retrieved after the cap');
    expect(waits).toEqual([MAX_AGENT_OUTPUT_TIMEOUT_MS, MAX_AGENT_OUTPUT_TIMEOUT_MS]);
  });
});
