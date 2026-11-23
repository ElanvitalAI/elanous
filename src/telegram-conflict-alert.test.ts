import { expect, test } from 'bun:test';
import { TelegramBot } from './telegram.js';

test('three consecutive conflicts alert once, success resets the streak', async () => {
  let bot!: TelegramBot;
  let poll = 0;
  let alerts = 0;
  const codes = [409, 409, 409, 409, 200, 409, 409, 409, 200];
  const fetchImpl = (async (url: RequestInfo | URL) => {
    if (!String(url).includes('getUpdates')) return Response.json({ ok: true, result: [] });
    const code = codes[poll++] ?? 200;
    if (poll >= codes.length) bot.stop();
    return code === 409
      ? Response.json({ ok: false, error_code: 409, description: 'conflict' }, { status: 409 })
      : Response.json({ ok: true, result: [] });
  }) as typeof fetch;
  bot = new TelegramBot({ token: '123:fake', allowedUsers: [], onMessage: async () => {}, fetchImpl,
    sleepImpl: async () => {}, pollTimeoutSec: 0, conflictAlert: async () => { alerts++; return true; } });
  await bot.start();
  expect(alerts).toBe(2);
});
