// DEC-TG — 리허설 판정선을 시험으로: 결정 3건(A/B · 예/아니오 · 되돌릴 수 없음) → 텔레그램 하나·디스코드 하나·/decisions 로 하나
// → 원장 3건 decided ⊕ 올린 자리 회신 3 ⊕ 다른 계정 버튼 거부 1.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { DecisionLedger, type DecisionEntry, type RaiseInput } from './decision-ledger.js';
import { DecisionCardService, parseTap, raiserReplyText, renderCard, type CardPlatform, type CardRef, type CardTransport, type CardView } from './decision-cards.js';
import { handleDiscordDecisionInteraction, discordComponents, discordDecisionsCommand } from './discord-decision-cards.js';
import { defaultTelegramCommands } from '../telegram-commands.js';
import { attachTelegramDecisionCards } from './telegram-decision-cards.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const VERSION = { released: '0.2.8', dev: '0.2.9-dev.0' };
// 시험 시계 하나 — 원장과 카드 서비스가 «같은» 시계를 써야 한다. 서비스가 실제 시계를 쓰면 이 날짜(10-02 12:00 KST)가
// 지난 순간부터 «기준선 뒤에 올라온 결정»이 아니게 되어 카드가 안 나간다(2026-10-02 12:2x main 실측 · 시한폭탄).
const TEST_NOW = () => new Date('2026-10-02T03:00:00Z');
function ledgerAt(now = TEST_NOW): DecisionLedger {
  const dir = mkdtempSync(join(tmpdir(), 'dec-tg-')); dirs.push(dir);
  return new DecisionLedger({ stateDir: dir, now, resolveVersion: () => VERSION as never });
}
const base = (over: Partial<RaiseInput> = {}): RaiseInput => ({
  title: '사이트 히어로 문구 A/B', category: 'scope',
  scqa: { s: '행사 전 사이트 문구를 정해야 한다.', c: '두 안이 있다.' },
  options: [{ key: 'a', label: '스스로 안', consequence: '오늘 반영' }, { key: 'b', label: '팩트 안', consequence: '내일 반영' }],
  recommendation: { option: 'a', why: '대표 지시와 맞다' }, raisedBy: { agent: 'OP', track: 'O' }, ...over,
});

class FakeTransport implements CardTransport {
  sent: Array<{ chat: string; view: CardView }> = [];
  edits: Array<{ ref: CardRef; view: CardView }> = [];
  notes: string[] = [];
  constructor(readonly platform: 'telegram' | 'discord') {}
  async ownerChats() { return ['chat-1']; }
  async send(chat: string, view: CardView) { this.sent.push({ chat, view }); return { chat, message: String(this.sent.length) }; }
  async edit(ref: CardRef, view: CardView) { this.edits.push({ ref, view }); }
  async notify(_chat: string, text: string) { this.notes.push(text); }
}

describe('DEC-TG decision cards', () => {
  test('rehearsal: three decisions — Telegram tap, Discord tap, /decisions re-send — all decided, three replies, one refusal', async () => {
    const ledger = ledgerAt();
    const old = ledger.raise(base({ title: '배포 전부터 열려 있던 결정' }));
    const ab = ledger.raise(base());
    const yn = ledger.raise(base({ title: '행사 폰 공유 캡처 켜기', options: [{ key: 'y', label: '예', consequence: '켠다' }, { key: 'n', label: '아니오', consequence: '끈다' }], recommendation: { option: 'y', why: '시연' } }));
    const irrev = ledger.raise(base({ title: '광고비 집행 30만원', category: 'money', options: [{ key: 'a', label: '집행', consequence: '돈이 나간다' }, { key: 'b', label: '보류', consequence: '다음 주' }], recommendation: { option: 'b', why: '데이터 먼저' } }));
    const replies: string[] = [];
    const replyToRaiser = async (e: DecisionEntry, via: CardPlatform) => { replies.push(raiserReplyText(e, via)); };
    const tg = new FakeTransport('telegram');
    const dc = new FakeTransport('discord');
    // The baseline is the first start; decisions raised at or after it are pushed, older ones only via /decisions.
    const tgService = new DecisionCardService({ transport: tg, ownerIds: ['111'], ledger, replyToRaiser, now: () => new Date('2026-10-02T03:00:00Z') });
    const dcService = new DecisionCardService({ transport: dc, ownerIds: ['999'], ledger, replyToRaiser, now: () => new Date('2026-10-02T03:00:00Z') });
    void old;

    expect(await tgService.tick()).toEqual({ sent: 4, closed: 0, reminded: 0 });
    expect(await tgService.tick()).toEqual({ sent: 0, closed: 0, reminded: 0 }); // no duplicates
    await dcService.tick();
    const irrevCard = tg.sent.find((s) => s.view.text.includes(irrev.id))!;
    expect(irrevCard.view.text).toContain('되돌릴 수 없음');

    // ① someone else taps → refused, nothing recorded
    expect((await tgService.tap('222', `dec:${ab.id}:a`)).kind).toBe('refused');
    expect(ledger.show(ab.id).status).toBe('open');
    // ② Telegram: A/B decided by the owner
    expect((await tgService.tap('111', `dec:${ab.id}:a`)).kind).toBe('decided');
    // ③ Discord: yes/no decided
    expect((await dcService.tap('999', `dec:${yn.id}:y`)).kind).toBe('decided');
    // ④ /decisions re-sends what is still open (the irreversible one) → confirm twice
    const listed = await tgService.listOpen('chat-1');
    expect(listed).toContain(irrev.id);
    expect(listed).not.toContain(ab.id);
    expect(listed).toContain(old.id);
    expect((await tgService.tap('111', `dec:${irrev.id}:b`)).kind).toBe('confirm');
    expect(ledger.show(irrev.id).status).toBe('open');
    expect((await tgService.tap('111', `dec:${irrev.id}:b:ok`)).kind).toBe('decided');

    const decided = ledger.list({ status: 'decided' });
    expect(decided.map((e) => [e.id, e.choice, e.decidedBy?.kind]).sort()).toEqual([[ab.id, 'a', 'human'], [irrev.id, 'b', 'human'], [yn.id, 'y', 'human']].sort());
    expect(replies).toHaveLength(3);
    expect(replies[0]).toMatch(new RegExp(`^\\*\\*\\[대표\\]\\*\\* .+ KST → OP · 결정 ${ab.id} «사이트 히어로 문구 A/B» = A\\) 스스로 안 \\(텔레그램\\)$`));
    expect(replies[1]).toContain('(디스코드)');

    // Discord's card for the Telegram-decided one closes on its next tick.
    const before = dc.edits.length;
    await dcService.tick();
    expect(dc.edits.length).toBeGreaterThan(before);
    expect(dc.edits.at(-1)!.view.text).toContain('✅ 결정됨');
    expect(dc.edits.at(-1)!.view.buttons).toEqual([]);
  });

  test('memo rides along with the decision; deadline reminder fires once two hours before', async () => {
    let now = new Date('2026-10-02T03:00:00Z');
    const ledger = ledgerAt(() => now);
    const e = ledger.raise(base({ dueAt: '2026-10-02T08:00:00Z' }));
    const tg = new FakeTransport('telegram');
    const service = new DecisionCardService({ transport: tg, ownerIds: ['111'], ledger, now: () => now });
    await service.tick();
    expect(tg.sent[0]!.view.text).toContain('기한');
    expect((await service.tap('111', `dec:${e.id}:memo`)).kind).toBe('memo-requested');
    expect(await service.setNote('222', e.id, '남의 메모')).toBeNull();
    expect((await service.setNote('111', e.id, '문구는 MK 와 한 번 더'))!.text).toContain('📝 메모: 문구는 MK 와 한 번 더');
    now = new Date('2026-10-02T06:10:00Z');
    expect((await service.tick()).reminded).toBe(1);
    expect((await service.tick()).reminded).toBe(0);
    expect(tg.notes[0]).toContain('기한 2시간 전');
    await service.tap('111', `dec:${e.id}:b`);
    expect(ledger.show(e.id).note).toBe('문구는 MK 와 한 번 더');
  });

  test('decided elsewhere (CLI) → card closes; a late tap says «already decided»; cancel restores the card', async () => {
    const ledger = ledgerAt();
    const e = ledger.raise(base({ category: 'publish' }));
    const tg = new FakeTransport('telegram');
    const service = new DecisionCardService({ transport: tg, ownerIds: ['111'], ledger, now: TEST_NOW });
    await service.tick();
    const confirm = await service.tap('111', `dec:${e.id}:a`);
    expect(confirm.kind).toBe('confirm');
    expect((await service.tap('111', `dec:${e.id}:-`)).kind).toBe('cancelled');
    ledger.decide(e.id, 'b', { kind: 'human' });
    expect((await service.tick()).closed).toBe(1);
    expect((await service.tap('111', `dec:${e.id}:a:ok`)).kind).toBe('closed');
    expect(ledger.show(e.id).choice).toBe('b');
  });

  test('decisions raised before the first start are not pushed (no burst at deploy) but /decisions still shows them', async () => {
    const ledger = ledgerAt(() => new Date('2026-09-30T03:00:00Z'));
    const earlier = ledger.raise(base({ title: '이틀 전 결정' }));
    const tg = new FakeTransport('telegram');
    const service = new DecisionCardService({ transport: tg, ownerIds: ['111'], ledger, now: () => new Date('2026-10-02T03:00:00Z') });
    expect((await service.tick()).sent).toBe(0);
    expect(await service.listOpen('chat-1')).toContain(earlier.id);
    expect(tg.sent).toHaveLength(1);
  });

  test('TC must-fix: /decisions answers only in the owner\'s private chat; memo capture only in a private chat', async () => {
    const ledger = ledgerAt();
    const e = ledger.raise(base());
    const transport = new FakeTransport('telegram');
    const service = new DecisionCardService({ transport, ownerIds: ['111'], ledger, now: TEST_NOW });
    let handler: ((q: { id: string; userId: number; chatId?: number; messageId?: number; data: string }) => Promise<void>) | null = null;
    const acks: string[] = []; let captures = 0;
    const bot = {
      onCallbackQuery: (h: typeof handler) => { handler = h; return () => undefined; },
      answerCallbackQuery: async (_id: string, o: { text?: string }) => { acks.push(o.text ?? ''); },
      sendMessage: async () => null, sendInlineKeyboard: async () => ({ messageId: 7 }), editMessageWithKeyboard: async () => undefined,
      captureNextText: () => { captures++; return () => undefined; }, isPolling: () => false,
    } as never;
    const stop = attachTelegramDecisionCards(bot, { telegram: { allowedUsers: [111, 222] }, raw: {} } as never, { service });
    try {
      const command = defaultTelegramCommands().find((c) => c.name === 'decisions')!;
      // group chat (negative id) → no cards
      expect(await command.handler([], { chatId: -1001, userId: 111 } as never, {} as never)).toBe('결정은 개인 대화에서만 볼 수 있습니다.');
      expect(transport.sent).toHaveLength(0);
      // another allow-listed member in a DM → refused
      expect(await command.handler([], { chatId: 222, userId: 222 } as never, {} as never)).toBe('결정은 소유자만 볼 수 있습니다.');
      // the owner's private chat → the card
      expect(await command.handler([], { chatId: 111, userId: 111 } as never, {} as never)).toContain(e.id);
      expect(transport.sent).toHaveLength(1);
      // «메모 달기» tapped from a group → no capture (a second member's line could become 대표's memo)
      await handler!({ id: 'q', userId: 111, chatId: -1001, messageId: 7, data: `dec:${e.id}:memo` });
      expect(acks.at(-1)).toBe('메모는 개인 대화에서만 달 수 있습니다');
      expect(captures).toBe(0);
      await handler!({ id: 'q', userId: 111, chatId: 111, messageId: 7, data: `dec:${e.id}:memo` });
      expect(captures).toBe(1);
    } finally { stop(); }
    // Discord: a guild channel sends nothing; the DM does
    const dc = new FakeTransport('discord');
    const dcService = new DecisionCardService({ transport: dc, ownerIds: ['999'], ledger, now: TEST_NOW });
    expect(await discordDecisionsCommand(dcService, { userId: '999', channelId: 'guild-ch', isDm: false })).toBe('결정은 개인 대화(DM)에서만 볼 수 있습니다.');
    expect(dc.sent).toHaveLength(0);
    expect(await discordDecisionsCommand(dcService, { userId: '999', channelId: 'dm', isDm: true })).toContain(e.id);
    expect(dc.sent).toHaveLength(1);
  });

  test('callback data fits Telegram (64 bytes) and Discord (100); parse rejects anything else', () => {
    const ledger = ledgerAt();
    const e = ledger.raise(base({ category: 'money' }));
    for (const view of [renderCard(e), renderCard(e, { confirm: 'a' })]) {
      for (const b of view.buttons.flat()) expect(Buffer.byteLength(b.data)).toBeLessThanOrEqual(64);
    }
    expect(parseTap(`dec:${e.id}:a:ok`)).toEqual({ id: e.id, action: 'choose', key: 'a', confirmed: true });
    expect(parseTap('dec:../../x:a')).toBeNull();
    expect(parseTap('elanous-q:1')).toBeNull();
    expect(discordComponents(renderCard(e))[0]!.components).toHaveLength(2);
  });

  test('Discord: button → UPDATE_MESSAGE · memo → modal · modal submit → note · stranger → ephemeral refusal', async () => {
    const ledger = ledgerAt();
    const e = ledger.raise(base());
    const responses: Array<Record<string, unknown>> = [];
    const bot = {
      respondToInteraction: async (_id: string, _token: string, body: Record<string, unknown>) => { responses.push(body); },
      openDmChannel: async () => 'dm', sendMessageWithComponents: async () => ({ id: '1' }), editMessageWithComponents: async () => undefined, sendMessage: async () => null,
    } as never;
    const service = new DecisionCardService({ transport: new FakeTransport('discord'), ownerIds: ['999'], ledger, now: TEST_NOW });
    const button = (user: string, custom: string) => ({ id: 'i', token: 't', type: 3, user: { id: user }, data: { custom_id: custom } });
    expect(await handleDiscordDecisionInteraction(bot, service, { type: 3, data: { custom_id: 'elanous-q:x' } })).toBe(false);
    await handleDiscordDecisionInteraction(bot, service, button('123', `dec:${e.id}:a`));
    expect(responses.at(-1)).toEqual({ type: 4, data: { content: '권한이 없습니다.', flags: 64 } });
    await handleDiscordDecisionInteraction(bot, service, button('999', `dec:${e.id}:memo`));
    expect(responses.at(-1)!.type).toBe(9);
    await handleDiscordDecisionInteraction(bot, service, { id: 'i', token: 't', type: 5, user: { id: '999' }, data: { custom_id: `decmemo:${e.id}`, components: [{ components: [{ value: '디스코드 메모' }] }] } });
    await handleDiscordDecisionInteraction(bot, service, button('999', `dec:${e.id}:b`));
    expect(responses.at(-1)!.type).toBe(7);
    expect(ledger.show(e.id)).toMatchObject({ status: 'decided', choice: 'b', note: '디스코드 메모' });
  });

  test('Telegram attach: only the owner reaches the service; memo uses next-message capture; ticks only while polling', async () => {
    const ledger = ledgerAt();
    const e = ledger.raise(base());
    let handler: ((q: { id: string; userId: number; chatId?: number; messageId?: number; data: string }) => Promise<void>) | null = null;
    const acks: string[] = []; const sent: string[] = []; let captured: ((t: string | null) => void) | null = null; let polling = false;
    const bot = {
      onCallbackQuery: (h: typeof handler) => { handler = h; return () => undefined; },
      answerCallbackQuery: async (_id: string, o: { text?: string }) => { acks.push(o.text ?? ''); },
      sendMessage: async (_c: number, t: string) => { sent.push(t); return null; },
      sendInlineKeyboard: async () => ({ messageId: 7 }), editMessageWithKeyboard: async () => undefined,
      captureNextText: (_c: number, _t: undefined, r: (t: string | null) => void) => { captured = r; return () => undefined; },
      isPolling: () => polling,
    } as never;
    const cfg = { telegram: { allowedUsers: [111] }, raw: {} } as never;
    const service = new DecisionCardService({ transport: new FakeTransport('telegram'), ownerIds: ['111'], ledger, now: TEST_NOW });
    const tickSpy = spyOn(service, 'tick');
    const stop = attachTelegramDecisionCards(bot, cfg, { service, tickMs: 5 });
    await Bun.sleep(25);
    expect(tickSpy).not.toHaveBeenCalled();
    polling = true;
    await Bun.sleep(25);
    expect(tickSpy).toHaveBeenCalled();
    await handler!({ id: 'q1', userId: 222, chatId: 1, messageId: 7, data: `dec:${e.id}:a` });
    expect(acks.at(-1)).toBe('권한이 없습니다');
    await handler!({ id: 'q2', userId: 111, chatId: 111, messageId: 7, data: `dec:${e.id}:memo` });
    captured!('텔레그램 메모');
    await Bun.sleep(5);
    await handler!({ id: 'q3', userId: 111, chatId: 111, messageId: 7, data: `dec:${e.id}:a` });
    expect(ledger.show(e.id)).toMatchObject({ status: 'decided', choice: 'a', note: '텔레그램 메모' });
    stop();
  });

  test('observation lands in decisions.telegram and never carries option text or notes', async () => {
    const lines: string[] = [];
    const spy = spyOn(debug, 'log').mockImplementation(((...a: unknown[]) => { lines.push(JSON.stringify(a)); }) as typeof debug.log);
    try {
      const ledger = ledgerAt();
      const e = ledger.raise(base());
      const service = new DecisionCardService({ transport: new FakeTransport('telegram'), ownerIds: ['111'], ledger, now: TEST_NOW });
      await service.tick();
      await service.setNote('111', e.id, '비밀스러운 메모');
      await service.tap('222', `dec:${e.id}:a`);
      await service.tap('111', `dec:${e.id}:a`);
    } finally { spy.mockRestore(); }
    const ours = lines.filter((l) => l.includes('decisions.telegram'));
    expect(ours.map((l) => JSON.parse(l)[1])).toEqual(expect.arrayContaining(['card-sent', 'memo-set', 'tap-refused', 'decided']));
    expect(ours.join('\n')).not.toContain('비밀스러운');
    expect(ours.join('\n')).not.toContain('스스로 안');
  });
});

describe('HITL1 H3 card bridge — pending questions become decision cards', () => {
  const pending = (over: { impact?: 'low' | 'medium' | 'high' | 'critical'; options?: number; recommendedIndex?: number; expiresAt?: string; id?: string } = {}) => () => ({
    ok: true as const,
    questions: [{
      id: over.id ?? 'auq:h3:abcde', runId: 'run-x', startedAt: '2026-10-02T02:55:00.000Z', surface: 'file' as const, delivery: 'file' as const,
      ...(over.expiresAt ? { expiresAt: over.expiresAt } : {}),
      questions: [{
        id: 'scope', question: 'Widen the release scope?\n\nRecommended: Keep.',
        options: Array.from({ length: over.options ?? 3 }, (_, i) => ({ label: `opt${i}`, description: `d${i}` })),
        ...(over.impact ? { impact: over.impact } : {}),
        ...(over.recommendedIndex !== undefined ? { recommendedIndex: over.recommendedIndex } : {}),
      }],
    }],
  });

  test('high impact · 3 options · recommended b → one decision with resume, one card; a second tick dedups', async () => {
    const ledger = ledgerAt();
    const tg = new FakeTransport('telegram');
    const service = new DecisionCardService({ transport: tg, ownerIds: ['111'], ledger, now: TEST_NOW, pendingQuestions: pending({ impact: 'high', recommendedIndex: 1 }) as never });
    await service.tick();
    const open = ledger.list({ status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ category: 'scope', raisedBy: { agent: 'harness' }, resume: { questionId: 'auq:h3:abcde', runId: 'run-x' },
      recommendation: { option: 'b' } });
    expect(open[0]!.options.map((o) => o.key)).toEqual(['a', 'b', 'c']);
    expect(tg.sent).toHaveLength(1);
    await service.tick();
    expect(ledger.list({ status: 'all' })).toHaveLength(1);
    expect(tg.sent).toHaveLength(1);
  });

  test('critical becomes an irreversible decision; low, missing impact, 5 options and expired questions raise nothing', async () => {
    const critical = ledgerAt();
    await new DecisionCardService({ transport: new FakeTransport('telegram'), ownerIds: ['111'], ledger: critical, now: TEST_NOW, pendingQuestions: pending({ impact: 'critical' }) as never }).tick();
    expect(critical.list({ status: 'open' })[0]).toMatchObject({ category: 'irreversible', recommendation: { skipped: true } });
    for (const over of [{ impact: 'low' as const }, {}, { impact: 'high' as const, options: 5 }, { impact: 'high' as const, expiresAt: '2026-10-02T02:59:00.000Z' }]) {
      const ledger = ledgerAt();
      await new DecisionCardService({ transport: new FakeTransport('telegram'), ownerIds: ['111'], ledger, now: TEST_NOW, pendingQuestions: pending(over) as never }).tick();
      expect(ledger.list({ status: 'all' })).toHaveLength(0);
    }
  });

  test('a question already tied to a decided card is not raised again', async () => {
    const ledger = ledgerAt();
    const raised = ledger.raise(base({ resume: { questionId: 'auq:h3:abcde' } }));
    ledger.decide(raised.id, 'a', { kind: 'human' });
    await new DecisionCardService({ transport: new FakeTransport('telegram'), ownerIds: ['111'], ledger, now: TEST_NOW, pendingQuestions: pending({ impact: 'high' }) as never }).tick();
    expect(ledger.list({ status: 'all' })).toHaveLength(1);
  });
});
