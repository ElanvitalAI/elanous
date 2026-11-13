import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramBot } from './telegram.js';
import { createMemberStore } from './nexus/members/member-store.js';
import { handleScraps } from './nexus/api/scraps.js';
import { setUserConfigOverlay } from './user-config.js';
import { activeTelegramMember, consumeTelegramMemberCode, issueTelegramMemberCode, markTelegramCompletionSent, markTelegramReceiptSent,
  pendingTelegramCompletion, pendingTelegramReceipts, recordTelegramCompletion, retryPendingTelegramMemberCards, telegramReceiptStatus,
  saveTelegramMemberScrap, verifiedTelegramMember } from './telegram-member-scrap.js';

const previousStateDir = process.env.ELANOUS_STATE_DIR;
const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'telegram-member-scrap-')); roots.push(dir); return dir; };
afterEach(() => {
  setUserConfigOverlay(null);
  if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previousStateDir;
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const identity = { botId: '123', userId: 42, chatId: 42 };

test('member-issued code binds only the exact DM identity and can be consumed once', () => {
  const dir = root();
  const code = issueTelegramMemberCode(dir, 'member-a', 1000);
  expect(verifiedTelegramMember(dir, identity)).toBeNull();
  expect(consumeTelegramMemberCode(dir, { ...identity, chatId: -42 }, code, 1001)).toBe(false);
  expect(consumeTelegramMemberCode(dir, identity, code, 1001)).toBe(true);
  expect(consumeTelegramMemberCode(dir, { ...identity, userId: 43, chatId: 43 }, code, 1002)).toBe(false);
  expect(verifiedTelegramMember(dir, identity)).toBe('member-a');
  expect(verifiedTelegramMember(dir, { ...identity, botId: 'other' })).toBeNull();
  const expired = issueTelegramMemberCode(dir, 'member-b', 1000);
  expect(consumeTelegramMemberCode(dir, { ...identity, userId: 43, chatId: 43 }, expired, 601001)).toBe(false);
});

test('unbound or group identity cannot create a scrap; extractor failure cannot claim a saved card', async () => {
  const dir = root();
  let extracts = 0;
  const options = { instanceRoot: dir, memberActive: () => true, extractors: { digestWeb: async () => {
    extracts++;
    throw new Error('reader unavailable');
  } } };
  const input = { options, identity, messageId: 1, url: 'https://example.org/article' };
  expect(await saveTelegramMemberScrap(input)).toEqual({ status: 'failed', reason: 'connection-required' });
  expect(extracts).toBe(0);
  const code = issueTelegramMemberCode(dir, 'member-a');
  expect(consumeTelegramMemberCode(dir, identity, code)).toBe(true);
  expect(await saveTelegramMemberScrap({ ...input, identity: { ...identity, chatId: -42 } }))
    .toEqual({ status: 'failed', reason: 'connection-required' });
  expect(extracts).toBe(0);
  expect(await saveTelegramMemberScrap(input)).toEqual({ status: 'failed', reason: 'scrap-post-502' });
  expect(extracts).toBe(1);
});

test('a completion card stays retryable until Bot API confirms its send', () => {
  const dir = root();
  const code = issueTelegramMemberCode(dir, 'member-a');
  expect(consumeTelegramMemberCode(dir, identity, code)).toBe(true);
  expect(telegramReceiptStatus(dir, identity, 'tg-receipt-1', 'scrap-1')).toBe('pending');
  markTelegramReceiptSent(dir, identity, 'tg-receipt-1');
  expect(telegramReceiptStatus(dir, identity, 'tg-receipt-1', 'scrap-1')).toBe('sent');
  recordTelegramCompletion(dir, identity, { status: 'absorbed', memberId: 'member-a', receiptId: 'tg-receipt-1', scrapId: 'scrap-1', cardText: 'Saved card' });
  expect(pendingTelegramCompletion(dir, identity)).toEqual([{ receiptId: 'tg-receipt-1', text: 'Saved card' }]);
  expect(pendingTelegramCompletion(dir, { ...identity, userId: 43, chatId: 43 })).toEqual([]);
  markTelegramCompletionSent(dir, identity, 'tg-receipt-1');
  expect(pendingTelegramCompletion(dir, identity)).toEqual([]);
});

test('relinking the same DM never replays a previous member card', () => {
  const dir = root();
  expect(consumeTelegramMemberCode(dir, identity, issueTelegramMemberCode(dir, 'member-a'))).toBe(true);
  telegramReceiptStatus(dir, identity, 'tg-old', 'old-scrap');
  markTelegramReceiptSent(dir, identity, 'tg-old');
  recordTelegramCompletion(dir, identity, { status: 'absorbed', memberId: 'member-a', receiptId: 'tg-old', scrapId: 'old-scrap', cardText: 'Private old card' });
  expect(pendingTelegramCompletion(dir, identity)).toHaveLength(1);
  expect(consumeTelegramMemberCode(dir, identity, issueTelegramMemberCode(dir, 'member-b'))).toBe(true);
  expect(verifiedTelegramMember(dir, identity)).toBe('member-b');
  expect(pendingTelegramCompletion(dir, identity)).toEqual([]);
});

test('Bot API failure and process restart retry the pending receipt before the completion card', async () => {
  const dir = root();
  process.env.ELANOUS_STATE_DIR = dir;
  expect(consumeTelegramMemberCode(dir, identity, issueTelegramMemberCode(dir, 'member-a'))).toBe(true);
  expect(telegramReceiptStatus(dir, identity, 'tg-restart', 'scrap-restart')).toBe('pending');
  recordTelegramCompletion(dir, identity, { status: 'absorbed', memberId: 'member-a',
    receiptId: 'tg-restart', scrapId: 'scrap-restart', cardText: 'Saved after restart' });
  const attempts: { phase: number; chatId: number; text: string }[] = [];
  const run = async (phase: number, failText?: string, allowedUsers = [42]) => {
    let bot!: TelegramBot;
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = new URL(String(url)).pathname.split('/').at(-1);
      if (method === 'getUpdates') {
        bot.stop();
        return Response.json({ ok: true, result: [] });
      }
      if (method === 'sendMessage') {
        const body = JSON.parse(String(init?.body)) as { chat_id: number; text: string };
        attempts.push({ phase, chatId: body.chat_id, text: body.text });
        if (failText && body.text.includes(failText)) {
          return Response.json({ ok: false, error_code: 400, description: 'test send failure' });
        }
      }
      return Response.json({ ok: true, result: { message_id: attempts.length } });
    }) as typeof fetch;
    bot = new TelegramBot({ token: '123:fake', allowedUsers, fetchImpl,
      perChatGapMs: 0, pollTimeoutSec: 0,
      scrapRouteOptions: { instanceRoot: dir, memberActive: () => true, extractors: {} },
      readContextNow: () => ({ at: '2026-11-12T00:00:00.000Z', topic: null, facts: [], events: [], guide: [] }),
      onMessage: async () => 'unexpected',
    });
    await bot.start();
  };
  await run(0, undefined, [43]);
  expect(attempts).toEqual([]);
  expect(pendingTelegramReceipts(dir, identity)).toEqual(['tg-restart']);
  await run(1, '접수 ID:');
  expect(attempts.map((item) => item.text)).toEqual(['접수했습니다. 접수 ID: tg-restart']);
  expect(pendingTelegramReceipts(dir, identity)).toEqual(['tg-restart']);
  expect(pendingTelegramCompletion(dir, identity)).toEqual([]);
  await run(2, 'Saved after restart');
  expect(attempts.slice(1).map((item) => item.text)).toEqual([
    '접수했습니다. 접수 ID: tg-restart', 'Saved after restart',
  ]);
  expect(pendingTelegramReceipts(dir, identity)).toEqual([]);
  expect(pendingTelegramCompletion(dir, identity)).toEqual([{ receiptId: 'tg-restart', text: 'Saved after restart' }]);
  await run(3);
  expect(attempts.at(-1)).toEqual({ phase: 3, chatId: 42, text: 'Saved after restart' });
  expect(pendingTelegramCompletion(dir, identity)).toEqual([]);
});

test('process restart retries a pending receipt then its completion card once, and never a relinked member', async () => {
  const dir = root();
  const other = { botId: '123', userId: 43, chatId: 43 };
  expect(consumeTelegramMemberCode(dir, identity, issueTelegramMemberCode(dir, 'member-a'))).toBe(true);
  expect(consumeTelegramMemberCode(dir, other, issueTelegramMemberCode(dir, 'member-b'))).toBe(true);
  expect(telegramReceiptStatus(dir, identity, 'tg-stuck', 'scrap-stuck')).toBe('pending');
  recordTelegramCompletion(dir, identity, { status: 'absorbed', memberId: 'member-a',
    receiptId: 'tg-stuck', scrapId: 'scrap-stuck', cardText: 'Saved after five hours' });
  expect(telegramReceiptStatus(dir, other, 'tg-other', 'scrap-other')).toBe('pending');
  markTelegramReceiptSent(dir, other, 'tg-other');
  recordTelegramCompletion(dir, other, { status: 'absorbed', memberId: 'member-b',
    receiptId: 'tg-other', scrapId: 'scrap-other', cardText: 'Other member card' });

  const sent: { userId: number; chatId: number; text: string }[] = [];
  const restart = (failText?: string) => retryPendingTelegramMemberCards({
    root: dir, botId: '123', memberActive: () => true,
    transport: { send: async (target, text) => {
      sent.push({ userId: target.userId, chatId: target.chatId, text });
      return !(failText && text.includes(failText));
    } },
  });

  expect(await restart('접수 ID:')).toEqual({ attempted: 2, confirmed: 1 });
  expect(sent).toEqual([
    { userId: 42, chatId: 42, text: '접수했습니다. 접수 ID: tg-stuck' },
    { userId: 43, chatId: 43, text: 'Other member card' },
  ]);
  expect(pendingTelegramReceipts(dir, identity)).toEqual(['tg-stuck']);
  expect(pendingTelegramCompletion(dir, identity)).toEqual([]);
  expect(pendingTelegramCompletion(dir, other)).toEqual([]);

  sent.length = 0;
  expect(await restart('Saved after five hours')).toEqual({ attempted: 2, confirmed: 1 });
  expect(sent.map((item) => item.text)).toEqual([
    '접수했습니다. 접수 ID: tg-stuck', 'Saved after five hours',
  ]);
  expect(sent.every((item) => item.userId === 42 && item.chatId === 42)).toBe(true);
  expect(pendingTelegramReceipts(dir, identity)).toEqual([]);
  expect(pendingTelegramCompletion(dir, identity)).toEqual([{ receiptId: 'tg-stuck', text: 'Saved after five hours' }]);
  expect(pendingTelegramCompletion(dir, other)).toEqual([]);

  sent.length = 0;
  expect(await restart()).toEqual({ attempted: 1, confirmed: 1 });
  expect(sent.map((item) => `${item.userId}:${item.text}`)).toEqual([
    '42:Saved after five hours',
  ]);
  expect(pendingTelegramCompletion(dir, identity)).toEqual([]);
  expect(pendingTelegramCompletion(dir, other)).toEqual([]);

  sent.length = 0;
  expect(consumeTelegramMemberCode(dir, identity, issueTelegramMemberCode(dir, 'member-a'))).toBe(true);
  expect(telegramReceiptStatus(dir, identity, 'tg-inactive', 'scrap-inactive')).toBe('pending');
  expect(await retryPendingTelegramMemberCards({
    root: dir, botId: '123', memberActive: () => false,
    transport: { send: async (target, text) => {
      sent.push({ userId: target.userId, chatId: target.chatId, text });
      return true;
    } },
  })).toEqual({ attempted: 0, confirmed: 0 });
  expect(sent).toEqual([]);
  expect(pendingTelegramReceipts(dir, identity)).toEqual(['tg-inactive']);

  sent.length = 0;
  expect(consumeTelegramMemberCode(dir, identity, issueTelegramMemberCode(dir, 'member-c'))).toBe(true);
  expect(verifiedTelegramMember(dir, identity)).toBe('member-c');
  expect(() => recordTelegramCompletion(dir, identity, { status: 'absorbed', memberId: 'member-a',
    receiptId: 'tg-stuck', scrapId: 'scrap-stuck', cardText: 'Saved after five hours' })).toThrow('telegram member binding changed');
  expect(await restart()).toEqual({ attempted: 0, confirmed: 0 });
  expect(sent).toEqual([]);
  expect(pendingTelegramReceipts(dir, identity)).toEqual([]);
  expect(pendingTelegramCompletion(dir, identity)).toEqual([]);
});

test('restart drain sends more than eight pending cards and keeps a refused chat from blocking a later healthy chat', async () => {
  const dir = root();
  const refused = { botId: '123', userId: 41, chatId: 41 };
  const healthy = { botId: '123', userId: 44, chatId: 44 };
  expect(consumeTelegramMemberCode(dir, refused, issueTelegramMemberCode(dir, 'member-refused'))).toBe(true);
  expect(consumeTelegramMemberCode(dir, identity, issueTelegramMemberCode(dir, 'member-a'))).toBe(true);
  expect(consumeTelegramMemberCode(dir, healthy, issueTelegramMemberCode(dir, 'member-healthy'))).toBe(true);
  for (let index = 0; index < 9; index++) {
    const receiptId = `tg-nine-${index}`;
    expect(telegramReceiptStatus(dir, identity, receiptId, `scrap-nine-${index}`)).toBe('pending');
    markTelegramReceiptSent(dir, identity, receiptId);
    recordTelegramCompletion(dir, identity, { status: 'absorbed', memberId: 'member-a',
      receiptId, scrapId: `scrap-nine-${index}`, cardText: `Nine card ${index}` });
  }
  expect(telegramReceiptStatus(dir, refused, 'tg-refused', 'scrap-refused')).toBe('pending');
  expect(telegramReceiptStatus(dir, healthy, 'tg-healthy', 'scrap-healthy')).toBe('pending');
  markTelegramReceiptSent(dir, healthy, 'tg-healthy');
  recordTelegramCompletion(dir, healthy, { status: 'absorbed', memberId: 'member-healthy',
    receiptId: 'tg-healthy', scrapId: 'scrap-healthy', cardText: 'Healthy card' });

  const sent: { userId: number; chatId: number; text: string }[] = [];
  const result = await retryPendingTelegramMemberCards({
    root: dir, botId: '123', memberActive: () => true,
    transport: { send: async (target, text) => {
      sent.push({ userId: target.userId, chatId: target.chatId, text });
      if (target.chatId === 41) throw new Error('forbidden');
      return true;
    } },
  });

  expect(result).toEqual({ attempted: 11, confirmed: 10 });
  expect(sent.filter((item) => item.chatId === 42).map((item) => item.text)).toEqual(
    Array.from({ length: 9 }, (_, index) => `Nine card ${index}`),
  );
  expect(sent.filter((item) => item.chatId === 41)).toEqual([
    { userId: 41, chatId: 41, text: '접수했습니다. 접수 ID: tg-refused' },
  ]);
  expect(sent.filter((item) => item.chatId === 44)).toEqual([
    { userId: 44, chatId: 44, text: 'Healthy card' },
  ]);
  expect(new Set(sent.map((item) => `${item.chatId}:${item.text}`)).size).toBe(sent.length);
  expect(pendingTelegramCompletion(dir, identity)).toEqual([]);
  expect(pendingTelegramReceipts(dir, refused)).toEqual(['tg-refused']);
  expect(pendingTelegramCompletion(dir, healthy)).toEqual([]);
});

test('restart drain continues past the 64-card batch and keeps a failed chat from starving later healthy cards', async () => {
  for (const count of [65, 130]) {
    const dir = root();
    const failed = { botId: '123', userId: 40, chatId: 40 };
    const healthy = { botId: '123', userId: 44, chatId: 44 };
    expect(consumeTelegramMemberCode(dir, failed, issueTelegramMemberCode(dir, 'member-failed'))).toBe(true);
    expect(consumeTelegramMemberCode(dir, identity, issueTelegramMemberCode(dir, 'member-a'))).toBe(true);
    expect(consumeTelegramMemberCode(dir, healthy, issueTelegramMemberCode(dir, 'member-healthy'))).toBe(true);
    for (let index = 0; index < 64; index++) {
      const receiptId = `tg-failed-${index}`;
      expect(telegramReceiptStatus(dir, failed, receiptId, `scrap-failed-${index}`)).toBe('pending');
    }
    for (let index = 0; index < count; index++) {
      const receiptId = `tg-many-${count}-${index}`;
      expect(telegramReceiptStatus(dir, identity, receiptId, `scrap-many-${count}-${index}`)).toBe('pending');
      markTelegramReceiptSent(dir, identity, receiptId);
      recordTelegramCompletion(dir, identity, { status: 'absorbed', memberId: 'member-a',
        receiptId, scrapId: `scrap-many-${count}-${index}`, cardText: `Many card ${count}-${index}` });
    }
    expect(telegramReceiptStatus(dir, healthy, `tg-healthy-${count}`, `scrap-healthy-${count}`)).toBe('pending');
    markTelegramReceiptSent(dir, healthy, `tg-healthy-${count}`);
    recordTelegramCompletion(dir, healthy, { status: 'absorbed', memberId: 'member-healthy',
      receiptId: `tg-healthy-${count}`, scrapId: `scrap-healthy-${count}`, cardText: `Healthy after cap ${count}` });

    const sent: { userId: number; chatId: number; text: string }[] = [];
    const batchSizes: number[] = [];
    let yields = 0;
    const result = await retryPendingTelegramMemberCards({
      root: dir, botId: '123', memberActive: () => true,
      yieldBetweenBatches: async () => { batchSizes.push(sent.length); yields++; },
      transport: { send: async (target, text) => {
        sent.push({ userId: target.userId, chatId: target.chatId, text });
        if (target.chatId === 40) return false;
        return true;
      } },
    });

    batchSizes.push(sent.length);
    expect(batchSizes).toEqual(count === 65 ? [64, 67] : [64, 128, 132]);
    expect(yields).toBe(count === 65 ? 1 : 2);
    expect(result).toEqual({ attempted: count + 2, confirmed: count + 1 });
    expect(sent.filter((item) => item.chatId === 40)).toEqual([
      { userId: 40, chatId: 40, text: '접수했습니다. 접수 ID: tg-failed-0' },
    ]);
    expect(sent.filter((item) => item.chatId === 42).map((item) => item.text)).toEqual(
      Array.from({ length: count }, (_, index) => `Many card ${count}-${index}`),
    );
    expect(sent.filter((item) => item.chatId === 44)).toEqual([
      { userId: 44, chatId: 44, text: `Healthy after cap ${count}` },
    ]);
    expect(new Set(sent.map((item) => `${item.chatId}:${item.text}`)).size).toBe(sent.length);
    expect(pendingTelegramCompletion(dir, identity)).toEqual([]);
    expect(pendingTelegramReceipts(dir, failed)).toHaveLength(64);
    expect(pendingTelegramCompletion(dir, healthy)).toEqual([]);
  }
});

test('sixty-four failed chats before a healthy chat do not consume the restart drain', async () => {
  const dir = root();
  const failed = Array.from({ length: 64 }, (_, index) => ({ botId: '123', userId: index + 1, chatId: index + 1 }));
  const healthy = { botId: '123', userId: 100, chatId: 100 };
  for (const identity of failed) {
    expect(consumeTelegramMemberCode(dir, identity, issueTelegramMemberCode(dir, `member-failed-${identity.userId}`))).toBe(true);
    expect(telegramReceiptStatus(dir, identity, `tg-failed-${identity.userId}`, `scrap-failed-${identity.userId}`)).toBe('pending');
  }
  expect(consumeTelegramMemberCode(dir, healthy, issueTelegramMemberCode(dir, 'member-healthy'))).toBe(true);
  expect(telegramReceiptStatus(dir, healthy, 'tg-healthy-after-failures', 'scrap-healthy-after-failures')).toBe('pending');
  markTelegramReceiptSent(dir, healthy, 'tg-healthy-after-failures');
  recordTelegramCompletion(dir, healthy, { status: 'absorbed', memberId: 'member-healthy',
    receiptId: 'tg-healthy-after-failures', scrapId: 'scrap-healthy-after-failures', cardText: 'Healthy after failed chats' });

  const sent: { userId: number; chatId: number; text: string }[] = [];
  let yields = 0;
  const result = await retryPendingTelegramMemberCards({
    root: dir, botId: '123', memberActive: () => true,
    yieldBetweenBatches: async () => { yields++; },
    transport: { send: async (target, text) => {
      sent.push({ userId: target.userId, chatId: target.chatId, text });
      return target.chatId === 100;
    } },
  });

  expect(yields).toBe(1);
  expect(result).toEqual({ attempted: 65, confirmed: 1 });
  expect(sent.filter((item) => item.chatId !== 100)).toHaveLength(64);
  expect(sent.at(-1)).toEqual({ userId: 100, chatId: 100, text: 'Healthy after failed chats' });
  expect(new Set(sent.map((item) => item.chatId)).size).toBe(65);
  expect(pendingTelegramCompletion(dir, healthy)).toEqual([]);
  for (const identity of failed) expect(pendingTelegramReceipts(dir, identity)).toEqual([`tg-failed-${identity.userId}`]);
});

test('member deletion revokes Telegram scrap writes and foreign member readback remains empty', async () => {
  const dir = root();
  const store = createMemberStore({ path: join(dir, 'members', 'members.sqlite') });
  try {
    const member = store.register({ sub: 'telegram-owner', email: 'owner@example.test', emailVerified: true, name: 'Owner' },
      { consents: { privacy: 'v1', terms: 'v1' } });
    expect(consumeTelegramMemberCode(dir, identity, issueTelegramMemberCode(dir, member.id))).toBe(true);
    expect(activeTelegramMember(dir, member.id)).toBe(true);
    let extracts = 0;
    const options = { instanceRoot: dir, extractors: { digestWeb: async () => {
      extracts++;
      return { title: 'Article', body: 'A saved article.' };
    } } };
    const first = await saveTelegramMemberScrap({ options, identity, messageId: 1, url: 'https://example.org/one' });
    expect(first.status).toBe('absorbed');
    expect(store.requestDeletion(member.session.token)).toBe(true);
    expect(activeTelegramMember(dir, member.id)).toBe(false);
    expect(await saveTelegramMemberScrap({ options, identity, messageId: 2, url: 'https://example.org/two' }))
      .toEqual({ status: 'failed', reason: 'member-inactive' });
    expect(extracts).toBe(1);
    const foreign = await handleScraps(new Request('http://nexus.local/v1/scraps'), {
      ...options, resolveOwner: async () => ({ memberId: 'foreign-member' }),
    });
    expect(foreign.status).toBe(200);
    expect(await foreign.json()).toEqual({ scraps: [] });
  } finally { store.close(); }
});

test('real TelegramBot URL branch uses member scrap POST/GET and sends receipt then saved card to same DM', async () => {
  const dir = root();
  process.env.ELANOUS_STATE_DIR = dir;
  const code = issueTelegramMemberCode(dir, 'member-a');
  setUserConfigOverlay((cfg) => ({ ...cfg, skills: { ...cfg.skills,
    urlRouting: { ...cfg.skills.urlRouting, enabled: true, twoStage: true, absorbKeywords: ['저장'] },
  } }));
  const sent: { chat_id: number; text: string }[] = [];
  let polls = 0;
  let turns = 0;
  let bot!: TelegramBot;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = new URL(String(url)).pathname.split('/').at(-1);
    if (method === 'getUpdates') {
      if (polls++ === 0) return Response.json({ ok: true, result: [
        { update_id: 1, message: { message_id: 76, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: `/connect ${code}` } },
        { update_id: 2, message: { message_id: 77, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: 'https://example.org/article 요약해 저장' } },
        { update_id: 3, message: { message_id: 77, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: 'https://example.org/article 요약해 저장' } },
      ] });
      bot.stop();
      return Response.json({ ok: true, result: [] });
    }
    if (method === 'sendMessage') sent.push(JSON.parse(String(init?.body)) as { chat_id: number; text: string });
    return Response.json({ ok: true, result: { message_id: sent.length } });
  }) as typeof fetch;
  bot = new TelegramBot({ token: '123:fake', allowedUsers: [42], fetchImpl, perChatGapMs: 0, pollTimeoutSec: 0,
    scrapRouteOptions: { instanceRoot: dir, memberActive: () => true, extractors: { digestWeb: async () => {
      expect(sent.map((item) => item.text)).toEqual([
        expect.stringContaining('회원 계정이 연결되었습니다'),
        expect.stringContaining('접수 ID: tg-'),
      ]);
      return { title: 'Concert tickets', body: 'Tickets sold out quickly. Fans requested another show.' };
    } } },
    readContextNow: () => ({ at: '2026-11-12T00:00:00.000Z', topic: null, facts: [], events: [], guide: [] }),
    onMessage: async () => { turns++; return 'unexpected'; },
  });
  await bot.start();
  expect(turns).toBe(0);
  expect(sent).toHaveLength(3);
  expect(sent.map((item) => item.chat_id)).toEqual([42, 42, 42]);
  expect(sent[0]?.text).toContain('회원 계정이 연결되었습니다');
  expect(sent[1]?.text).toContain('접수 ID: tg-');
  expect(sent[2]?.text).toContain('Concert tickets');
  expect(sent[2]?.text).toContain('저장 ID: ');
  expect(pendingTelegramCompletion(dir, identity)).toEqual([]);
  const again = await saveTelegramMemberScrap({ identity, messageId: 77, url: 'https://example.org/article',
    options: { instanceRoot: dir, memberActive: () => true, extractors: { digestWeb: async () => { throw new Error('must not extract twice'); } } } });
  expect(again.status).toBe('absorbed');
});

test('a failed Bot API receipt during URL intake persists the scrap and replays receipt then card on restart', async () => {
  const dir = root();
  process.env.ELANOUS_STATE_DIR = dir;
  expect(consumeTelegramMemberCode(dir, identity, issueTelegramMemberCode(dir, 'member-a'))).toBe(true);
  setUserConfigOverlay((cfg) => ({ ...cfg, skills: { ...cfg.skills,
    urlRouting: { ...cfg.skills.urlRouting, enabled: true, twoStage: true, absorbKeywords: ['저장'] },
  } }));
  const sent: { phase: number; text: string; chatId: number }[] = [];
  let extracts = 0;
  const run = async (phase: number) => {
    let polls = 0;
    let bot!: TelegramBot;
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = new URL(String(url)).pathname.split('/').at(-1);
      if (method === 'getUpdates') {
        if (phase === 1 && polls++ === 0) return Response.json({ ok: true, result: [
          { update_id: 1, message: { message_id: 77, from: { id: 42 },
            chat: { id: 42, type: 'private' }, text: 'https://example.org/restart 요약해 저장' } },
        ] });
        bot.stop();
        return Response.json({ ok: true, result: [] });
      }
      if (method === 'sendMessage') {
        const body = JSON.parse(String(init?.body)) as { chat_id: number; text: string };
        sent.push({ phase, text: body.text, chatId: body.chat_id });
        if (phase === 1) return Response.json({ ok: false, error_code: 400, description: 'test send failure' });
      }
      return Response.json({ ok: true, result: { message_id: sent.length } });
    }) as typeof fetch;
    bot = new TelegramBot({ token: '123:fake', allowedUsers: [42], fetchImpl,
      perChatGapMs: 0, pollTimeoutSec: 0,
      scrapRouteOptions: { instanceRoot: dir, memberActive: () => true, extractors: { digestWeb: async () => {
        extracts++;
        return { title: 'Restart article', body: 'The saved article survives a Bot API failure.' };
      } } },
      readContextNow: () => ({ at: '2026-11-12T00:00:00.000Z', topic: null, facts: [], events: [], guide: [] }),
      onMessage: async () => 'unexpected',
    });
    await bot.start();
  };
  await run(1);
  expect(extracts).toBe(1);
  expect(sent.map((item) => item.text)).toEqual([expect.stringContaining('접수 ID: tg-')]);
  expect(pendingTelegramReceipts(dir, identity)).toHaveLength(1);
  await run(2);
  expect(sent.slice(1).map((item) => item.text)).toEqual([
    expect.stringContaining('접수 ID: tg-'), expect.stringContaining('Restart article'),
  ]);
  expect(sent.every((item) => item.chatId === 42)).toBe(true);
  expect(pendingTelegramReceipts(dir, identity)).toEqual([]);
  expect(pendingTelegramCompletion(dir, identity)).toEqual([]);
});
