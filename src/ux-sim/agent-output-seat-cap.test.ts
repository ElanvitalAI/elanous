// UX simulation for the production core-turn, session-native AgentOutput, and seat-cap timer paths.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as llmModule from '../llm.js';
import type { LLMProvider, LLMStreamEvent } from '../llm.js';
import * as surfaceModule from '../session-runtime/index.js';
import * as deferredModule from '../session-runtime/tier-flip.js';
import { dispatchSessionRuntimeTool } from '../session-runtime/index.js';
import { buildAgentOutputTool, dispatchAgentOutput } from '../agent/agent-output-tool.js';
import { globalAgentRegistry } from '../agent/registry.js';
import type { AgentDefinition } from '../agent/types.js';
import { debug } from '../debug/log.js';
import type { CoreTurnContext } from '../core-turn/types.js';
import { runGoalLoop } from '../core-turn/run-goal-loop.js';

const realStream = llmModule.streamLLMWithTools;

beforeEach(() => {
  globalAgentRegistry.clear();
  spyOn(surfaceModule, 'resolveSessionSurfaceProfile').mockImplementation(() => ({
    id: 'default', selectionReason: 'ux-sim', baselineContexts: [], defaultFamilies: [], conditionalFamilies: [],
  }) as unknown as ReturnType<typeof surfaceModule.resolveSessionSurfaceProfile>);
  spyOn(deferredModule, 'applyDeferredTools').mockImplementation((messages, tools) => ({
    messages: [...messages], tools: [...tools],
    stats: { activeCount: tools.length, deferredCount: 0, warmPreloaded: [], injected: false, deferredNames: [], unhydratableNames: [], unhydratableCount: 0 },
  }) as unknown as ReturnType<typeof deferredModule.applyDeferredTools>);
});

afterEach(() => {
  mock.restore();
  globalAgentRegistry.clear();
});

describe('ux-sim — long AgentOutput wait at the seat wall-clock cap', () => {
  test('20-minute cap returns the real parent turn and leaves its child available in background', async () => {
    const task = globalAgentRegistry.register({ name: 'slow-child', systemPrompt: '' } satisfies AgentDefinition, 'long AgentOutput');
    task.state = 'running';
    task.startedAt = 1_000;
    let now = 1_000;
    let waitListenerRegistered = false;
    let capFiredBeforeWaitListener = false;
    let resolveWaitListenerRegistered!: () => void;
    const waitListenerReady = new Promise<void>((resolve) => {
      resolveWaitListenerRegistered = resolve;
    });
    const originalOnTaskDone = globalAgentRegistry.onTaskDone.bind(globalAgentRegistry);
    spyOn(globalAgentRegistry, 'onTaskDone').mockImplementation((listener) => {
      waitListenerRegistered = true;
      resolveWaitListenerRegistered();
      return originalOnTaskDone(listener);
    });
    const events: string[] = [];
    const originalLog = debug.log;
    debug.log = ((category: string, event: string) => {
      if (category === 'goal.loop') events.push(event);
    }) as typeof debug.log;
    let providerCalls = 0;
    const provider: LLMProvider = {
      name: 'ux-sim-agent-output-wait', defaultModel: 'ux-sim', available: () => true,
      async *streamChat() {
        providerCalls += 1;
        yield { type: 'tool_call', id: 'agent-output-long-wait', name: 'AgentOutput', args: {
          taskId: task.id, block: true, timeoutMs: 30 * 60_000,
        } } satisfies LLMStreamEvent;
      },
      async *chat() {},
    };
    spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, handlers, opts = {}) =>
      realStream(messages, handlers, { ...opts, provider, maxTurns: 4 }));
    const ctx = {
      sessionId: 'ux-sim-agent-output-seat-cap',
      messages: [{ role: 'user', content: '긴 AgentOutput 대기' }],
      userText: '긴 AgentOutput 대기',
      tools: [buildAgentOutputTool()],
      dispatchTool: (name: string, args: Record<string, unknown>, dispatch: { signal?: AbortSignal }) =>
        dispatchSessionRuntimeTool(name, args, {
          sessionId: 'ux-sim-agent-output-seat-cap',
          signal: dispatch.signal,
          getToolRuntime: () => undefined,
          dispatchToolRuntime: async () => ({ error: 'unexpected ToolRuntime route' }),
          dispatchPluginTool: async () => ({ ok: false, error: 'unexpected plugin route' }),
        }),
      signal: new AbortController().signal,
    } as unknown as CoreTurnContext;
    const waitFailSafe = setTimeout(() => {
      if (task.state !== 'running') return;
      task.state = 'done';
      task.result = 'simulation fail-safe released the blocked wait';
      task.finishedAt = now;
      globalAgentRegistry.notifyTaskDone(task);
    }, 250);

    try {
      const result = await runGoalLoop(ctx, {
        seatTurnCap: { seat: 'UX', maxTools: 60, maxWallMs: 20 * 60_000, idleEmptyMsgListLimit: 2 },
        maxIterations: 4,
        changedFiles: () => [],
        controlSpaceId: null,
        intentStallProvider: null,
        attachLifecycleBridge: () => () => {},
        startLivenessHeartbeat: () => () => {},
        now: () => now,
        // Fire only after the real AgentOutput wait subscribes; keep a guard so a broken path fails rather than hangs.
        scheduleSeatWallCap: (callback, delayMs) => {
          expect(delayMs).toBe(20 * 60_000);
          let disposed = false;
          const fallback = setTimeout(() => {
            capFiredBeforeWaitListener = !waitListenerRegistered;
            now += delayMs;
            callback();
          }, 1_000);
          void waitListenerReady.then(() => {
            if (disposed) return;
            clearTimeout(fallback);
            now += delayMs;
            callback();
          });
          return { dispose: () => { disposed = true; clearTimeout(fallback); } };
        },
      });

      expect(providerCalls).toBe(1);
      expect(waitListenerRegistered).toBe(true);
      expect(capFiredBeforeWaitListener).toBe(false);
      expect(result).toMatchObject({ stopReason: 'max_turns', goalComplete: false, iterations: 1 });
      expect(events).toContain('seat-turn-cap');
      expect(events).toContain('seat-turn-cap-exhausted');
      expect(globalAgentRegistry.get(task.id)?.state).toBe('running');

      task.state = 'done';
      task.result = '하위 작업 완료';
      task.finishedAt = now;
      globalAgentRegistry.notifyTaskDone(task);
      expect(await dispatchAgentOutput({ taskId: task.id }, { registry: globalAgentRegistry })).toMatchObject({
        retrievalStatus: 'success', state: 'done', text: '하위 작업 완료',
      });
    } finally {
      clearTimeout(waitFailSafe);
      debug.log = originalLog;
    }
  });
});
