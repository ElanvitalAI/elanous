import { describe, expect, it } from 'bun:test';
import {
  runDashboardPlainTurnStream,
  type DashboardPlainTurnAcpSend,
  type DashboardPlainTurnStreamDeps,
} from '../src/dashboard/input/dashboard-plain-turn-stream';

describe('runDashboardPlainTurnStream', () => {
  it('forwards transient status callbacks to the dashboard owner', async () => {
    const statuses: string[] = [];
    const resetCalls: number[] = [];
    const send: DashboardPlainTurnAcpSend = {
      async send(opts) {
        opts.onStatus?.('스트림 무응답 · 재시도');
        opts.onText('recovered');
      },
    };
    const deps: DashboardPlainTurnStreamDeps = {
      userText: 'hello',
      abortCtrl: new AbortController(),
      acpSession: send,
      onText: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onUsage: () => {},
      onStatus: (line) => statuses.push(line),
      resetTurnRef: () => { resetCalls.push(1); },
    };

    await runDashboardPlainTurnStream(deps);
    expect(statuses).toEqual(['스트림 무응답 · 재시도']);
    expect(resetCalls).toHaveLength(1);
  });

  it('forwards text and tool rounds while returning the full response', async () => {
    const textEvents: Array<{ chunk: string; accumulated: string }> = [];
    const toolCalls: unknown[] = [];
    const toolResults: unknown[] = [];
    const usage: unknown[] = [];
    const send: DashboardPlainTurnAcpSend = {
      async send(opts) {
        opts.onText('Hello');
        opts.onToolCall({ name: 'bash' });
        opts.onToolResult({ result: 'ok' });
        opts.onText(' world');
        opts.onUsage({ tokens: 42 });
      },
    };
    const deps: DashboardPlainTurnStreamDeps = {
      userText: 'hello',
      abortCtrl: new AbortController(),
      acpSession: send,
      onText: (chunk, accumulated) => textEvents.push({ chunk, accumulated }),
      onToolCall: (call) => toolCalls.push(call),
      onToolResult: (result) => toolResults.push(result),
      onUsage: (value) => usage.push(value),
      resetTurnRef: () => {},
    };

    const result = await runDashboardPlainTurnStream(deps);
    expect(result.fullResponse).toBe('Hello world');
    expect(textEvents).toEqual([
      { chunk: 'Hello', accumulated: 'Hello' },
      { chunk: ' world', accumulated: ' world' },
    ]);
    expect(toolCalls).toHaveLength(1);
    expect(toolResults).toHaveLength(1);
    expect(usage).toEqual([{ tokens: 42 }]);
  });

  it('rethrows dispatch errors after resetting the turn reference', async () => {
    let resetCalls = 0;
    const deps: DashboardPlainTurnStreamDeps = {
      userText: 'hello',
      abortCtrl: new AbortController(),
      acpSession: { async send() { throw new Error('boom'); } },
      onText: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onUsage: () => {},
      resetTurnRef: () => { resetCalls += 1; },
    };

    await expect(runDashboardPlainTurnStream(deps)).rejects.toThrow('boom');
    expect(resetCalls).toBe(1);
  });
});
