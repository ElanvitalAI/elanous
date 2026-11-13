import { expect, test } from 'bun:test';
import { TelegramBot } from './telegram.js';
import type { UserConfig } from './user-config.js';

// A real bot router must leave appointment-app requests with the conversational turn.
test('Telegram appointment app requests reach onMessage instead of the routines command', async () => {
  const prompts = [
    '동네 가게 예약 앱을 만들어줘',
    '예약 취소와 빈 시간 표시를 추가해줘',
    '승인 전 상태와 미리보기 링크를 보여줘',
    '루틴 목록 보여주는 앱 개발해줘',
  ];
  const updates = [...prompts, '/routines'];
  const delivered: string[] = [];
  const logs: string[] = [];
  let routines = 0;
  let polls = 0;
  let bot!: TelegramBot;
  const fetchImpl = (async (url: RequestInfo | URL) => {
    const method = new URL(String(url)).pathname.split('/').at(-1);
    if (method === 'getUpdates') {
      if (polls < updates.length) {
        const i = polls++;
        return Response.json({ ok: true, result: [{
          update_id: i + 1,
          message: { message_id: i + 10, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: updates[i] },
        }] });
      }
      bot.stop();
      return Response.json({ ok: true, result: [] });
    }
    return Response.json({ ok: true, result: { message_id: 100 } });
  }) as typeof fetch;
  bot = new TelegramBot({
    token: '123:FAKE', allowedUsers: [42], fetchImpl, perChatGapMs: 0, pollTimeoutSec: 0,
    log: (line) => logs.push(line),
    readContextNow: () => ({ at: '2026-11-12T00:00:00.000Z', topic: null, facts: [], events: [], guide: [] }),
    slashCommands: [{ name: 'routines', description: 'List routines',
      handler: async () => { routines += 1; return 'routines'; } }],
    slashContext: { userConfig: { telegram: { allowedUsers: [42] } } as UserConfig },
    onMessage: async (ctx) => { delivered.push(ctx.text); return 'received'; },
  });
  await bot.start();
  expect(delivered).toEqual(prompts);
  expect(routines).toBe(1);
});
