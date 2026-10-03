import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import type { PushPayload, SendPushResult } from '../web-push/sender.js';
import type { PushSubscriptionRecord } from '../web-push/subscriptions.js';
import { DecisionCardService, renderCard } from './decision-cards.js';
import { DecisionLedger, type RaiseInput } from './decision-ledger.js';
import { webPushDecisionTransport } from './web-push-decision-cards.js';

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
  const payloads: PushPayload[] = [];
  const ledger = new DecisionLedger({ stateDir: dir, now: () => now, resolveVersion: () => ({ released: '0.2.8', dev: '0.2.9-dev.0' }) as never });
  const transport = webPushDecisionTransport(ledger, {
    subscriptions: () => Array.from({ length: subscribers }, (_, i) => ({ id: String(i) }) as PushSubscriptionRecord),
    push: async (payload): Promise<SendPushResult> => {
      payloads.push(payload);
      return { attempted: subscribers, delivered: subscribers, removed: 0, errors: [] };
    },
  });
  const service = new DecisionCardService({ transport, ownerIds: [], ledger, now: () => now });
  return { ledger, transport, service, payloads, setNow: (date: Date) => { now = date; }, setSubscribers: (count: number) => { subscribers = count; } };
}

describe('AN1a web push decision cards', () => {
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
