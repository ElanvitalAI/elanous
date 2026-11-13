import { expect, test } from 'bun:test';
import { TelegramBot } from './telegram.js';
import { telegramTestApiBase } from './telegram-test-runner.js';

test('test Bot API base accepts loopback only and rejects remote or credentialed origins', () => {
  expect(telegramTestApiBase(undefined)).toBeUndefined();
  expect(telegramTestApiBase('http://127.0.0.1:12345')).toBe('http://127.0.0.1:12345');
  for (const value of ['https://api.telegram.org', 'http://example.com', 'http://localhost.evil:1234',
    'http://user:pass@127.0.0.1:1234', 'http://127.0.0.1:1234/path']) {
    expect(() => telegramTestApiBase(value)).toThrow('loopback HTTP origin');
  }
});

test('isolated bot polls and replies through a local fake Telegram Bot API', async () => {
  const methods: string[] = [];
  const replies: string[] = [];
  let polls = 0;
  let bot: TelegramBot;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const method = new URL(request.url).pathname.split('/').at(-1)!;
    methods.push(method);
    if (method === 'getUpdates') {
      if (++polls > 1) { await Bun.sleep(20); return Response.json({ ok: true, result: [] }); }
      return Response.json({ ok: true, result: [{ update_id: 1, message: {
        message_id: 1, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: '뉴스레터를 만들어줘',
      } }] });
    }
    if (method === 'sendMessage' || method === 'editMessageText') {
      const text = String((await request.json() as { text?: unknown }).text ?? '');
      replies.push(text);
      if (text === 'Elanous reply from the handler') bot.stop();
    }
    return Response.json({ ok: true, result: { message_id: 2 } });
  } });
  try {
    bot = new TelegramBot({ token: '123:fake', allowedUsers: [42],
      apiBase: telegramTestApiBase(`http://127.0.0.1:${server.port}`),
      perChatGapMs: 0, nowImpl: () => Date.parse('2026-11-12T00:00:00Z'),
      onMessage: async () => 'Elanous reply from the handler',
    });
    const timeout = setTimeout(() => bot.stop(), 2_000);
    try { await bot.start(); } finally { clearTimeout(timeout); }
    expect(methods).toContain('getUpdates');
    expect(methods).toContain('sendMessage');
    expect(replies).toContain('Elanous reply from the handler');
    expect(methods).toContain('editMessageText');
  } finally { server.stop(true); }
});
