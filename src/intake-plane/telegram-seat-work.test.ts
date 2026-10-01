import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { handleTelegramSeatWork } from './telegram-seat-work.js';
import { TelegramBot } from '../telegram.js';

const MSG = { chatId: -123, messageId: 456 };

describe('Telegram addressed seat work', () => {
  test('leaves unaddressed messages untouched without submitting', async () => {
    let calls = 0;
    const reply = await handleTelegramSeatWork('일반 대화 중 @cmo 언급', MSG, {
      submit: async () => { calls++; return { ok: true, track: 'graph', acceptanceId: 'R-1' }; },
    });
    expect(reply).toBeNull();
    expect(calls).toBe(0);
    expect(await handleTelegramSeatWork('일반 대화\n@cmo 전략 수립', MSG, {
      submit: async () => { calls++; return { ok: true, track: 'graph', acceptanceId: 'R-1' }; },
    })).toBeNull();
    expect(calls).toBe(0);
  });

  test('resolves seats and submits each once with Telegram origin and reportTo', async () => {
    const inputs: unknown[] = [];
    const reply = await handleTelegramSeatWork('@cmo,cTo 10-28 마케팅 전략 한 장', { ...MSG, threadId: 789, botId: '123' }, {
      submit: async (input) => {
        inputs.push(input);
        return { ok: true, track: 'graph', acceptanceId: `R-${inputs.length}` };
      },
    });
    expect(inputs).toEqual(['CMO', 'CTO'].map((label) => ({
      text: `@${label} 10-28 마케팅 전략 한 장`, track: 'graph',
      origin: { kind: 'external', ledgerSource: 'telegram-bot', provider: 'telegram', ref: 'telegram:-123:456',
        reportTo: { channel: 'telegram', chatId: -123, botId: '123', threadId: 789 } },
    })));
    expect(reply).toBe('@CMO 접수번호: R-1\n@CTO 접수번호: R-2');
  });

  test('actual intake forwards the originating Telegram conversation to the harness', async () => {
    const received: unknown[] = [];
    const reply = await handleTelegramSeatWork('@mk 구현해 줘', MSG, {
      askHarness: async (text, reportTo) => {
        received.push({ text, reportTo });
        return { acceptanceId: 'R-77' };
      }, log: () => {},
    });
    expect(received).toEqual([{ text: '@CMO 구현해 줘', reportTo: { channel: 'telegram', chatId: -123 } }]);
    expect(reply).toBe('@CMO 접수번호: R-77');
  });

  test('unknown seat rejects all seats with one clarification and no submissions', async () => {
    let calls = 0;
    const reply = await handleTelegramSeatWork('@cmo,cfo 작성해', MSG, {
      submit: async () => { calls++; return { ok: true, track: 'graph', acceptanceId: 'R-1' }; },
    });
    expect(reply).toContain('@cfo');
    expect(reply).toContain('좌석을 확인해 다시 보내');
    expect(reply?.split('\n')).toHaveLength(1);
    expect(calls).toBe(0);
  });

  test('empty body asks for work without submitting', async () => {
    let calls = 0;
    const reply = await handleTelegramSeatWork('@cmo  ', MSG, {
      submit: async () => { calls++; return { ok: true, track: 'graph', acceptanceId: 'R-1' }; },
    });
    expect(reply).toContain('요청 내용을 적어');
    expect(calls).toBe(0);
  });

  test('failed intake never claims an acceptance number', async () => {
    const reply = await handleTelegramSeatWork('@cmo 실행해', MSG, {
      submit: async () => ({ ok: false, track: 'graph', reason: 'no-acceptance-id\ninternal trace' }),
    });
    expect(reply).toBe('@CMO 접수 실패 — no-acceptance-id');
  });

  test('seat observations contain names and reason, never the request body', async () => {
    const observed: Array<{ category: string; event: string; data: unknown }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
      if (category === 'seat-address.telegram') observed.push({ category, event, data });
    }) as typeof debug.log);
    try {
      await handleTelegramSeatWork('@cmo private-request-body', MSG, {
        submit: async () => ({ ok: true, track: 'graph', acceptanceId: 'R-1' }),
      });
      await handleTelegramSeatWork('@cfo private-request-body', MSG);
      await handleTelegramSeatWork('@cmo ', MSG);
      expect(observed).toEqual([
        { category: 'seat-address.telegram', event: 'parsed', data: { seats: ['cmo'] } },
        { category: 'seat-address.telegram', event: 'enqueued', data: { seats: ['CMO'] } },
        { category: 'seat-address.telegram', event: 'parsed', data: { seats: ['cfo'] } },
        { category: 'seat-address.telegram', event: 'rejected', data: { seats: ['cfo'], reason: 'unknown-seat' } },
        { category: 'seat-address.telegram', event: 'parsed', data: { seats: ['cmo'] } },
        { category: 'seat-address.telegram', event: 'rejected', data: { seats: ['cmo'], reason: 'empty-body' } },
      ]);
      expect(JSON.stringify(observed)).not.toContain('private-request-body');
    } finally {
      log.mockRestore();
    }
  });

  test('gateway accepts only owner seat messages, replies in the same chat/thread, and preserves ordinary chat', async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const inputs: unknown[] = [];
    const chats: string[] = [];
    let polls = 0;
    let bot: TelegramBot;
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = String(url).split('/').at(-1)!;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ method, body });
      if (method === 'getUpdates') {
        if (++polls > 1) { bot.stop(); return Response.json({ ok: true, result: [] }); }
        const message = (id: number, user: number, text: string) => ({
          update_id: id, message: { message_id: id, from: { id: user }, chat: { id: -123, type: 'supergroup' },
            message_thread_id: 789, text },
        });
        return Response.json({ ok: true, result: [
          message(1, 10, '@cmo 10-28 마케팅 전략 한 장'),
          message(2, 10, '@cfo 작성해'),
          message(3, 10, '일반 대화'),
          message(4, 11, '@cmo 작성해'),
        ] });
      }
      return Response.json({ ok: true, result: { message_id: 777 } });
    }) as typeof fetch;
    bot = new TelegramBot({
      token: '123:test', allowedUsers: [10], fetchImpl, perChatGapMs: 0,
      onMessage: async (ctx) => { chats.push(ctx.text); },
      seatWorkDeps: { submit: async (input) => {
        inputs.push(input);
        return { ok: true, track: 'graph', acceptanceId: 'R-42' };
      } },
    });
    await bot.start();
    expect(inputs).toEqual([{ text: '@CMO 10-28 마케팅 전략 한 장', track: 'graph', origin: {
      kind: 'external', ledgerSource: 'telegram-bot', provider: 'telegram', ref: 'telegram:-123:1',
      reportTo: { channel: 'telegram', chatId: -123, botId: '123', threadId: 789 },
    } }]);
    expect(chats).toEqual(['일반 대화']);
    const sent = calls.filter(({ method }) => method === 'sendMessage').map(({ body }) => body);
    expect(sent).toHaveLength(4);
    expect(sent.find((body) => body.reply_to_message_id === 1)).toEqual({ chat_id: -123, text: '@CMO 접수번호: R-42', reply_to_message_id: 1, message_thread_id: 789 });
    const unknownReply = sent.find((body) => body.reply_to_message_id === 2);
    expect(unknownReply?.text).toContain('좌석을 확인해 다시 보내');
    expect(unknownReply).toMatchObject({ chat_id: -123, reply_to_message_id: 2, message_thread_id: 789 });
    expect(sent.find((body) => body.reply_to_message_id === 3)).toEqual({ chat_id: -123, text: '⏳ Working…', reply_to_message_id: 3, message_thread_id: 789 });
    expect(sent.find((body) => body.reply_to_message_id === 4)).toEqual({ chat_id: -123, text: 'This bot is private. Your user ID is not on the allowlist.', reply_to_message_id: 4, message_thread_id: 789 });
  });
});

test('a throwing intake door still answers in the same chat (review must-fix)', async () => {
  const { handleTelegramSeatWork } = await import('./telegram-seat-work.js');
  const reply = await handleTelegramSeatWork('@cmo 10-28 마케팅 전략 한 장', { chatId: 1, messageId: 2 }, {
    submit: async () => { throw new Error('queue offline\nstack'); },
  } as never);
  expect(reply).toBe('@CMO 접수 실패 — queue offline');
});
