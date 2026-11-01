import { describe, expect, test } from 'bun:test';
import { receiveChannelEvent } from '../outbound/router.js';
import { createGrokbotMainSessionDispatcher, createNexusGrokbotTriggerBot, type GrokbotMailbox } from './grokbot-trigger-bot.js';

function mailboxWith(requests: Record<string, string>): GrokbotMailbox & { replies: Record<string, string>; acks: string[] } {
  const pending = new Map(Object.entries(requests));
  const replies: Record<string, string> = {};
  const acks: string[] = [];
  return {
    replies,
    acks,
    sendPrompt: async () => ({ preview: 'sent' }),
    listPending: async () => [...pending.keys()].map((id) => ({ id })),
    claim: async (id) => { const text = pending.get(id); pending.delete(id); return text ?? null; },
    acknowledge: async (id, text) => { acks.push(`${id}:${text}`); },
    complete: async (id, text) => { replies[id] = text; },
  };
}

describe('Nexus Grokbot trigger adapter', () => {
  test('uses one durable main-session id for follow-up messages', async () => {
    const turns: Array<{ sessionId: string; userText: string; botId?: string }> = [];
    const dispatch = createGrokbotMainSessionDispatcher({} as never, async (opts) => {
      turns.push({ sessionId: opts.sessionId, userText: opts.userText, botId: opts.tgChat?.botId });
      return { text: `main: ${opts.userText}` } as never;
    }, () => 'main-session-1');

    expect(await dispatch({ text: '첫 요청', kind: 'request' })).toBe('main: 첫 요청');
    expect(await dispatch({ text: '승인', kind: 'decision' })).toBe('main: 승인');
    expect(turns).toEqual([
      { sessionId: 'main-session-1', userText: '첫 요청', botId: 'grokbot-coo' },
      { sessionId: 'main-session-1', userText: '승인', botId: 'grokbot-coo' },
    ]);
  });

  test('routes mailbox text through receiveChannelEvent into the same main-session dispatcher and returns its reply', async () => {
    const mailbox = mailboxWith({ 'request-1': '[시험] 주 세션 연결 확인', 'request-2': '승인' });
    const delivered: Array<{ text: string; kind: string; session: string }> = [];
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const bot = createNexusGrokbotTriggerBot({
      mailbox,
      dispatch: async (envelope) => {
        delivered.push({ text: envelope.text, kind: envelope.kind, session: 'grokbot-coo-main' });
        return envelope.kind === 'decision' ? '승인 답을 주 세션에 전달했습니다.' : '주 세션 응답';
      },
      log: (event, data) => logs.push({ event, data }),
    });

    await bot.pollOnce();
    await bot.stop();

    expect(delivered).toEqual([
      { text: '[시험] 주 세션 연결 확인', kind: 'request', session: 'grokbot-coo-main' },
      { text: '승인', kind: 'decision', session: 'grokbot-coo-main' },
    ]);
    expect(mailbox.acks).toEqual([
      'request-1:OP 접수 — 답을 준비 중입니다.',
      'request-2:OP 접수 — 답을 준비 중입니다.',
    ]);
    expect(mailbox.replies).toEqual({
      'request-1': '주 세션 응답',
      'request-2': '승인 답을 주 세션에 전달했습니다.',
    });
    expect(logs.some(({ event, data }) => event === 'received' && data.text === '[시험] 주 세션 연결 확인' && data.receivedAt)).toBe(true);
    expect(logs.some(({ event, data }) => event === 'reply' && data.id === 'request-1' && data.repliedAt)).toBe(true);
    expect(await receiveChannelEvent('grokbot', { id: 'x', text: 'x' })).toBeNull();
  });

  test('writes a fail-closed response and records the cause when main-session dispatch fails', async () => {
    const mailbox = mailboxWith({ 'request-2': '원문' });
    const logs: string[] = [];
    const bot = createNexusGrokbotTriggerBot({
      mailbox,
      dispatch: async () => { throw new Error('main session unavailable'); },
      log: (event) => logs.push(event),
    });

    await bot.pollOnce();
    await bot.stop();

    expect(mailbox.replies['request-2']).toContain('요청을 처리하지 못했습니다');
    expect(logs).toContain('failure');
  });
});
