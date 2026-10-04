import { expect, test } from 'bun:test';
import { TelegramBot } from './telegram.js';

const id = '12345678-1234-1234-1234-123456789012';
const request = '경쟁사를 조사하고 기능을 개발한 뒤 배포한다';

function setup(text: string, userId = 10, options: { titles?: string[]; failPreviewMessage?: number } = {}) {
  const telegramCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const httpCalls: Array<{ path: string; method: string; body?: unknown; auth?: string }> = [];
  const turns: string[] = [];
  let updates = [{ update_id: 1, message: { message_id: 1, from: { id: userId }, chat: { id: 10, type: 'private' }, text } }];
  let bot: TelegramBot;
  const telegramFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    telegramCalls.push({ method, body });
    if (method === 'sendMessage' && telegramCalls.filter(call => call.method === 'sendMessage').length === options.failPreviewMessage) {
      return Response.json({ ok: false, error_code: 400, description: 'preview delivery failed' });
    }
    if (method === 'getUpdates') {
      const result = updates;
      updates = [];
      if (!result.length) bot.stop();
      return Response.json({ ok: true, result });
    }
    return Response.json({ ok: true, result: { message_id: 777 } });
  }) as typeof fetch;
  const httpFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    httpCalls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: new Headers(init?.headers).get('authorization') ?? undefined });
    if (path.endsWith('/approve')) return Response.json({ candidate: { planId: id } });
    return Response.json({ plan: { id, status: 'draft', nodes: (options.titles ?? [
      '경쟁 조사', '기능 개발', '배포',
    ]).map(title => ({ title })) } }, { status: 201 });
  }) as typeof fetch;
  bot = new TelegramBot({ token: '123:test', allowedUsers: [10], fetchImpl: telegramFetch, perChatGapMs: 0,
    fabricPlanDeps: { fetchImpl: httpFetch, baseUrl: () => 'http://127.0.0.1:1234', token: () => 'owner-token' },
    onMessage: async (ctx) => { turns.push(ctx.text); return 'normal reply'; },
  });
  return { bot, telegramCalls, httpCalls, turns };
}

test('one arc line creates a draft via daemon HTTP and replies with steps and approval/edit buttons, never executes before approval', async () => {
  const { bot, telegramCalls, httpCalls, turns } = setup(`아크: ${request}`);
  await bot.start();
  expect(httpCalls).toEqual([{ path: '/v1/fabric/decompose', method: 'POST', body: { request }, auth: 'Bearer owner-token' }]);
  expect(turns).toEqual([]);
  const reply = telegramCalls.find(call => call.method === 'sendMessage')?.body;
  expect(reply?.text).toContain('1. 경쟁 조사\n2. 기능 개발\n3. 배포');
  expect(reply?.reply_markup).toEqual({ inline_keyboard: [[
    { text: '승인', callback_data: `fabric:approve:${id}` },
    { text: '고치기', callback_data: `fabric:edit:${id}` },
  ]] });
  expect(httpCalls.filter(call => call.path.includes('/approve') || call.path.includes('/execute'))).toHaveLength(0);
});

test('long draft displays every step before offering approval; no unseen tail can be approved', async () => {
  const titles = ['조사 ' + '가'.repeat(2100), '구현 ' + '나'.repeat(2100), '마지막 단계 배포'];
  const { bot, httpCalls, telegramCalls } = setup(`아크: ${request}`, 10, { titles });
  await bot.start();
  const messages = telegramCalls.filter(call => call.method === 'sendMessage' && call.body.reply_markup);
  expect(messages).toHaveLength(1);
  const previews = telegramCalls.filter(call => call.method === 'sendMessage' && !call.body.reply_markup);
  expect(previews.length).toBeGreaterThan(0);
  const delivered = [...previews, ...messages].map(call => String(call.body.text));
  expect(delivered.every(chunk => chunk.length <= 4000)).toBe(true);
  expect(delivered.join('')).toBe(`아크 초안 · 실행 전 검토\n${titles.map((title, i) => `${i + 1}. ${title}`).join('\n')}`);
  expect(messages[0]?.body.reply_markup).toEqual({ inline_keyboard: [[
    { text: '승인', callback_data: `fabric:approve:${id}` },
    { text: '고치기', callback_data: `fabric:edit:${id}` },
  ]] });
  expect(httpCalls.map(call => call.path)).toEqual(['/v1/fabric/decompose']);
});

test('failed preview delivery does not offer approval or call execution', async () => {
  const titles = ['첫 단계 ' + '가'.repeat(4000), '두 번째 단계'];
  const { bot, httpCalls, telegramCalls } = setup(`아크: ${request}`, 10, { titles, failPreviewMessage: 1 });
  await bot.start();
  expect(telegramCalls.filter(call => call.method === 'sendMessage' && call.body.reply_markup)).toHaveLength(0);
  expect(telegramCalls.some(call => call.method === 'sendMessage' && String(call.body.text).includes('초안 생성 실패'))).toBe(true);
  const handlers = bot as unknown as { callbackHandlers: Set<(q: { id: string; userId: number; chatId: number; messageId: number; data: string }) => Promise<void>> };
  for (const handler of handlers.callbackHandlers) {
    await handler({ id: 'unseen', userId: 10, chatId: 10, messageId: 777, data: `fabric:approve:${id}` });
  }
  expect(httpCalls.map(call => call.path)).toEqual(['/v1/fabric/decompose']);
});

test('approval is explicit and edit asks for a new arc without approving or executing', async () => {
  const { bot, httpCalls, telegramCalls } = setup(`아크: ${request}`);
  await bot.start();
  const handlers = bot as unknown as { callbackHandlers: Set<(q: { id: string; userId: number; chatId: number; messageId: number; data: string }) => Promise<void>> };
  for (const handler of handlers.callbackHandlers) {
    await handler({ id: 'bad', userId: 11, chatId: 10, messageId: 777, data: `fabric:approve:${id}` });
    await handler({ id: 'edit', userId: 10, chatId: 10, messageId: 777, data: `fabric:edit:${id}` });
    await handler({ id: 'stale', userId: 10, chatId: 10, messageId: 777, data: `fabric:approve:${id}` });
  }
  expect(httpCalls).toHaveLength(1);
  expect(telegramCalls.some(call => call.method === 'sendMessage' && String(call.body.text).includes('다시 보내세요'))).toBe(true);
  expect(httpCalls.filter(call => call.path.includes('/execute'))).toHaveLength(0);
});

test('only the original requester can approve a displayed draft through the daemon approval route', async () => {
  const { bot, httpCalls } = setup(`아크: ${request}`);
  await bot.start();
  const handlers = bot as unknown as { callbackHandlers: Set<(q: { id: string; userId: number; chatId: number; messageId: number; data: string }) => Promise<void>> };
  for (const handler of handlers.callbackHandlers) {
    await handler({ id: 'wrong-message', userId: 10, chatId: 10, messageId: 999, data: `fabric:approve:${id}` });
    await handler({ id: 'approved', userId: 10, chatId: 10, messageId: 777, data: `fabric:approve:${id}` });
    await handler({ id: 'duplicate', userId: 10, chatId: 10, messageId: 777, data: `fabric:approve:${id}` });
  }
  expect(httpCalls.map(call => [call.path, call.method])).toEqual([
    ['/v1/fabric/decompose', 'POST'], [`/v1/fabric/plans/${id}/approve`, 'POST'],
  ]);
  expect(httpCalls.filter(call => call.path.includes('/execute'))).toHaveLength(0);
});

test('other prefixes retain the normal turn and do not contact fabric HTTP', async () => {
  const { bot, httpCalls, turns } = setup(`질문: ${request}`);
  await bot.start();
  expect(turns).toEqual([`질문: ${request}`]);
  expect(httpCalls).toEqual([]);
});

test('unknown sender cannot create a fabric draft', async () => {
  const { bot, httpCalls, turns } = setup(`아크: ${request}`, 11);
  await bot.start();
  expect(httpCalls).toEqual([]);
  expect(turns).toEqual([]);
});
