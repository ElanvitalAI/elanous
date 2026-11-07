import { describe, expect, test, spyOn } from 'bun:test';

import { runDaemonPromptTurn } from '../src/boot/daemon-prompt-turn.js';
import { DaemonSessionHistory } from '../src/boot/daemon-runtime.js';
import * as coreTurnModule from '../src/core-turn/run-core-turn.js';
import * as acpServerModule from '../src/acp/server.js';
import {
  PWA_TOOL_RESULT_MAX_BYTES,
  handlePromptStreamPost,
  projectDashboardToolResult,
  projectPwaToolResult,
} from '../src/nexus/api/meta-api.js';

function request(sessionId: string) {
  return {
    sessionId,
    userText: 'tool result',
    source: null,
    userContent: null,
    tools: null,
    effectiveSystemPrompt: 'sys',
  };
}

async function drainSse(res: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await res.text();
  return text.trim().split('\n\n').map((block) => {
    const event = block.match(/^event: (.+)$/m)?.[1]!;
    const data = JSON.parse(block.match(/^data: (.+)$/m)?.[1]!) as Record<string, unknown>;
    return { event, data };
  });
}

describe('daemon prompt tool result forwarding', () => {
  test('forwards a present raw result independently from the existing summary', async () => {
    const result = { output: 'first line\nsecond line', count: 2 };
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      ctx.callbacks?.onToolResult?.({ id: 'call-1', name: 'Read', result });
      return { stopReason: 'end_turn', finalText: '' };
    });
    const seen: Record<string, unknown>[] = [];
    await runDaemonPromptTurn({
      history: new DaemonSessionHistory(),
      request: request('present'),
      onToolResultMeta: (info) => seen.push(info),
      dispatchToolErrorMessage: 'unused',
    });

    expect(seen).toEqual([{
      id: 'call-1', name: 'Read', ok: true, summary: 'first line', result,
    }]);
  });

  test('omits raw-result and omission fields when the tool result is absent', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      ctx.callbacks?.onToolResult?.({ id: 'call-2', name: 'NoResult', result: undefined });
      return { stopReason: 'end_turn', finalText: '' };
    });
    const seen: Record<string, unknown>[] = [];
    await runDaemonPromptTurn({
      history: new DaemonSessionHistory(),
      request: request('absent'),
      onToolResultMeta: (info) => seen.push(info),
      dispatchToolErrorMessage: 'unused',
    });

    expect(seen).toEqual([{ id: 'call-2', name: 'NoResult', ok: true }]);
    expect('result' in seen[0]!).toBe(false);
    expect('resultOmittedReason' in seen[0]!).toBe(false);
  });
});

describe('PWA tool-result projection', () => {
  const meta = { id: 'call-1', name: 'Read', ok: true, summary: 'one line' };

  test('preserves an eligible raw result unchanged, including the exact byte boundary', () => {
    const atBoundary = 'x'.repeat(PWA_TOOL_RESULT_MAX_BYTES - 2);
    expect(Buffer.byteLength(JSON.stringify(atBoundary), 'utf8')).toBe(PWA_TOOL_RESULT_MAX_BYTES);
    expect(projectPwaToolResult({ ...meta, result: atBoundary })).toEqual({ ...meta, result: atBoundary });
  });

  test('omits an oversized result without truncation and records only the known reason', () => {
    const oversized = 'x'.repeat(PWA_TOOL_RESULT_MAX_BYTES - 1);
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeGreaterThan(PWA_TOOL_RESULT_MAX_BYTES);
    const projected = projectPwaToolResult({ ...meta, result: oversized });
    expect(projected).toEqual({ ...meta, resultOmittedReason: 'too_large' });
    expect('result' in projected).toBe(false);
  });

  test('serializes once and projects the verified JSON snapshot rather than a stateful source object', () => {
    let calls = 0;
    const stateful = {
      toJSON: () => {
        calls += 1;
        if (calls > 1) throw new Error('must not serialize twice');
        return { stable: true };
      },
    };

    expect(projectPwaToolResult({ ...meta, result: stateful })).toEqual({
      ...meta,
      result: { stable: true },
    });
    expect(calls).toBe(1);
  });

  test('safely omits unserializable results and leaves the dashboard payload unchanged', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(projectPwaToolResult({ ...meta, result: circular })).toEqual({
      ...meta,
      resultOmittedReason: 'unserializable',
    });
    expect(projectDashboardToolResult({ ...meta, result: { private: 'raw value' } })).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
      title: 'one line',
    });
  });
});

describe('handlePromptStreamPost tool-result dual emit', () => {
  test('writes projected PWA results while ACP keeps its existing dashboard payload', async () => {
    const broadcasts: Array<{ sessionId: string; update: Record<string, unknown> }> = [];
    spyOn(acpServerModule, 'getActiveAcpBroadcaster').mockReturnValue(async (sessionId, update) => {
      broadcasts.push({ sessionId, update: update as Record<string, unknown> });
      return { delivered: 1 };
    });
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      ctx.callbacks?.onToolResult?.({
        id: 'call-wire',
        name: 'Read',
        result: 'x'.repeat(PWA_TOOL_RESULT_MAX_BYTES - 1),
      });
      return { stopReason: 'end_turn', finalText: '' };
    });

    const res = await handlePromptStreamPost(new Request('http://test/v1/prompt/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-wire', userText: 'x' }),
    }), { noAuth: true, history: new DaemonSessionHistory() });
    const events = await drainSse(res);
    const pwa = events.find((event) => event.event === 'tool-result')!.data;

    expect(pwa).toMatchObject({
      id: 'call-wire', name: 'Read', ok: true, resultOmittedReason: 'too_large',
    });
    expect('result' in pwa).toBe(false);
    expect(broadcasts).toEqual([{
      sessionId: 'sess-wire',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-wire',
        status: 'completed',
        title: `${'x'.repeat(80)}…`,
      },
    }]);
  });
});
