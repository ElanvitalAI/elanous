// UI-Core arc Phase U3b Step 3 (scaffold) — DashboardSession test.
//
// Scaffold-level shape check: the exported class, its static
// `create`, the instance methods (`id`, `send`, `close`), and its
// options type are all in place. End-to-end boot through
// `runAcpServer` + an in-process ACP client requires the ACP SDK's
// initialize/newSession handshake to round-trip over the in-process
// bridge, which is a whole-system integration test better left to
// the dashboard-side substitution arc — it depends on orchestrating
// three async loops (server, client, turn) that tie to the real
// streamLLMWithTools stack. The per-layer contract tests landed
// in #702 / #703 / #704 / #705 already cover the constituent
// pieces.

import { describe, expect, test } from 'bun:test';
import {
  DashboardSession,
  _buildSendInterceptorForTest,
  type DashboardSessionToolCall,
  type DashboardSessionToolResult,
  type DashboardSessionUsage,
} from '../src/tui-client/dashboard-session.js';
import { formatElanousUiEnvelope } from '../src/acp/elanous-extensions.js';

describe('DashboardSession — scaffold surface', () => {
  test('exports the class with create/send/close shape', () => {
    expect(typeof DashboardSession).toBe('function');
    expect(typeof DashboardSession.create).toBe('function');
    // Prototype methods landed — checking on the class prototype so
    // we don't need an instance.
    expect(typeof DashboardSession.prototype.send).toBe('function');
    expect(typeof DashboardSession.prototype.close).toBe('function');
  });
});

describe('DashboardSession — send interceptor (P2-bridge-ext)', () => {
  const wrap = (u: Record<string, unknown>) => ({ sessionId: 's', update: u });

  test('routes agent_message_chunk to onText', () => {
    const texts: string[] = [];
    const intercept = _buildSendInterceptorForTest({
      userText: 'x',
      onText: (t) => texts.push(t),
    });
    intercept(wrap({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hel' } }));
    intercept(wrap({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } }));
    expect(texts).toEqual(['hel', 'lo']);
  });

  test('routes tool_call to onToolCall', () => {
    const seen: DashboardSessionToolCall[] = [];
    const intercept = _buildSendInterceptorForTest({
      userText: 'x',
      onToolCall: (c) => seen.push(c),
    });
    intercept(wrap({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'echo',
      rawInput: { x: 1 },
      status: 'pending',
    }));
    expect(seen).toEqual([{ id: 'c1', name: 'echo', args: { x: 1 } }]);
  });

  test('routes tool_call_update (completed) to onToolResult', () => {
    const seen: DashboardSessionToolResult[] = [];
    const intercept = _buildSendInterceptorForTest({
      userText: 'x',
      onToolResult: (c) => seen.push(c),
    });
    intercept(wrap({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      title: 'echo',
      rawOutput: { ok: true },
    }));
    expect(seen).toEqual([{ id: 'c1', name: 'echo', result: { ok: true } }]);
  });

  test('ignores tool_call_update when status is not completed', () => {
    const seen: DashboardSessionToolResult[] = [];
    const intercept = _buildSendInterceptorForTest({
      userText: 'x',
      onToolResult: (c) => seen.push(c),
    });
    intercept(wrap({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'in_progress',
    }));
    expect(seen).toEqual([]);
  });

  test('routes elanous/ui/usage envelope to onUsage (sans correlation id)', () => {
    const seen: DashboardSessionUsage[] = [];
    const intercept = _buildSendInterceptorForTest({
      userText: 'x',
      onUsage: (u) => seen.push(u),
    });
    const envText = formatElanousUiEnvelope({
      method: 'usage',
      payload: {
        id: 'turn:1',
        provider: 'anthropic',
        model: 'routed-model-x',
        inputTokens: 4,
        outputTokens: 2,
      },
    });
    intercept(wrap({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: envText },
    }));
    // 턴 모델도 그대로 건넌다 — 대시보드 턴 지표가 이것으로 ctx 최대치·단가를 잡는다.
    expect(seen).toEqual([{ provider: 'anthropic', model: 'routed-model-x', inputTokens: 4, outputTokens: 2 }]);
  });

  test('ignores unrelated agent_thought_chunk text (plain thought)', () => {
    const textSeen: string[] = [];
    const usageSeen: DashboardSessionUsage[] = [];
    const intercept = _buildSendInterceptorForTest({
      userText: 'x',
      onText: (t) => textSeen.push(t),
      onUsage: (u) => usageSeen.push(u),
    });
    intercept(wrap({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'just a thought' },
    }));
    expect(usageSeen).toEqual([]);
    expect(textSeen).toEqual([]);
  });

  test('dispatches nothing when the caller omits the matching callback', () => {
    const intercept = _buildSendInterceptorForTest({ userText: 'x' });
    expect(() => {
      intercept(wrap({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'echo' }));
      intercept(wrap({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 't' } }));
    }).not.toThrow();
  });
});
