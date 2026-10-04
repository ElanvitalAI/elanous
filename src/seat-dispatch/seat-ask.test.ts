import { expect, test, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MsgStore } from '../msg/msg-store.js';
import { debug } from '../debug/log.js';
import { handleTelegramSeatWork } from '../intake-plane/telegram-seat-work.js';
import { TelegramBot } from '../telegram.js';
import { DiscordBot } from '../discord.js';
import { handleDiscordSeatWork, type DiscordSeatWorkDeps } from '../intake-plane/discord-seat-work.js';
import { handleSeatRequests } from '../nexus/api/seat-requests.js';
import type { UserConfig } from '../user-config.js';
import { answerSeatAsk, askSeat, deliverSeatAnswers, type AskOrigin, type SeatAskDeps } from './seat-ask.js';

const config = { raw: { decisions: { telegramOwnerId: 111 } } } as unknown as UserConfig;
const command = (store: MsgStore, lines: string[]) => ({ ownerId: '111', replyTarget: 'acme/repo#42',
  runGh: async (_args: string[], stdin: string) => { lines.push(stdin); return 0; },
  append: (message: Parameters<MsgStore['append']>[0]) => store.append(message),
});

test('fake Telegram ask reaches the /cto channel and seat inbox; seat mailbox reply returns to the same chat', async () => {
  const store = new MsgStore(':memory:');
  store.close = () => {};
  const lines: string[] = [];
  const sent: Array<{ origin: AskOrigin; text: string }> = [];
  const events: string[] = [];
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
    if (category === 'seat.ask') events.push(event);
  }) as typeof debug.log);
  try {
    const askDeps = { open: () => store, now: () => 0, send: async (origin: AskOrigin, text: string) => { sent.push({ origin, text }); } };
    const receipt = await handleTelegramSeatWork('CTO 에게 물어봐: 배포 상태?', { chatId: 111, userId: 111, messageId: 456, threadId: 7 },
      { config, commandDeps: command(store, lines), askDeps });
    expect(receipt).toContain('답을 기다립니다');
    expect(receipt).toContain('최대 120분');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('→ TC · 질문: 배포 상태?');
    const inbox = store.list('TC');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.kind).toBe('ceo-task');
    const id = /요청: ask:([\w-]+)/.exec(inbox[0]!.body)?.[1];
    expect(id).toBeTruthy();
    expect(inbox[0]!.body).toContain(`elanous seat answer ${id} "<답>"`);
    answerSeatAsk(id!, '배포 완료', askDeps);
    expect((store.db.query('SELECT answer FROM seat_asks WHERE id = ?').get(id!) as { answer: string }).answer).toBe('배포 완료');
    await deliverSeatAnswers(askDeps);
    await deliverSeatAnswers(askDeps);
    expect(sent).toEqual([{ origin: { channel: 'telegram', chatId: 111, messageId: 456, threadId: 7 }, text: `CTO 답변 (${id}): 배포 완료` }]);
    expect(events).toEqual(['sent', 'reply-recorded', 'answered']);
  } finally { log.mockRestore(); store.close(); }
});

test('two polling Telegram bots route a seat mailbox answer only through the receiving token', async () => {
  const store = new MsgStore(':memory:');
  store.close = () => {};
  const sent: Array<{ token: string; body: Record<string, unknown> }> = [];
  const lines: string[] = [];
  let releasePoll!: () => void;
  const nextPoll = new Promise<void>(resolve => { releasePoll = resolve; });
  let receiptSeen!: () => void;
  const receipt = new Promise<void>(resolve => { receiptSeen = resolve; });
  let receipts = 0;
  let answerSeen!: () => void;
  const answer = new Promise<void>(resolve => { answerSeen = resolve; });
  const bots: TelegramBot[] = [];
  for (const token of ['123:receive', '456:other']) {
    let polls = 0;
    bots.push(new TelegramBot({ token, allowedUsers: [111], perChatGapMs: 0,
      onMessage: async () => { throw Error('ask must not enter ordinary chat'); },
      seatWorkDeps: { config, commandDeps: command(store, lines), askDeps: { open: () => store } as SeatAskDeps },
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        const method = String(url).split('/').at(-1);
        if (method === 'getUpdates') {
          if (++polls > 1) {
            await nextPoll;
            return Response.json({ ok: true, result: [] });
          }
          return Response.json({ ok: true, result: [{ update_id: 1,
            message: { message_id: token === '123:receive' ? 456 : 789, from: { id: 111 }, chat: { id: 111, type: 'private' },
              text: token === '123:receive' ? 'CTO 에게 물어봐: 배포 상태?' : 'CTO 에게 물어봐: 별도 봇 상태?' },
          }] });
        }
        if (method === 'sendMessage') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          sent.push({ token, body });
          if (String(body.text).startsWith('CTO에게 물었습니다') && ++receipts === 2) receiptSeen();
          if (String(body.text).startsWith('CTO 답변')) answerSeen();
        }
        return Response.json({ ok: true, result: { message_id: 9 } });
      }) as typeof fetch,
    }));
  }
  const running = bots.map(bot => bot.start());
  try {
    await receipt;
    const inbox = store.list('TC');
    expect(inbox).toHaveLength(2);
    const id = /요청: ask:([\w-]+)/.exec(inbox.find(({ body }) => body.includes('배포 상태?'))!.body)?.[1];
    expect(id).toBeTruthy();
    expect(lines.some(line => line.includes('→ TC · 질문: 배포 상태?'))).toBe(true);
    answerSeatAsk(id!, '배포 완료', { open: () => store });
    releasePoll();
    await answer;
    expect(sent.filter(({ body }) => String(body.text).startsWith('CTO 답변'))).toEqual([
      { token: '123:receive', body: { chat_id: 111, text: `CTO 답변 (${id}): 배포 완료`, reply_to_message_id: 456 } },
    ]);
    expect((store.db.query("SELECT status FROM seat_asks WHERE json_extract(origin, '$.botId') = '456'").get() as { status: string }).status).toBe('pending');
  } finally {
    bots.forEach(bot => bot.stop());
    releasePoll();
    await Promise.all(running);
    store.close();
  }
});

test('seat answer CLI records the request in the existing ledger and the fake Telegram sender replies only to the originating chat and thread', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-answer-cli-'));
  const open = () => new MsgStore(join(root, 'msg', 'messages.db'));
  const sent: Array<{ chat: number; body: Record<string, unknown> }> = [];
  const store = open();
  let bot!: TelegramBot;
  let polls = 0;
  const botOpts = { token: '123:fake', allowedUsers: [111], perChatGapMs: 0,
    onMessage: async () => { throw Error('ask must not reach ordinary chat'); },
    seatWorkDeps: { config, commandDeps: command(store, []), askDeps: { open } as SeatAskDeps },
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = String(url).split('/').at(-1);
      if (method === 'getUpdates') {
        if (++polls > 1) { bot.stop(); return Response.json({ ok: true, result: [] }); }
        return Response.json({ ok: true, result: [{ update_id: 1, message: {
          message_id: 456, from: { id: 111 }, chat: { id: 111, type: 'private' },
          message_thread_id: 7, text: 'CTO 에게 물어봐: 배포 상태?',
        } }] });
      }
      if (method === 'sendMessage') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sent.push({ chat: Number(body.chat_id), body });
      }
      return Response.json({ ok: true, result: { message_id: 9 } });
    }) as typeof fetch,
  };
  try {
    await (bot = new TelegramBot(botOpts)).start();
    const id = /요청: ask:([\w-]+)/.exec(store.list('TC')[0]!.body)?.[1];
    expect(id).toBeTruthy();
    const otherReceipt = await askSeat('CTO 에게 물어봐: 다른 채팅?',
      { channel: 'telegram', chatId: 222, messageId: 99, botId: '123' }, command(store, []),
      { open, send: async () => {} });
    const otherId = /요청: ([\w-]+)/.exec(otherReceipt)![1]!;
    const cli = Bun.spawnSync(['bun', 'bin/elanous.mjs', `--test=${root}`, 'seat', 'answer', id!, '배포 완료'], {
      cwd: process.cwd(), env: { ...process.env },
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(new TextDecoder().decode(cli.stderr)).toBe('');
    expect(cli.exitCode).toBe(0);
    expect((store.db.query('SELECT answer FROM seat_asks WHERE id = ?').get(id!) as { answer: string }).answer).toBe('배포 완료');
    await deliverSeatAnswers({ open, channel: 'telegram', botId: '123', send: async (origin, text) => {
      if (origin.channel !== 'telegram') throw Error('unexpected surface');
      const posted = await bot.sendMessage(Number(origin.chatId), text, { replyTo: origin.messageId, threadId: origin.threadId });
      if (!posted) throw Error('not posted');
    } });
    expect(sent.filter(({ body }) => String(body.text).startsWith('CTO 답변'))).toEqual([{ chat: 111,
      body: { chat_id: 111, text: `CTO 답변 (${id}): 배포 완료`, reply_to_message_id: 456, message_thread_id: 7 },
    }]);
    expect(sent.every(({ chat }) => chat === 111)).toBe(true);
    expect((store.db.query('SELECT status FROM seat_asks WHERE id = ?').get(otherId) as { status: string }).status).toBe('pending');
    expect(() => answerSeatAsk(id!, '중복 답', { open })).toThrow('not pending');
    expect(() => answerSeatAsk(otherId, '  ', { open })).toThrow('must not be empty');
    await deliverSeatAnswers({ open, now: () => Date.now() + 2 * 60 * 60 * 1000 + 1,
      channel: 'telegram', botId: '123', send: async (origin, text) => {
        if (origin.channel !== 'telegram') throw Error('unexpected surface');
        const posted = await bot.sendMessage(Number(origin.chatId), text, { replyTo: origin.messageId, threadId: origin.threadId });
        if (!posted) throw Error('not posted');
      } });
    expect(sent.filter(({ body }) => String(body.text).startsWith('CTO 미답'))).toEqual([{ chat: 222,
      body: { chat_id: 222, text: `CTO 미답 (${otherId}): 아직 답 없음 (120분 경과).`, reply_to_message_id: 99 },
    }]);
    expect(sent.filter(({ chat, body }) => chat === 222 && String(body.text).startsWith('CTO 답변'))).toEqual([]);
  } finally { bot?.stop(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('existing /cto-style task dispatch still reaches the coordination channel and seat mailbox unchanged', async () => {
  const store = new MsgStore(':memory:');
  store.close = () => {};
  const lines: string[] = [];
  try {
    const reply = await handleTelegramSeatWork('@CTO 배포 점검해 줘',
      { chatId: 111, userId: 111, messageId: 5 }, { config, commandDeps: command(store, lines) });
    expect(reply).toBe('받음 — TC에 전했습니다.');
    expect(store.list('TC').map(({ body, kind }) => ({ body, kind })))
      .toEqual([{ body: '배포 점검해 줘', kind: 'ceo-task' }]);
    expect(lines[0]).toContain('→ TC · 배포 점검해 줘');
  } finally { store.close(); }
});

test('custom ask deadline is reflected in the unanswered notice', async () => {
  const store = new MsgStore(':memory:');
  store.close = () => {};
  const sent: string[] = [];
  try {
    let time = 0;
    const deps = { open: () => store, now: () => time, timeoutMs: 60_000,
      send: async (_origin: AskOrigin, text: string) => { sent.push(text); } };
    const receipt = await askSeat('CTO 에게 물어봐: 점검?', { channel: 'telegram', chatId: 111, messageId: 4 }, command(store, []), deps);
    expect(receipt).toContain('최대 1분');
    time = 60_000;
    await deliverSeatAnswers(deps);
    expect(sent[0]).toContain('아직 답 없음 (1분 경과)');
  } finally { store.close(); }
});

test('untrusted Telegram chat cannot send a CTO ask to the seat inbox', async () => {
  const store = new MsgStore(':memory:');
  store.close = () => {};
  try {
    const askDeps = { open: () => store, send: async () => { throw new Error('unexpected send'); } };
    expect(await handleTelegramSeatWork('CTO 에게 물어봐: 비밀?', { chatId: 222, userId: 222, messageId: 7 },
      { config, commandDeps: command(store, []), askDeps })).toBeNull();
    expect(store.list('TC')).toEqual([]);
  } finally { store.close(); }
});

test('past deadline marks an unanswered ask and does not forward a late reply', async () => {
  const store = new MsgStore(':memory:');
  store.close = () => {};
  const sent: string[] = [];
  const events: string[] = [];
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
    if (category === 'seat.ask') events.push(event);
  }) as typeof debug.log);
  try {
    let time = 0;
    const askDeps = { open: () => store, now: () => time, send: async (_origin: AskOrigin, text: string) => { sent.push(text); } };
    await handleTelegramSeatWork('CTO 에게 물어봐: 배포 상태?', { chatId: 111, userId: 111, messageId: 4 },
      { config, commandDeps: command(store, []), askDeps });
    time = 2 * 60 * 60 * 1000;
    const id = /요청: ask:([\w-]+)/.exec(store.list('TC')[0]!.body)?.[1];
    expect(() => answerSeatAsk(id!, '늦은 답', askDeps)).toThrow('deadline passed');
    await deliverSeatAnswers(askDeps);
    await deliverSeatAnswers(askDeps);
    expect(sent).toEqual([`CTO 미답 (${id}): 아직 답 없음 (120분 경과).`]);
    expect(events).toEqual(['sent', 'expired']);
  } finally { log.mockRestore(); store.close(); }
});

test('Discord DM asks use the same seat inbox and return to the originating channel', async () => {
  const store = new MsgStore(':memory:');
  store.close = () => {};
  const sent: Array<{ origin: AskOrigin; text: string }> = [];
  const askDeps = { open: () => store, now: () => 0, channel: 'discord' as const,
    send: async (origin: AskOrigin, text: string) => { sent.push({ origin, text }); } };
  try {
    const discordConfig = { raw: { decisions: { discordOwnerId: '11111' } }, discord: { allowedUsers: ['11111'] } } as unknown as UserConfig;
    const receipt = await handleDiscordSeatWork('CTO 에게 물어봐: 준비됐나요?',
      { channelId: 'dm-111', messageId: 'm1', userId: '11111', isDm: true },
      { config: discordConfig, commandDeps: command(store, []), askDeps });
    expect(receipt).toContain('답을 기다립니다');
    const id = /요청: ask:([\w-]+)/.exec(store.list('TC')[0]!.body)?.[1];
    store.append({ from: 'TC', to: 'CEO', kind: 'seat-ask-reply', body: `${id}: 네` });
    store.db.query('UPDATE msg_messages SET created_at = ? WHERE kind = ?').run('1970-01-01T00:01:00.000Z', 'seat-ask-reply');
    await deliverSeatAnswers(askDeps);
    expect(sent).toEqual([{ origin: { channel: 'discord', channelId: 'dm-111', messageId: 'm1' }, text: `CTO 답변 (${id}): 네` }]);
  } finally { store.close(); }
});

test('Discord bot with injected ask dependencies never claims a Telegram answer', async () => {
  const store = new MsgStore(':memory:');
  store.close = () => {};
  const sent: AskOrigin[] = [];
  let bot!: DiscordBot;
  class ClosedSocket {
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    constructor() { queueMicrotask(() => this.onclose?.({ code: 1000, reason: '' })); }
    close() { this.onclose?.({ code: 1000, reason: '' }); }
  }
  try {
    const deps = { open: () => store, send: async (origin: AskOrigin) => { sent.push(origin); if (origin.channel === 'discord') bot.stop(); } };
    const tg = await askSeat('CTO 에게 물어봐: 텔레그램?', { channel: 'telegram', chatId: 111, messageId: 1, botId: '123' }, command(store, []), deps);
    const dc = await askSeat('CTO 에게 물어봐: 디스코드?', { channel: 'discord', channelId: 'dm-1', messageId: 'm1' }, command(store, []), deps);
    for (const receipt of [tg, dc]) {
      const id = /요청: ([\w-]+)/.exec(receipt)![1]!;
      store.append({ from: 'TC', to: 'CEO', kind: 'seat-ask-reply', body: `${id}: 답` });
    }
    bot = new DiscordBot({ token: 'fake', allowedUsers: ['111'], onMessage: async () => {},
      wsImpl: ClosedSocket as unknown as typeof WebSocket,
      seatWorkDeps: { askDeps: deps } as DiscordSeatWorkDeps,
    });
    await bot.start();
    expect(sent).toEqual([{ channel: 'discord', channelId: 'dm-1', messageId: 'm1' }]);
    expect((store.db.query("SELECT status FROM seat_asks WHERE origin LIKE '%telegram%'").get() as { status: string }).status).toBe('pending');
  } finally { bot?.stop(); store.close(); }
});

test('PWA seat ask polling returns only to its own browser client', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-ask-'));
  const store = new MsgStore(':memory:');
  store.close = () => {};
  const clientId = 'a0000000-0000-4000-8000-000000000001';
  const other = 'a0000000-0000-4000-8000-000000000002';
  const deps = { root: () => root, ceoDeps: () => command(store, []),
    askDeps: { open: () => store, now: () => 0, channel: 'pwa' as const, clientId,
      send: async () => {} } };
  try {
    const post = await handleSeatRequests(new Request('http://localhost/v1/seat-requests', { method: 'POST',
      headers: { 'x-seat-ask-client': clientId, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'CTO 에게 물어봐: 배포 상태?' }) }), deps);
    expect(post.status).toBe(202);
    const id = /요청: ask:([\w-]+)/.exec(store.list('TC')[0]!.body)?.[1];
    store.append({ from: 'TC', to: 'CEO', kind: 'seat-ask-reply', body: `${id}: 완료` });
    store.db.query('UPDATE msg_messages SET created_at = ? WHERE kind = ?').run('1970-01-01T00:01:00.000Z', 'seat-ask-reply');
    const query = (id: string) => new Request('http://localhost/v1/seat-requests?answers=1', { headers: { 'x-seat-ask-client': id } });
    expect((await (await handleSeatRequests(query(other), deps)).json() as { items: unknown[] }).items).toEqual([]);
    expect((await (await handleSeatRequests(query(clientId), deps)).json() as { items: unknown[] }).items)
      .toEqual([{ id, text: `CTO 답변 (${id}): 완료`, status: 'answered' }]);
    // A dropped response or unmounted browser must be able to poll again before ACK.
    expect((await (await handleSeatRequests(query(clientId), deps)).json() as { items: unknown[] }).items)
      .toEqual([{ id, text: `CTO 답변 (${id}): 완료`, status: 'answered' }]);
    const ack = (client: string) => new Request('http://localhost/v1/seat-requests?answers=ack', {
      method: 'POST', headers: { 'x-seat-ask-client': client, 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id] }),
    });
    expect((await handleSeatRequests(ack(other), deps)).status).toBe(200);
    expect((await (await handleSeatRequests(query(clientId), deps)).json() as { items: unknown[] }).items).toHaveLength(1);
    expect((await handleSeatRequests(ack(clientId), deps)).status).toBe(200);
    expect((await (await handleSeatRequests(query(clientId), deps)).json() as { items: unknown[] }).items).toEqual([]);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a failed outbox insert rolls back the answer decision and retries the same answer', async () => {
  const store = new MsgStore(':memory:');
  store.close = () => {};
  const sent: string[] = [];
  try {
    const deps = { open: () => store, send: async (_origin: AskOrigin, text: string) => { sent.push(text); } };
    const receipt = await askSeat('CTO 에게 물어봐: 상태?', { channel: 'telegram', chatId: 111, messageId: 3 }, command(store, []), deps);
    const id = /요청: ([\w-]+)/.exec(receipt)![1]!;
    store.append({ from: 'TC', to: 'CEO', kind: 'seat-ask-reply', body: `${id}: 제때 답` });
    store.db.exec("CREATE TRIGGER reject_seat_outbox BEFORE INSERT ON seat_ask_outbox BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END");
    expect(deliverSeatAnswers(deps)).rejects.toThrow('outbox unavailable');
    expect((store.db.query('SELECT status FROM seat_asks WHERE id = ?').get(id) as { status: string }).status).toBe('pending');
    store.db.exec('DROP TRIGGER reject_seat_outbox');
    await deliverSeatAnswers(deps);
    expect(sent).toEqual([`CTO 답변 (${id}): 제때 답`]);
    expect((store.db.query('SELECT status FROM seat_asks WHERE id = ?').get(id) as { status: string }).status).toBe('answered');
  } finally { store.close(); }
});

test('the originating Telegram bot alone claims its answer, including a retry from the outbox', async () => {
  const store = new MsgStore(':memory:');
  store.close = () => {};
  const wrong: string[] = [];
  const right: string[] = [];
  try {
    const receipt = await askSeat('CTO 에게 물어봐: 상태?', { channel: 'telegram', chatId: 111, messageId: 3, botId: '123' },
      command(store, []), { open: () => store, send: async () => {} });
    const id = /요청: ([\w-]+)/.exec(receipt)![1]!;
    store.append({ from: 'TC', to: 'CEO', kind: 'seat-ask-reply', body: `${id}: 완료` });
    await deliverSeatAnswers({ open: () => store, channel: 'telegram', botId: '456', send: async (_origin, text) => { wrong.push(text); } });
    await deliverSeatAnswers({ open: () => store, channel: 'telegram', botId: '123', send: async () => { throw Error('network failed'); } }).catch(() => {});
    await deliverSeatAnswers({ open: () => store, channel: 'telegram', botId: '456', send: async (_origin, text) => { wrong.push(text); } });
    await deliverSeatAnswers({ open: () => store, channel: 'telegram', botId: '123', send: async (_origin, text) => { right.push(text); } });
    expect(wrong).toEqual([]);
    expect(right).toEqual([`CTO 답변 (${id}): 완료`]);
  } finally { store.close(); }
});

test('concurrent delivery workers cannot both send the same mailbox answer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-ask-race-'));
  const path = join(root, 'messages.db');
  const open = () => new MsgStore(path);
  const store = open();
  const origin: AskOrigin = { channel: 'telegram', chatId: 111, messageId: 3 };
  let release!: () => void;
  let entered!: () => void;
  const sending = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const sent: string[] = [];
  try {
    const ask = await askSeat('CTO 에게 물어봐: 상태?', origin, command(store, []), { open, send: async () => {} });
    const id = /요청: ([\w-]+)/.exec(ask)![1]!;
    store.append({ from: 'TC', to: 'CEO', kind: 'seat-ask-reply', body: `${id}: 완료` });
    const worker = { open, channel: 'telegram' as const, send: async (_origin: AskOrigin, text: string) => {
      sent.push(text); entered(); await sending;
    } };
    const first = deliverSeatAnswers(worker);
    await started;
    await deliverSeatAnswers(worker);
    release();
    await first;
    expect(sent).toEqual([`CTO 답변 (${id}): 완료`]);
  } finally { release(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
