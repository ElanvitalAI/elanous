import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setElanousConfigDir, resetElanousConfigDir } from '../../elanous-config-dir.js';
import { ProjectStore } from '../../project/project-store.js';
import { createSession } from '../../session/index.js';

import { DaemonSessionHistory } from '../../boot/daemon-runtime.js';
import { surfaceUxFromDispatchCtx } from '../../agent/surface-ux/build.js';
import * as coreTurnModule from '../../core-turn/index.js';
import * as providerSummary from '../../provider-summary.js';
import { debug } from '../../debug/log.js';
import { HudStore } from '../state/hud-store.js';
import { NexusEventBus } from './event-bus.js';
import { createHitlPendingCallbacks } from './hitl-runtime.js';
import * as hudWriter from './daemon-hud-writer.js';
import type { DaemonToolDispatchCtx, DaemonToolSurface } from '../../boot/daemon-tools/types.js';
import type { FeedbackEnvelope } from '../../feedback/envelope.js';
import { handlePromptPost, handlePromptStreamPost } from './meta-api.js';

afterEach(() => {
  mock.restore();
});

const ACTIVE = {
  provider: 'grok',
  model: 'grok-4.6',
  auth: 'oauth' as const,
  authDetail: 'test',
};

function mockTurn(finalText = 'OK'): void {
  spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
    ctx.callbacks?.onText?.(finalText, finalText);
    return { stopReason: 'end_turn', finalText };
  });
}

async function drainSse(res: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await res.text();
  return text.trim().split('\n\n').map((block) => {
    const event = block.match(/^event: (.+)$/m)?.[1]!;
    const data = JSON.parse(block.match(/^data: (.+)$/m)?.[1]!) as Record<string, unknown>;
    return { event, data };
  });
}

const feedbackEnvelope: FeedbackEnvelope = {
  envelopeVersion: 1,
  sessionId: 'feedback-session',
  blockId: 'feedback-block',
  kind: 'agent.thinking',
  phase: 'delta',
  emittedAt: 1,
  seq: 1,
  asciiFallback: ['working'],
  payload: { msg: 'working' },
};

function mockFeedbackTurn(): void {
  spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
    await ctx.dispatchTool?.('FeedbackTool', {});
    return { stopReason: 'end_turn', finalText: 'OK' };
  });
}

function feedbackToolSurface(env = feedbackEnvelope, count = 1): DaemonToolSurface {
  return {
    kind: 'chat',
    specs: [],
    async dispatch(_name, _args, ctx) {
      for (let index = 0; index < count; index += 1) ctx.emitFeedback?.(env);
      return { ok: true };
    },
  };
}

function includesFeedbackEnvelope(frames: readonly unknown[]): boolean {
  return frames.some((frame) => JSON.stringify(frame) === JSON.stringify(feedbackEnvelope));
}

test('project conversation selects tool cwd and attaches AGENTS.md to system context; unassigned stays on default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'project-prompt-'));
  const oldSession = process.env.ELANOUS_SESSION_ROOT;
  try {
    setElanousConfigDir(join(root, 'config'));
    process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
    const folder = join(root, 'project');
    mkdirSync(folder);
    writeFileSync(join(folder, 'AGENTS.md'), 'Use the project conventions.');
    const project = new ProjectStore(join(root, 'config')).create({ name: 'sample', primaryFolder: folder });
    const assigned = createSession({ projectId: project.id });
    const plain = createSession();
    const observations: Array<{ cwd: string | undefined; system: string }> = [];
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      const tool = await ctx.dispatchTool?.('CheckCwd', {});
      observations.push({ cwd: (tool as { cwd?: string })?.cwd, system: JSON.stringify(ctx.messages) });
      return { stopReason: 'end_turn', finalText: 'OK' };
    });
    const opts = { noAuth: true, history: new DaemonSessionHistory(), toolCwd: root,
      toolSurface: { kind: 'chat' as const, specs: [], dispatch: async (_name: string, _args: unknown, ctx: DaemonToolDispatchCtx) => ({ cwd: ctx.cwd }) },
      systemPrompt: 'Base instructions' };
    for (const sessionId of [assigned.id, plain.id]) {
      await handlePromptPost(new Request('http://test/v1/prompt', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, userText: 'check' }),
      }), opts);
    }
    await drainSse(await handlePromptStreamPost(new Request('http://test/v1/prompt/stream', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: assigned.id, userText: 'stream check' }),
    }), opts));
    expect(observations.map(o => o.cwd)).toEqual([folder, root, folder]);
    expect(observations[0]?.system).toContain('Use the project conventions.');
    expect(observations[2]?.system).toContain('Use the project conventions.');
    expect(observations[0]?.system).toContain('Base instructions');
    expect(observations[1]?.system).toContain('Base instructions');
    expect(observations[1]?.system).not.toContain('Use the project conventions.');
    const liveInstructions = join(folder, 'AGENTS.md');
    writeFileSync(liveInstructions, 'Updated project conventions.');
    await drainSse(await handlePromptStreamPost(new Request('http://test/v1/prompt/stream', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: assigned.id, userText: 'updated instructions' }),
    }), opts));
    expect(observations[3]?.system).toContain('Updated project conventions.');
    expect(observations[3]?.system).not.toContain('Use the project conventions.');
  } finally {
    resetElanousConfigDir();
    if (oldSession === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = oldSession;
    rmSync(root, { recursive: true, force: true });
  }
});

test('both prompt endpoints reject JSON null with the existing bad-request response', async () => {
  const opts = { noAuth: true, history: new DaemonSessionHistory() };
  for (const [path, handler] of [
    ['/v1/prompt', handlePromptPost],
    ['/v1/prompt/stream', handlePromptStreamPost],
  ] as const) {
    const response = await handler(new Request(`http://test${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null',
    }), opts);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'bad_request', reason: 'userText or userContent required' });
  }
});

describe('POST /v1/prompt/stream feedback event-bus delivery', () => {
  test('publishes the original FeedbackEnvelope to long-lived media subscribers while preserving SSE', async () => {
    mockFeedbackTurn();
    const eventBus = new NexusEventBus();
    const received: unknown[] = [];
    eventBus.subscribe((event) => received.push(event), ['media.']);

    const response = await handlePromptStreamPost(new Request('http://test/v1/prompt/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'feedback-session', userText: 'please run the tool' }),
    }), {
      noAuth: true,
      history: new DaemonSessionHistory(),
      toolSurface: feedbackToolSurface(),
      toolCwd: process.cwd(),
      eventBus,
    });

    const events = await drainSse(response);
    const feedbackFrames = events.filter((event) => event.event === 'feedback').map((event) => event.data);
    expect(includesFeedbackEnvelope(feedbackFrames)).toBe(true);
    expect(received).toHaveLength(feedbackFrames.length);
    expect(received.some((event) => {
      const candidate = event as { kind?: string; detail?: unknown };
      return candidate.kind === 'media.feedback'
        && JSON.stringify(candidate.detail) === JSON.stringify(feedbackEnvelope);
    })).toBe(true);
  });

  test('preserves feedback SSE delivery when no event bus is supplied', async () => {
    mockFeedbackTurn();

    const response = await handlePromptStreamPost(new Request('http://test/v1/prompt/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'feedback-session', userText: 'please run the tool' }),
    }), {
      noAuth: true,
      history: new DaemonSessionHistory(),
      toolSurface: feedbackToolSurface(),
      toolCwd: process.cwd(),
    });

    const withoutBusFeedbackFrames = (await drainSse(response))
      .filter((event) => event.event === 'feedback').map((event) => event.data);

    mockFeedbackTurn();
    const withBusResponse = await handlePromptStreamPost(new Request('http://test/v1/prompt/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'feedback-session', userText: 'please run the tool' }),
    }), {
      noAuth: true,
      history: new DaemonSessionHistory(),
      toolSurface: feedbackToolSurface(),
      toolCwd: process.cwd(),
      eventBus: new NexusEventBus(),
    });
    const withBusFeedbackFrames = (await drainSse(withBusResponse))
      .filter((event) => event.event === 'feedback').map((event) => event.data);

    expect(includesFeedbackEnvelope(withoutBusFeedbackFrames)).toBe(true);
    expect(includesFeedbackEnvelope(withBusFeedbackFrames)).toBe(true);
    expect(withoutBusFeedbackFrames).toHaveLength(withBusFeedbackFrames.length);
  });

  test('continues and completes the SSE turn when event-bus publishing throws', async () => {
    mockFeedbackTurn();
    const eventBus = new NexusEventBus();
    spyOn(eventBus, 'publish').mockImplementation(() => { throw new Error('bus unavailable'); });

    const response = await handlePromptStreamPost(new Request('http://test/v1/prompt/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'feedback-session', userText: 'please run the tool' }),
    }), {
      noAuth: true,
      history: new DaemonSessionHistory(),
      toolSurface: feedbackToolSurface(),
      toolCwd: process.cwd(),
      eventBus,
    });

    const events = await drainSse(response);
    expect(includesFeedbackEnvelope(events.filter((event) => event.event === 'feedback').map((event) => event.data))).toBe(true);
    expect(events.find((event) => event.event === 'turn-end')?.data).toMatchObject({
      sessionId: 'feedback-session', text: 'OK', stopReason: 'end_turn',
    });
  });

  test('records only the first throwing-bus failure and one per-turn total while preserving SSE completion', async () => {
    mockFeedbackTurn();
    const eventBus = new NexusEventBus();
    const publish = spyOn(eventBus, 'publish').mockImplementation(() => { throw new Error('bus unavailable'); });
    const logs: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const originalLog = debug.log.bind(debug) as typeof debug.log;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'nexus.event-bus') logs.push({ category, event, data });
    }) as typeof debug.log;
    try {
      const response = await handlePromptStreamPost(new Request('http://test/v1/prompt/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'feedback-session', userText: 'please run the tool' }),
      }), {
        noAuth: true,
        history: new DaemonSessionHistory(),
        toolSurface: feedbackToolSurface(feedbackEnvelope, 100),
        toolCwd: process.cwd(),
        eventBus,
      });

      const events = await drainSse(response);
      const failures = logs.filter(({ event }) => event === 'feedback-delivery-failed');
      const totals = logs.filter(({ event }) => event === 'feedback-delivery-failures');
      expect(failures).toEqual([{ category: 'nexus.event-bus', event: 'feedback-delivery-failed', data: { reason: 'publish_threw' } }]);
      expect(totals).toHaveLength(1);
      expect(totals[0]?.data).toEqual({ count: publish.mock.calls.length });
      expect(publish.mock.calls.length).toBeGreaterThanOrEqual(100);
      expect(includesFeedbackEnvelope(events.filter((event) => event.event === 'feedback').map((event) => event.data))).toBe(true);
      expect(events.find((event) => event.event === 'turn-end')?.data).toMatchObject({
        sessionId: 'feedback-session', text: 'OK', stopReason: 'end_turn',
      });
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });

  test('does not record a failure total when every event-bus publish succeeds', async () => {
    mockFeedbackTurn();
    const logs: Array<{ category: string; event: string }> = [];
    const originalLog = debug.log.bind(debug) as typeof debug.log;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string) => {
      if (category === 'nexus.event-bus') logs.push({ category, event });
    }) as typeof debug.log;
    try {
      const response = await handlePromptStreamPost(new Request('http://test/v1/prompt/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'feedback-session', userText: 'please run the tool' }),
      }), {
        noAuth: true,
        history: new DaemonSessionHistory(),
        toolSurface: feedbackToolSurface(feedbackEnvelope, 100),
        toolCwd: process.cwd(),
        eventBus: new NexusEventBus(),
      });

      await drainSse(response);
      expect(logs).toEqual([]);
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });

  test('records absent and throwing event buses with distinct failure reasons', async () => {
    const run = async (eventBus?: NexusEventBus): Promise<Record<string, unknown>> => {
      mockFeedbackTurn();
      const logs: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
      const originalLog = debug.log.bind(debug) as typeof debug.log;
      (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => {
        if (category === 'nexus.event-bus' && event === 'feedback-delivery-failed') logs.push({ category, event, data });
      }) as typeof debug.log;
      try {
        const response = await handlePromptStreamPost(new Request('http://test/v1/prompt/stream', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: 'feedback-session', userText: 'please run the tool' }),
        }), {
          noAuth: true, history: new DaemonSessionHistory(), toolSurface: feedbackToolSurface(), toolCwd: process.cwd(), eventBus,
        });
        await drainSse(response);
        return logs[0]?.data ?? {};
      } finally {
        (debug as { log: typeof debug.log }).log = originalLog;
      }
    };

    const throwingBus = new NexusEventBus();
    spyOn(throwingBus, 'publish').mockImplementation(() => { throw new Error('bus unavailable'); });
    expect(await run()).toEqual({ reason: 'event_bus_absent' });
    expect(await run(throwingBus)).toEqual({ reason: 'publish_threw' });
  });
});

describe('daemon prompt surface wiring', () => {
  test('passes a resolved surface at every runDaemonPromptTurn call site', () => {
    const source = readFileSync(new URL('./meta-api.ts', import.meta.url), 'utf8');
    expect(source.match(/runDaemonPromptTurn\(/g)).toHaveLength(2);
    expect(source.match(/surface: surfaceResolution\.surface/g)).toHaveLength(2);
  });
});

describe('POST /v1/prompt HITL channel wiring', () => {
  test('passes PWA confirm and question channels to prompt turns only with a session ID', async () => {
    let dispatch: ((name: string, args: Record<string, unknown>, ctx?: { callId: string }) => Promise<unknown>) | undefined;
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      dispatch = ctx.dispatchTool;
      return { stopReason: 'end_turn', finalText: 'OK' };
    });
    const received: DaemonToolDispatchCtx[] = [];
    const toolSurface: DaemonToolSurface = {
      kind: 'chat', specs: [],
      async dispatch(_name, _args, ctx) { received.push(ctx); return { ok: true }; },
    };
    const opts = {
      noAuth: true,
      history: new DaemonSessionHistory(),
      toolSurface,
      toolCwd: process.cwd(),
      eventBus: new NexusEventBus(),
      hitlPending: createHitlPendingCallbacks(),
    };

    const withSession = await handlePromptPost(new Request('http://test/v1/prompt', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'pwa-hitl', userText: 'please run the tool' }),
    }), opts);
    expect(withSession.status).toBe(200);
    await dispatch!('SelfImplement', {});
    expect(received[0]!.surfaceHitlChannels).toHaveLength(1);
    expect(received[0]!.surfaceQuestionChannels).toHaveLength(1);
    expect(surfaceUxFromDispatchCtx(received[0]!).interactive).toBe(true);

    received.length = 0;
    const withoutSession = await handlePromptPost(new Request('http://test/v1/prompt', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userText: 'please run the tool' }),
    }), opts);
    expect(withoutSession.status).toBe(200);
    await dispatch!('SelfImplement', {});
    expect('surfaceHitlChannels' in received[0]!).toBe(false);
    expect('surfaceQuestionChannels' in received[0]!).toBe(false);
    expect(surfaceUxFromDispatchCtx(received[0]!).interactive).toBe(false);
  });

  test('wires PWA HITL channels through prompt-stream turns', async () => {
    let dispatch: ((name: string, args: Record<string, unknown>, ctx?: { callId: string }) => Promise<unknown>) | undefined;
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      dispatch = ctx.dispatchTool;
      return { stopReason: 'end_turn', finalText: 'OK' };
    });
    const received: DaemonToolDispatchCtx[] = [];
    const toolSurface: DaemonToolSurface = {
      kind: 'chat', specs: [],
      async dispatch(_name, _args, ctx) { received.push(ctx); return { ok: true }; },
    };
    const response = await handlePromptStreamPost(new Request('http://test/v1/prompt/stream', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'pwa-hitl-stream', userText: 'please run the tool' }),
    }), {
      noAuth: true, history: new DaemonSessionHistory(), toolSurface, toolCwd: process.cwd(),
      eventBus: new NexusEventBus(), hitlPending: createHitlPendingCallbacks(),
    });
    expect(response.status).toBe(200);
    await response.text();
    await dispatch!('SelfImplement', {});
    expect(received[0]!.surfaceHitlChannels).toHaveLength(1);
    expect(received[0]!.surfaceQuestionChannels).toHaveLength(1);
  });
});

describe('POST /v1/prompt/stream turn-end provider tagging', () => {
  test('inspectActiveProvider runs once before turn-end and HUD reuses that result', async () => {
    mockTurn();
    const inspect = spyOn(providerSummary, 'inspectActiveProvider').mockReturnValue(ACTIVE);
    const push = spyOn(hudWriter, 'pushTokenGaugeFromTurn').mockImplementation(() => {});
    const hudStore = new HudStore();

    const res = await handlePromptStreamPost(new Request('http://test/v1/prompt/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-tag', userText: 'please run the tool' }),
    }), { noAuth: true, history: new DaemonSessionHistory(), hudStore });

    expect(res.status).toBe(200);
    const events = await drainSse(res);
    const turnEnd = events.find((e) => e.event === 'turn-end')!.data;

    expect(inspect).toHaveBeenCalledTimes(1);
    expect(turnEnd).toEqual({
      sessionId: 'sess-tag',
      text: 'OK',
      stopReason: 'end_turn',
      provider: 'grok',
      model: 'grok-4.6',
    });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]![0]).toBe(hudStore);
    expect(push.mock.calls[0]![1]).toMatchObject({
      model: 'grok-4.6',
      inputText: 'please run the tool',
      outputText: 'OK',
    });
  });

  test('omits provider/model on inspect failure without dropping sessionId/text/stopReason', async () => {
    mockTurn();
    spyOn(providerSummary, 'inspectActiveProvider').mockImplementation(() => {
      throw new Error('no provider');
    });

    const res = await handlePromptStreamPost(new Request('http://test/v1/prompt/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-legacy', userText: 'please run the tool' }),
    }), { noAuth: true, history: new DaemonSessionHistory() });

    const events = await drainSse(res);
    const turnEnd = events.find((e) => e.event === 'turn-end')!.data;
    expect(turnEnd).toEqual({
      sessionId: 'sess-legacy',
      text: 'OK',
      stopReason: 'end_turn',
    });
    expect('provider' in turnEnd).toBe(false);
    expect('model' in turnEnd).toBe(false);
  });

  test('non-stream /v1/prompt still tags provider/model without changing existing fields', async () => {
    mockTurn('Hello');
    spyOn(providerSummary, 'inspectActiveProvider').mockReturnValue(ACTIVE);

    const res = await handlePromptPost(new Request('http://test/v1/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-json', userText: 'please run the tool' }),
    }), { noAuth: true, history: new DaemonSessionHistory() });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId: 'sess-json',
      text: 'Hello',
      stopReason: 'end_turn',
      provider: 'grok',
      model: 'grok-4.6',
    });
  });
});
