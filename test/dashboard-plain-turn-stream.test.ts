// Step 2 next-stone — plain dispatch streaming round unit tests.
//
// Mirrors the assertions we'd want at the inline call site in
// src/dashboard/index.ts — covers the stream handler routing, first-
// chunk speaking transition, settle sink wiring, and abort path.

import { describe, expect, it } from 'bun:test';
import {
  runDashboardPlainTurnStream,
  type DashboardPlainTurnAcpSend,
  type DashboardPlainTurnStreamDeps,
} from '../src/dashboard/input/dashboard-plain-turn-stream';
import { createControlSignalBus } from '../src/input/control-signal.js';

interface StreamSpy {
  textEvents: Array<{ chunk: string; accumulated: string }>;
  toolCalls: unknown[];
  toolResults: unknown[];
  usage: unknown[];
  statuses: string[];
  pushChunkCalls: string[];
  commitCalls: number;
  cancelCalls: number;
  notifyCalls: number;
  voicePhaseTransitions: string[];
  resetTurnRefCalls: number;
}

function buildDeps(opts: {
  send: DashboardPlainTurnAcpSend;
  initialPhase?: string;
  drainCooldownMs?: number;
}): { deps: DashboardPlainTurnStreamDeps; spy: StreamSpy; abortCtrl: AbortController } {
  const spy: StreamSpy = {
    textEvents: [],
    toolCalls: [],
    toolResults: [],
    usage: [],
    statuses: [],
    pushChunkCalls: [],
    commitCalls: 0,
    cancelCalls: 0,
    notifyCalls: 0,
    voicePhaseTransitions: [],
    resetTurnRefCalls: 0,
  };
  let phase = opts.initialPhase ?? 'idle';
  const abortCtrl = new AbortController();
  const deps: DashboardPlainTurnStreamDeps = {
    userText: 'hello',
    abortCtrl,
    acpSession: opts.send,
    onText: (chunk, accumulated) => spy.textEvents.push({ chunk, accumulated }),
    onToolCall: (call) => spy.toolCalls.push(call),
    onToolResult: (r) => spy.toolResults.push(r),
    onUsage: (u) => spy.usage.push(u),
    onStatus: (line) => spy.statuses.push(line),
    autoTts: {
      pushChunk: (c) => spy.pushChunkCalls.push(c),
      commit: () => { spy.commitCalls += 1; },
      cancel: () => { spy.cancelCalls += 1; },
    },
    voiceChat: {
      getPhase: () => phase,
      transitionToSpeaking: () => {
        spy.voicePhaseTransitions.push(`${phase}→speaking`);
        phase = 'speaking';
      },
      notifyResponseDone: () => { spy.notifyCalls += 1; },
    },
    drainCooldownMs: opts.drainCooldownMs ?? 0,
    resetTurnRef: () => { spy.resetTurnRefCalls += 1; },
  };
  return { deps, spy, abortCtrl };
}

describe('runDashboardPlainTurnStream — happy path', () => {
  it('forwards transient status callbacks to the dashboard owner', async () => {
    const send: DashboardPlainTurnAcpSend = {
      async send(opts) { opts.onStatus?.('스트림 무응답 · 재시도'); opts.onText('recovered'); },
    };
    const { deps, spy } = buildDeps({ send });
    await runDashboardPlainTurnStream(deps);
    expect(spy.statuses).toEqual(['스트림 무응답 · 재시도']);
  });

  it('forwards text chunks + accumulates fullResponse + settles end_turn', async () => {
    const send: DashboardPlainTurnAcpSend = {
      async send(opts) {
        opts.onText('Hello');
        opts.onText(' world');
        opts.onText('!');
      },
    };
    const { deps, spy } = buildDeps({ send });
    const result = await runDashboardPlainTurnStream(deps);
    expect(result.fullResponse).toBe('Hello world!');
    expect(result.settled).toBe('end_turn');
    expect(spy.textEvents.map((e) => e.chunk)).toEqual(['Hello', ' world', '!']);
    expect(spy.textEvents.map((e) => e.accumulated)).toEqual(['Hello', 'Hello world', 'Hello world!']);
    expect(spy.pushChunkCalls).toEqual(['Hello', ' world', '!']);
    expect(spy.resetTurnRefCalls).toBe(1);
  });

  it('first chunk transitions voice-chat from processing → speaking', async () => {
    const send: DashboardPlainTurnAcpSend = {
      async send(opts) {
        opts.onText('hi');
        opts.onText('!');
      },
    };
    const { deps, spy } = buildDeps({ send, initialPhase: 'processing' });
    await runDashboardPlainTurnStream(deps);
    // Only the FIRST chunk triggers the transition.
    expect(spy.voicePhaseTransitions).toEqual(['processing→speaking']);
  });

  it('does not transition when initial phase is not processing', async () => {
    const send: DashboardPlainTurnAcpSend = {
      async send(opts) { opts.onText('hi'); },
    };
    const { deps, spy } = buildDeps({ send, initialPhase: 'idle' });
    await runDashboardPlainTurnStream(deps);
    expect(spy.voicePhaseTransitions).toEqual([]);
  });

  it('routes onToolCall / onToolResult / onUsage', async () => {
    const send: DashboardPlainTurnAcpSend = {
      async send(opts) {
        opts.onToolCall({ name: 'bash', args: { cmd: 'ls' } });
        opts.onToolResult({ name: 'bash', result: 'file.txt' });
        opts.onUsage({ tokens: 42 });
      },
    };
    const { deps, spy } = buildDeps({ send });
    await runDashboardPlainTurnStream(deps);
    expect(spy.toolCalls.length).toBe(1);
    expect(spy.toolResults.length).toBe(1);
    expect(spy.usage.length).toBe(1);
  });
});

describe('runDashboardPlainTurnStream — settle sink wire', () => {
  it('end_turn → commit + notifyResponseDone', async () => {
    const send: DashboardPlainTurnAcpSend = {
      async send(opts) { opts.onText('done'); },
    };
    const { deps, spy } = buildDeps({ send });
    await runDashboardPlainTurnStream(deps);
    // Settle sink is fire-and-forget; wait a microtask.
    await new Promise((r) => setTimeout(r, 10));
    expect(spy.commitCalls).toBe(1);
    expect(spy.cancelCalls).toBe(0);
    expect(spy.notifyCalls).toBe(1);
  });

  it('error → cancel + notifyResponseDone (rethrows)', async () => {
    const send: DashboardPlainTurnAcpSend = {
      async send() { throw new Error('boom'); },
    };
    const { deps, spy } = buildDeps({ send });
    await expect(runDashboardPlainTurnStream(deps)).rejects.toThrow('boom');
    await new Promise((r) => setTimeout(r, 10));
    expect(spy.cancelCalls).toBe(1);
    expect(spy.commitCalls).toBe(0);
    expect(spy.notifyCalls).toBe(1);
    expect(spy.resetTurnRefCalls).toBe(1);
  });

  it('aborted signal → settled = cancelled', async () => {
    const send: DashboardPlainTurnAcpSend = {
      async send(opts) {
        opts.onText('partial');
        // Caller aborts mid-stream.
      },
    };
    const { deps, spy, abortCtrl } = buildDeps({ send });
    abortCtrl.abort();
    const result = await runDashboardPlainTurnStream(deps);
    expect(result.settled).toBe('cancelled');
    await new Promise((r) => setTimeout(r, 10));
    // 'cancelled' uses the cancel hook (not commit).
    expect(spy.cancelCalls).toBe(1);
  });

  it('cooldownMs > 0 → notify after sleep', async () => {
    const send: DashboardPlainTurnAcpSend = {
      async send(opts) { opts.onText('done'); },
    };
    const { deps, spy } = buildDeps({ send, drainCooldownMs: 50 });
    const startedAt = Date.now();
    await runDashboardPlainTurnStream(deps);
    // Wait for sink + cooldown to complete.
    await new Promise((r) => setTimeout(r, 100));
    expect(spy.notifyCalls).toBe(1);
    // Elapsed should include the cooldown.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
  });

  it('recent quick-pass downgrades end_turn settle to cancel', async () => {
    const send: DashboardPlainTurnAcpSend = {
      async send(opts) { opts.onText('done'); },
    };
    const { deps, spy } = buildDeps({ send });
    const bus = createControlSignalBus(() => new Date().toISOString());
    bus.emit({
      kind: 'voice-chat-stop',
      urgency: 'quick-pass',
      source: 'sensor',
      mayPreempt: true,
      scope: { surface: 'voice-chat', channel: 'dashboard' },
    });
    deps.control = { signalBus: bus };
    await runDashboardPlainTurnStream(deps);
    await new Promise((r) => setTimeout(r, 10));
    expect(spy.cancelCalls).toBe(1);
    expect(spy.commitCalls).toBe(0);
  });
});
