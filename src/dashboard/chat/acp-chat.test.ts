import { describe, expect, test } from 'bun:test';
import { DashboardAcpChat } from './acp-chat.js';

describe('DashboardAcpChat busy notifications', () => {
  test('routes explicit ACP text replacement to the replacement handler', async () => {
    const appended: string[] = [];
    const replaced: string[] = [];
    const chat = new DashboardAcpChat({
      cwd: '/tmp/acp-replace-test',
      disableStreamSmoothing: true,
      agentManager: {
        getAgent: async () => ({
          newSession: async () => 'session-replace',
          cancel: async () => {},
          prompt: async (_sessionId: string, _prompt: unknown, onUpdate: (update: any) => void) => {
            onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '선답' } });
            onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '최종 답' },
              _meta: { elanous: { textOperation: 'replace' } } });
            return { stopReason: 'end_turn' };
          },
        }),
      },
      sessionStore: { get: () => null, set: () => {}, delete: () => true },
    });
    await chat.send('claude', '분석', {
      pushLine: () => {}, appendChunk: (text) => appended.push(text),
      replaceText: (text) => replaced.push(text), pushToolCall: () => {},
      onDone: () => {}, onError: (error) => { throw error; },
    });
    expect(appended).toEqual(['선답']);
    expect(replaced).toEqual(['최종 답']);
  });

  test('renders an ACP recovery status as a neutral visible thought line', async () => {
    const thoughts: Array<{ text: string; reasoning: boolean }> = [];
    const chat = new DashboardAcpChat({
      cwd: '/tmp/acp-status-test',
      disableStreamSmoothing: true,
      agentManager: {
        getAgent: async () => ({
          newSession: async () => 'session-status',
          cancel: async () => {},
          prompt: async (_sessionId: string, _prompt: unknown, onUpdate: (update: any) => void) => {
            onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '스트림 무응답 · 재시도' }, _meta: { status: true, reasoning: true } });
            return { stopReason: 'end_turn' };
          },
        }),
      },
      sessionStore: { get: () => null, set: () => {}, delete: () => true },
    });
    await chat.send('claude', 'recover stream', {
      pushLine: () => {}, appendChunk: () => {}, pushToolCall: () => {},
      pushThought: (text, reasoning) => thoughts.push({ text, reasoning }),
      onDone: () => {}, onError: (error) => { throw error; },
    });
    expect(thoughts).toEqual([{ text: '스트림 무응답 · 재시도', reasoning: false }]);
  });

  test('notifies idle-sensitive services across a real in-flight send', async () => {
    let finishPrompt!: (result: { stopReason: string }) => void;
    let markPromptStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
    const busyChanges: boolean[] = [];
    const chat = new DashboardAcpChat({
      cwd: '/tmp/acp-busy-test',
      disableStreamSmoothing: true,
      onBusyChange: () => busyChanges.push(chat.isBusy()),
      agentManager: {
        getAgent: async () => ({
          newSession: async () => 'session-1',
          prompt: async () => {
            const prompt = new Promise<{ stopReason: string }>((resolve) => { finishPrompt = resolve; });
            markPromptStarted();
            return prompt;
          },
          cancel: async () => {},
        }),
      },
      sessionStore: {
        get: () => null,
        set: () => {},
        delete: () => true,
      },
    });
    let done = false;
    const send = chat.send('claude', 'keep the turn active', {
      pushLine: () => {},
      appendChunk: () => {},
      pushToolCall: () => {},
      onDone: () => { done = true; },
      onError: (error) => { throw error; },
    });

    await promptStarted;
    expect(chat.isBusy()).toBe(true);
    expect(busyChanges).toEqual([true]);

    finishPrompt({ stopReason: 'end_turn' });
    await send;
    expect(done).toBe(true);
    expect(chat.isBusy()).toBe(false);
    expect(busyChanges).toEqual([true, false]);
  });
});
