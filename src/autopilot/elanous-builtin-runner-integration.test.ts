// src/autopilot/elanous-builtin-runner-integration.test.ts
//
// MB-17 (2026-05-15) — ElanousBuiltinTurnRunner integration mock test.
//
// 직전 (MB-3) 의 unit test 는 abort-trick 으로 runCoreTurn 의 early-return
// path 만 exercise. 본 test 는 `mock.module` 으로 `runCoreTurn` 를 stub
// 해서 full path 검증:
//   - onText delta → SessionUpdate(agent_message_chunk) emit
//   - onToolCall → SessionUpdate(tool_call) emit (#2777 contract)
//   - onToolResult → SessionUpdate(tool_call_update · status:completed) emit
//   - onTurnComplete → history 에 newMessages append
//   - stopReason mapping: end_turn · aborted → cancelled · max_turns → max_turn_requests
//   - cancel(): in-flight abort propagate
//   - multi-iter: 2회 호출 시 history 누적
//
// mock.module 은 test file boot 시 1회 호출 — runtime swap. Barrel의 다른
// runtime export를 보존해야 같은 suite의 runGoalLoop import가 깨지지 않는다. dynamic
// behavior (per-test 다른 onText/onToolCall 의 시퀀스) 는 mock state
// (`__mockRunCoreTurn`) 통해 inject.

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type {
  CoreTurnContext,
  CoreTurnResult,
  CoreTurnStopReason,
} from '../core-turn/types.js';
import type { LLMMessage } from '../llm.js';
import type { ContentBlock, SessionUpdate, StopReason } from '@agentclientprotocol/sdk';
import * as goalLoop from '../core-turn/run-goal-loop.js';

// ── Mock state ──────────────────────────────────────────────────
//
// 각 test 가 beforeEach 에서 `mockState` 를 reset 후 자신의 시나리오
// (events to fire · final stopReason · onTurnComplete messages) 를
// stuffing. mock.module 의 stub 함수가 이를 read.

interface MockEvent {
  type: 'text' | 'toolCall' | 'toolResult' | 'turnComplete' | 'usage';
  payload: unknown;
}

interface MockState {
  events: MockEvent[];
  /** Mapped final stopReason (CoreTurnStopReason). 'end_turn' default. */
  stopReason: CoreTurnStopReason;
  /** finalText return (text concat). */
  finalText: string;
  /** runCoreTurn calls counter (regression guard). */
  callCount: number;
  /** Latest ctx the mock received — assertion 가능. */
  lastCtx: CoreTurnContext | null;
}

const mockState: MockState = {
  events: [],
  stopReason: 'end_turn',
  finalText: '',
  callCount: 0,
  lastCtx: null,
};

function resetMockState(): void {
  mockState.events = [];
  mockState.stopReason = 'end_turn';
  mockState.finalText = '';
  mockState.callCount = 0;
  mockState.lastCtx = null;
}

// Mock runCoreTurn — stub 이 mockState.events 를 ctx.callbacks 로 forward
// 후 mockState.stopReason / finalText 반환. signal.aborted 이미 set 시
// pre-flight abort. 각 event 사이 microtask yield — cancel() race 가능.
mock.module('../core-turn/index.js', () => ({
  ...goalLoop,
  runCoreTurn: async (ctx: CoreTurnContext): Promise<CoreTurnResult> => {
    mockState.callCount += 1;
    mockState.lastCtx = ctx;
    if (ctx.signal.aborted) {
      return { stopReason: 'aborted', finalText: '' };
    }
    for (const event of mockState.events) {
      // microtask yield — real streamLLMWithTools 도 await 다수 — cancel
      // 이 mid-flight race 가능하게 동등.
      await Promise.resolve();
      if (ctx.signal.aborted) {
        return { stopReason: 'aborted', finalText: mockState.finalText };
      }
      switch (event.type) {
        case 'text': {
          const text = event.payload as string;
          ctx.callbacks?.onText?.(text, text);
          break;
        }
        case 'toolCall': {
          ctx.callbacks?.onToolCall?.(event.payload as never);
          break;
        }
        case 'toolResult': {
          ctx.callbacks?.onToolResult?.(event.payload as never);
          break;
        }
        case 'turnComplete': {
          ctx.callbacks?.onTurnComplete?.(event.payload as LLMMessage[]);
          break;
        }
        case 'usage': {
          ctx.callbacks?.onUsage?.(event.payload as never);
          break;
        }
      }
    }
    // Final check before successful return.
    if (ctx.signal.aborted) {
      return { stopReason: 'aborted', finalText: mockState.finalText };
    }
    return { stopReason: mockState.stopReason, finalText: mockState.finalText };
  },
}));

// Imported AFTER mock.module — picks up the stub.
const coreTurn = await import('../core-turn/index.js');
const { ElanousBuiltinTurnRunner } = await import('./elanous-builtin-runner.js');

function noopDispatch() {
  return async () => ({ output: 'mock-tool-result' });
}

describe('ElanousBuiltinTurnRunner — integration (mocked runCoreTurn)', () => {
  beforeEach(() => resetMockState());

  test('mock preserves the core-turn barrel exports used by other test files', async () => {
    expect(typeof coreTurn.runGoalLoop).toBe('function');
  });

  test('end_turn stopReason: ACP end_turn 으로 매핑 + 빈 onUpdate', async () => {
    const runner = new ElanousBuiltinTurnRunner({
      sessionId: 'sid-int-1',
      tools: [],
      dispatchTool: noopDispatch(),
    });
    const updates: SessionUpdate[] = [];
    const blocks: ContentBlock[] = [{ type: 'text', text: 'hi' }];
    const result = await runner.prompt(blocks, (u) => updates.push(u));
    expect(result.stopReason).toBe('end_turn');
    expect(updates).toHaveLength(0);
    expect(mockState.callCount).toBe(1);
  });

  test('onText delta → agent_message_chunk SessionUpdate emit', async () => {
    mockState.events = [
      { type: 'text', payload: 'Hello' },
      { type: 'text', payload: ' world' },
    ];
    const runner = new ElanousBuiltinTurnRunner({
      sessionId: 'sid-int-2',
      tools: [],
      dispatchTool: noopDispatch(),
    });
    const updates: SessionUpdate[] = [];
    await runner.prompt([{ type: 'text', text: 'go' }], (u) => updates.push(u));
    expect(updates).toHaveLength(2);
    const u0 = updates[0] as unknown as Record<string, unknown>;
    expect(u0.sessionUpdate).toBe('agent_message_chunk');
    expect((u0.content as { text: string }).text).toBe('Hello');
    const u1 = updates[1] as unknown as Record<string, unknown>;
    expect((u1.content as { text: string }).text).toBe(' world');
  });

  test('empty onText delta 는 emit 안 함 (noise reduction)', async () => {
    mockState.events = [
      { type: 'text', payload: 'a' },
      { type: 'text', payload: '' }, // should be filtered
      { type: 'text', payload: 'b' },
    ];
    const runner = new ElanousBuiltinTurnRunner({
      sessionId: 'sid-int-3',
      tools: [],
      dispatchTool: noopDispatch(),
    });
    const updates: SessionUpdate[] = [];
    await runner.prompt([{ type: 'text', text: 'go' }], (u) => updates.push(u));
    expect(updates).toHaveLength(2);
  });

  test('onToolCall → tool_call SessionUpdate · #2777 contract shape', async () => {
    mockState.events = [
      {
        type: 'toolCall',
        payload: { id: 'tc-1', name: 'Bash', args: { command: 'pwd' } },
      },
    ];
    const runner = new ElanousBuiltinTurnRunner({
      sessionId: 'sid-int-4',
      tools: [],
      dispatchTool: noopDispatch(),
    });
    const updates: SessionUpdate[] = [];
    await runner.prompt([{ type: 'text', text: 'pwd 실행' }], (u) => updates.push(u));
    expect(updates).toHaveLength(1);
    const u = updates[0] as unknown as Record<string, unknown>;
    expect(u.sessionUpdate).toBe('tool_call');
    expect(u.toolCallId).toBe('tc-1');
    expect(u.toolName).toBe('Bash');
    expect(u.title).toBe('Bash');
    expect(u.status).toBe('in_progress');
    expect((u.rawInput as { command: string }).command).toBe('pwd');
  });

  test('onToolResult → tool_call_update · status completed', async () => {
    mockState.events = [
      {
        type: 'toolResult',
        payload: { id: 'tc-1', name: 'Bash', result: { output: 'monad-agent' } },
      },
    ];
    const runner = new ElanousBuiltinTurnRunner({
      sessionId: 'sid-int-5',
      tools: [],
      dispatchTool: noopDispatch(),
    });
    const updates: SessionUpdate[] = [];
    await runner.prompt([{ type: 'text', text: 'go' }], (u) => updates.push(u));
    expect(updates).toHaveLength(1);
    const u = updates[0] as unknown as Record<string, unknown>;
    expect(u.sessionUpdate).toBe('tool_call_update');
    expect(u.toolCallId).toBe('tc-1');
    expect(u.status).toBe('completed');
  });

  test('onTurnComplete → history 에 newMessages append', async () => {
    const assistantMsg: LLMMessage = {
      role: 'assistant',
      content: 'I read the file.',
    };
    mockState.events = [{ type: 'turnComplete', payload: [assistantMsg] }];
    const runner = new ElanousBuiltinTurnRunner({
      sessionId: 'sid-int-6',
      tools: [],
      dispatchTool: noopDispatch(),
      systemPrompt: 'sys',
    });
    await runner.prompt([{ type: 'text', text: 'read' }], () => {});
    const hist = runner._getHistoryForTesting();
    // system + user + assistant
    expect(hist).toHaveLength(3);
    expect(hist[0].role).toBe('system');
    expect(hist[1].role).toBe('user');
    expect(hist[2].role).toBe('assistant');
  });

  test('stopReason 매핑: aborted → cancelled', async () => {
    mockState.stopReason = 'aborted';
    const runner = new ElanousBuiltinTurnRunner({
      sessionId: 'sid-int-7',
      tools: [],
      dispatchTool: noopDispatch(),
    });
    const result = await runner.prompt([{ type: 'text', text: 'go' }], () => {});
    expect(result.stopReason).toBe('cancelled');
  });

  test('stopReason 매핑: max_turns → max_turn_requests', async () => {
    mockState.stopReason = 'max_turns';
    const runner = new ElanousBuiltinTurnRunner({
      sessionId: 'sid-int-8',
      tools: [],
      dispatchTool: noopDispatch(),
    });
    const result = await runner.prompt([{ type: 'text', text: 'go' }], () => {});
    expect(result.stopReason).toBe('max_turn_requests');
  });

  test('stopReason 매핑: error → refusal', async () => {
    mockState.stopReason = 'error';
    const runner = new ElanousBuiltinTurnRunner({
      sessionId: 'sid-int-9',
      tools: [],
      dispatchTool: noopDispatch(),
    });
    const result = await runner.prompt([{ type: 'text', text: 'go' }], () => {});
    expect(result.stopReason).toBe('refusal');
  });

  test('stopReason 매핑: auth_rejected → refusal · not a successful end_turn', async () => {
    mockState.stopReason = 'auth_rejected';
    const runner = new ElanousBuiltinTurnRunner({
      sessionId: 'sid-int-auth',
      tools: [],
      dispatchTool: noopDispatch(),
    });
    const result = await runner.prompt([{ type: 'text', text: 'go' }], () => {});
    expect(result.stopReason).not.toBe('end_turn');
    expect(result.stopReason).toBe('refusal');
  });

  // Completeness latch: a new CoreTurnStopReason member is a type error
  // here instead of a silent end_turn fallback through prompt().
  const EXPECTED_ACP_STOP: { [K in CoreTurnStopReason]: StopReason } = {
    end_turn: 'end_turn',
    max_turns: 'max_turn_requests',
    aborted: 'cancelled',
    error: 'refusal',
    auth_rejected: 'refusal',
  };

  test('prompt() maps every CoreTurnStopReason through the public return path', async () => {
    const reasons = Object.keys(EXPECTED_ACP_STOP) as CoreTurnStopReason[];
    expect(reasons).toHaveLength(5);
    for (const reason of reasons) {
      resetMockState();
      mockState.stopReason = reason;
      const runner = new ElanousBuiltinTurnRunner({
        sessionId: `sid-int-map-${reason}`,
        tools: [],
        dispatchTool: noopDispatch(),
      });
      const result = await runner.prompt([{ type: 'text', text: 'go' }], () => {});
      expect(result.stopReason).toBe(EXPECTED_ACP_STOP[reason]);
    }
  });

  test('cancel() 호출 시 in-flight signal abort → cancelled', async () => {
    // 여러 event 가 있어야 mid-flight cancel race window 가 충분.
    mockState.events = [
      { type: 'text', payload: 'partial' },
      { type: 'text', payload: ' more' },
      { type: 'text', payload: ' tail' },
    ];
    const runner = new ElanousBuiltinTurnRunner({
      sessionId: 'sid-int-10',
      tools: [],
      dispatchTool: noopDispatch(),
    });
    const promptPromise = runner.prompt([{ type: 'text', text: 'long' }], () => {});
    // cancel() 은 그 자체 await — 다음 microtask 에서 abort 가 set
    await runner.cancel();
    const result = await promptPromise;
    // mock 의 매 event 시작 시 signal.aborted check → aborted → 'cancelled'
    expect(result.stopReason).toBe('cancelled');
  });

  test('multi-iter 시 history + dispatch 누적 + 같은 sessionId 통과', async () => {
    const runner = new ElanousBuiltinTurnRunner({
      sessionId: 'sid-int-multi',
      tools: [],
      dispatchTool: noopDispatch(),
      systemPrompt: 'sys',
    });
    // iter 1
    mockState.events = [
      { type: 'text', payload: 'iter1 reply' },
      {
        type: 'turnComplete',
        payload: [{ role: 'assistant', content: 'iter1 reply' }],
      },
    ];
    await runner.prompt([{ type: 'text', text: 'first' }], () => {});
    expect(mockState.lastCtx?.sessionId).toBe('sid-int-multi');
    // iter 2 — reset events only · history accumulated
    resetMockState();
    mockState.events = [
      { type: 'text', payload: 'iter2 reply' },
      {
        type: 'turnComplete',
        payload: [{ role: 'assistant', content: 'iter2 reply' }],
      },
    ];
    await runner.prompt([{ type: 'text', text: 'second' }], () => {});

    const hist = runner._getHistoryForTesting();
    // system + user1 + assistant1 + user2 + assistant2 = 5
    expect(hist).toHaveLength(5);
    expect(hist[0].role).toBe('system');
    expect(hist[1].role).toBe('user');
    expect(hist[1].content).toBe('first');
    expect(hist[2].role).toBe('assistant');
    expect(hist[3].role).toBe('user');
    expect(hist[3].content).toBe('second');
    expect(hist[4].role).toBe('assistant');
  });

  test('ctx.tools + dispatchTool 가 runCoreTurn 으로 forward', async () => {
    const tools = [{ name: 'X', description: 'x', parameters: {} }];
    const dispatch = noopDispatch();
    const runner = new ElanousBuiltinTurnRunner({
      sessionId: 'sid-int-ctx',
      tools,
      dispatchTool: dispatch,
    });
    await runner.prompt([{ type: 'text', text: 'go' }], () => {});
    expect(mockState.lastCtx?.userText).toBe('go');
    expect(mockState.lastCtx?.tools).toBe(tools);
    expect(mockState.lastCtx?.dispatchTool).toBe(dispatch);
  });

  test('forwards only text blocks from a multimodal prompt as userText', async () => {
    const runner = new ElanousBuiltinTurnRunner({
      sessionId: 'sid-int-multimodal',
      tools: [],
      dispatchTool: noopDispatch(),
    });
    await runner.prompt([
      { type: 'text', text: 'inspect this screenshot' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      { type: 'text', text: ' and report the error' },
    ], () => {});

    expect(mockState.lastCtx?.userText).toBe('inspect this screenshot and report the error');
  });

  test('omits userText for a multimodal prompt without text blocks', async () => {
    const runner = new ElanousBuiltinTurnRunner({
      sessionId: 'sid-int-media-only',
      tools: [],
      dispatchTool: noopDispatch(),
    });
    await runner.prompt([
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
    ], () => {});

    expect(mockState.lastCtx?.userText).toBeUndefined();
  });

  test('modelOverride + maxToolTurns 가 forward', async () => {
    const runner = new ElanousBuiltinTurnRunner({
      sessionId: 'sid-int-opts',
      tools: [],
      dispatchTool: noopDispatch(),
      modelOverride: 'claude-opus-4-7',
      maxToolTurns: 5,
    });
    await runner.prompt([{ type: 'text', text: 'go' }], () => {});
    expect(mockState.lastCtx?.modelOverride).toBe('claude-opus-4-7');
    expect(mockState.lastCtx?.maxToolTurns).toBe(5);
  });

  test('full streaming sequence: text → toolCall → toolResult → turnComplete', async () => {
    mockState.events = [
      { type: 'text', payload: "I'll check pwd. " },
      {
        type: 'toolCall',
        payload: { id: 'tc-pwd', name: 'Bash', args: { command: 'pwd' } },
      },
      {
        type: 'toolResult',
        payload: { id: 'tc-pwd', name: 'Bash', result: { output: '/Users/x' } },
      },
      { type: 'text', payload: 'You are in /Users/x.' },
      {
        type: 'turnComplete',
        payload: [
          { role: 'assistant', content: "I'll check pwd. You are in /Users/x." },
        ],
      },
    ];
    const runner = new ElanousBuiltinTurnRunner({
      sessionId: 'sid-int-full',
      tools: [],
      dispatchTool: noopDispatch(),
    });
    const updates: SessionUpdate[] = [];
    const result = await runner.prompt(
      [{ type: 'text', text: 'pwd 실행' }],
      (u) => updates.push(u),
    );
    // 4 emits: 2 text + 1 tool_call + 1 tool_call_update
    // (turnComplete 는 onUpdate 발행 안 함 · history 누적만)
    expect(updates).toHaveLength(4);
    expect(result.stopReason).toBe('end_turn');
    const hist = runner._getHistoryForTesting();
    expect(hist.length).toBeGreaterThanOrEqual(2); // user + assistant minimum
  });
});
