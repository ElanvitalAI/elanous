import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRIEF_DOMAINS, BRIEF_SLOTS, BriefItemsInputError, BriefItemsLedger, composeBriefMarkdown, composeBriefPage, composeIntakeDailyBrief, normalizeClaim, orderBriefDomains, pendingRealtime, type BriefItem, type BriefWeeklyActions } from './brief-items.js';
import { runRequirementFunnel, type RequirementFunnelResult } from '../intake-plane/requirement-funnel.js';
import { briefFeedbackButtons, recordBriefTelegramUpdate, registerBriefCommands } from '../cli/brief-cli.js';
import { Command } from 'commander';
import { TelegramBot } from '../telegram.js';
import type { DirectiveRow } from '../intake-plane/requirement-funnel.js';
import { runIntakeIssueBriefing } from '../intake-plane/actions.js';

const NOW = new Date('2026-10-05T00:00:00Z'); // 09:00 KST — after 08:30, before 22:00

/** Keep 08:30 compose off the host funnel so split-send counts stay the ledger items under test. */
function emptyFunnel(): RequirementFunnelResult {
  return {
    counts: { directive: 0, intake: 0, grounding: 0, coordination: 0, linear: 0 },
    candidates: 0, decisions: [], unlinkedDirectives: [], briefItems: [],
  };
}

function weeklyActions(overrides: Partial<Record<keyof BriefWeeklyActions['byKind'], { acted: number; total: number }>> = {}): BriefWeeklyActions {
  const byKind = Object.fromEntries(BRIEF_DOMAINS.map(kind => {
    const count = overrides[kind] ?? { acted: 0, total: 0 };
    return [kind, { ...count, rate: count.total === 0 ? 0 : count.acted / count.total }];
  })) as BriefWeeklyActions['byKind'];
  const acted = BRIEF_DOMAINS.reduce((sum, kind) => sum + byKind[kind].acted, 0);
  const total = BRIEF_DOMAINS.reduce((sum, kind) => sum + byKind[kind].total, 0);
  return { acted, total, rate: total === 0 ? 0 : acted / total, byKind };
}

function pageItem(partial: Pick<BriefItem, 'id' | 'text' | 'domain'> & Partial<BriefItem>): BriefItem {
  return {
    priority: 'P1', deadline: null, evidence: null, source: 'test',
    created_at: '2026-10-04T23:00:00Z', sent_at: null, ...partial,
  };
}

function fixture(events: Array<{ event: string; data?: unknown }> = []) {
  const root = mkdtempSync(join(tmpdir(), 'brief-items-'));
  const store = new BriefItemsLedger({
    stateDir: root,
    now: () => NOW,
    log: (_category, event, data) => { events.push({ event, data }); },
    requirementFunnel: emptyFunnel,
  });
  return { root, store, events };
}

test('orderBriefDomains returns BRIEF_DOMAINS unchanged when rate data is missing or every total is 0', () => {
  expect(orderBriefDomains()).toEqual([...BRIEF_DOMAINS]);
  expect(orderBriefDomains(null)).toEqual([...BRIEF_DOMAINS]);
  expect(orderBriefDomains(weeklyActions())).toEqual([...BRIEF_DOMAINS]);
});

test('orderBriefDomains sorts sampled domains by action rate, not raw event count, and keeps zero-sample relative order', () => {
  // 시장 1/1 beats 운영 1/2 even though 운영 recorded more events; 판·흡수 stay 운영 뒤 고정 상대 순서.
  expect(orderBriefDomains(weeklyActions({
    운영: { acted: 1, total: 2 },
    시장: { acted: 1, total: 1 },
  }))).toEqual(['시장', '운영', '판', '흡수', '행정', '코나투스']);
});

test('composeBriefPage keeps P0 and KST-today first, then high-rate domains, then zero-sample in fixed order', () => {
  const items: BriefItem[] = [
    pageItem({ id: 1, text: '운영 항목', domain: '운영' }),
    pageItem({ id: 2, text: '판 항목', domain: '판' }),
    pageItem({ id: 3, text: '시장 항목', domain: '시장' }),
    pageItem({ id: 4, text: '오늘 결정', domain: '행정', priority: 'P2', deadline: '2026-10-05' }),
    pageItem({ id: 5, text: '즉시 결정', domain: '운영', priority: 'P0' }),
  ];
  const actions = weeklyActions({ 시장: { acted: 1, total: 1 }, 운영: { acted: 1, total: 2 } });
  const page = composeBriefPage(items, '08:30', NOW, actions);
  expect(page.markdown.indexOf('## 결정이 필요한 것')).toBeLessThan(page.markdown.indexOf('- [P0] 즉시 결정'));
  expect(page.markdown.indexOf('- [P0] 즉시 결정')).toBeLessThan(page.markdown.indexOf('- [P2] 오늘 결정'));
  expect(page.markdown.indexOf('- [P2] 오늘 결정')).toBeLessThan(page.markdown.indexOf('## 시장'));
  expect(page.markdown.indexOf('## 시장')).toBeLessThan(page.markdown.indexOf('## 운영'));
  expect(page.markdown.indexOf('## 운영')).toBeLessThan(page.markdown.indexOf('## 판'));
});

test('composeBriefPage suppresses duplicate claims, copies text verbatim, and matches the no-rate page when rates are missing', () => {
  const original = '  흡수   대기 ';
  const items: BriefItem[] = [
    pageItem({ id: 1, text: original, domain: '흡수' }),
    pageItem({ id: 2, text: '흡수 대기', domain: '운영' }),
    pageItem({ id: 3, text: '판 컷 확인', domain: '판' }),
  ];
  const withRates = composeBriefPage(items, '08:30', NOW, weeklyActions({ 판: { acted: 1, total: 1 } }));
  const withoutRates = composeBriefPage(items, '08:30', NOW);
  expect(withRates.markdown.split('흡수   대기').length - 1).toBe(1);
  expect(withRates.markdown).toContain(original);
  expect(withRates.markdown).not.toContain('- [P1] 흡수 대기');
  expect(withoutRates.markdown).toBe(composeBriefPage(items, '08:30', NOW, weeklyActions()).markdown);
  expect(withoutRates.markdown.indexOf('## 판')).toBeLessThan(withoutRates.markdown.indexOf('## 흡수'));
  expect(withRates.markdown.indexOf('## 판')).toBeLessThan(withRates.markdown.indexOf('## 흡수'));
});

test('undeliverable same kind and route within an hour is one ledger item, then a fresh hour adds one', () => {
  const root = mkdtempSync(join(tmpdir(), 'brief-undeliverable-'));
  let now = new Date('2026-10-08T03:00:00Z');
  const store = new BriefItemsLedger({ stateDir: root, now: () => now, log: () => {} });
  const input = {
    text: '미전달: kind report · 데몬 not-found · 경로 bot unknown · 우주 test',
    domain: '운영' as const, priority: 'P1' as const, source: 'outbound.undeliverable',
    evidence: 'elanous logs --category outbound.send --event undeliverable',
    dedupeKey: 'report · bot unknown', dedupeWithinMs: 60 * 60_000,
  };
  try {
    const first = store.add(input);
    now = new Date('2026-10-08T03:59:59Z');
    expect(store.add({ ...input, text: '미전달: kind report · 데몬 rejected · 경로 bot unknown · 우주 prod' }).id).toBe(first.id);
    expect(new BriefItemsLedger({ stateDir: root, now: () => now, log: () => {} }).list()).toHaveLength(1);
    expect(store.compose('after-release')).toContain(input.text);
    now = new Date('2026-10-08T04:00:01Z');
    expect(store.add({ ...input, dedupeKey: 'report · path undeliverable' }).id).not.toBe(first.id);
    expect(store.add(input).id).not.toBe(first.id);
    expect(store.list()).toHaveLength(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('undeliverable retry before send shares one item, but retry after send appears on the next page', () => {
  const root = mkdtempSync(join(tmpdir(), 'brief-undeliverable-sent-'));
  let now = new Date('2026-10-08T03:00:00Z');
  const store = new BriefItemsLedger({ stateDir: root, now: () => now, log: () => {} });
  const input = {
    text: '미전달: kind report · 데몬 not-found · 경로 no-report-channel · 우주 test',
    domain: '운영' as const, priority: 'P1' as const, source: 'outbound.undeliverable',
    evidence: 'elanous logs --category outbound.send --event undeliverable',
    dedupeKey: 'report · no-report-channel', dedupeWithinMs: 60 * 60_000,
  };
  try {
    const first = store.add(input);
    now = new Date('2026-10-08T03:01:00Z');
    expect(store.add(input).id).toBe(first.id);
    expect(store.list()).toHaveLength(1);
    expect(store.composeWithIds('after-release').ids).toEqual([first.id]);
    store.markSent([first.id], 'after-release');
    expect(store.composeWithIds('after-release').ids).toEqual([]);
    now = new Date('2026-10-08T03:02:00Z');
    const second = store.add(input);
    expect(second.id).not.toBe(first.id);
    now = new Date('2026-10-08T03:03:00Z');
    expect(store.add(input).id).toBe(second.id);
    expect(store.list()).toHaveLength(2);
    now = new Date('2026-10-08T13:01:00Z'); // 22:01 KST — the next briefing slot has opened
    const next = store.composeWithIds('22:00');
    expect(next.ids).toEqual([second.id]);
    expect(next.markdown).toContain(input.text);
    store.markSent(next.ids, '22:00');
    expect(store.composeWithIds('22:00').ids).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ordinary claim duplicates remain suppressed after a delivered page', () => {
  const root = mkdtempSync(join(tmpdir(), 'brief-ordinary-delivered-'));
  let now = new Date('2026-10-08T03:00:00Z');
  const store = new BriefItemsLedger({ stateDir: root, now: () => now, log: () => {} });
  try {
    const first = store.add({ text: '작업 결과', domain: '운영', priority: 'P1', source: 'test' });
    now = new Date('2026-10-08T03:01:00Z');
    store.markSent([first.id], 'after-release');
    const second = store.add({ text: '작업 결과', domain: '운영', priority: 'P1', source: 'test' });
    now = new Date('2026-10-08T03:02:00Z');
    expect(store.list()).toHaveLength(2);
    expect(store.composeWithIds('after-release').ids).toEqual([]);
    expect(store.compose('after-release')).not.toContain('작업 결과');
    expect(second.sent_at).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('append-only items keep the claim verbatim under briefing/items.sqlite', () => {
  const events: Array<{ event: string }> = [];
  const { root, store } = fixture(events);
  try {
    expect(store.path).toBe(join(root, 'briefing', 'items.sqlite'));
    const text = '  흡수 큐가 멈췄다  ';
    const first = store.add({
      text, domain: '흡수', priority: 'P1', source: '흡수',
      evidence: 'https://example.test/1', deadline: '2026-10-06',
    });
    const second = store.add({ text: '코나투스 공회전', domain: '코나투스', priority: 'P2', source: '코나투스' });
    expect(existsSync(store.path)).toBe(true);
    expect(first).toEqual({
      id: 1, text, domain: '흡수', priority: 'P1', deadline: '2026-10-06',
      evidence: 'https://example.test/1', source: '흡수', linearIssueId: null,
      created_at: '2026-10-05T00:00:00.000Z', sent_at: null,
    });
    expect(second.deadline).toBeNull();
    expect(second.evidence).toBeNull();
    expect(second.sent_at).toBeNull();
    expect(new BriefItemsLedger({ stateDir: root }).list()).toEqual([first, second]);
    const db = new Database(store.path);
    try {
      expect(() => db.query('UPDATE items SET text = ? WHERE id = ?').run('rewritten', first.id)).toThrow('brief items are immutable');
      expect(() => db.query('DELETE FROM items WHERE id = ?').run(first.id)).toThrow('brief items are immutable');
    } finally { db.close(); }
    expect(store.list()[0]?.text).toBe(text);
    expect(events.map(event => event.event)).toEqual(['added', 'added']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reactions append per sent item without rewriting items; weekly action rates count distinct acted items by domain', () => {
  const { root, store } = fixture();
  try {
    const first = store.add({ text: '움직임', domain: '판', priority: 'P0', source: 'test' });
    const second = store.add({ text: '열람만', domain: '판', priority: 'P1', source: 'test' });
    const third = store.add({ text: '무시', domain: '시장', priority: 'P1', source: 'test' });
    const unsent = store.add({ text: '미발송', domain: '시장', priority: 'P2', source: 'test' });
    expect(() => store.recordReaction(unsent.id, '버튼')).toThrow('item was not sent');
    store.markSent([first.id, second.id, third.id], '08:30');
    const before = store.list();
    for (const reaction of ['열람', '버튼', '답장', '정정'] as const) store.recordReaction(first.id, reaction);
    store.recordReaction(second.id, '열람');
    store.recordReaction(third.id, '무시');
    const reopened = new BriefItemsLedger({ stateDir: root, now: () => NOW, log: () => {} });
    expect(reopened.weeklyActions()).toEqual({
      acted: 1, total: 3, rate: 1 / 3,
      byKind: {
        운영: { acted: 0, total: 0, rate: 0 },
        판: { acted: 1, total: 2, rate: 0.5 },
        흡수: { acted: 0, total: 0, rate: 0 },
        시장: { acted: 0, total: 1, rate: 0 },
        행정: { acted: 0, total: 0, rate: 0 },
        코나투스: { acted: 0, total: 0, rate: 0 },
      },
    });
    expect(reopened.list()).toEqual(before);
    const db = new Database(store.path);
    try {
      expect(db.query('SELECT item_id, reaction FROM reactions ORDER BY id').all()).toEqual([
        { item_id: first.id, reaction: '열람' }, { item_id: first.id, reaction: '버튼' },
        { item_id: first.id, reaction: '답장' }, { item_id: first.id, reaction: '정정' },
        { item_id: second.id, reaction: '열람' }, { item_id: third.id, reaction: '무시' },
      ]);
    } finally { db.close(); }
    expect(() => store.recordReaction(0, '버튼')).toThrow('invalid item id');
    expect(() => store.recordReaction(999, '버튼')).toThrow('item was not sent');
    expect(() => store.recordReaction(first.id, 'unknown' as '버튼')).toThrow('invalid reaction');
    expect(reopened.weeklyActions().total).toBe(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('no feedback preserves id order inside a domain even when input is reversed', () => {
  const { root, store } = fixture();
  try {
    const first = store.add({ text: '먼저', domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    const second = store.add({ text: '나중', domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    const page = composeBriefPage(store.list().reverse(), '08:30', NOW);
    expect(page.ids).toEqual([first.id, second.id]);
    expect(page.markdown.indexOf('먼저')).toBeLessThan(page.markdown.indexOf('나중'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Telegram feedback buttons and attributed updates keep item and send rows unchanged', () => {
  const { root, store } = fixture();
  try {
    const first = store.add({ text: '첫째', domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    const second = store.add({ text: '둘째', domain: '판', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    expect(briefFeedbackButtons([first.id])[0]).toEqual([
      { text: `👀 ${first.id} 읽음`, data: `brief-item:${first.id}:read` },
      { text: `✅ ${first.id} 움직임`, data: `brief-item:${first.id}:button` },
      { text: `➖ ${first.id} 넘김`, data: `brief-item:${first.id}:ignore` },
    ]);
    store.withSendLock('08:30', (page, mark) => {
      expect(page.ids).toEqual([first.id, second.id]);
      mark(page.ids, '08:30', { botId: 'bot', chatId: 42, messageId: 77 });
    });
    const db = new Database(store.path);
    try {
      const sends = db.query('SELECT * FROM sends ORDER BY item_id').all();
      const items = store.list();
      const base = { botId: 'bot', chatId: 42, messageId: 77 };
      expect(recordBriefTelegramUpdate(store, { ...base, botId: 'other', updateId: 'u1', text: '#1 답장' })).toBe(false);
      expect(recordBriefTelegramUpdate(store, { ...base, chatId: 43, updateId: 'u1', text: '#1 답장' })).toBe(false);
      expect(recordBriefTelegramUpdate(store, { ...base, messageId: 78, updateId: 'u1', text: '#1 답장' })).toBe(false);
      expect(recordBriefTelegramUpdate(store, { ...base, updateId: 'u2', text: '그게 아니라' })).toBe(false);
      expect(recordBriefTelegramUpdate(store, { ...base, updateId: 'u2a', callbackData: 'brief-item:999:button' })).toBe(false);
      expect(recordBriefTelegramUpdate(store, { ...base, updateId: 'u3', callbackData: `brief-item:${first.id}:button` })).toBe(true);
      expect(recordBriefTelegramUpdate(store, { ...base, updateId: 'u3', callbackData: `brief-item:${second.id}:button` })).toBe(false);
      expect(recordBriefTelegramUpdate(store, { ...base, updateId: 'u4', text: `#${second.id}: 그게 아니라 내일` })).toBe(true);
    expect(recordBriefTelegramUpdate(store, { ...base, updateId: 'u5', text: `#${first.id} 정정: 마감은 내일` })).toBe(true);
      expect(db.query('SELECT item_id, reaction FROM reactions ORDER BY id').all()).toEqual([
        { item_id: first.id, reaction: '버튼' }, { item_id: second.id, reaction: '정정' }, { item_id: first.id, reaction: '정정' },
      ]);
      expect(store.weeklyActions()).toMatchObject({ acted: 2, total: 2 });
      expect(db.query('SELECT * FROM sends ORDER BY item_id').all()).toEqual(sends);
      expect(store.list()).toEqual(items);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('brief send failure leaves sends and Telegram coordinates empty', async () => {
  const { root, store } = fixture();
  const priorExit = process.exitCode;
  try {
    store.add({ text: '재시도', domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    const program = new Command();
    const errors: string[] = [];
    registerBriefCommands(program, { ledger: store, send: () => null,
      telegramTarget: { botToken: '123:secret', chatId: 42 }, error: text => errors.push(text) });
    await program.parseAsync(['brief', 'send', '--slot', '08:30'], { from: 'user' });
    expect(errors[0]).toContain('발송 실패');
    const db = new Database(store.path);
    try {
      expect(db.query('SELECT COUNT(*) AS count FROM sends').get()).toEqual({ count: 0 });
      expect(db.query('SELECT COUNT(*) AS count FROM telegram_sends').get()).toEqual({ count: 0 });
    } finally { db.close(); }
  } finally { process.exitCode = priorExit ?? 0; rmSync(root, { recursive: true, force: true }); }
});

test('a Telegram coordinate write failure rolls back the sent mark with it', () => {
  const { root, store } = fixture();
  try {
    const item = store.add({ text: '좌표 실패 재시도', domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    let db = new Database(store.path);
    try {
      db.exec("CREATE TRIGGER reject_telegram_send BEFORE INSERT ON telegram_sends BEGIN SELECT RAISE(ABORT, 'coordinate failed'); END");
    } finally { db.close(); }
    expect(() => store.withSendLock('08:30', (page, mark) => {
      mark(page.ids, '08:30', { botId: 'bot', chatId: 42, messageId: 77 });
    })).toThrow('coordinate failed');
    db = new Database(store.path);
    try {
      expect(db.query('SELECT COUNT(*) AS count FROM sends').get()).toEqual({ count: 0 });
      expect(db.query('SELECT COUNT(*) AS count FROM telegram_sends').get()).toEqual({ count: 0 });
      db.exec('DROP TRIGGER reject_telegram_send');
    } finally { db.close(); }
    store.withSendLock('08:30', (page, mark) => { mark(page.ids, '08:30', { botId: 'bot', chatId: 42, messageId: 78 }); });
    db = new Database(store.path);
    try {
      expect(db.query('SELECT item_id FROM sends').all()).toEqual([{ item_id: item.id }]);
      expect(db.query('SELECT message_id, item_id FROM telegram_sends').all()).toEqual([{ message_id: 78, item_id: item.id }]);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('31-item Telegram brief gives every split message item buttons and attributes early read and reply', async () => {
  const { root, store } = fixture();
  try {
    const items = Array.from({ length: 31 }, (_, index) => store.add({
      text: `요청 ${index} ` + '가'.repeat(100), domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z',
    }));
    const delivered: Array<{ text: string; buttons: ReturnType<typeof briefFeedbackButtons>; messageId: number }> = [];
    const program = new Command();
    const outputs: string[] = [];
    registerBriefCommands(program, { ledger: store, telegramTarget: { botToken: '123:secret', chatId: 42 },
      sendWithButtons: (text, buttons) => {
        const messageId = 77 + delivered.length;
        delivered.push({ text, buttons, messageId });
        return messageId;
      }, output: text => outputs.push(text) });
    await program.parseAsync(['brief', 'send', '--slot', '08:30'], { from: 'user' });
    expect(delivered).toHaveLength(31);
    expect(delivered.every(part => part.text.length <= 3900)).toBe(true);
    expect(delivered[0]!.text).toContain(items[0]!.text);
    expect(delivered[0]!.buttons).toEqual(briefFeedbackButtons([items[0]!.id]));
    expect(outputs).toEqual(['sent 107 (31 items)']);
    const early = { botId: '123', chatId: 42, messageId: delivered[0]!.messageId };
    const updates = [
      { update_id: 1, callback_query: { id: 'read-first', from: { id: 42 }, message: { message_id: early.messageId, chat: { id: 42 } }, data: delivered[0]!.buttons[0]![0]!.data } },
      { update_id: 2, message: { message_id: 88, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: '움직이겠습니다', reply_to_message: { message_id: early.messageId } } },
    ];
    let polls = 0;
    let bot: TelegramBot;
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/getUpdates')) {
        if (++polls === 1) return Response.json({ ok: true, result: updates });
        bot.stop();
        return Response.json({ ok: true, result: [] });
      }
      return Response.json({ ok: true, result: { message_id: 99 } });
    }) as typeof fetch;
    bot = new TelegramBot({ token: '123:secret', allowedUsers: [42], fetchImpl, nowImpl: () => NOW.getTime(),
      perChatGapMs: 0, briefLedger: store, onMessage: async ctx => { seen.push(ctx.text); } });
    await bot.start();
    expect(seen).toEqual(['움직이겠습니다']);
    expect(recordBriefTelegramUpdate(store, { ...early, updateId: 'wrong-item', callbackData: `brief-item:${items[30]!.id}:button` })).toBe(false);
    const db = new Database(store.path);
    try {
      expect(db.query('SELECT item_id, slot FROM sends ORDER BY item_id').all()).toEqual(items.map(item => ({ item_id: item.id, slot: '08:30' })));
      expect(db.query('SELECT message_id, item_id FROM telegram_sends ORDER BY message_id').all()).toEqual(
        items.map((item, index) => ({ message_id: 77 + index, item_id: item.id })),
      );
      expect(db.query('SELECT item_id, reaction FROM reactions ORDER BY id').all()).toEqual([
        { item_id: items[0]!.id, reaction: '열람' }, { item_id: items[0]!.id, reaction: '답장' },
      ]);
      expect(store.weeklyActions()).toMatchObject({ acted: 1, total: 31 });
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15000);

test('a separate Telegram poller records feedback arriving while later fragments are delayed', async () => {
  const { root, store } = fixture();
  let workerProcess: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const items = Array.from({ length: 31 }, (_, index) => store.add({
      text: `조기 반응 ${index} ` + '가'.repeat(100), domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z',
    }));
    const marker = join(root, 'first-fragment-sent');
    const worker = join(root, 'send-worker.ts');
    writeFileSync(worker, `
import { writeFileSync } from 'node:fs';
import { BriefItemsLedger } from ${JSON.stringify(join(import.meta.dir, 'brief-items.ts'))};
import { registerBriefCommands } from ${JSON.stringify(join(import.meta.dir, '../cli/brief-cli.ts'))};
class Command {
  children = [];
  constructor(name) { this.name = name; }
  description() { return this; }
  requiredOption() { return this; }
  option() { return this; }
  action(fn) { this.handler = fn; return this; }
  command(name) { const child = new Command(name); this.children.push(child); return child; }
}
const [root, marker] = process.argv.slice(2);
const command = new Command('root');
let sends = 0;
registerBriefCommands(command, {
  ledger: new BriefItemsLedger({ stateDir: root, now: () => new Date('2026-10-05T00:00:00Z'), log: () => {}, requirementFunnel: () => ({ counts: { directive: 0, intake: 0, grounding: 0, coordination: 0, linear: 0 }, candidates: 0, decisions: [], unlinkedDirectives: [], briefItems: [] }) }),
  telegramTarget: { botToken: '123:secret', chatId: 42 },
  sendWithButtons: () => {
    sends += 1;
    if (sends === 1) writeFileSync(marker, 'ready');
    if (sends === 2) Bun.sleepSync(1000);
    return 76 + sends;
  }, output: () => {}, error: message => { throw new Error(message); },
});
command.children[0].children.find(child => child.name === 'send').handler({ slot: '08:30' });
`);
    workerProcess = Bun.spawn(['bun', 'run', worker, root, marker], { stdout: 'pipe', stderr: 'pipe' });
    for (let i = 0; i < 1500 && !existsSync(marker); i += 1) await Bun.sleep(10);
    expect(existsSync(marker)).toBe(true);
    let polls = 0;
    let bot: TelegramBot;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/getUpdates')) {
        if (++polls === 1) return Response.json({ ok: true, result: [{ update_id: 1, callback_query: {
          id: 'early-read', from: { id: 42 }, message: { message_id: 77, chat: { id: 42 } },
          data: `brief-item:${items[0]!.id}:read`,
        } }] });
        bot.stop();
        return Response.json({ ok: true, result: [] });
      }
      return Response.json({ ok: true, result: true });
    }) as typeof fetch;
    bot = new TelegramBot({ token: '123:secret', allowedUsers: [42], fetchImpl, nowImpl: () => NOW.getTime(),
      perChatGapMs: 0, briefLedger: store, onMessage: async () => undefined });
    await bot.start();
    expect(await workerProcess.exited).toBe(0);
    const db = new Database(store.path);
    try { expect(db.query('SELECT item_id, reaction FROM reactions').all()).toEqual([{ item_id: items[0]!.id, reaction: '열람' }]); }
    finally { db.close(); }
  } finally { workerProcess?.kill(); rmSync(root, { recursive: true, force: true }); }
}, 30000);

test('item-number prefixes are counted before choosing a single Telegram message', async () => {
  const { root, store } = fixture();
  try {
    for (let index = 0; index < 30; index += 1) {
      store.add({ text: `요청 ${index} ` + '가'.repeat(100), domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    }
    const page = store.composeWithIds('08:30');
    expect(page.ids).toHaveLength(30);
    expect(page.markdown.length + page.markdown.split('\n').length).toBeLessThanOrEqual(3900);
    const delivered: string[] = [];
    const program = new Command();
    registerBriefCommands(program, { ledger: store, telegramTarget: { botToken: '123:secret', chatId: 42 },
      sendWithButtons: text => { delivered.push(text); return 100 + delivered.length; }, output: () => {} });
    await program.parseAsync(['brief', 'send', '--slot', '08:30'], { from: 'user' });
    expect(delivered).toHaveLength(30);
    expect(delivered.every(text => text.length + text.split('\n').length <= 3900)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15000);

test('identical item lines in different domains retain distinct Telegram coordinates', async () => {
  const { root, store } = fixture();
  try {
    const first = store.add({ text: '동일 주장', domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    const second = store.add({ text: '동일 주장', domain: '판', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    const delivered: ReturnType<typeof briefFeedbackButtons>[] = [];
    const program = new Command();
    registerBriefCommands(program, { ledger: store, telegramTarget: { botToken: '123:secret', chatId: 42 },
      sendWithButtons: (_text, buttons) => { delivered.push(buttons); return 77 + delivered.length; }, output: () => {} });
    await program.parseAsync(['brief', 'send', '--slot', '08:30'], { from: 'user' });
    expect(delivered).toEqual([briefFeedbackButtons([first.id])]);
    const db = new Database(store.path);
    try {
      expect(db.query('SELECT item_id FROM sends').all()).toEqual([{ item_id: first.id }]);
      expect(db.query('SELECT item_id FROM telegram_sends').all()).toEqual([{ item_id: first.id }]);
      expect(store.list().find(item => item.id === second.id)?.sent_at).toBeNull();
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('oversized single item splits with its own buttons on both fragments', async () => {
  const { root, store } = fixture();
  try {
    const item = store.add({ text: '긴 브리핑 ' + '가'.repeat(3900), domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    const delivered: Array<{ text: string; buttons: ReturnType<typeof briefFeedbackButtons> }> = [];
    const program = new Command();
    registerBriefCommands(program, { ledger: store, telegramTarget: { botToken: '123:secret', chatId: 42 },
      sendWithButtons: (text, buttons) => { delivered.push({ text, buttons }); return 76 + delivered.length; }, output: () => {} });
    await program.parseAsync(['brief', 'send', '--slot', '08:30'], { from: 'user' });
    expect(delivered.length).toBeGreaterThan(1);
    expect(delivered.every(part => part.text.length <= 3900 && JSON.stringify(part.buttons) === JSON.stringify(briefFeedbackButtons([item.id])))).toBe(true);
    expect(recordBriefTelegramUpdate(store, { botId: '123', chatId: 42, messageId: 77, updateId: 'early', text: '그게 아니라 수정' })).toBe(true);
    const db = new Database(store.path);
    try {
      expect(db.query('SELECT item_id, slot FROM sends').all()).toEqual([{ item_id: item.id, slot: '08:30' }]);
      expect(db.query('SELECT message_id, item_id FROM telegram_sends ORDER BY message_id').all()).toEqual(
        delivered.map((_, index) => ({ message_id: 77 + index, item_id: item.id })),
      );
      expect(db.query('SELECT item_id, reaction FROM reactions').all()).toEqual([{ item_id: item.id, reaction: '정정' }]);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a failed second fragment leaves the long item unsent and retries every fragment', async () => {
  const { root, store } = fixture();
  const priorExit = process.exitCode;
  try {
    const item = store.add({ text: '긴 재시도 ' + '가'.repeat(3900), domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    const firstAttempt: string[] = [];
    const errors: string[] = [];
    const first = new Command();
    registerBriefCommands(first, { ledger: store, telegramTarget: { botToken: '123:secret', chatId: 42 },
      sendWithButtons: text => { firstAttempt.push(text); return firstAttempt.length === 1 ? 77 : null; },
      output: () => {}, error: text => errors.push(text) });
    await first.parseAsync(['brief', 'send', '--slot', '08:30'], { from: 'user' });
    expect(firstAttempt).toHaveLength(2);
    expect(errors[0]).toContain('발송 실패');
    let db = new Database(store.path);
    try {
      expect(db.query('SELECT COUNT(*) AS count FROM sends').get()).toEqual({ count: 0 });
      expect(db.query('SELECT COUNT(*) AS count FROM telegram_sends').get()).toEqual({ count: 0 });
    } finally { db.close(); }
    const retried: string[] = [];
    const retry = new Command();
    registerBriefCommands(retry, { ledger: store, telegramTarget: { botToken: '123:secret', chatId: 42 },
      sendWithButtons: text => { retried.push(text); return 100 + retried.length; },
      output: () => {}, error: () => {} });
    await retry.parseAsync(['brief', 'send', '--slot', '08:30'], { from: 'user' });
    expect(retried.length).toBeGreaterThan(1);
    expect(retried[0]).toBe(firstAttempt[0]);
    db = new Database(store.path);
    try {
      expect(db.query('SELECT item_id, slot FROM sends').all()).toEqual([{ item_id: item.id, slot: '08:30' }]);
      expect(db.query('SELECT message_id, item_id FROM telegram_sends ORDER BY message_id').all()).toEqual(
        retried.map((_, index) => ({ message_id: 101 + index, item_id: item.id })),
      );
    } finally { db.close(); }
  } finally { process.exitCode = priorExit ?? 0; rmSync(root, { recursive: true, force: true }); }
});

test('brief send records Telegram coordinates without changing the sends ledger or output', async () => {
  const { root, store } = fixture();
  try {
    const item = store.add({ text: '응답 요청', domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    const program = new Command();
    const outputs: string[] = [];
    registerBriefCommands(program, { ledger: store, send: () => 77,
      telegramTarget: { botToken: '123:secret', chatId: 42 }, output: text => outputs.push(text) });
    await program.parseAsync(['brief', 'send', '--slot', '08:30'], { from: 'user' });
    expect(outputs).toEqual(['sent 77 (1 items)']);
    const db = new Database(store.path);
    try {
      expect(db.query('SELECT item_id, slot FROM sends').all()).toEqual([{ item_id: item.id, slot: '08:30' }]);
      expect(db.query('SELECT bot_id, chat_id, message_id, item_id FROM telegram_sends').all()).toEqual([
        { bot_id: '123', chat_id: 42, message_id: 77, item_id: item.id },
      ]);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mid-flight Telegram split failure keeps the delivered front items and a retry sends only the remainder', async () => {
  const { root, store } = fixture();
  const priorExit = process.exitCode;
  try {
    const items = Array.from({ length: 31 }, (_, index) => store.add({
      text: `요청 ${index} ` + '가'.repeat(100), domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z',
    }));
    const errors: string[] = [];
    const firstRun: Array<{ text: string; buttons: ReturnType<typeof briefFeedbackButtons> }> = [];
    let sends = 0;
    const program = new Command();
    registerBriefCommands(program, { ledger: store, telegramTarget: { botToken: '123:secret', chatId: 42 },
      sendWithButtons: (text, buttons) => {
        sends += 1;
        if (sends > 2) return null;
        firstRun.push({ text, buttons });
        return 76 + sends;
      }, output: () => {}, error: text => errors.push(text) });
    await program.parseAsync(['brief', 'send', '--slot', '08:30'], { from: 'user' });
    expect(errors[0]).toContain('발송 실패');
    // the two messages the 대표 already received stay recorded; the unsent 29 stay unsent
    expect(firstRun[0]!.text).toContain(`#${items[0]!.id} `);
    let db = new Database(store.path);
    try {
      expect(db.query('SELECT item_id, slot FROM sends ORDER BY item_id').all()).toEqual([
        { item_id: items[0]!.id, slot: '08:30' }, { item_id: items[1]!.id, slot: '08:30' },
      ]);
      expect(db.query('SELECT message_id, item_id FROM telegram_sends ORDER BY message_id').all()).toEqual([
        { message_id: 77, item_id: items[0]!.id }, { message_id: 78, item_id: items[1]!.id },
      ]);
    } finally { db.close(); }
    expect(store.list().filter(item => item.sent_at)).toHaveLength(2);
    // retry: only the unsent remainder goes out — nothing already delivered is re-sent
    const retry: Array<{ text: string; buttons: ReturnType<typeof briefFeedbackButtons> }> = [];
    const outputs: string[] = [];
    const programRetry = new Command();
    registerBriefCommands(programRetry, { ledger: store, telegramTarget: { botToken: '123:secret', chatId: 42 },
      sendWithButtons: (text, buttons) => { retry.push({ text, buttons }); return 100 + retry.length; },
      output: text => outputs.push(text), error: () => {} });
    await programRetry.parseAsync(['brief', 'send', '--slot', '08:30'], { from: 'user' });
    expect(retry).toHaveLength(1);
    expect(retry[0]!.text).toContain(`#${items[2]!.id} `);
    expect(retry[0]!.text).not.toContain(`#${items[0]!.id} `);
    expect(retry[0]!.text).not.toContain(`#${items[1]!.id} `);
    expect(retry[0]!.buttons).toEqual(briefFeedbackButtons(items.slice(2).map(item => item.id)));
    expect(outputs).toEqual(['sent 101 (29 items)']);
    db = new Database(store.path);
    try {
      expect(db.query('SELECT COUNT(*) AS count FROM sends').get()).toEqual({ count: 31 });
      expect(db.query('SELECT COUNT(*) AS count FROM telegram_sends').get()).toEqual({ count: 31 });
    } finally { db.close(); }
  } finally { process.exitCode = priorExit ?? 0; rmSync(root, { recursive: true, force: true }); }
}, 15000);

test('a thrown split send preserves completed front items and retries only the remainder', async () => {
  const { root, store } = fixture();
  const priorExit = process.exitCode;
  try {
    const items = Array.from({ length: 31 }, (_, index) => store.add({
      text: `요청 ${index} ` + '가'.repeat(100), domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z',
    }));
    let attempts = 0;
    const errors: string[] = [];
    const first = new Command();
    registerBriefCommands(first, { ledger: store, telegramTarget: { botToken: '123:secret', chatId: 42 },
      sendWithButtons: () => { if (++attempts === 2) throw new Error('network failed'); return 77; },
      output: () => {}, error: text => errors.push(text) });
    await first.parseAsync(['brief', 'send', '--slot', '08:30'], { from: 'user' });
    expect(errors[0]).toContain('network failed');
    let db = new Database(store.path);
    try {
      expect(db.query('SELECT item_id FROM sends').all()).toEqual([{ item_id: items[0]!.id }]);
      expect(db.query('SELECT message_id, item_id FROM telegram_sends').all()).toEqual([{ message_id: 77, item_id: items[0]!.id }]);
    } finally { db.close(); }
    const retryTexts: string[] = [];
    const retry = new Command();
    registerBriefCommands(retry, { ledger: store, telegramTarget: { botToken: '123:secret', chatId: 42 },
      sendWithButtons: text => { retryTexts.push(text); return 100 + retryTexts.length; },
      output: () => {}, error: () => {} });
    await retry.parseAsync(['brief', 'send', '--slot', '08:30'], { from: 'user' });
    expect(retryTexts.join('\n')).toContain(`#${items[1]!.id} `);
    expect(retryTexts.join('\n')).not.toContain(`#${items[0]!.id} `);
    db = new Database(store.path);
    try {
      expect(db.query('SELECT COUNT(*) AS count FROM sends').get()).toEqual({ count: 31 });
    } finally { db.close(); }
  } finally { process.exitCode = priorExit ?? 0; rmSync(root, { recursive: true, force: true }); }
}, 15000);

test('multi-item single-message brief carries item numbers so a reply can name its target item', async () => {
  const { root, store } = fixture();
  try {
    const first = store.add({ text: '첫 항목', domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    const second = store.add({ text: '둘 항목', domain: '판', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    const sent: string[] = [];
    const program = new Command();
    registerBriefCommands(program, { ledger: store, send: text => { sent.push(text); return 77; },
      telegramTarget: { botToken: '123:secret', chatId: 42 }, output: () => {} });
    await program.parseAsync(['brief', 'send', '--slot', '08:30'], { from: 'user' });
    // the delivered text numbers every item line so a plain reply can name its target
    expect(sent[0]).toContain(`#${first.id} - [P1] 첫 항목`);
    expect(sent[0]).toContain(`#${second.id} - [P1] 둘 항목`);
    const base = { botId: '123', chatId: 42, messageId: 77 };
    // an unnumbered reply to a multi-item message stays unattributed (signal dropped)
    expect(recordBriefTelegramUpdate(store, { ...base, updateId: 'u1', text: '그게 아니라 내일' })).toBe(false);
    // a reply naming the item lands on exactly that item
    expect(recordBriefTelegramUpdate(store, { ...base, updateId: 'u2', text: `#${second.id} 그게 아니라 내일` })).toBe(true);
    expect(recordBriefTelegramUpdate(store, { ...base, updateId: 'u3', text: `#${first.id} 움직이겠습니다` })).toBe(true);
    const db = new Database(store.path);
    try {
      expect(db.query('SELECT item_id, reaction FROM reactions ORDER BY id').all()).toEqual([
        { item_id: second.id, reaction: '정정' }, { item_id: first.id, reaction: '답장' },
      ]);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Telegram poller automatically collects owner button and reply feedback without swallowing normal turns', async () => {
  const { root, store } = fixture();
  try {
    const item = store.add({ text: '응답 요청', domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    store.withSendLock('08:30', (page, mark) => { mark(page.ids, '08:30', { botId: '123', chatId: 42, messageId: 77 }); });
    const updates = [
      { update_id: 1, callback_query: { id: 'blocked', from: { id: 999 }, message: { message_id: 77, chat: { id: 42 } }, data: `brief-item:${item.id}:button` } },
      { update_id: 2, callback_query: { id: 'owner', from: { id: 42 }, message: { message_id: 77, chat: { id: 42 } }, data: `brief-item:${item.id}:button` } },
      { update_id: 3, message: { message_id: 88, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: '그게 아니라 내일', reply_to_message: { message_id: 77 } } },
      { update_id: 4, callback_query: { id: 'other', from: { id: 42 }, message: { message_id: 77, chat: { id: 42 } }, data: 'other:action' } },
    ];
    const seen: string[] = [];
    const otherCallbacks: string[] = [];
    const acknowledgements: string[] = [];
    const allowedUpdates: string[] = [];
    let polls = 0;
    let bot: TelegramBot;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/answerCallbackQuery')) acknowledgements.push(String(init?.body));
      if (String(input).endsWith('/getUpdates')) {
        allowedUpdates.push(String(init?.body));
        if (++polls === 1) return Response.json({ ok: true, result: updates });
        bot.stop();
        return Response.json({ ok: true, result: [] });
      }
      return Response.json({ ok: true, result: { message_id: 99 } });
    }) as typeof fetch;
    bot = new TelegramBot({ token: '123:secret', allowedUsers: [42], fetchImpl, nowImpl: () => NOW.getTime(),
      perChatGapMs: 0, briefLedger: store, onMessage: async ctx => { seen.push(ctx.text); } });
    bot.onCallbackQuery(query => { otherCallbacks.push(query.data); });
    await bot.start();
    const db = new Database(store.path);
    try {
      expect(db.query('SELECT item_id, reaction FROM reactions ORDER BY id').all()).toEqual([
        { item_id: item.id, reaction: '버튼' }, { item_id: item.id, reaction: '정정' },
      ]);
      expect(store.weeklyActions()).toMatchObject({ acted: 1, total: 1 });
      expect(seen).toEqual(['그게 아니라 내일']);
      expect(otherCallbacks).toEqual(['other:action']);
      expect(acknowledgements).toHaveLength(2);
      expect(allowedUpdates[0]).toContain('callback_query');
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('one-item Telegram page records read and ignore without inflating the weekly action rate', () => {
  const { root, store } = fixture();
  try {
    const item = store.add({ text: '읽을 항목', domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    store.withSendLock('08:30', (page, mark) => { mark(page.ids, '08:30', { botId: 'bot', chatId: 42, messageId: 77 }); });
    const base = { botId: 'bot', chatId: 42, messageId: 77 };
    expect(recordBriefTelegramUpdate(store, { ...base, updateId: 'r', callbackData: `brief-item:${item.id}:read` })).toBe(true);
    expect(recordBriefTelegramUpdate(store, { ...base, updateId: 'i', callbackData: `brief-item:${item.id}:ignore` })).toBe(true);
    expect(store.weeklyActions()).toMatchObject({ acted: 0, total: 1 });
    expect(recordBriefTelegramUpdate(store, { ...base, updateId: 'a', text: '그게 아니라 수정' })).toBe(true);
    expect(store.weeklyActions()).toMatchObject({ acted: 1, total: 1 });
    const output: string[] = [];
    const program = new Command();
    registerBriefCommands(program, { ledger: store, output: line => output.push(line) });
    program.parse(['brief'], { from: 'user' });
    expect(output).toEqual(['이번 주 브리핑 중 대표가 움직인 것 1/1']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('one observed low-yield kind keeps its heading and item in the first slice', () => {
  const { root, store } = fixture();
  try {
    const old = store.add({ text: '시장 이전', domain: '시장', priority: 'P1', source: 'test' });
    store.markSent([old.id], '08:30');
    store.recordReaction(old.id, '무시');
    const item = store.add({ text: '시장 현재', domain: '시장', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    const page = store.composeWithIds('08:30');
    expect(page.ids).toEqual([item.id]);
    expect(page.markdown).toContain('## 시장\n');
    expect(page.markdown).not.toContain('## 그 밖의 동향');
    expect(page.markdown).toContain(item.text);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('feedback changes domain priority without changing id order inside the domain', () => {
  const { root, store } = fixture();
  try {
    const history = store.add({ text: '시장 발송', domain: '시장', priority: 'P1', source: 'test' });
    store.markSent([history.id], '08:30');
    store.recordReaction(history.id, '버튼');
    const first = store.add({ text: '시장 첫째', domain: '시장', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    const second = store.add({ text: '시장 둘째', domain: '시장', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    store.add({ text: '운영 항목', domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    const page = store.compose('08:30');
    expect(page.indexOf('## 시장')).toBeLessThan(page.indexOf('## 운영'));
    expect(page.indexOf(first.text)).toBeLessThan(page.indexOf(second.text));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('feedback moves acted kinds forward while retaining headings, items and decisions', () => {
  const { root, store } = fixture();
  try {
    const history = [
      store.add({ text: '운영 이전', domain: '운영', priority: 'P1', source: 'test' }),
      store.add({ text: '판 이전', domain: '판', priority: 'P1', source: 'test' }),
      store.add({ text: '시장 이전', domain: '시장', priority: 'P1', source: 'test' }),
    ];
    store.markSent(history.map(item => item.id), '08:30');
    store.recordReaction(history[0]!.id, '무시');
    store.recordReaction(history[1]!.id, '버튼');
    store.recordReaction(history[2]!.id, '열람');
    const first = store.add({ text: '운영 새 항목', domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    const next = store.add({ text: '판 새 항목', domain: '판', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    const last = store.add({ text: '시장 새 항목', domain: '시장', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    const decision = store.add({ text: '즉시 결정', domain: '운영', priority: 'P0', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    const before = store.list();
    const page = store.composeWithIds('08:30');
    expect(page.ids).toEqual([first.id, next.id, last.id, decision.id]);
    expect(page.markdown.indexOf('## 결정이 필요한 것')).toBeLessThan(page.markdown.indexOf('## 판'));
    expect(page.markdown.indexOf('## 판')).toBeLessThan(page.markdown.indexOf('## 운영'));
    expect(page.markdown).toContain('## 운영\n');
    expect(page.markdown).toContain('## 시장\n');
    expect(page.markdown).toContain('운영 새 항목');
    expect(page.markdown).toContain('시장 새 항목');
    expect(page.markdown).not.toContain('## 그 밖의 동향');
    expect(store.list()).toEqual(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an unmeasured page retains the default domain order and a read without action never moves a kind ahead', () => {
  const { root, store } = fixture();
  try {
    const oldOperation = store.add({ text: '운영 발송', domain: '운영', priority: 'P1', source: 'test' });
    const oldMarket = store.add({ text: '시장 발송', domain: '시장', priority: 'P1', source: 'test' });
    store.add({ text: '운영 새 항목', domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    store.add({ text: '시장 새 항목', domain: '시장', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    const unmeasured = store.compose('08:30');
    expect(unmeasured.indexOf('## 운영')).toBeLessThan(unmeasured.indexOf('## 시장'));
    expect(unmeasured).not.toContain('## 그 밖의 동향');
    store.markSent([oldOperation.id, oldMarket.id], '08:30');
    store.recordReaction(oldOperation.id, '무시');
    store.recordReaction(oldMarket.id, '열람');
    const readOnly = store.compose('08:30');
    expect(readOnly).toContain('## 운영\n');
    expect(readOnly).toContain('## 시장\n');
    expect(readOnly).not.toContain('## 그 밖의 동향');
    expect(store.weeklyActions().acted).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('sent kinds with no observed reaction are not called ignored or merged', () => {
  const { root, store } = fixture();
  try {
    const oldOperation = store.add({ text: '운영 발송', domain: '운영', priority: 'P1', source: 'test' });
    const oldMarket = store.add({ text: '시장 발송', domain: '시장', priority: 'P1', source: 'test' });
    store.markSent([oldOperation.id, oldMarket.id], '08:30');
    store.add({ text: '운영 새 항목', domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    store.add({ text: '시장 새 항목', domain: '시장', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    const page = store.compose('08:30');
    expect(store.weeklyActions()).toMatchObject({ acted: 0, total: 2 });
    expect(page).toContain('## 운영\n');
    expect(page).toContain('## 시장\n');
    expect(page).not.toContain('## 그 밖의 동향');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('measured high-action kinds lead regardless of fixed domain order; zero-sample kinds keep their own heading', () => {
  const { root, store } = fixture();
  try {
    const oldOperation = store.add({ text: '운영 옛 항목', domain: '운영', priority: 'P1', source: 'test' });
    const oldMarket = store.add({ text: '시장 옛 항목', domain: '시장', priority: 'P1', source: 'test' });
    store.markSent([oldOperation.id, oldMarket.id], '08:30');
    store.recordReaction(oldMarket.id, '답장');
    store.add({ text: '운영 새 항목', domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    store.add({ text: '시장 새 항목', domain: '시장', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    store.add({ text: '판 미측정', domain: '판', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    const page = store.compose('08:30');
    expect(page).toContain('## 시장\n');
    expect(page).toContain('## 운영\n');
    expect(page.indexOf('## 시장')).toBeLessThan(page.indexOf('## 운영'));
    expect(page).toContain('## 판\n');
    expect(page).not.toContain('## 그 밖의 동향');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ordering follows distinct per-kind action rate, not raw number of button and reply events', () => {
  const { root, store } = fixture();
  try {
    const operations = [
      store.add({ text: '운영 기록 1', domain: '운영', priority: 'P1', source: 'test' }),
      store.add({ text: '운영 기록 2', domain: '운영', priority: 'P1', source: 'test' }),
    ];
    const market = store.add({ text: '시장 기록', domain: '시장', priority: 'P1', source: 'test' });
    store.markSent([...operations.map(item => item.id), market.id], '08:30');
    store.recordReaction(operations[0]!.id, '버튼');
    store.recordReaction(operations[0]!.id, '답장');
    store.recordReaction(market.id, '정정');
    store.add({ text: '운영 새 항목', domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    store.add({ text: '시장 새 항목', domain: '시장', priority: 'P1', source: 'test', createdAt: '2026-10-04T23:00:00Z' });
    const page = store.compose('08:30');
    expect(store.weeklyActions().byKind.운영).toEqual({ acted: 1, total: 2, rate: 0.5 });
    expect(store.weeklyActions().byKind.시장).toEqual({ acted: 1, total: 1, rate: 1 });
    expect(page.indexOf('## 시장\n')).toBeLessThan(page.indexOf('## 운영\n'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('feedback ordering follows this KST week and reverts when the measured week expires', () => {
  const root = mkdtempSync(join(tmpdir(), 'brief-feedback-week-'));
  let current = new Date('2026-10-05T00:00:00Z');
  const store = new BriefItemsLedger({ stateDir: root, now: () => current, log: () => {} });
  try {
    const history = store.add({ text: '시장 지난주', domain: '시장', priority: 'P1', source: 'test' });
    store.markSent([history.id], '08:30');
    store.recordReaction(history.id, '정정');
    store.add({ text: '운영 다음주', domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-11T23:00:00Z' });
    store.add({ text: '시장 다음주', domain: '시장', priority: 'P1', source: 'test', createdAt: '2026-10-11T23:00:00Z' });
    current = new Date('2026-10-12T00:00:00Z');
    const page = store.compose('08:30');
    expect(store.weeklyActions()).toMatchObject({ acted: 0, total: 0 });
    expect(page).toContain('## 운영\n');
    expect(page).toContain('## 시장\n');
    expect(page.indexOf('## 운영')).toBeLessThan(page.indexOf('## 시장'));
    expect(page).not.toContain('## 그 밖의 동향');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('weekly actions use KST Monday boundary and exclude future sends and reactions outside this week', () => {
  const root = mkdtempSync(join(tmpdir(), 'brief-week-'));
  try {
    let current = new Date('2026-10-04T14:59:00Z'); // Sunday 23:59 KST
    const store = new BriefItemsLedger({ stateDir: root, now: () => current, log: () => {} });
    const old = store.add({ text: '지난주', domain: '운영', priority: 'P1', source: 'test' });
    store.markSent([old.id], '22:00');
    store.recordReaction(old.id, '버튼');
    current = new Date('2026-10-04T15:01:00Z'); // Monday 00:01 KST
    const fresh = store.add({ text: '이번주', domain: '시장', priority: 'P1', source: 'test' });
    store.markSent([fresh.id], '08:30');
    store.recordReaction(fresh.id, '답장');
    expect(store.weeklyActions()).toMatchObject({ acted: 1, total: 1, byKind: { 운영: { total: 0 }, 시장: { acted: 1, total: 1 } } });
    current = new Date('2026-10-04T14:59:30Z');
    expect(() => store.recordReaction(fresh.id, '버튼')).toThrow('item was not sent');
    expect(store.weeklyActions()).toMatchObject({ acted: 1, total: 1, byKind: { 운영: { acted: 1 }, 시장: { total: 0 } } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('five items: P0 leads, the same claim once, three domain heads, post-slot items drop', () => {
  const events: Array<{ event: string; data?: unknown }> = [];
  const { root, store } = fixture(events);
  try {
    store.add({ text: '흡수 대기', domain: '흡수', priority: 'P1', source: '흡수', createdAt: '2026-10-04T23:00:00Z' });
    store.add({ text: '판 컷 확인', domain: '판', priority: 'P1', source: '자리', createdAt: '2026-10-04T23:10:00Z' });
    store.add({ text: '시장 급변', domain: '시장', priority: 'P2', source: '루프', createdAt: '2026-10-04T23:20:00Z' });
    store.add({ text: '  흡수   대기 ', domain: '운영', priority: 'P2', source: '루프', createdAt: '2026-10-04T23:25:00Z' });
    store.add({
      text: '오늘 결정', domain: '행정', priority: 'P0', source: '코나투스',
      deadline: '2026-10-06', evidence: 'https://example.test/p0', createdAt: '2026-10-04T23:28:00Z',
    });
    store.add({ text: '슬롯 이후', domain: '운영', priority: 'P0', source: '루프', createdAt: '2026-10-04T23:30:00Z' });
    const before = store.list();
    const markdown = store.compose('08:30');
    const lines = markdown.trimEnd().split('\n');
    expect(lines[0]).toBe('# 브리핑 — 08:30');
    const decisionHead = lines.indexOf('## 결정이 필요한 것');
    expect(decisionHead).toBeGreaterThan(0);
    expect(lines[decisionHead + 2]).toStartWith('- [P0] 오늘 결정');
    expect(markdown.split('흡수 대기').length - 1).toBe(1);
    expect(normalizeClaim('  흡수   대기 ') === normalizeClaim('흡수 대기')).toBe(true);
    expect(lines.filter(line => line.startsWith('## ') && line !== '## 결정이 필요한 것')).toEqual(['## 판', '## 흡수', '## 시장']);
    expect(markdown).not.toContain('슬롯 이후');
    expect(markdown).toContain('근거: https://example.test/p0');
    expect(store.list()).toEqual(before);
    expect(events.at(-1)).toMatchObject({ event: 'composed', data: { slot: '08:30' } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('after-release keeps the morning and drops the evening; 22:00 keeps both and a deadline due today', () => {
  const { root, store } = fixture();
  try {
    store.add({ text: '아침 전', domain: '운영', priority: 'P1', source: '루프', createdAt: '2026-10-04T23:00:00Z' });
    store.add({ text: '낮', domain: '판', priority: 'P1', source: '자리', deadline: '2026-10-05', createdAt: '2026-10-04T23:40:00Z' });
    store.add({ text: '밤 이후', domain: '시장', priority: 'P2', source: '루프', createdAt: '2026-10-05T13:30:00Z' });
    const morning = store.compose('08:30');
    expect(morning).toContain('아침 전');
    expect(morning).not.toContain('낮');
    expect(morning).not.toContain('밤 이후');
    const after = store.compose('after-release');
    expect(after).toContain('아침 전');
    expect(after).toContain('낮');
    expect(after.indexOf('## 결정이 필요한 것')).toBeLessThan(after.indexOf('- [P1] 낮'));
    expect(after).not.toContain('밤 이후');
    expect(after).not.toContain('## 판');
    const night = store.compose('22:00');
    expect(night).toContain('아침 전');
    expect(night).toContain('낮');
    expect(night).not.toContain('밤 이후');
    expect(() => store.compose('not-a-slot')).toThrow('invalid slot');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('sent items and items from other days stay out; originals are not rewritten', () => {
  const sent: BriefItem = {
    id: 1, text: '이미 보냄', domain: '운영', priority: 'P0', deadline: null, evidence: null,
    source: '루프', created_at: '2026-10-04T23:00:00Z', sent_at: '2026-10-05T00:00:00Z',
  };
  const kept: BriefItem = {
    id: 2, text: '아직', domain: '흡수', priority: 'P2', deadline: '2026-10-05T15:00:00Z', evidence: null,
    source: '흡수', created_at: '2026-10-04T22:00:00Z', sent_at: null, // deadline instant is 2026-10-06 00:00 KST, not today
  };
  const due: BriefItem = { ...kept, id: 3, text: '오늘 마감', deadline: '2026-10-05' };
  const markdown = composeBriefMarkdown([sent, kept, due], '08:30', NOW);
  expect(markdown).not.toContain('이미 보냄');
  expect(markdown).toContain('- [P2] 아직');
  expect(markdown).toContain('## 흡수');
  expect(markdown.indexOf('## 결정이 필요한 것')).toBeLessThan(markdown.indexOf('오늘 마감'));
  expect(markdown.indexOf('오늘 마감')).toBeLessThan(markdown.indexOf('## 흡수'));
  expect(kept.text).toBe('아직');
});

test('pendingRealtime is pure and selects unsent P0 or KST-today deadlines, regardless of slot cutoff', () => {
  const base: BriefItem = { id: 1, text: 'P0', domain: '운영', priority: 'P0', deadline: null,
    evidence: null, source: '루프', created_at: '2026-10-05T00:00:00Z', sent_at: null };
  const items: BriefItem[] = [
    base,
    { ...base, id: 2, priority: 'P1', text: 'today ISO', deadline: '2026-10-04T15:30:00Z' },
    { ...base, id: 3, priority: 'P2', text: 'today date', deadline: '2026-10-05' },
    { ...base, id: 4, priority: 'P1', text: 'tomorrow KST', deadline: '2026-10-05T15:00:00Z' },
    { ...base, id: 5, priority: 'P1', text: 'no deadline' },
    { ...base, id: 6, text: 'sent P0', sent_at: NOW.toISOString() },
  ];
  expect(pendingRealtime(items, NOW).map(item => item.id)).toEqual([1, 2, 3]);
  expect(items[0]?.sent_at).toBeNull();
  expect(BRIEF_SLOTS).toEqual(['08:30', 'after-release', '22:00']);
});

test('DEMO1104-ABSORB-BRIEFING: issue-scoped items keep the existing Linear issue key and render a related-issue card', () => {
  const { root, store } = fixture();
  try {
    const item = store.add({
      text: '흡수한 변화가 기존 판단을 흔든다', domain: '흡수', priority: 'P0',
      source: 'intake-daily', evidence: 'https://example.com/brief', issueRef: 'ELN-1104',
      createdAt: '2026-10-04T23:00:00Z',
    });
    expect(item.issue_ref).toBe('ELN-1104');
    expect(store.compose('08:30')).toContain('관련 이슈: ELN-1104');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('DEMO1104-ABSORB-BRIEFING 2/2: the intake-daily action keeps an issue watch, briefs open issues, comments, and reopens a done issue on a material event', async () => {
  const { root, store } = fixture();
  const registrations: Array<{ id: string; issueRef?: string }> = [];
  const comments: Array<{ issueRef: string; body: string }> = [];
  const reopened: string[] = [];
  let collections = 0;
  const deps = {
    stateDir: root,
    ledger: store,
    registerSource: (source: { id: string; issueRef?: string }) => { registrations.push(source); },
    runSources: async () => { collections++; return { ran: [{ id: 'watch-ELN-1104', items: 5 }] }; },
    commentIssue: async (issueRef: string, body: string) => { comments.push({ issueRef, body }); },
    reopenIssue: async (issueRef: string) => { reopened.push(issueRef); },
  };
  try {
    await runIntakeIssueBriefing({ issueRef: 'ELN-1104', topic: 'agent harness', state: 'open',
      evidence: [{ title: '새 수집 결과', url: 'https://example.com/1', summary: '판단을 바꿀 변화' }] }, deps);
    expect(registrations).toMatchObject([{ id: 'watch-ELN-1104', issueRef: 'ELN-1104', spec: 'agent harness', every: '1d' }]);
    expect(collections).toBe(1);
    expect(store.list()).toMatchObject([{ issue_ref: 'ELN-1104', evidence: 'https://example.com/1' }]);
    expect(store.compose('22:00')).toContain('관련 이슈: ELN-1104');
    expect(comments).toEqual([{ issueRef: 'ELN-1104', body: expect.stringContaining('https://example.com/1') }]);

    await runIntakeIssueBriefing({ issueRef: 'ELN-1104', topic: 'agent harness', state: 'done',
      evidence: [{ title: '결정을 흔드는 사건', url: 'https://example.com/2', summary: '재검토가 필요하다', reopensIssue: true }] }, deps);
    expect(registrations).toHaveLength(2);
    expect(collections).toBe(2);
    expect(reopened).toEqual(['ELN-1104']);
    expect(store.list().filter(item => item.issue_ref === 'ELN-1104')).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('invalid item and slot inputs do not add rows', () => {
  const { root, store } = fixture();
  try {
    const input = { text: 'valid', domain: '운영' as const, priority: 'P0' as const, source: '루프' };
    expect(() => store.add({ ...input, text: '  ' })).toThrow(BriefItemsInputError);
    expect(() => store.add({ ...input, domain: 'ops' as '운영' })).toThrow('invalid domain');
    expect(() => store.add({ ...input, priority: 'high' as 'P0' })).toThrow('invalid priority');
    expect(() => store.add({ ...input, deadline: 'next week' })).toThrow('invalid deadline');
    expect(() => store.add({ ...input, evidence: '' })).toThrow('evidence is required');
    expect(() => store.compose('morning')).toThrow('invalid slot');
    expect(() => store.compose('realtime')).toThrow('invalid slot');
    expect(store.list()).toEqual([]);
    expect(store.list({ domain: '운영' })).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('brief items retain parent Linear issue UUID and reject display identifiers', () => {
  const { root, store } = fixture();
  try {
    const linearIssueId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const item = store.add({ text: 'demo evidence', domain: '흡수', priority: 'P1', source: 'intake.topic-search',
      evidence: 'https://example.test/evidence', linearIssueId });
    expect(item.linearIssueId).toBe(linearIssueId);
    expect(new BriefItemsLedger({ stateDir: root }).list()[0]?.linearIssueId).toBe(linearIssueId);
    expect(() => store.add({ text: 'bad id', domain: '흡수', priority: 'P1', source: 'test', linearIssueId: 'ENG-123' }))
      .toThrow('invalid Linear issue UUID');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('08:30 compose reaches requirement funnel and shows P0 oldest directive; other slots preserve their items', () => {
  const root = mkdtempSync(join(tmpdir(), 'brief-funnel-'));
  const directive: DirectiveRow = { ts: '2026-10-04T23:00:00Z',
    track: 'OP', text: '대표 요구', source_file: 'directive.jsonl', line_no: 1 };
  let calls = 0;
  const ledger = new BriefItemsLedger({ stateDir: root, now: () => NOW, log: () => {}, requirementFunnel: now => {
    calls++;
    return runRequirementFunnel({ now, cells: [], sources: { directives: [directive] }, placement: {
      schedules: [], released: '0.2.17', merged24h: 0, checklist: version => ({ version, released: '0.2.17', dev: version, items: [], history: [] }),
    } });
  } });
  try {
    const morning = ledger.compose('08:30');
    expect(morning).toContain('들어온 요구 1(문별 지시 1');
    expect(morning).toContain('대표 지시 중 아직 칸 없는 것 — 최근 24시간 1: 대표 요구');
    expect(morning).toContain('[P0]');
    expect(calls).toBe(1);
    expect(ledger.list()).toEqual([]);
    expect(ledger.compose('22:00')).not.toContain('대표 지시 중 아직 칸 없는 것');
    expect(calls).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('DEMO1104-ABSORB-BRIEFING: intake-daily 그래프 브리핑 단계가 requirement-funnel의 briefItems를 08:30 구성 경로로 전달한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'brief-intake-daily-'));
  const graph = readFileSync('graphs/intake/intake-daily.yaml', 'utf8');
  const funnelItem = { text: '일일 흡수 브리핑', domain: '흡수' as const, priority: 'P1' as const, source: 'intake-daily' };
  let receivedAt: Date | undefined;
  const brief = composeIntakeDailyBrief({
    stateDir: root,
    now: () => NOW,
    log: () => {},
    requirementFunnel: now => {
      receivedAt = now;
      return { ...emptyFunnel(), briefItems: [funnelItem] };
    },
  });
  try {
    expect(graph).toContain('node_id: briefing-0830');
    expect(graph).toContain('recipe: cmd:brief-compose-0830');
    expect(graph).toContain('entrypoint: src/briefing/brief-items.ts#composeIntakeDailyBrief');
    expect(graph).toContain('orchestration_id: orchestrationId()');
    expect(brief.orchestrationId).not.toBe('');
    expect(brief.markdown).toContain('[P1] 일일 흡수 브리핑');
    expect(receivedAt?.toISOString()).toBe('2026-10-04T23:29:59.999Z');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('08:30 compose still renders ledger items when the requirement funnel throws', () => {
  const root = mkdtempSync(join(tmpdir(), 'brief-funnel-fail-'));
  const events: string[] = [];
  const ledger = new BriefItemsLedger({ stateDir: root, now: () => NOW, log: (_c, event) => { events.push(event); },
    requirementFunnel: () => { throw new Error('directive index unreadable'); } });
  try {
    ledger.add({ text: '원장 항목', domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T20:00:00Z' });
    const morning = ledger.compose('08:30');
    expect(morning).toContain('원장 항목');
    expect(events).toContain('requirement-funnel-failed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe('ACP must-fix (harvest 10-06)', () => {
  test('a legacy items.sqlite (high/medium/low · no sent_at) is migrated and keeps its rows', async () => {
    const { mkdtempSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Database } = await import('bun:sqlite');
    const { BriefItemsLedger } = await import('./brief-items.js');
    const stateDir = mkdtempSync(join(tmpdir(), 'brief-legacy-'));
    mkdirSync(join(stateDir, 'briefing'), { recursive: true });
    const legacy = new Database(join(stateDir, 'briefing', 'items.sqlite'), { create: true });
    legacy.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, domain TEXT NOT NULL,
      priority TEXT NOT NULL CHECK(priority IN ('high', 'medium', 'low')), deadline TEXT, evidence TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL)`);
    legacy.query("INSERT INTO items (text, domain, priority, source, created_at) VALUES ('old claim', '운영', 'high', 'seat', '2026-10-05T00:00:00Z')").run();
    legacy.query("INSERT INTO items (text, domain, priority, source, created_at) VALUES ('fin claim', 'finance', 'low', 'conatus', '2026-10-05T00:01:00Z')").run();
    legacy.close();
    const ledger = new BriefItemsLedger({ stateDir, log: () => {} });
    expect(ledger.list().map((i) => [i.text, i.priority, i.source, i.sent_at])).toEqual([
      ['old claim', 'P0', 'seat', null], ['fin claim', 'P2', 'conatus · 옛 도메인 finance', null]]);
    expect(ledger.add({ text: 'new claim', domain: '판', priority: 'P1', source: 'seat', createdAt: '2026-10-05T01:00:00Z' }).priority).toBe('P1');
  });

  test('a duplicate claim keeps its most urgent copy; multi-line text is refused; mark-sent drops items from the next compose', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { BriefItemsLedger, BriefItemsInputError } = await import('./brief-items.js');
    const now = new Date('2026-10-05T23:40:00Z'); // 08:40 KST
    const ledger = new BriefItemsLedger({ stateDir: mkdtempSync(join(tmpdir(), 'brief-mf-')), now: () => now, log: () => {} });
    ledger.add({ text: 'Same claim', domain: '운영', priority: 'P2', source: 'a', createdAt: '2026-10-05T22:00:00Z' });
    ledger.add({ text: 'same  claim', domain: '운영', priority: 'P0', source: 'b', createdAt: '2026-10-05T22:10:00Z' });
    expect(() => ledger.add({ text: 'two\nlines', domain: '운영', priority: 'P1', source: 'c' })).toThrow(BriefItemsInputError);
    expect(() => ledger.add({ text: 'ok', domain: '운영', priority: 'P1', source: 'c\n## forged' })).toThrow(BriefItemsInputError);
    expect(() => ledger.add({ text: 'ok', domain: '운영', priority: 'P1', source: 'c', evidence: 'https://x\n- [P0] forged' })).toThrow(BriefItemsInputError);
    const first = ledger.compose('08:30');
    expect(first).toContain('## 결정이 필요한 것');
    expect(first).toContain('[P0] same  claim');
    expect(first).not.toContain('[P2] Same claim');
    expect(ledger.compose('08:30')).toContain('claim'); // compose is read-only
    ledger.markSent(ledger.list().map((i) => i.id), '08:30'); // a sender records what it sent
    expect(ledger.compose('08:30')).not.toContain('claim');
    // A due-today P2 copy beats an undated P1 copy of the same claim.
    ledger.add({ text: 'Due claim', domain: '판', priority: 'P1', source: 'a', createdAt: '2026-10-05T22:20:00Z' });
    ledger.add({ text: 'due claim', domain: '판', priority: 'P2', source: 'b', deadline: '2026-10-06', createdAt: '2026-10-05T22:30:00Z' });
    const due = ledger.compose('08:30');
    expect(due).toContain('[P2] due claim');
    expect(due).not.toContain('[P1] Due claim');
  });
});
