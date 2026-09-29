import { describe, expect, test } from 'bun:test';
import { TelegramBot, type TgCallbackQuery, type TgMessageReaction } from './telegram.js';

type ApiCall = { method: string; body: Record<string, unknown> };

type TestUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number };
    chat: { id: number; type: 'private' | 'group' };
    text: string;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message: { message_id: number; chat: { id: number } };
    data: string;
  };
  message_reaction?: {
    chat: { id: number };
    message_id: number;
    user?: { id: number };
    new_reaction: Array<{ type: 'emoji'; emoji: string }>;
  };
};

function reaction(updateId: number, userId?: number): TestUpdate {
  return {
    update_id: updateId,
    message_reaction: { chat: { id: -10 }, message_id: 7, ...(userId === undefined ? {} : { user: { id: userId } }), new_reaction: [{ type: 'emoji', emoji: '👍' }] },
  };
}

function message(updateId: number, userId: number, chatId = userId, text = '/work'): TestUpdate {
  return {
    update_id: updateId,
    message: { message_id: updateId, from: { id: userId }, chat: { id: chatId, type: chatId === userId ? 'private' : 'group' }, text },
  };
}

function callback(updateId: number, userId: number): TestUpdate {
  return {
    update_id: updateId,
    callback_query: { id: `tap-${updateId}`, from: { id: userId }, message: { message_id: 7, chat: { id: -10 } }, data: 'approve:mission' },
  };
}

function setup(allowedUsers: number[], updates: TestUpdate[], nowImpl?: () => number) {
  const calls: ApiCall[] = [];
  const logs: string[] = [];
  const turns: number[] = [];
  const triggers: string[] = [];
  let polls = 0;
  let bot: TelegramBot;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(input).split('/').at(-1)!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ method, body });
    if (method === 'getUpdates') {
      if (++polls > 1) {
        bot.stop();
        return Response.json({ ok: true, result: [] });
      }
      return Response.json({ ok: true, result: updates });
    }
    return Response.json({ ok: true, result: { message_id: 777 } });
  }) as typeof fetch;
  bot = new TelegramBot({
    token: '123:test', allowedUsers, fetchImpl, perChatGapMs: 0,
    ...(nowImpl ? { nowImpl } : {}),
    log: (line) => logs.push(line),
    onMessage: async (ctx) => { turns.push(ctx.userId); },
    onTriggerTap: (event) => { triggers.push(event.kind); },
  });
  return { bot, calls, logs, turns, triggers };
}

const api = (calls: ApiCall[], method: string) => calls.filter((call) => call.method === method).map((call) => call.body);

describe('telegram owner gate', () => {
  test('empty allowlist replies with registration instructions only and throttles each chat for ten minutes', async () => {
    let now = 1_000;
    const capture: string[] = [];
    const { bot: polled, calls: outbound, logs: startup, turns: handled, triggers } = setup([], [
      message(1, 10, 10, '/work'), message(2, 11, 10, '미션: 시작해줘'), message(3, 12, 12, 'https://example.com'),
    ], () => now);
    polled.captureNextText(10, undefined, (text) => capture.push(text ?? 'cancelled'));
    await polled.start();
    expect(api(outbound, 'sendMessage')).toEqual([
      { chat_id: 10, text: "이 봇은 아직 소유자가 정해지지 않았습니다. 당신의 사용자 ID 는 10 입니다 — 기계에서 `elanous config set telegram.allowedUsers '[10]'` 로 등록하면 쓸 수 있습니다.", reply_to_message_id: 1 },
      { chat_id: 12, text: "이 봇은 아직 소유자가 정해지지 않았습니다. 당신의 사용자 ID 는 12 입니다 — 기계에서 `elanous config set telegram.allowedUsers '[12]'` 로 등록하면 쓸 수 있습니다.", reply_to_message_id: 3 },
    ]);
    expect(handled).toEqual([]);
    expect(triggers).toEqual([]);
    expect(capture).toEqual([]);
    expect(api(outbound, 'setMessageReaction')).toEqual([]);
    expect(startup).toContain('telegram bot starting (allowlist size 0)');
    expect(startup).toContain('telegram.owner-gate empty-allowlist');
    // Time-window boundary is exercised on the same instance, not a fresh throttle map.
    now += 10 * 60 * 1000;
    const direct = polled as unknown as { handleIncoming: (ctx: unknown) => Promise<void> };
    await direct.handleIncoming({ chatId: 10, userId: 11, messageId: 4, text: '/work', attachments: [], isDm: false, isGroup: true });
    expect(api(outbound, 'sendMessage')).toHaveLength(3);
    expect((api(outbound, 'sendMessage')[2] as { text: string }).text).toContain("'[11]'");
  });

  test('non-allowlisted message retains the existing refusal and does not run a turn', async () => {
    const { bot, calls, turns, triggers } = setup([10], [message(1, 11, -10, '/work')]);
    await bot.start();
    expect(api(calls, 'sendMessage')).toEqual([{
      chat_id: -10, text: 'This bot is private. Your user ID is not on the allowlist.', reply_to_message_id: 1,
    }]);
    expect(turns).toEqual([]);
    expect(triggers).toEqual([]);
  });

  test('non-allowlisted /cancel cannot bypass the message gate', async () => {
    const { bot, calls, turns } = setup([10], [message(1, 11, -10, '/cancel')]);
    await bot.start();
    expect(api(calls, 'sendMessage')).toEqual([{
      chat_id: -10, text: 'This bot is private. Your user ID is not on the allowlist.', reply_to_message_id: 1,
    }]);
    expect(turns).toEqual([]);
  });

  test('allowlisted message reaches its normal turn', async () => {
    const { bot, turns, calls, triggers } = setup([10], [message(1, 10, 10, 'hello')]);
    await bot.start();
    expect(turns).toEqual([10]);
    expect(triggers).toEqual(['message']);
    expect(api(calls, 'sendMessage')).toEqual([{ chat_id: 10, text: '⏳ Working…', reply_to_message_id: 1 }]);
  });

  test('only the owner can complete a pending text capture in a shared chat', async () => {
    const { bot, calls, turns } = setup([10], [message(1, 11, -10, 'not the owner'), message(2, 10, -10, 'owner answer')]);
    const captured: string[] = [];
    bot.captureNextText(-10, undefined, (text) => { captured.push(text ?? 'cancelled'); });
    await bot.start();
    expect(captured).toEqual(['owner answer']);
    expect(turns).toEqual([]);
    expect(api(calls, 'sendMessage')).toEqual([{
      chat_id: -10, text: 'This bot is private. Your user ID is not on the allowlist.', reply_to_message_id: 1,
    }]);
  });

  for (const [label, allowedUsers] of [['empty', []], ['non-owner', [10]]] as const) {
    test(`${label} callback is acknowledged without dispatching`, async () => {
      const { bot, calls, turns } = setup([...allowedUsers], [callback(1, 11)]);
      const handled: TgCallbackQuery[] = [];
      bot.onCallbackQuery((query) => { handled.push(query); });
      await bot.start();
      expect(handled).toEqual([]);
      expect(turns).toEqual([]);
      expect(api(calls, 'answerCallbackQuery')).toEqual([
        { callback_query_id: 'tap-1', text: '권한이 없습니다' },
      ]);
    });
  }

  test('owner callback reaches subscribers without an extra acknowledgement', async () => {
    const { bot, calls } = setup([10], [callback(1, 10)]);
    const handled: TgCallbackQuery[] = [];
    bot.onCallbackQuery((query) => { handled.push(query); });
    await bot.start();
    expect(handled).toEqual([{ id: 'tap-1', userId: 10, userName: undefined, chatId: -10, messageId: 7, data: 'approve:mission' }]);
    expect(api(calls, 'answerCallbackQuery')).toEqual([]);
  });

  for (const [label, allowedUsers, userId] of [['empty', [], 11], ['non-owner', [10], 11], ['anonymous', [10], undefined]] as const) {
    test(`${label} reaction never reaches reaction subscribers`, async () => {
      const { bot, turns } = setup([...allowedUsers], [reaction(1, userId)]);
      const handled: TgMessageReaction[] = [];
      bot.onMessageReaction((event) => { handled.push(event); });
      await bot.start();
      expect(handled).toEqual([]);
      expect(turns).toEqual([]);
    });
  }

  test('owner reaction reaches reaction subscribers', async () => {
    const { bot } = setup([10], [reaction(1, 10)]);
    const handled: TgMessageReaction[] = [];
    bot.onMessageReaction((event) => { handled.push(event); });
    await bot.start();
    expect(handled.map((event) => event.userId)).toEqual([10]);
  });
});
