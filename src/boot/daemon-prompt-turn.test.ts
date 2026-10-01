import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { DaemonSessionHistory } from './daemon-runtime.js';
import { runDaemonPromptTurn } from './daemon-prompt-turn.js';
import * as coreTurnModule from '../core-turn/index.js';
import { debug } from '../debug/log.js';
import { surfaceUxFromDispatchCtx } from '../agent/surface-ux/build.js';
import type { ConfirmChannel } from '../hitl/confirm.js';
import type { DaemonToolDispatchCtx, DaemonToolSurface } from './daemon-tools/types.js';
import { handlePromptStreamPost } from '../nexus/api/meta-api.js';

afterEach(() => {
  spyOn(coreTurnModule, 'runCoreTurn').mockRestore();
  spyOn(debug, 'log').mockRestore();
});

describe('runDaemonPromptTurn surface dispatch context', () => {
  test('forwards Android surface and original Korean user text to every daemon tool', async () => {
    let dispatch: ((name: string, args: Record<string, unknown>, ctx?: { callId: string }) => Promise<unknown>) | undefined;
    const runCoreTurn = spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      dispatch = ctx.dispatchTool;
      return { stopReason: 'end_turn', finalText: 'done' };
    });
    const received: DaemonToolDispatchCtx[] = [];
    const toolSurface: DaemonToolSurface = {
      kind: 'chat',
      specs: [],
      async dispatch(_name, _args, ctx) {
        received.push(ctx);
        return { ok: true };
      },
    };

    await runDaemonPromptTurn({
      history: new DaemonSessionHistory(),
      request: {
        sessionId: 'android-turn',
        userText: '하니스로 구현해줘',
        userContent: null,
        source: { kind: 'native', platform: 'android' },
        effectiveSystemPrompt: undefined,
        tools: null,
      },
      toolSurface,
      toolCwd: process.cwd(),
      surface: 'android',
      surfaceResolutionReason: 'resolved',
      dispatchToolErrorMessage: 'unused',
    });
    await dispatch!('SelfImplement', {}, { callId: 'call-android' });

    expect(runCoreTurn).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      surface: 'android',
      userText: '하니스로 구현해줘',
      toolCallId: 'call-android',
    });
  });

  test('attaches provided HITL channels so SurfaceUx is interactive and omits them otherwise', async () => {
    let dispatch: ((name: string, args: Record<string, unknown>, ctx?: { callId: string }) => Promise<unknown>) | undefined;
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      dispatch = ctx.dispatchTool;
      return { stopReason: 'end_turn', finalText: 'done' };
    });
    const received: DaemonToolDispatchCtx[] = [];
    const toolSurface: DaemonToolSurface = {
      kind: 'chat',
      specs: [],
      async dispatch(_name, _args, ctx) {
        received.push(ctx);
        return { ok: true };
      },
    };
    const channel: ConfirmChannel = { name: 'test', request: async () => false, cancel: () => {} };
    const request = {
      sessionId: 'hitl-turn', userText: 'ask me', userContent: null,
      source: null, effectiveSystemPrompt: undefined, tools: null,
    };

    await runDaemonPromptTurn({
      history: new DaemonSessionHistory(), request, toolSurface, toolCwd: process.cwd(),
      surfaceHitlChannels: [channel], dispatchToolErrorMessage: 'unused',
    });
    await dispatch!('SelfImplement', {});
    expect(received).toHaveLength(1);
    expect(received[0]!.surfaceHitlChannels).toEqual([channel]);
    expect(surfaceUxFromDispatchCtx(received[0]!).interactive).toBe(true);

    received.length = 0;
    await runDaemonPromptTurn({
      history: new DaemonSessionHistory(), request, toolSurface, toolCwd: process.cwd(),
      dispatchToolErrorMessage: 'unused',
    });
    await dispatch!('SelfImplement', {});
    expect(received).toHaveLength(1);
    expect('surfaceHitlChannels' in received[0]!).toBe(false);
    expect(surfaceUxFromDispatchCtx(received[0]!).interactive).toBe(false);
  });

  test('emits exactly one surface-resolved observation per turn', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockResolvedValue({ stopReason: 'end_turn', finalText: 'done' });
    const log = spyOn(debug, 'log').mockImplementation(() => {});

    await runDaemonPromptTurn({
      history: new DaemonSessionHistory(),
      request: {
        sessionId: 'surface-observation',
        userText: '',
        userContent: null,
        source: null,
        effectiveSystemPrompt: undefined,
        tools: null,
      },
      surface: 'unknown',
      surfaceResolutionReason: 'absent',
      dispatchToolErrorMessage: 'unused',
    });

    expect(log.mock.calls.filter(([category, event]) => category === 'daemon-prompt-turn' && event === 'surface-resolved')).toEqual([
      ['daemon-prompt-turn', 'surface-resolved', { surface: 'unknown', reason: 'absent', hasUserText: false }],
    ]);
  });

  test('derives an omitted resolution reason from the actual request source', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockResolvedValue({ stopReason: 'end_turn', finalText: 'done' });
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const cases = [
      { source: null, surface: undefined, expected: { surface: 'unknown', reason: 'absent' } },
      { source: { kind: 'native', platform: 'android' } as const, surface: 'android' as const, expected: { surface: 'android', reason: 'resolved' } },
      { source: { kind: 'glass' } as const, surface: undefined, expected: { surface: 'unknown', reason: 'unmapped' } },
    ];

    for (const [index, current] of cases.entries()) {
      await runDaemonPromptTurn({
        history: new DaemonSessionHistory(),
        request: {
          sessionId: `source-resolution-${index}`,
          userText: '',
          userContent: null,
          source: current.source,
          effectiveSystemPrompt: undefined,
          tools: null,
        },
        ...(current.surface ? { surface: current.surface } : {}),
        dispatchToolErrorMessage: 'unused',
      });
    }

    expect(log.mock.calls
      .filter(([category, event]) => category === 'daemon-prompt-turn' && event === 'surface-resolved')
      .map(([, , data]) => data)).toEqual([
      { surface: 'unknown', reason: 'absent', hasUserText: false },
      { surface: 'android', reason: 'resolved', hasUserText: false },
      { surface: 'unknown', reason: 'unmapped', hasUserText: false },
    ]);
  });
});

describe('short question daemon turn wiring', () => {
  const specs = [{ name: 'Read', description: 'Read a file', parameters: { type: 'object' as const, properties: {} } }];
  const toolSurface: DaemonToolSurface = {
    kind: 'chat', specs,
    async dispatch() { return { ok: true }; },
  };
  const request = (sessionId: string, userText: string) => ({
    sessionId, userText, userContent: null, source: null,
    effectiveSystemPrompt: 'Original system prompt', tools: null,
  });

  test('fast KTX question starts without tools and adds one-line verification guidance', async () => {
    const turn = spyOn(coreTurnModule, 'runCoreTurn').mockResolvedValue({ stopReason: 'end_turn', finalText: 'done' });
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const history = new DaemonSessionHistory();

    await runDaemonPromptTurn({ history, request: request('ktx-turn', '서울에서 부산까지 KTX 로 대략 몇 시간? 한 줄로.'),
      toolSurface, toolCwd: process.cwd(), dispatchToolErrorMessage: 'no tools' });

    expect(turn).toHaveBeenCalledTimes(1);
    expect(turn.mock.calls[0]![0].tools).toEqual([]);
    expect(turn.mock.calls[0]![0].messages[0]).toEqual({
      role: 'system', content: 'Original system prompt\n확인이 필요하면 "확인해 볼까요?" 한 줄로 끝낸다',
    });
    await expect(turn.mock.calls[0]![0].dispatchTool('Read', {})).rejects.toThrow('no tools');
    expect(log.mock.calls.filter(([category, event]) => category === 'chat.fast-path' && event === 'decided'))
      .toEqual([['chat.fast-path', 'decided', { fast: true, reason: 'question', toolsBefore: 1, toolsAfter: 0 }]]);
  });

  test('chat.fastPath off keeps the tools on the same KTX question (SW2 switch)', async () => {
    const turn = spyOn(coreTurnModule, 'runCoreTurn').mockResolvedValue({ stopReason: 'end_turn', finalText: 'done' });
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const history = new DaemonSessionHistory();

    await runDaemonPromptTurn({ history, request: request('ktx-off', '서울에서 부산까지 KTX 로 대략 몇 시간? 한 줄로.'),
      toolSurface, toolCwd: process.cwd(), dispatchToolErrorMessage: 'no tools', fastPathEnabled: false });

    expect(turn.mock.calls[0]![0].tools).toHaveLength(1);
    expect(log.mock.calls.filter(([category, event]) => category === 'chat.fast-path' && event === 'decided'))
      .toEqual([['chat.fast-path', 'decided', { fast: false, reason: 'disabled', toolsBefore: 1, toolsAfter: 1 }]]);
  });

  test('fast guidance is present on a later turn without persisting into history', async () => {
    const turn = spyOn(coreTurnModule, 'runCoreTurn').mockResolvedValue({ stopReason: 'end_turn', finalText: 'done' });
    const history = new DaemonSessionHistory();
    history.append('later-turn', [{ role: 'user', content: 'Earlier question' }]);

    await runDaemonPromptTurn({ history, request: request('later-turn', '안녕'),
      toolSurface, toolCwd: process.cwd(), dispatchToolErrorMessage: 'no tools' });

    expect(turn.mock.calls[0]![0].messages[0]).toEqual({ role: 'system', content: '확인이 필요하면 "확인해 볼까요?" 한 줄로 끝낸다' });
    expect(history.get('later-turn')[0]).toEqual({ role: 'user', content: 'Earlier question' });
  });

  test('task and attachment turns retain the original tools and system prompt', async () => {
    const turn = spyOn(coreTurnModule, 'runCoreTurn').mockResolvedValue({ stopReason: 'end_turn', finalText: 'done' });
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    await runDaemonPromptTurn({ history: new DaemonSessionHistory(), request: request('task-turn', '테스트 돌려줘'),
      toolSurface, toolCwd: process.cwd(), dispatchToolErrorMessage: 'no tools' });
    await runDaemonPromptTurn({ history: new DaemonSessionHistory(),
      request: { ...request('attachment-turn', '안녕'), userContent: [{ type: 'image', data: 'a', mimeType: 'image/png' }] },
      toolSurface, toolCwd: process.cwd(), dispatchToolErrorMessage: 'no tools' });
    await runDaemonPromptTurn({ history: new DaemonSessionHistory(),
      request: request('prompt-blocks-turn', '안녕'),
      promptBlocks: [{ type: 'image', data: 'a', mimeType: 'image/png' }],
      toolSurface, toolCwd: process.cwd(), dispatchToolErrorMessage: 'no tools' });

    expect(turn).toHaveBeenCalledTimes(3);
    for (const [ctx] of turn.mock.calls) {
      expect(ctx.tools).toBe(specs);
      expect(ctx.messages[0]).toEqual({ role: 'system', content: 'Original system prompt' });
      await expect(ctx.dispatchTool('Read', {})).resolves.toEqual({ ok: true });
    }
    expect(log.mock.calls.filter(([category, event]) => category === 'chat.fast-path' && event === 'decided'))
      .toEqual([
        ['chat.fast-path', 'decided', { fast: false, reason: 'request', toolsBefore: 1, toolsAfter: 1 }],
        ['chat.fast-path', 'decided', { fast: false, reason: 'attachment', toolsBefore: 1, toolsAfter: 1 }],
        ['chat.fast-path', 'decided', { fast: false, reason: 'attachment', toolsBefore: 1, toolsAfter: 1 }],
      ]);
  });

  test('stream retains turn-begin → text-delta → turn-end for a fast question', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      expect(ctx.tools).toEqual([]);
      ctx.callbacks?.onText?.('안녕', '안녕');
      return { stopReason: 'end_turn', finalText: '안녕' };
    });
    const response = await handlePromptStreamPost(new Request('http://localhost/v1/prompt/stream', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'fast-stream-test', userText: '안녕' }),
    }), { noAuth: true, history: new DaemonSessionHistory(), toolSurface, toolCwd: process.cwd() });
    expect(response.status).toBe(200);
    const events = (await response.text()).split('\n').filter((line) => line.startsWith('event: ')).map((line) => line.slice(7));
    expect(events.filter((event) => event !== 'feedback')).toEqual(['turn-begin', 'text-delta', 'turn-end']);
  });

  test('stream keeps the same event order for a non-fast task', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      expect(ctx.tools).toBe(specs);
      ctx.callbacks?.onText?.('완료', '완료');
      return { stopReason: 'end_turn', finalText: '완료' };
    });
    const response = await handlePromptStreamPost(new Request('http://localhost/v1/prompt/stream', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'task-stream-test', userText: '테스트 돌려줘' }),
    }), { noAuth: true, history: new DaemonSessionHistory(), toolSurface, toolCwd: process.cwd() });
    expect(response.status).toBe(200);
    const events = (await response.text()).split('\n').filter((line) => line.startsWith('event: ')).map((line) => line.slice(7));
    expect(events.filter((event) => event !== 'feedback')).toEqual(['turn-begin', 'text-delta', 'turn-end']);
  });
});
