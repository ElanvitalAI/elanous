import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import type { PushPayload, SendPushResult } from '../web-push/sender.js';
import type { PushSubscriptionRecord } from '../web-push/subscriptions.js';
import { DecisionCardService, renderCard } from './decision-cards.js';
import { DecisionLedger, type RaiseInput } from './decision-ledger.js';
import { WEB_PUSH_URGENT_WINDOW_MS, webPushDecisionTransport, webPushUrgency } from './web-push-decision-cards.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const start = new Date('2026-10-02T03:00:00Z');
const input = (overrides: Partial<RaiseInput> = {}): RaiseInput => ({
  title: '사이트 히어로 문구', category: 'scope', scqa: { s: '상황', c: '문제' },
  options: [{ key: 'a', label: '옵션 비공개 A', consequence: '결과 A' }, { key: 'b', label: '옵션 비공개 B', consequence: '결과 B' }],
  recommendation: { option: 'a', why: '권고 이유' }, raisedBy: { agent: 'OP' }, ...overrides,
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'webpush-dec-')); dirs.push(dir);
  let now = start;
  let subscribers = 1;
  let delivered: number | undefined;
  const payloads: PushPayload[] = [];
  const ledger = new DecisionLedger({ stateDir: dir, now: () => now, resolveVersion: () => ({ released: '0.2.8', dev: '0.2.9-dev.0' }) as never });
  const transport = webPushDecisionTransport(ledger, {
    subscriptions: () => Array.from({ length: subscribers }, (_, i) => ({ id: String(i) }) as PushSubscriptionRecord),
    push: async (payload): Promise<SendPushResult> => {
      payloads.push(payload);
      return { attempted: subscribers, delivered: delivered ?? subscribers, removed: 0, errors: [] };
    },
  });
  const service = new DecisionCardService({ transport, ownerIds: [], ledger, now: () => now });
  return { ledger, transport, service, payloads, dir, setNow: (date: Date) => { now = date; }, setSubscribers: (count: number) => { subscribers = count; }, setDelivered: (count: number) => { delivered = count; } };
}

describe('AN1a web push decision cards', () => {
  test('webPushUrgency distinguishes no deadline, unreadable deadline, near deadline and irreversible category', () => {
    const f = fixture();
    const entry = f.ledger.raise(input());
    expect(webPushUrgency(entry, start)).toBe('not-urgent');
    expect(webPushUrgency({ ...entry, dueAt: 'not-a-date' }, start)).toBe('due-unreadable');
    expect(webPushUrgency({ ...entry, dueAt: '' }, start)).toBe('due-unreadable');
    expect(webPushUrgency({ ...entry, dueAt: new Date(start.getTime() + 3600_000).toISOString() }, start)).toBe('due-soon');
    expect(webPushUrgency({ ...entry, category: 'secret' }, start)).toBe('irreversible');
    expect(webPushUrgency({ ...entry, dueAt: start.toISOString() }, start)).toBe('due-soon');
    expect(WEB_PUSH_URGENT_WINDOW_MS).toBe(24 * 3600_000);
    expect(webPushUrgency({ ...entry, dueAt: new Date(start.getTime() + WEB_PUSH_URGENT_WINDOW_MS).toISOString() }, start)).toBe('due-soon');
    expect(webPushUrgency({ ...entry, dueAt: new Date(start.getTime() + WEB_PUSH_URGENT_WINDOW_MS + 1).toISOString() }, start)).toBe('not-urgent');
  });

  test('urgency-filtered push sends only irreversible and due-soon decisions', async () => {
    const f = fixture();
    let current = start;
    const service = new DecisionCardService({ transport: f.transport, ownerIds: [], ledger: f.ledger, now: () => current,
      sendFilter: (entry, now) => webPushUrgency(entry, now) !== 'not-urgent' });
    await service.tick();
    current = new Date(start.getTime() + 1000);
    const ordinary = f.ledger.raise(input({ title: '게시판 결정' }));
    const money = f.ledger.raise(input({ title: '지출 결정', category: 'money' }));
    const near = f.ledger.raise(input({ title: '임박한 결정', dueAt: new Date(current.getTime() + 3 * 3600_000).toISOString() }));
    expect((await service.tick()).sent).toBe(2);
    expect(f.payloads.map(payload => payload.tag).sort()).toEqual([`decision-${money.id}`, `decision-${near.id}`].sort());
    expect(f.payloads.some(payload => payload.tag === `decision-${ordinary.id}`)).toBe(false);
    const state = JSON.parse(readFileSync(join(f.dir, 'decisions', 'cards-webpush.json'), 'utf8')) as { cards: Record<string, unknown> };
    expect(state.cards[ordinary.id]).toBeUndefined();
  });

  test('deferred deadline is rechecked each tick and observed only once across restarts', async () => {
    const f = fixture();
    let current = start;
    const options = { transport: f.transport, ownerIds: [], ledger: f.ledger, now: () => current,
      sendFilter: (entry: ReturnType<DecisionLedger['raise']>, now: Date) => webPushUrgency(entry, now) !== 'not-urgent', deferredReason: webPushUrgency };
    const service = new DecisionCardService(options);
    const logs: unknown[][] = [];
    const spy = spyOn(debug, 'log').mockImplementation(((...args: unknown[]) => { logs.push(args); }) as typeof debug.log);
    try {
      await service.tick();
      current = new Date(start.getTime() + 1000);
      const e = f.ledger.raise(input({ dueAt: new Date(current.getTime() + 30 * 3600_000).toISOString() }));
      expect((await service.tick()).sent).toBe(0);
      expect(f.payloads).toHaveLength(0);
      const state = JSON.parse(readFileSync(join(f.dir, 'decisions', 'cards-webpush.json'), 'utf8')) as { cards: Record<string, unknown> };
      expect(state.cards[e.id]).toBeUndefined();
      await service.tick();
      await new DecisionCardService(options).tick();
      current = new Date(current.getTime() + 7 * 3600_000);
      expect((await new DecisionCardService(options).tick()).sent).toBe(1);
      expect(f.payloads.map(payload => payload.tag)).toEqual([`decision-${e.id}`]);
      expect(logs.filter(args => args[0] === 'decisions.webpush' && args[1] === 'push-deferred' && (args[2] as { id?: string }).id === e.id)).toEqual([
        ['decisions.webpush', 'push-deferred', { id: e.id, urgency: 'not-urgent' }],
      ]);
    } finally { spy.mockRestore(); }
  });

  test('unreadable due date fails open without crashing the push payload', async () => {
    const f = fixture();
    let current = start;
    const service = new DecisionCardService({ transport: f.transport, ownerIds: [], ledger: f.ledger, now: () => current,
      sendFilter: (entry, now) => webPushUrgency(entry, now) !== 'not-urgent' });
    await service.tick();
    current = new Date(start.getTime() + 1000);
    const e = f.ledger.raise(input());
    const list = f.ledger.list.bind(f.ledger);
    const listSpy = spyOn(f.ledger, 'list').mockImplementation((filters) => list(filters).map(entry => entry.id === e.id ? { ...entry, dueAt: 'not-a-date' } : entry));
    try {
      expect((await service.tick()).sent).toBe(1);
      expect(f.payloads).toMatchObject([{ tag: `decision-${e.id}`, body: '추천안: A · 기한: 읽을 수 없음' }]);
    } finally { listSpy.mockRestore(); }
  });

  test('no subscriptions: no send, then a newly subscribed device receives a later decision', async () => {
    const f = fixture();
    f.setSubscribers(0);
    expect(await f.transport.ownerChats()).toEqual([]);
    await f.service.tick();
    f.setNow(new Date(start.getTime() + 1000));
    f.ledger.raise(input());
    expect((await f.service.tick()).sent).toBe(0);
    expect(f.payloads).toHaveLength(0);
    f.setSubscribers(1);
    expect(await f.transport.ownerChats()).toEqual(['webpush']);
    expect((await f.service.tick()).sent).toBe(1);
    expect(f.payloads).toHaveLength(1);
  });

  test('zero subscribers: no push and one no-subscribers observation per card across ticks and service restarts', async () => {
    const f = fixture();
    f.setSubscribers(0);
    const logs: unknown[][] = [];
    const spy = spyOn(debug, 'log').mockImplementation(((...args: unknown[]) => { logs.push(args); }) as typeof debug.log);
    try {
      await f.service.tick();
      f.setNow(new Date(start.getTime() + 1000));
      const e = f.ledger.raise(input());
      for (let i = 0; i < 3; i++) expect((await f.service.tick()).sent).toBe(0);
      const restarted = new DecisionCardService({ transport: f.transport, ownerIds: [], ledger: f.ledger, now: () => new Date(start.getTime() + 2000) });
      await restarted.tick();
      expect(f.payloads).toHaveLength(0);
      expect(logs.filter(args => args[0] === 'decisions.webpush' && args[1] === 'no-subscribers')).toEqual([
        ['decisions.webpush', 'no-subscribers', { id: e.id }],
      ]);
      expect(logs.filter(args => args[0] === 'decisions.telegram' && args[1] === 'card-sent' && (args[2] as { id?: string }).id === e.id)).toEqual([]);
      f.setSubscribers(1);
      expect((await restarted.tick()).sent).toBe(1);
      expect((await f.service.tick()).sent).toBe(0);
      expect(f.payloads).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });

  test('failed delivery retries only up to the bounded attempt count, then stops across restarts', async () => {
    const f = fixture();
    f.setDelivered(0);
    await f.service.tick();
    f.setNow(new Date(start.getTime() + 1000));
    const e = f.ledger.raise(input());
    for (let i = 0; i < 8; i++) expect((await f.service.tick()).sent).toBe(0);
    expect(f.payloads).toHaveLength(3);
    const state = JSON.parse(readFileSync(join(f.dir, 'decisions', 'cards-webpush.json'), 'utf8')) as { cards: Record<string, { attempts: number; refs: unknown[] }> };
    expect(state.cards[e.id]).toMatchObject({ attempts: 3, refs: [] });
    f.setDelivered(1);
    const restarted = new DecisionCardService({ transport: f.transport, ownerIds: [], ledger: f.ledger, now: () => new Date(start.getTime() + 2000) });
    expect((await restarted.tick()).sent).toBe(0);
    expect(f.payloads).toHaveLength(3);
  });

  test('a failed delivery followed by success sends no further duplicate after restart', async () => {
    const f = fixture();
    f.setDelivered(0);
    await f.service.tick();
    f.setNow(new Date(start.getTime() + 1000));
    f.ledger.raise(input());
    await f.service.tick();
    f.setDelivered(1);
    expect((await f.service.tick()).sent).toBe(1);
    const restarted = new DecisionCardService({ transport: f.transport, ownerIds: [], ledger: f.ledger, now: () => new Date(start.getTime() + 2000) });
    for (let i = 0; i < 4; i++) expect((await restarted.tick()).sent).toBe(0);
    expect(f.payloads).toHaveLength(2);
  });

  test('title is limited to 60 characters; url and tag identify the decision; no option labels, button text or notes escape', async () => {
    const f = fixture();
    await f.service.tick();
    f.setNow(new Date(start.getTime() + 1000));
    const e = f.ledger.raise(input({ title: '가'.repeat(80), dueAt: '2026-10-02T09:00:00Z' }));
    const card = renderCard(e, { note: '메모 비공개' });
    const ref = await f.transport.send('webpush', card);
    expect(ref).toEqual({ chat: 'webpush', message: e.id });
    expect(f.payloads).toEqual([{ title: `대표 결정 · ${'가'.repeat(52)}`, body: '추천안: A · 기한: 10. 2. 18:00', url: `/approvals?decision=${e.id}`, tag: `decision-${e.id}` }]);
    expect(JSON.stringify(f.payloads)).not.toMatch(/옵션 비공개|메모 비공개|권고 이유|결과 A|메모 달기/);
  });

  test('first-start baseline excludes earlier decisions; a decision made elsewhere closes once using the same tag; open edits do nothing', async () => {
    const f = fixture();
    const old = f.ledger.raise(input({ title: '이전 결정' }));
    f.setNow(new Date(start.getTime() + 1000));
    expect((await f.service.tick()).sent).toBe(0);
    expect(f.payloads).toHaveLength(0);
    f.setNow(new Date(start.getTime() + 2000));
    const e = f.ledger.raise(input());
    expect((await f.service.tick()).sent).toBe(1);
    const ref = { chat: 'webpush', message: e.id };
    await f.transport.edit(ref, renderCard(e, { note: '메모 비공개' }));
    expect(f.payloads).toHaveLength(1);
    f.ledger.decide(e.id, 'b', { kind: 'human' }, '메모 비공개');
    expect((await f.service.tick()).closed).toBe(1);
    expect((await f.service.tick()).closed).toBe(0);
    expect(f.payloads).toHaveLength(2);
    expect(f.payloads[1]).toEqual({ title: `결정됨 · ${e.title}`, url: `/approvals?decision=${e.id}`, tag: f.payloads[0]!.tag, data: { silent: true } });
    expect(JSON.stringify(f.payloads)).not.toContain('메모 비공개');
    expect(f.payloads.every((p) => p.tag !== `decision-${old.id}`)).toBe(true);
  });

  test('withdrawn decisions replace the push once; ordinary edits never push', async () => {
    const f = fixture();
    await f.service.tick();
    f.setNow(new Date(start.getTime() + 1000));
    const e = f.ledger.raise(input());
    await f.service.tick();
    f.ledger.withdraw(e.id, '철회 사유 비공개');
    expect((await f.service.tick()).closed).toBe(1);
    expect((await f.service.tick()).closed).toBe(0);
    expect(f.payloads).toHaveLength(2);
    expect(f.payloads[1]).toEqual({ title: `결정됨 · ${e.title}`, url: `/approvals?decision=${e.id}`, tag: `decision-${e.id}`, data: { silent: true } });
    expect(JSON.stringify(f.payloads)).not.toContain('철회 사유 비공개');
  });

  test('only the deadline reminder replaces the same tag once; unrelated notify text is ignored', async () => {
    const f = fixture();
    await f.service.tick();
    f.setNow(new Date(start.getTime() + 1000));
    const e = f.ledger.raise(input({ dueAt: '2026-10-02T09:00:00Z' }));
    await f.service.tick();
    await f.transport.notify('webpush', `임의 알림 ${e.id}`);
    expect(f.payloads).toHaveLength(1);
    f.setNow(new Date('2026-10-02T07:00:00Z'));
    expect((await f.service.tick()).reminded).toBe(1);
    expect((await f.service.tick()).reminded).toBe(0);
    expect(f.payloads).toHaveLength(2);
    expect(f.payloads[1]).toMatchObject({ tag: `decision-${e.id}`, url: `/approvals?decision=${e.id}` });
    expect(f.payloads[1]!.body).toContain('기한 2시간 전');
  });

  test('observability contains id and delivered count but no subscription key, option or note', async () => {
    const f = fixture();
    const logs: unknown[][] = [];
    const spy = spyOn(debug, 'log').mockImplementation(((...args: unknown[]) => { logs.push(args); }) as typeof debug.log);
    try {
      await f.service.tick();
      f.setNow(new Date(start.getTime() + 1000));
      const e = f.ledger.raise(input());
      await f.service.tick();
      f.ledger.decide(e.id, 'b', { kind: 'human' }, '메모 비공개');
      await f.service.tick();
      const events = logs.filter((args) => args[0] === 'decisions.webpush');
      expect(events.filter((args) => args[1] === 'card-sent' || args[1] === 'card-closed')).toEqual([
        ['decisions.webpush', 'card-sent', { id: e.id, delivered: 1 }],
        ['decisions.webpush', 'card-closed', { id: e.id, delivered: 1 }],
      ]);
      expect(JSON.stringify(events)).not.toMatch(/옵션 비공개|메모 비공개|endpoint|p256dh|auth/);
    } finally { spy.mockRestore(); }
  });
});
