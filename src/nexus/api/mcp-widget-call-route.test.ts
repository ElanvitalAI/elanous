import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpProxyRuntime, createMcpToolAuthorizer } from '../../mcp/proxy-runtime.js';
import {
  _resetToolRuntimeRegistryForTest,
  registerToolRuntime,
} from '../../tool-runtime/registry.js';
import { debug } from '../../debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { runNexus } from '../index.js';
import { setTestStateRoot } from '../paths.js';
import { startNexusHttpServer, type NexusHttpServerOpts } from './http-server.js';
import {
  handleMcpWidgetCall,
  MCP_WIDGET_JOB_POLL_MAX_ELAPSED_MS,
  MCP_WIDGET_VIDEO_JOB_POLL_MAX_ELAPSED_MS,
  pollMaxElapsedMsFor,
  widgetCallTranscriptMessages,
  mediaResultMessage,
  MEDIA_RESULT_TOOL_NAME,
} from './mcp-widget-call-route.js';
import type { SerializedMessage } from '../../session/index.js';
import type { FeedbackEnvelope } from '../../feedback/envelope.js';
import type { ToolRuntimeContext } from '../../tool-runtime/types.js';
import { NexusEventBus } from './event-bus.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';

const PATH = '/v1/mcp/widgets/call';

afterEach(() => _resetToolRuntimeRegistryForTest());

function serverFixture() {
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  return { state, eventBus, registry: new TabRegistry(state) };
}

function registerProxy(serverId: string) {
  const calls: Array<{ toolId: string; name: string; args: Record<string, unknown> }> = [];
  const authorizer = createMcpToolAuthorizer();
  authorizer.grant({ serverId, toolName: 'paint' });
  registerToolRuntime(createMcpProxyRuntime({
    serverId,
    mcpTool: { name: 'paint', inputSchema: { type: 'object' } },
    authorizer,
    client: {
      async callTool(name, args) {
        calls.push({ toolId: `${serverId}.${name}`, name, args });
        return { content: [{ type: 'text', text: `painted:${serverId}` }] };
      },
    },
  }) as never);
  return calls;
}

function mcpHandle(perServer: Record<string, { status: 'ready' | 'failed' | 'disabled'; toolCount: number }>) {
  return {
    clients: [],
    registered: Object.values(perServer).reduce((sum, server) => sum + server.toolCount, 0),
    perServer,
    shutdown: async () => {},
  } as never;
}

async function postCall(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}${PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function widgetRequest(body: unknown): Request {
  return new Request(`http://nexus.test${PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 시험 전용 시간 상한 — 실물 180초와 «다른 값»이다. 시간 예산 정책만 잰다. */
const TEST_POLL_MAX_ELAPSED_MS = 10_000;

function routeOptions(dispatch: (context: ToolRuntimeContext) => Promise<unknown>, getFeedbackEmitter?: (sessionId: string) => ((env: FeedbackEnvelope) => void) | undefined,
  pollLimits: NonNullable<Parameters<typeof handleMcpWidgetCall>[1]['_pollLimitsForTest']> = { maxElapsedMs: TEST_POLL_MAX_ELAPSED_MS }) {
  return {
    authorize: () => true,
    getTrustedServerId: () => 'trusted',
    getRuntime: () => ({}),
    dispatch: (_toolId: string, _args: Record<string, unknown>, context: ToolRuntimeContext) => dispatch(context) as never,
    ...(getFeedbackEmitter ? { getFeedbackEmitter } : {}),
    // ⭐ 시험은 «규칙»을 재지 «실물 시간»을 재지 않는다 — 상한을 작게 주입한다.
    //   ⛔ 실제 시간 상한(180초)은 실측에서 온 값이고, 그것을 시험이 기다리면 한 파일이 수 분이 된다.
    _pollLimitsForTest: pollLimits,
  };
}

function fakeClock() {
  let current = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => current,
    setTimeout: (callback: () => void, ms: number) => {
      const id = ++nextId;
      timers.set(id, { at: current + ms, callback });
      return id;
    },
    clearTimeout: (timer: unknown) => { timers.delete(timer as number); },
    advance: (ms: number) => {
      current += ms;
      for (const [id, timer] of timers) {
        if (timer.at > current) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

describe('MCP widget call route · poll budgets', () => {
  const imageJob = { job: { jobId: 'image-1', kind: 'image' as const, status: 'pending' as const, model: 'image-model' }, index: 0 };
  const videoJob = { job: { jobId: 'video-1', kind: 'video' as const, status: 'pending' as const, model: 'video-model' }, index: 1 };

  test('keeps the 180-second budget for image-only batches', () => {
    expect(pollMaxElapsedMsFor([imageJob])).toBe(MCP_WIDGET_JOB_POLL_MAX_ELAPSED_MS);
    expect(MCP_WIDGET_JOB_POLL_MAX_ELAPSED_MS).toBe(180_000);
  });

  test('uses the 20-minute budget for video-only and mixed batches', () => {
    expect(pollMaxElapsedMsFor([videoJob])).toBe(MCP_WIDGET_VIDEO_JOB_POLL_MAX_ELAPSED_MS);
    expect(pollMaxElapsedMsFor([imageJob, videoJob])).toBe(MCP_WIDGET_VIDEO_JOB_POLL_MAX_ELAPSED_MS);
    expect(MCP_WIDGET_VIDEO_JOB_POLL_MAX_ELAPSED_MS).toBe(1_200_000);
    expect(MCP_WIDGET_VIDEO_JOB_POLL_MAX_ELAPSED_MS).toBeGreaterThan(MCP_WIDGET_JOB_POLL_MAX_ELAPSED_MS);
  });

  test('keeps a test poll-budget override ahead of the video default', () => {
    expect(pollMaxElapsedMsFor([videoJob], { maxElapsedMs: 10 })).toBe(10);
  });
});

describe('MCP widget call route · feedback context', () => {
  test('passes a valid sessionId and feedback emitter to dispatch without changing the successful body', async () => {
    const contexts: ToolRuntimeContext[] = [];
    const emitFeedback = (_env: FeedbackEnvelope) => {};
    const withSession = await handleMcpWidgetCall(
      widgetRequest({ toolName: 'paint', args: {}, sessionId: 'session-1' }),
      routeOptions(async (context) => { contexts.push(context); return { output: 'painted' }; }, () => emitFeedback),
    );
    const withoutSession = await handleMcpWidgetCall(
      widgetRequest({ toolName: 'paint', args: {} }),
      routeOptions(async (context) => { contexts.push(context); return { output: 'painted' }; }),
    );

    expect(withSession.status).toBe(200);
    expect(withoutSession.status).toBe(200);
    expect(await withSession.json()).toEqual(await withoutSession.json());
    expect(contexts).toEqual([
      { surface: 'mcp', sessionId: 'session-1', emitFeedback },
      { surface: 'mcp' },
    ]);
  });

  test('keeps dispatching and logs when a valid sessionId has no emitter', async () => {
    const logs: Array<{ category: string; event: string; data?: unknown }> = [];
    const originalLog = debug.log.bind(debug) as typeof debug.log;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      logs.push({ category, event, data });
      originalLog(category, event, data);
    }) as typeof debug.log;
    const contexts: ToolRuntimeContext[] = [];
    try {
      const response = await handleMcpWidgetCall(
        widgetRequest({ toolName: 'paint', args: {}, sessionId: 'session-without-emitter' }),
        routeOptions(async (context) => { contexts.push(context); return { output: 'painted' }; }, () => undefined),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ output: 'painted' });
      expect(contexts).toEqual([{ surface: 'mcp' }]);
      expect(logs).toContainEqual({
        category: 'mcp.widget', event: 'feedback-emitter-absent', data: { sessionId: 'session-without-emitter' },
      });
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });

  test('keeps dispatching with the unchanged body when the feedback resolver throws', async () => {
    const contexts: ToolRuntimeContext[] = [];
    const response = await handleMcpWidgetCall(
      widgetRequest({ toolName: 'paint', args: {}, sessionId: 'resolver-throws' }),
      routeOptions(async (context) => { contexts.push(context); return { output: 'painted' }; }, () => {
        throw new Error('ACP broadcaster unavailable');
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ output: 'painted' });
    expect(contexts).toEqual([{ surface: 'mcp' }]);
  });

  test('ignores absent, non-string, empty, and overlong sessionIds without returning 400', async () => {
    const cases = [undefined, 42, '', 'x'.repeat(201)];
    for (const sessionId of cases) {
      const contexts: ToolRuntimeContext[] = [];
      const response = await handleMcpWidgetCall(
        widgetRequest({ toolName: 'paint', args: {}, ...(sessionId === undefined ? {} : { sessionId }) }),
        routeOptions(async (context) => { contexts.push(context); return { output: 'painted' }; }, () => (_env) => {}),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ output: 'painted' });
      expect(contexts).toEqual([{ surface: 'mcp' }]);
    }
  });

  test('polls pending jobs after returning the original response and emits completed images through proxy runtime', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const emitted: FeedbackEnvelope[] = [];
    const authorizer = createMcpToolAuthorizer();
    for (const toolName of ['paint', 'jobs_wait']) authorizer.grant({ serverId: 'trusted', toolName });
    const client = {
      async callTool(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return name === 'paint'
          ? { content: [], structuredContent: { results: [{ job_id: 'job-1', type: 'image', status: 'pending' }] } }
          : { content: [], structuredContent: { results: [{ job_id: 'job-1', type: 'image', status: 'completed', result_url: 'https://image.test/result.png' }] } };
      },
    };
    for (const name of ['paint', 'jobs_wait']) {
      registerToolRuntime(createMcpProxyRuntime({
        serverId: 'trusted', mcpTool: { name, inputSchema: { type: 'object' } }, authorizer, client,
      }) as never);
    }

    const response = await handleMcpWidgetCall(widgetRequest({ toolName: 'paint', args: {}, sessionId: 'session-1' }), {
      authorize: () => true,
      getTrustedServerId: () => 'trusted',
      _pollLimitsForTest: { maxElapsedMs: TEST_POLL_MAX_ELAPSED_MS },
      getFeedbackEmitter: () => (env) => emitted.push(env),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ output: '', structured: { results: [{ job_id: 'job-1', type: 'image', status: 'pending' }] } });
    expect(calls).toEqual([{ name: 'paint', args: {} }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([
      { name: 'paint', args: {} },
      { name: 'jobs_wait', args: { jobs: [{ index: 0, job_id: 'job-1' }] } },
    ]);
    expect(emitted).toContainEqual(expect.objectContaining({
      kind: 'media.image', payload: expect.objectContaining({ src: 'https://image.test/result.png' }),
    }));
  });

  test('uses the trusted server ID for jobs_wait when the initiating tool name contains dots', async () => {
    const calls: string[] = [];
    const response = await handleMcpWidgetCall(widgetRequest({ toolName: 'images.generate', args: {}, sessionId: 'session-1' }), {
      authorize: () => true,
      getTrustedServerId: () => 'trusted',
      _pollLimitsForTest: { maxElapsedMs: TEST_POLL_MAX_ELAPSED_MS },
      getRuntime: () => ({}),
      getFeedbackEmitter: () => () => {},
      dispatch: async (toolId) => {
        calls.push(toolId);
        return toolId === 'trusted.images.generate'
          ? { structured: { results: [{ job_id: 'job-1', type: 'image', status: 'pending' }] } } as never
          : { structured: { results: [{ job_id: 'job-1', type: 'image', status: 'completed' }] } } as never;
      },
    });

    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(['trusted.images.generate', 'trusted.jobs_wait']);
    expect(calls).not.toContain('trusted.images.jobs_wait');
  });

  test('polls beyond twelve attempts until a pending job completes and records the actual count', async () => {
    const logs: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const originalLog = debug.log.bind(debug) as typeof debug.log;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => {
      logs.push({ category, event, data });
      originalLog(category, event, data);
    }) as typeof debug.log;
    try {
      let waitCalls = 0;
      const response = await handleMcpWidgetCall(widgetRequest({ toolName: 'paint', args: {}, sessionId: 'session-1' }), {
        authorize: () => true,
        getTrustedServerId: () => 'trusted',
        _pollLimitsForTest: { maxElapsedMs: TEST_POLL_MAX_ELAPSED_MS },
        getRuntime: () => ({}),
        getFeedbackEmitter: () => () => {},
        dispatch: async (toolId) => {
          if (toolId === 'trusted.paint') return { structured: { results: [{ job_id: 'job-1', type: 'image', status: 'pending' }] } } as never;
          waitCalls += 1;
          return { structured: { results: [{ job_id: 'job-1', type: 'image', status: waitCalls === 20 ? 'completed' : 'pending' }] } } as never;
        },
      });
      expect(response.status).toBe(200);
      await Bun.sleep(30);
      expect(waitCalls).toBe(20);
      expect(logs).toContainEqual(expect.objectContaining({
        category: 'mcp.widget', event: 'poll-done', data: expect.objectContaining({ jobId: 'job-1', attempts: 20 }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });

  test('times out a hung jobs_wait and records the actual attempted call count', async () => {
    const logs: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const emitted: FeedbackEnvelope[] = [];
    const originalLog = debug.log.bind(debug) as typeof debug.log;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => {
      logs.push({ category, event, data });
      originalLog(category, event, data);
    }) as typeof debug.log;
    try {
      let waitCalls = 0;
      const response = await handleMcpWidgetCall(widgetRequest({ toolName: 'paint', args: {}, sessionId: 'session-1' }), {
        authorize: () => true,
        getTrustedServerId: () => 'trusted',
        _pollLimitsForTest: { maxElapsedMs: 40 },
        getRuntime: () => ({}),
        getFeedbackEmitter: () => (env) => emitted.push(env),
        dispatch: async (toolId) => {
          if (toolId === 'trusted.paint') return { structured: { results: [{ job_id: 'job-1', type: 'image', status: 'pending' }] } } as never;
          waitCalls += 1;
          return new Promise(() => {}) as never;
        },
      });
      expect(response.status).toBe(200);
      await Bun.sleep(100);
      expect(waitCalls).toBe(1);
      expect(logs).toContainEqual(expect.objectContaining({
        category: 'mcp.widget', event: 'poll-gave-up', data: expect.objectContaining({ jobId: 'job-1', attempts: 1, emitterRevoked: false }),
      }));
      expect(emitted).toContainEqual(expect.objectContaining({
        kind: 'media.job', phase: 'end', payload: { jobId: 'job-1', mediaKind: 'image', status: 'failed' },
        asciiFallback: ['job-1 failed: polling ended without a result'],
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  }, 12_000);

  test('revokes the polling emitter when timeout feedback throws, blocking late feedback', async () => {
    let pollingEmit: ((env: FeedbackEnvelope) => void) | undefined;
    let emitterCalls = 0;
    const response = await handleMcpWidgetCall(widgetRequest({ toolName: 'paint', args: {}, sessionId: 'session-1' }), {
      authorize: () => true,
      getTrustedServerId: () => 'trusted',
      _pollLimitsForTest: { maxElapsedMs: 10 },
      getRuntime: () => ({}),
      getFeedbackEmitter: () => () => {
        emitterCalls += 1;
        throw new Error('feedback unavailable');
      },
      dispatch: async (toolId, _args, context) => {
        if (toolId === 'trusted.paint') return { structured: { results: [{ job_id: 'job-1', type: 'image', status: 'pending' }] } } as never;
        pollingEmit = context.emitFeedback;
        return new Promise(() => {}) as never;
      },
    });

    expect(response.status).toBe(200);
    await Bun.sleep(30);
    expect(emitterCalls).toBe(1);
    expect(pollingEmit).toBeDefined();
    pollingEmit?.({} as FeedbackEnvelope);
    expect(emitterCalls).toBe(1);
  }, 12_000);

  test('isolates timeout notification failures per pending job and revokes the emitter afterward', async () => {
    const logs: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const emitted: FeedbackEnvelope[] = [];
    const originalLog = debug.log.bind(debug) as typeof debug.log;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => {
      logs.push({ category, event, data });
      originalLog(category, event, data);
    }) as typeof debug.log;
    let pollingEmit: ((env: FeedbackEnvelope) => void) | undefined;
    let emitterCalls = 0;
    try {
      const response = await handleMcpWidgetCall(widgetRequest({ toolName: 'paint', args: {}, sessionId: 'session-1' }), {
        authorize: () => true,
        getTrustedServerId: () => 'trusted',
        _pollLimitsForTest: { maxElapsedMs: 10 },
        getRuntime: () => ({}),
        getFeedbackEmitter: () => (env) => {
          emitterCalls += 1;
          if (emitterCalls === 1) throw new Error('first notification unavailable');
          emitted.push(env);
        },
        dispatch: async (toolId, _args, context) => {
          if (toolId === 'trusted.paint') {
            return { structured: { results: [
              { job_id: 'job-1', type: 'image', status: 'pending' },
              { job_id: 'job-2', type: 'image', status: 'pending' },
            ] } } as never;
          }
          pollingEmit = context.emitFeedback;
          return new Promise(() => {}) as never;
        },
      });

      expect(response.status).toBe(200);
      await Bun.sleep(40);
      expect(emitted).toContainEqual(expect.objectContaining({
        kind: 'media.job', payload: { jobId: 'job-2', mediaKind: 'image', status: 'failed' },
      }));
      expect(logs).toContainEqual(expect.objectContaining({
        category: 'mcp.widget', event: 'poll-gave-up-notify-failed', data: expect.objectContaining({ jobId: 'job-1' }),
      }));
      expect(logs.filter(({ event }) => event === 'poll-gave-up').map(({ data }) => data?.jobId).sort()).toEqual(['job-1', 'job-2']);
      expect(logs.filter(({ event }) => event === 'poll-gave-up').every(({ data }) => data?.attempts === 1)).toBe(true);
      expect(pollingEmit).toBeDefined();
      const emittedBeforeLateFeedback = emitted.length;
      pollingEmit?.({} as FeedbackEnvelope);
      expect(emitted).toHaveLength(emittedBeforeLateFeedback);
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  }, 12_000);

  test('emits a failed terminal job when jobs_wait rejects', async () => {
    const emitted: FeedbackEnvelope[] = [];
    const response = await handleMcpWidgetCall(widgetRequest({ toolName: 'paint', args: {}, sessionId: 'session-1' }), {
      authorize: () => true,
      getTrustedServerId: () => 'trusted',
      _pollLimitsForTest: { maxElapsedMs: TEST_POLL_MAX_ELAPSED_MS },
      getRuntime: () => ({}),
      getFeedbackEmitter: () => (env) => emitted.push(env),
      dispatch: async (toolId) => {
        if (toolId === 'trusted.paint') return { structured: { results: [{ job_id: 'job-1', type: 'image', status: 'pending' }] } } as never;
        throw new Error('jobs_wait unavailable');
      },
    });

    expect(response.status).toBe(200);
    await Bun.sleep(30);
    expect(emitted).toContainEqual(expect.objectContaining({
      kind: 'media.job', phase: 'end', payload: { jobId: 'job-1', mediaKind: 'image', status: 'failed' },
    }));
    // ⛔ 이 경로는 «즉시 거부»다 — 시간 상한을 쓰지 «않았다».
    //    그러니 사람에게 「timed out」이라 말하면 «거짓»이다. 문면이 원인을 단정하지 않는지 «본다».
    //    📏 반증: 문면을 `polling timed out` 으로 되돌리면 이 단언이 빨강이 된다.
    const rejected = emitted.find((env) => env.kind === 'media.job' && env.phase === 'end');
    expect(rejected?.asciiFallback?.join(' ')).not.toContain('timed out');
    expect(rejected?.asciiFallback?.join(' ')).toContain('polling ended without a result');
  });

  test('records every terminal job and retries jobs omitted from a polling result', async () => {
    const logs: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const originalLog = debug.log.bind(debug) as typeof debug.log;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => {
      logs.push({ category, event, data });
      originalLog(category, event, data);
    }) as typeof debug.log;
    try {
      let waitCalls = 0;
      const response = await handleMcpWidgetCall(widgetRequest({ toolName: 'paint', args: {}, sessionId: 'session-1' }), {
        authorize: () => true,
        getTrustedServerId: () => 'trusted',
        _pollLimitsForTest: { maxElapsedMs: TEST_POLL_MAX_ELAPSED_MS },
        getRuntime: () => ({}),
        getFeedbackEmitter: () => () => {},
        dispatch: async (toolId) => {
          if (toolId === 'trusted.paint') {
            return { structured: { results: [
              { job_id: 'job-1', type: 'image', status: 'pending' },
              { job_id: 'job-2', type: 'image', status: 'pending' },
              { job_id: 'job-3', type: 'image', status: 'pending' },
            ] } } as never;
          }
          waitCalls += 1;
          return { structured: { results: waitCalls === 1 ? [
            { job_id: 'job-1', type: 'image', status: 'completed' },
            { job_id: 'job-2', type: 'image', status: 'failed' },
          ] : [{ job_id: 'job-3', type: 'image', status: 'failed' }] } } as never;
        },
      });
      expect(response.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(waitCalls).toBe(2);
      expect(logs.filter(({ event }) => event === 'poll-done').map(({ data }) => data?.jobId).sort()).toEqual(['job-1', 'job-2', 'job-3']);
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });

  test('does not poll completed jobs, pending jobs without a sessionId, or pending jobs without an emitter', async () => {
    const calls: string[] = [];
    const dispatch = async (toolId: string, _args: Record<string, unknown>, context: ToolRuntimeContext) => {
      calls.push(`${toolId}:${context.sessionId ?? 'none'}`);
      const job = toolId === 'trusted.paint' && context.sessionId === 'completed'
        ? { job_id: 'completed-job', type: 'image', status: 'completed' }
        : { job_id: 'pending-job', type: 'image', status: 'pending' };
      return { structured: { results: [job] } } as never;
    };
    const completed = await handleMcpWidgetCall(widgetRequest({ toolName: 'paint', args: {}, sessionId: 'completed' }), {
      authorize: () => true, getTrustedServerId: () => 'trusted', getRuntime: () => ({}), getFeedbackEmitter: () => () => {}, dispatch,
      _pollLimitsForTest: { maxElapsedMs: TEST_POLL_MAX_ELAPSED_MS },
    });
    const withoutSession = await handleMcpWidgetCall(widgetRequest({ toolName: 'paint', args: {} }), {
      authorize: () => true, getTrustedServerId: () => 'trusted', getRuntime: () => ({}), dispatch,
      _pollLimitsForTest: { maxElapsedMs: TEST_POLL_MAX_ELAPSED_MS },
    });
    const withoutEmitter = await handleMcpWidgetCall(widgetRequest({ toolName: 'paint', args: {}, sessionId: 'missing-emitter' }), {
      authorize: () => true, getTrustedServerId: () => 'trusted', getRuntime: () => ({}), getFeedbackEmitter: () => undefined, dispatch,
      _pollLimitsForTest: { maxElapsedMs: TEST_POLL_MAX_ELAPSED_MS },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completed.status).toBe(200);
    expect(withoutSession.status).toBe(200);
    expect(withoutEmitter.status).toBe(200);
    expect(calls).toEqual(['trusted.paint:completed', 'trusted.paint:none', 'trusted.paint:none']);
  });

  // ⛔⭐ 무인 리뷰가 마지막에 잡은 결함의 회귀 가드.
  //   `Promise.race` 는 «기다림»만 끝내고 실제 dispatch 는 계속 산다.
  //   ⇒ 상한 뒤 «늦게» 끝난 jobs_wait 가 봉투를 내면, 「포기했다」고 기록해 놓고 화면은 갱신되는
  //     ***관측과 행동이 어긋난 상태***가 된다. emitter 를 해지해 그것을 막는다.
  test('상한 뒤 «늦게» 끝난 폴링은 봉투를 «내지 못한다»', async () => {
    const emitted: FeedbackEnvelope[] = [];
    const clock = fakeClock();
    const maxElapsedMs = 50;
    let lateEmit: ((env: FeedbackEnvelope) => void) | undefined;
    let calls = 0;
    let signalPollStarted!: () => void;
    const pollStarted = new Promise<void>(resolve => { signalPollStarted = resolve; });
    let signalPollEnded!: () => void;
    const pollEnded = new Promise<void>(resolve => { signalPollEnded = resolve; });
    const originalLog = debug.log;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => {
      originalLog.call(debug, category, event, data);
      if (category === 'mcp.widget' && event === 'poll-gave-up' && data?.jobId === 'job-late') signalPollEnded();
    }) as typeof debug.log;

    try {
      const res = await handleMcpWidgetCall(
        widgetRequest({ toolName: 'generate_image', args: {}, sessionId: 'sess-late' }),
        routeOptions(
        async (context) => {
          calls += 1;
          if (calls === 1) {
            // 제출 응답 — pending job 하나 ⇒ 폴링이 시작된다.
            return {
              structuredContent: {
                structured: { results: [{ id: 'job-late', type: 'image', status: 'pending', model: 'gpt_image_2' }] },
              },
            };
          }
          // 폴링 호출 — ⭐ 그 «폴링 컨텍스트의» emitter 를 붙잡아 두고 «영원히» 안 끝난다.
          lateEmit = context.emitFeedback;
          signalPollStarted();
          return await new Promise(() => {});
        },
        () => (env) => { emitted.push(env); },
        { maxElapsedMs, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
      ),
      );

      expect(res.status).toBe(200);
      await pollStarted;
      expect(typeof lateEmit).toBe('function');

      // 상한을 fake clock으로 넘긴 뒤, 실제 응답이 늦게 와도 봉투가 나가지 않는다.
      clock.advance(maxElapsedMs);
      await pollEnded;
      lateEmit!({ kind: 'media.image', blockId: 'b', phase: 'end', seq: 1, asciiFallback: ['x'] } as never);

      expect(emitted.filter((e) => e.kind === 'media.image')).toHaveLength(0);
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });
});

describe('MCP widget call route · trusted server binding', () => {
  test('configured widgetServerId dispatches to that server when two servers are ready', async () => {
    const trustedCalls = registerProxy('xcodebuild');
    const otherCalls = registerProxy('higgsfield');
    const fixture = serverFixture();
    const server = startNexusHttpServer({
      ...fixture,
      metaApi: { noAuth: true },
      getMcpClients: () => mcpHandle({
        xcodebuild: { status: 'ready', toolCount: 1 },
        higgsfield: { status: 'ready', toolCount: 1 },
      }),
      getMcpWidgetServerId: () => 'xcodebuild',
      startPort: 58000 + Math.floor(Math.random() * 1000),
    });
    try {
      const response = await postCall(server.url, {
        toolName: 'paint', args: { via: 'config' }, server: 'higgsfield',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ output: 'painted:xcodebuild' });
      expect(trustedCalls).toEqual([{ toolId: 'xcodebuild.paint', name: 'paint', args: { via: 'config' } }]);
      expect(otherCalls).toEqual([]);
    } finally { server.stop(); }
  });

  test('sole ready server still succeeds without a configured selector', async () => {
    const calls = registerProxy('xcodebuild');
    const fixture = serverFixture();
    const server = startNexusHttpServer({
      ...fixture,
      metaApi: { noAuth: true },
      getMcpClients: () => mcpHandle({
        xcodebuild: { status: 'ready', toolCount: 1 },
        xcode: { status: 'failed', toolCount: 0 },
      }),
      startPort: 59000 + Math.floor(Math.random() * 1000),
    });
    try {
      const response = await postCall(server.url, { toolName: 'paint', args: { via: 'sole' } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ output: 'painted:xcodebuild' });
      expect(calls).toEqual([{ toolId: 'xcodebuild.paint', name: 'paint', args: { via: 'sole' } }]);
    } finally { server.stop(); }
  });

  test('fails closed without a selector when more than one server is ready', async () => {
    const trustedCalls = registerProxy('xcodebuild');
    const otherCalls = registerProxy('higgsfield');
    const fixture = serverFixture();
    const server = startNexusHttpServer({
      ...fixture,
      metaApi: { noAuth: true },
      getMcpClients: () => mcpHandle({
        xcodebuild: { status: 'ready', toolCount: 1 },
        higgsfield: { status: 'ready', toolCount: 1 },
      }),
      startPort: 60000 + Math.floor(Math.random() * 1000),
    });
    try {
      const response = await postCall(server.url, {
        toolName: 'paint', args: {}, server: 'higgsfield',
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'mcp-widget-server-unavailable' });
      expect(trustedCalls).toEqual([]);
      expect(otherCalls).toEqual([]);
    } finally { server.stop(); }
  });
});

describe('MCP widget call route · runNexus boot options', () => {
  let stateRoot: string;
  let configDir: string;

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-widget-call-'));
    configDir = mkdtempSync(join(tmpdir(), 'elanous-nexus-widget-config-'));
    writeFileSync(join(configDir, 'user.json'), JSON.stringify({
      mcp: { enabled: false },
      autopilot: { threadRegistry: false, coordinatorGovern: false, coordinatorPush: false },
    }));
    setTestStateRoot(stateRoot);
    setElanousConfigDir(configDir);
  });

  afterEach(() => {
    resetElanousConfigDir();
    setTestStateRoot(null);
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  async function bootWidgetBinding(mcp: {
    servers: Array<{ id: string; command: string[] }>;
    widgetServerId?: string;
  }) {
    const logs: Array<{ category: string; event: string; data?: unknown }> = [];
    const originalLog = debug.log.bind(debug) as typeof debug.log;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      logs.push({ category, event, data });
      originalLog(category, event, data);
    }) as typeof debug.log;
    let captured: NexusHttpServerOpts | undefined;
    try {
      const nexus = await runNexus({
        detachForTesting: true,
        skipHttpServer: false,
        autoMountShare: false,
        mcpEnabled: false,
        skipSupervisor: true,
        skipRuntimeApi: true,
        skipPushcutChannel: true,
        skipPwaChannel: true,
        skipTelegramChannel: true,
        skipTerminalChannel: true,
        skipDiscordChannel: true,
        skipIntentPrediction: true,
        skipEnvMigration: true,
        skipRestoreFromPending: true,
        registerDaemonTab: false,
        registerSettingsTab: false,
        startNexusHttpServerFn: ((opts: NexusHttpServerOpts) => {
          captured = opts;
          return { port: 31415, stop: () => {} } as never;
        }) as typeof startNexusHttpServer,
        getMcpUserConfigForTesting: () => ({ mcp } as never),
        registerMcpClientsFn: async () => ({
          clients: [],
          registered: 0,
          perServer: {},
          shutdown: async () => {},
        }),
      });
      if (!nexus) throw new Error('runNexus returned undefined');
      return { nexus, captured, logs };
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  }

  function startFromBoot(
    captured: NexusHttpServerOpts | undefined,
    perServer: Record<string, { status: 'ready' | 'failed' | 'disabled'; toolCount: number }>,
    startPort: number,
  ) {
    const fixture = serverFixture();
    return startNexusHttpServer({
      ...fixture,
      metaApi: { noAuth: true },
      getMcpClients: () => mcpHandle(perServer),
      ...(captured?.getMcpWidgetServerId ? { getMcpWidgetServerId: captured.getMcpWidgetServerId } : {}),
      startPort,
    });
  }

  test('runNexus unknown widgetServerId logs, omits the selector, and never dispatches to ghost', async () => {
    const readyCalls = registerProxy('xcodebuild');
    const otherCalls = registerProxy('higgsfield');
    const ghostCalls = registerProxy('ghost');
    const { nexus, captured, logs } = await bootWidgetBinding({
      widgetServerId: 'ghost',
      servers: [
        { id: 'xcodebuild', command: ['xcodebuildmcp', 'mcp'] },
        { id: 'higgsfield', command: ['higgsfield'] },
      ],
    });
    const server = startFromBoot(captured, {
      xcodebuild: { status: 'ready', toolCount: 1 },
      higgsfield: { status: 'ready', toolCount: 1 },
    }, 61000 + Math.floor(Math.random() * 1000));
    try {
      expect(captured?.getMcpWidgetServerId).toBeUndefined();
      expect(logs).toContainEqual(expect.objectContaining({
        category: 'mcp.widget',
        event: 'unknown-widget-server-id',
        data: expect.objectContaining({ serverId: 'ghost' }),
      }));
      expect(logs).toContainEqual(expect.objectContaining({
        category: 'mcp.widget',
        event: 'server-binding',
        data: expect.objectContaining({ source: 'none', readyCount: 0 }),
      }));
      const response = await postCall(server.url, { toolName: 'paint', args: {}, server: 'ghost' });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'mcp-widget-server-unavailable' });
      expect(ghostCalls).toEqual([]);
      expect(readyCalls).toEqual([]);
      expect(otherCalls).toEqual([]);
    } finally {
      server.stop();
      await nexus.release();
    }
  }, 15_000);

  test('runNexus unknown widgetServerId with empty servers still logs and falls back', async () => {
    const ghostCalls = registerProxy('ghost');
    const readyCalls = registerProxy('xcodebuild');
    const { nexus, captured, logs } = await bootWidgetBinding({
      widgetServerId: 'ghost',
      servers: [],
    });
    const server = startFromBoot(captured, {
      xcodebuild: { status: 'ready', toolCount: 1 },
    }, 62000 + Math.floor(Math.random() * 1000));
    try {
      expect(captured?.getMcpWidgetServerId).toBeUndefined();
      expect(logs).toContainEqual(expect.objectContaining({
        category: 'mcp.widget',
        event: 'unknown-widget-server-id',
        data: expect.objectContaining({ serverId: 'ghost' }),
      }));
      const response = await postCall(server.url, { toolName: 'paint', args: { via: 'sole-after-unknown' } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ output: 'painted:xcodebuild' });
      expect(ghostCalls).toEqual([]);
      expect(readyCalls).toEqual([{
        toolId: 'xcodebuild.paint',
        name: 'paint',
        args: { via: 'sole-after-unknown' },
      }]);
    } finally {
      server.stop();
      await nexus.release();
    }
  }, 15_000);

  test('runNexus configured widgetServerId is the option the HTTP server dispatches with', async () => {
    const trustedCalls = registerProxy('xcodebuild');
    const otherCalls = registerProxy('higgsfield');
    const { nexus, captured, logs } = await bootWidgetBinding({
      widgetServerId: 'xcodebuild',
      servers: [
        { id: 'xcode', command: ['xcrun', 'mcpbridge'] },
        { id: 'xcodebuild', command: ['xcodebuildmcp', 'mcp'] },
        { id: 'higgsfield', command: ['higgsfield'] },
      ],
    });
    const server = startFromBoot(captured, {
      xcodebuild: { status: 'ready', toolCount: 1 },
      higgsfield: { status: 'ready', toolCount: 1 },
    }, 63000 + Math.floor(Math.random() * 1000));
    try {
      expect(captured?.getMcpWidgetServerId?.(new Request(`http://nexus.test${PATH}`))).toBe('xcodebuild');
      expect(logs).toContainEqual(expect.objectContaining({
        category: 'mcp.widget',
        event: 'server-binding',
        data: expect.objectContaining({ source: 'config', serverId: 'xcodebuild' }),
      }));
      const response = await postCall(server.url, {
        toolName: 'paint', args: { via: 'boot-config' }, server: 'higgsfield',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ output: 'painted:xcodebuild' });
      expect(trustedCalls).toEqual([{
        toolId: 'xcodebuild.paint',
        name: 'paint',
        args: { via: 'boot-config' },
      }]);
      expect(otherCalls).toEqual([]);
    } finally {
      server.stop();
      await nexus.release();
    }
  }, 15_000);
});

// ⛔⭐⭐ OBS-T521 — 슬래시 명령으로 «시작한» 세션이 저장소에 아예 안 생겼다.
//   📏 실기기 실측(2026-09-11): `/video` 로 연 세션 둘 다 `/v1/sessions/store/<id>` 404 ⊕ 목록에도 없음.
//   🔑 기전: 안드로이드는 슬래시를 만나면 `submitSlashCommand` 로 가고 «return» 한다 —
//      `/v1/prompt/stream` 을 «건너뛴다». 그 경로에만 저장소 미러(`wireDaemonHistoryToStore`)가 있었다.
//   ⇒ 이 라우트가 «자기 턴»을 남긴다.
describe('MCP widget call route · 세션 저장소 write-through (OBS-T521)', () => {
  test('세션 id 가 있으면 사용자 줄 ⊕ 도구 흔적을 남긴다', async () => {
    const persisted: { sessionId: string; messages: readonly SerializedMessage[] }[] = [];
    const response = await handleMcpWidgetCall(
      widgetRequest({
        toolName: 'paint',
        args: { params: { model: 'gpt_image_2', prompt: 'a small paper boat' } },
        sessionId: 'android-abc',
        userText: '/image a small paper boat',
      }),
      {
        ...routeOptions(async () => ({ ok: true })),
        persistTurn: (sessionId, messages) => persisted.push({ sessionId, messages }),
      },
    );

    expect(response.status).toBe(200);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.sessionId).toBe('android-abc');
    const roles = persisted[0]!.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'tool']);
    // ⭐ 화면에 «보이는 그대로»를 적는다 — prompt 만 적으면 대화 복원이 화면과 어긋난다.
    expect(persisted[0]!.messages[0]!.content).toBe('/image a small paper boat');
  });

  test('세션 id 가 «없으면» 아무것도 남기지 않는다', async () => {
    const persisted: unknown[] = [];
    await handleMcpWidgetCall(
      widgetRequest({ toolName: 'paint', args: {} }),
      { ...routeOptions(async () => ({ ok: true })), persistTurn: () => persisted.push(1) },
    );
    expect(persisted).toHaveLength(0);
  });

  test('⛔ 저장 실패가 위젯 호출을 «깨뜨리지 않는다» (fail-soft)', async () => {
    const response = await handleMcpWidgetCall(
      widgetRequest({ toolName: 'paint', args: {}, sessionId: 'android-abc' }),
      {
        ...routeOptions(async () => ({ ok: true })),
        persistTurn: () => { throw new Error('disk full'); },
      },
    );
    expect(response.status).toBe(200);
  });

  describe('widgetCallTranscriptMessages', () => {
    test('userText 가 없으면 도구 인자의 prompt 로 내려간다', () => {
      const msgs = widgetCallTranscriptMessages(
        'generate_video',
        { params: { prompt: 'a red lantern' } },
        undefined,
        { ok: true },
      );
      expect(msgs.map((m) => m.role)).toEqual(['user', 'tool']);
      expect(msgs[0]!.content).toBe('a red lantern');
    });

    test('⛔ 적을 사용자 줄이 «전혀 없으면» 빈 줄을 적지 않는다', () => {
      const msgs = widgetCallTranscriptMessages('generate_video', {}, '   ', { ok: true });
      expect(msgs.map((m) => m.role)).toEqual(['tool']);
    });

    test('도구 흔적은 이름·인자·결과를 담는다', () => {
      const msgs = widgetCallTranscriptMessages('generate_image', { params: { prompt: 'x' } }, 'x', { jobId: 'j1' });
      const trace = msgs.at(-1)!;
      expect(trace.toolName).toBe('generate_image');
      expect(String(trace.toolResult)).toContain('j1');
    });
  });
});

// ⛔⭐ OBS-T524 — 「대화는 돌아오는데 그 아래 생성물이 안 돌아온다」.
//   📏 실측(2026-09-11): 위젯 호출 «시점»의 도구 흔적에는 잡이 `status:"pending"` 으로만 있다.
//      결과 주소는 그 «뒤» 폴링으로 오는데, 폴링은 저장소에 아무것도 안 남겼다.
describe('mediaResultMessage · 완성된 미디어를 저장소 한 줄로 (OBS-T524)', () => {
  const NOW = '2026-09-11T00:00:00.000Z';

  test('결과 주소가 있으면 앱이 그릴 것만 담아 남긴다', () => {
    const msg = mediaResultMessage(
      { jobId: 'j1', kind: 'video', status: 'completed', model: 'minimax_hailuo', resultUrl: 'https://cdn.test/v.mp4', prompt: '종이배' },
      NOW,
    );
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe('tool');
    expect(msg!.toolName).toBe(MEDIA_RESULT_TOOL_NAME);
    const parsed = JSON.parse(String(msg!.toolResult)) as Record<string, unknown>;
    expect(parsed).toEqual({
      jobId: 'j1',
      kind: 'video',
      status: 'completed',
      model: 'minimax_hailuo',
      resultUrl: 'https://cdn.test/v.mp4',
      prompt: '종이배',
    });
  });

  test('⛔ 결과 주소가 «없으면» 아무 줄도 남기지 않는다', () => {
    // 그릴 수 없는 줄을 남기면 복원 화면에 «빈 칸»이 뜬다 — 그건 「고장」으로 읽힌다.
    expect(mediaResultMessage({ jobId: 'j2', kind: 'image', status: 'failed', model: 'm' }, NOW)).toBeNull();
    expect(mediaResultMessage({ jobId: 'j3', kind: 'image', status: 'completed', model: 'm' }, NOW)).toBeNull();
  });

  test('prompt 가 없으면 그 칸을 «만들지 않는다»', () => {
    const msg = mediaResultMessage(
      { jobId: 'j4', kind: 'image', status: 'completed', model: 'm', resultUrl: 'https://cdn.test/i.png' },
      NOW,
    );
    const parsed = JSON.parse(String(msg!.toolResult)) as Record<string, unknown>;
    expect('prompt' in parsed).toBe(false);
  });
});
