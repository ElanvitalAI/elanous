import { expect, test, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MsgStore } from '../msg/msg-store.js';
import { debug } from '../debug/log.js';
import { handleTelegramSeatWork } from '../intake-plane/telegram-seat-work.js';
import { TelegramBot } from '../telegram.js';
import { DiscordBot } from '../discord.js';
import { handleDiscordSeatWork, type DiscordSeatWorkDeps } from '../intake-plane/discord-seat-work.js';
import { handleSeatRequests } from '../nexus/api/seat-requests.js';
import { resolveDashboardChatMainSubmitIntent } from '../dashboard/input/chat-main-submit-route.js';
import type { UserConfig } from '../user-config.js';
import { acknowledgeSeatAnswers, answerSeatAsk, askSeat, askSeatAs, deliverSeatAnswers, getTuiSeatAskClientId, listSeatAskRoundTrips, parseSeatAsk, type AskOrigin, type SeatAskDeps } from './seat-ask.js';

const config = { raw: { decisions: { telegramOwnerId: 111 } } } as unknown as UserConfig;
const command = (store: MsgStore, lines: string[]) => ({ ownerId: '111', replyTarget: 'acme/repo#42',
  runGh: async (_args: string[], stdin: string) => { lines.push(stdin); return 0; },
  append: (message: Parameters<MsgStore['append']>[0]) => store.append(message),
});

const roundTripFixture = async (minutes: number) => {
  const store = new MsgStore(':memory:');
  store.close = () => {};
  let time = 1_700_000_000_000;
  const deps = { open: () => store, now: () => time, send: async () => {} };
  const receipt = await askSeat('CTO에게 물어봐 상태?', { channel: 'telegram', chatId: 111, messageId: 1 }, command(store, []), deps);
  const id = /요청: ([\w-]+)/.exec(receipt)![1]!;
  time += 60_000;
  answerSeatAsk(id, '완료', deps);
  time = 1_700_000_000_000 + minutes * 60_000;
  await deliverSeatAnswers(deps);
  return { store, id, rows: listSeatAskRoundTrips({ since: 1_699_999_000_000, now: time, open: () => store }) };
};

test('9 minute ask-to-delivery is 10분 안 and records sent_at in the sent update', async () => {
  const { store, id, rows } = await roundTripFixture(9);
  try {
    expect(rows).toEqual([{ id, surface: 'telegram', askedAt: 1_700_000_000_000,
      answeredAt: 1_700_000_060_000, deliveredAt: 1_700_000_540_000, roundTripMs: 540_000, verdict: '10분 안' }]);
    expect((store.db.query('SELECT sent_at FROM seat_ask_outbox WHERE id = ?').get(id) as { sent_at: number }).sent_at).toBe(1_700_000_540_000);
  } finally { store.close(); }
});

test('11 minute ask-to-delivery is 10분 넘음 (not the answer latency)', async () => {
  const { store, rows } = await roundTripFixture(11);
  try { expect(rows[0]?.verdict).toBe('10분 넘음'); expect(rows[0]?.roundTripMs).toBe(660_000); }
  finally { store.close(); }
});

test('past deadline is 미답 even before a worker has sent the expiry notice', async () => {
  const store = new MsgStore(':memory:');
  store.close = () => {};
  try {
    const receipt = await askSeat('CTO에게 물어봐 상태?', { channel: 'telegram', chatId: 111, messageId: 1 }, command(store, []),
      { open: () => store, now: () => 1_000, timeoutMs: 60_000, send: async () => {} });
    const id = /요청: ([\w-]+)/.exec(receipt)![1]!;
    expect(listSeatAskRoundTrips({ since: 0, now: 61_000, open: () => store })[0]).toMatchObject({ id, verdict: '미답', deliveredAt: null, roundTripMs: null });
    await deliverSeatAnswers({ open: () => store, now: () => 61_000, send: async () => {} });
    expect(listSeatAskRoundTrips({ since: 0, now: 61_000, open: () => store })[0])
      .toMatchObject({ id, verdict: '미답', deliveredAt: 61_000, answeredAt: null, roundTripMs: null });
  } finally { store.close(); }
});

test('open ask distinguishes 답 대기 from answered outbox 전달 대기 without claiming delivery', async () => {
  const store = new MsgStore(':memory:');
  store.close = () => {};
  try {
    const deps = { open: () => store, now: () => 1_000, send: async () => { throw Error('delivery offline'); } };
    const receipt = await askSeat('CTO에게 물어봐 상태?', { channel: 'telegram', chatId: 111, messageId: 1 }, command(store, []), deps);
    const id = /요청: ([\w-]+)/.exec(receipt)![1]!;
    const rows = () => listSeatAskRoundTrips({ since: 0, now: 2_000, open: () => store });
    expect(rows()[0]).toMatchObject({ id, verdict: '답 대기', answeredAt: null, deliveredAt: null });
    answerSeatAsk(id, '완료', { open: () => store, now: () => 2_000 });
    await deliverSeatAnswers(deps).catch(() => {});
    expect(rows()[0]).toMatchObject({ id, verdict: '전달 대기', answeredAt: 2_000, deliveredAt: null, roundTripMs: null });
  } finally { store.close(); }
});

test('legacy ask without asked_at is 시각 미상 rather than zero latency', async () => {
  const { store, id } = await roundTripFixture(9);
  try {
    store.db.query('UPDATE seat_asks SET asked_at = NULL WHERE id = ?').run(id);
    expect(listSeatAskRoundTrips({ since: 1_699_999_000_000, now: 1_700_000_540_000, open: () => store })[0])
      .toMatchObject({ id, askedAt: null, roundTripMs: null, verdict: '시각 미상' });
  } finally { store.close(); }
});

test('legacy outbox missing sent_at migrates and retains pending claim fields', async () => {
  const store = new MsgStore(':memory:');
  store.close = () => {};
  try {
    store.db.exec(`CREATE TABLE seat_ask_outbox (id TEXT PRIMARY KEY, origin TEXT NOT NULL, text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', claim_until INTEGER NOT NULL DEFAULT 0, claim_token TEXT)`);
    const receipt = await askSeat('CTO에게 물어봐 상태?', { channel: 'telegram', chatId: 111, messageId: 1 }, command(store, []),
      { open: () => store, now: () => 1_000, send: async () => {} });
    const id = /요청: ([\w-]+)/.exec(receipt)![1]!;
    answerSeatAsk(id, '완료', { open: () => store, now: () => 2_000 });
    await deliverSeatAnswers({ open: () => store, now: () => 3_000, send: async () => {} });
    expect((store.db.query('SELECT status, sent_at, claim_token FROM seat_ask_outbox WHERE id = ?').get(id) as
      { status: string; sent_at: number; claim_token: string | null })).toEqual({ status: 'sent', sent_at: 3_000, claim_token: null });
  } finally { store.close(); }
});

test('PWA delivery remains pending until the owning client explicitly acknowledges', async () => {
  const store = new MsgStore(':memory:');
  store.close = () => {};
  try {
    const receipt = await askSeat('CTO에게 물어봐 상태?', { channel: 'pwa', clientId: 'browser' }, command(store, []),
      { open: () => store, send: async () => {} });
    const id = /요청: ([\w-]+)/.exec(receipt)![1]!;
    answerSeatAsk(id, '완료', { open: () => store });
    await deliverSeatAnswers({ open: () => store, channel: 'pwa', clientId: 'browser', send: async () => {} });
    expect((store.db.query('SELECT status, sent_at FROM seat_ask_outbox WHERE id = ?').get(id) as object))
      .toEqual({ status: 'pending', sent_at: null });
    acknowledgeSeatAnswers('other', [id], () => store);
    expect((store.db.query('SELECT sent_at FROM seat_ask_outbox WHERE id = ?').get(id) as { sent_at: number | null }).sent_at).toBeNull();
    acknowledgeSeatAnswers('browser', [id], () => store);
    expect((store.db.query('SELECT status, sent_at FROM seat_ask_outbox WHERE id = ?').get(id) as { status: string; sent_at: number }))
      .toEqual({ status: 'sent', sent_at: expect.any(Number) });
  } finally { store.close(); }
});

test('legacy sent row without sent_at is 시각 미상, not pending or a zero-time delivery', async () => {
  const { store, id } = await roundTripFixture(9);
  try {
    store.db.query('UPDATE seat_ask_outbox SET sent_at = NULL WHERE id = ?').run(id);
    expect(listSeatAskRoundTrips({ since: 1_699_999_000_000, now: 1_700_000_540_000, open: () => store })[0])
      .toMatchObject({ id, deliveredAt: null, roundTripMs: null, verdict: '시각 미상' });
  } finally { store.close(); }
});

test('seat asks CLI prints a body-free KST table and JSON with the same measured delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-asks-cli-'));
  const open = () => new MsgStore(join(root, 'msg', 'messages.db'));
  const store = open();
  try {
    const now = Date.now();
    const receipt = await askSeat('CTO에게 물어봐 private question?', { channel: 'telegram', chatId: 111, messageId: 1 }, command(store, []),
      { open, now: () => now - 9 * 60_000, send: async () => {} });
    const id = /요청: ([\w-]+)/.exec(receipt)![1]!;
    answerSeatAsk(id, 'private answer', { open, now: () => now - 8 * 60_000 });
    await deliverSeatAnswers({ open, now: () => now, send: async () => {} });
    const absent = mkdtempSync(join(tmpdir(), 'seat-asks-absent-'));
    try {
      const missing = Bun.spawnSync(['bun', 'bin/elanous.mjs', `--test=${absent}`, 'seat', 'asks'],
        { cwd: process.cwd(), env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
      expect(missing.exitCode).toBe(0);
      expect(new TextDecoder().decode(missing.stdout)).toContain(`원장 없음 — ${join(absent, 'msg', 'messages.db')}`);
      const missingJson = Bun.spawnSync(['bun', 'bin/elanous.mjs', `--test=${absent}`, 'seat', 'asks', '--json'],
        { cwd: process.cwd(), env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
      expect(missingJson.exitCode).toBe(0);
      expect(JSON.parse(new TextDecoder().decode(missingJson.stdout))).toEqual([]);
    } finally { rmSync(absent, { recursive: true, force: true }); }
    const cli = (...args: string[]) => Bun.spawnSync(['bun', 'bin/elanous.mjs', `--test=${root}`, 'seat', 'asks', ...args],
      { cwd: process.cwd(), env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
    const table = cli();
    const text = new TextDecoder().decode(table.stdout);
    expect(table.exitCode).toBe(0);
    expect(text).toContain('id · 표면 · 물음 HH:MM KST · 답 · 도착 · 왕복 분 · 판정');
    const kst = (value: number) => new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(value);
    expect(text).toContain(`${id} · telegram · ${kst(now - 9 * 60_000)} KST · ${kst(now - 8 * 60_000)} · ${kst(now)} · 9.0분 · 10분 안`);
    expect(text).toContain('10분 안 1 / 넘음 0 / 미답 0 / 대기 0 / 미상 0');
    expect(text).not.toContain('private question');
    expect(text).not.toContain('private answer');
    const json = cli('--json');
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(json.stdout))).toEqual([{
      id, surface: 'telegram', askedAt: now - 9 * 60_000, answeredAt: now - 8 * 60_000,
      deliveredAt: now, roundTripMs: 540_000, verdict: '10분 안',
    }]);
    expect(new TextDecoder().decode(cli('--since', '1m').stdout)).toContain('이 창에 되묻기 0건');
    const emptyJson = cli('--since', '1m', '--json');
    expect(emptyJson.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(emptyJson.stdout))).toEqual([]);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test('CTO ask accepts the spoken form without requiring punctuation, but not an empty question', () => {
  expect(parseSeatAsk('CTO에게 물어봐 배포 상태?')).toBe('배포 상태?');
  expect(parseSeatAsk('CTO에게 물어봐: 배포 상태?')).toBe('배포 상태?');
  expect(parseSeatAsk('CTO에게 물어봐')).toBeNull();
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
    const receipt = await handleTelegramSeatWork('CTO에게 물어봐 배포 상태?', { chatId: 111, userId: 111, messageId: 456, threadId: 7 },
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

test('all seat titles label delivered answers and unanswered notices', async () => {
  const store = new MsgStore(':memory:');
  store.close = () => {};
  const sent: string[] = [];
  let time = 0;
  const deps = { open: () => store, now: () => time, timeoutMs: 60_000, channel: 'discord' as const,
    send: async (_origin: AskOrigin, text: string) => { sent.push(text); } };
  try {
    for (const [seat, title] of [['OP', 'COO'], ['TC', 'CTO'], ['MK', 'CMO'], ['UX', 'CXO']] as const) {
      const origin: AskOrigin = { channel: 'discord', channelId: 'dm-111', messageId: 'm1' };
      const reply = await askSeatAs(seat, '일정 정리해 줘', origin, command(store, []), deps);
      const id = /요청: ([\w-]+)/.exec(reply)![1]!;
      expect(store.list(seat).at(-1)!.body).toContain(`일: 일정 정리해 줘 답장 요청: ${id}`);
      answerSeatAsk(id, '완료', deps);
      await deliverSeatAnswers(deps);
      expect(sent.at(-1)).toBe(`${title} 답변 (${id}): 완료`);
      const unanswered = /요청: ([\w-]+)/.exec(await askSeatAs(seat, '미답 요청', origin, command(store, []), deps))![1]!;
      time += 60_000;
      await deliverSeatAnswers(deps);
      expect(sent.at(-1)).toBe(`${title} 미답 (${unanswered}): 아직 답 없음 (1분 경과).`);
    }
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

test('PWA poll shows overdue unanswered CTO request only to the requesting browser', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-ask-expiry-'));
  const store = new MsgStore(':memory:');
  store.close = () => {};
  let time = 0;
  const clientId = 'a0000000-0000-4000-8000-000000000001';
  const other = 'a0000000-0000-4000-8000-000000000002';
  const deps = { root: () => root, ceoDeps: () => command(store, []), askDeps: {
    open: () => store, now: () => time, send: async () => {},
  } };
  const query = (client: string) => new Request('http://localhost/v1/seat-requests?answers=1', { headers: { 'x-seat-ask-client': client } });
  try {
    const post = await handleSeatRequests(new Request('http://localhost/v1/seat-requests', { method: 'POST',
      headers: { 'x-seat-ask-client': clientId, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'CTO에게 물어봐 배포 상태?' }) }), deps);
    expect(post.status).toBe(202);
    const id = /요청: ask:([\w-]+)/.exec(store.list('TC')[0]!.body)![1]!;
    time = 2 * 60 * 60 * 1000;
    expect((await (await handleSeatRequests(query(other), deps)).json() as { items: unknown[] }).items).toEqual([]);
    expect((await (await handleSeatRequests(query(clientId), deps)).json() as { items: unknown[] }).items)
      .toEqual([{ id, text: `CTO 미답 (${id}): 아직 답 없음 (120분 경과).`, status: 'expired' }]);
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

test('TUI chat submit resolves CTO ask as a turn before sticky ACP or ordinary chat', () => {
  for (const stickyBackend of [null, 'codex']) {
    const intent = resolveDashboardChatMainSubmitIntent('CTO에게 물어봐 배포 상태?', { stickyBackend });
    expect(intent.kind).toBe('submit-turn');
    if (intent.kind === 'submit-turn') expect(parseSeatAsk(intent.text)).toBe('배포 상태?');
  }
});

test('TUI ask reaches TC and its reply or expired notice returns only to the originating TUI', async () => {
  const store = new MsgStore(':memory:');
  store.close = () => {};
  const sent: string[] = [];
  let time = 0;
  const worker = { open: () => store, now: () => time, channel: 'tui' as const, clientId: 'terminal-a',
    send: async (_origin: AskOrigin, text: string) => { sent.push(text); } };
  try {
    const receipt = await askSeat('CTO에게 물어봐 배포 상태?', { channel: 'tui', clientId: 'terminal-a' }, command(store, []), worker);
    const id = /요청: ([\w-]+)/.exec(receipt)![1]!;
    expect(store.list('TC')[0]!.body).toContain(`답장 요청: ${id}`);
    answerSeatAsk(id, '완료', worker);
    await deliverSeatAnswers({ ...worker, clientId: 'terminal-b' });
    expect(sent).toEqual([]);
    expect((store.db.query('SELECT status FROM seat_asks WHERE id = ?').get(id) as { status: string }).status).toBe('pending');
    await deliverSeatAnswers(worker);
    await deliverSeatAnswers(worker);
    expect(sent).toEqual([`CTO 답변 (${id}): 완료`]);
    const second = await askSeat('CTO에게 물어봐 다음 배포?', { channel: 'tui', clientId: 'terminal-a' }, command(store, []), worker);
    time = 2 * 60 * 60 * 1000;
    await deliverSeatAnswers(worker);
    expect(sent[1]).toBe(`CTO 미답 (${/요청: ([\w-]+)/.exec(second)![1]}): 아직 답 없음 (120분 경과).`);
  } finally { store.close(); }
});

test('dashboard uses the durable TUI address for both submission and reconnect polling', () => {
  const source = readFileSync(join(import.meta.dir, '../dashboard/index.ts'), 'utf8');
  expect(source.includes('const tuiSeatAskClientId = getTuiSeatAskClientId();')).toBe(true);
  expect(source.includes("askSeat(submitIntent.text, { channel: 'tui', clientId: tuiSeatAskClientId }")).toBe(true);
  expect(source.includes("channel: 'tui' as const, clientId: tuiSeatAskClientId,")).toBe(true);
  expect(source.includes('pollTuiSeatAnswers();')).toBe(true);
});

test('a restarted TUI recovers its own pending question, missed answer and overdue notice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-ask-tui-restart-'));
  const otherRoot = mkdtempSync(join(tmpdir(), 'seat-ask-tui-other-'));
  const open = () => new MsgStore(join(root, 'msg', 'messages.db'));
  const openOther = () => new MsgStore(join(otherRoot, 'msg', 'messages.db'));
  let time = 0;
  const received: string[] = [];
  const worker = (clientId: string) => ({ open, now: () => time, channel: 'tui' as const, clientId,
    send: async (_origin: AskOrigin, text: string) => { received.push(text); } });
  try {
    const beforeRestart = getTuiSeatAskClientId(open);
    expect(getTuiSeatAskClientId(openOther)).not.toBe(beforeRestart);
    const store = open();
    let answerId: string;
    let expiredId: string;
    try {
      const receipt = await askSeat('CTO에게 물어봐 답변할 질문?', { channel: 'tui', clientId: beforeRestart },
        command(store, []), worker(beforeRestart));
      answerId = /요청: ([\w-]+)/.exec(receipt)![1]!;
      expiredId = /요청: ([\w-]+)/.exec(await askSeat('CTO에게 물어봐 미답 질문?',
        { channel: 'tui', clientId: beforeRestart }, command(store, []), worker(beforeRestart)))![1]!;
    } finally { store.close(); }

    // No old worker polls after restart. A new DB connection must recover the address
    // before the answer arrives, then drain replies and overdue questions on startup.
    const afterRestart = getTuiSeatAskClientId(open);
    expect(afterRestart).toBe(beforeRestart);
    answerSeatAsk(answerId!, '재시작 후 완료', { open, now: () => time });
    time = 2 * 60 * 60 * 1000;
    await deliverSeatAnswers(worker(getTuiSeatAskClientId(openOther)));
    expect(received).toEqual([]);
    await deliverSeatAnswers(worker(afterRestart));
    expect(received).toEqual([
      `CTO 답변 (${answerId!}): 재시작 후 완료`,
      `CTO 미답 (${expiredId!}): 아직 답 없음 (120분 경과).`,
    ]);
    await deliverSeatAnswers(worker(getTuiSeatAskClientId(openOther)));
    await deliverSeatAnswers(worker(afterRestart));
    expect(received).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(otherRoot, { recursive: true, force: true }); }
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
