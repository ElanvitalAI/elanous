// SEAT-TURN-MIDTURN-MAIL · OP #106762 ⓐ — 턴 중 도착 우편은 이벤트함에 «본문 원문»을 싣고,
// 배수 시 큐의 대기 노티스를 지운다(같은 msgId 는 세션 동안 한 번 · 턴 끝 뒤 새 턴 0).
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { clearMidTurnEvents, drainMidTurnEvents, enqueueMidTurnEvent, midTurnEventCount } from '../session/mid-turn-events.js';
import { createNextTuiQueue } from './core/queue.js';
import { createChildNoticeProducers } from './core/notice-producers.js';
import { seatMailOnArrived } from './seat-mail-on-arrived.js';

const wake = { name: 'queue-wake' };

function seam(busy: boolean) {
  const injectKeys: unknown[] = [];
  const onArrived = seatMailOnArrived({
    busy: () => busy,
    injectKey: (key) => { injectKeys.push(key); },
    queueWake: wake,
  });
  return { onArrived, injectKeys };
}

test('idle arrival injects the queue wake and the leaf has no steer hook', () => {
  const s = seam(false);
  s.onArrived();
  s.onArrived();
  expect(s.injectKeys).toEqual([wake, wake]);
  const source = readFileSync(new URL('./seat-mail-on-arrived.ts', import.meta.url), 'utf8');
  expect(source.includes('steer?:')).toBe(false);
  expect(source.includes('steer(')).toBe(false);
});

test('busy arrival injects nothing', () => {
  const s = seam(true);
  s.onArrived();
  s.onArrived();
  expect(s.injectKeys).toEqual([]);
});

/** OP #106762 ⓐ — 세션 레지스트리와 진짜 큐·생산자로 리터럴(①-④)을 증명한다. */
function midturnFixture(session: string) {
  const queue = createNextTuiQueue();
  const producers = createChildNoticeProducers(queue);
  const removals: Array<{ source: string; msgId?: number; text?: string }> = [];
  const onArrived = seatMailOnArrived({
    busy: () => true,
    injectKey: (key) => { throw new Error(`unexpected inject ${String(key)}`); },
    queueWake: wake,
    enqueueMidTurn: (event, onDrained) => enqueueMidTurnEvent(session, event, onDrained),
    removeQueuedNotice: (match) => {
      removals.push(match);
      const wanted = queue.items.filter((item) =>
        item.kind === 'notice' && item.source === match.source && item.msgId === match.msgId);
      let removed = 0;
      for (const item of wanted) { try { queue.cancel(item.id, 'mid-turn-carried'); removed += 1; } catch { /* fail-open */ } }
      return removed;
    },
  });
  return { queue, producers, onArrived, removals };
}

test('ⓐ 리터럴 ①②③④ — 바쁜 턴 우편 1: 본문 원문·msgId·보낸 자리 → 배수 시 큐 제거 → 세션 1회 → 새 턴 0', () => {
  const session = 'midturn-mail-literal';
  clearMidTurnEvents(session);
  const f = midturnFixture(session);
  const input = { id: 4127, sender: 'TC-H-CX-1', body: '리터럴 본문 원문 4127', kind: null };
  const item = f.producers.seatMessageArrived(input); // q1 — 원본 큐 항목(watcher 가 적입하는 그것)
  expect(item).not.toBeNull();
  // ① 바쁜 턴 도중 우편 1 → 이벤트 text 에 본문 원문·msgId·보낸 자리가 실린다.
  f.onArrived([{ msgId: input.id, seat: 'TC-H-POOL-3', sender: 'TC-H-CX-1', text: item!.text }]);
  expect(midTurnEventCount(session)).toBe(1);
  const drained = drainMidTurnEvents(session);
  expect(drained).toHaveLength(1);
  expect(drained[0]!.kind).toBe('seat-mail');
  expect(drained[0]!.id).toBe('4127'); // msgId 가 곧 사건 id
  expect(drained[0]!.text).toBe(item!.text); // 큐 항목 문면과 일치(seatMessageNotice 재사용)
  expect(drained[0]!.text).toContain('TC-H-CX-1'); // 보낸 자리 — 머리줄
  expect(drained[0]!.text).toContain('msg:4127 · 리터럴 본문 원문 4127'); // 본문 원문(전문)
  // ② drain → onDrained 로 큐 항목(q1) 제거 1회.
  expect(f.removals).toEqual([{ source: 'seat-mail', msgId: 4127 }]);
  expect(f.queue.items.filter((q) => q.source === 'seat-mail')).toHaveLength(0);
  // ③ 같은 msgId 재도착 → 세션 동안 0건(한 번만).
  f.onArrived([{ msgId: input.id, seat: 'TC-H-POOL-3', sender: 'TC-H-CX-1', text: item!.text }]);
  expect(midTurnEventCount(session)).toBe(0);
  expect(f.removals).toHaveLength(1); // 재도착은 onDrained 도 다시 부르지 않는다
  // ④ 턴 끝 뒤 새 턴 0 — 큐에 남은 seat-mail 항목이 없다.
  expect(f.queue.items).toHaveLength(0);
  clearMidTurnEvents(session);
});

test('④ 바쁜 턴 — 다른 msgId 두 통은 별개 2건(«재도착 2건» 가정 정정: 같은 msgId 재도착은 1건)', () => {
  const session = 'midturn-mail-two-msgids';
  clearMidTurnEvents(session);
  const f = midturnFixture(session);
  f.onArrived([
    { msgId: 101, seat: 'TC-H-POOL-3', sender: 'TC-H-CX-1', text: 'mail 101 문면' },
    { msgId: 202, seat: 'TC-H-POOL-3', sender: 'TC-H-CX-2', text: 'mail 202 문면' },
  ]);
  expect(midTurnEventCount(session)).toBe(2); // 다른 msgId — 별개 2건
  const drained = drainMidTurnEvents(session);
  expect(drained.map((e) => e.id)).toEqual(['101', '202']);
  clearMidTurnEvents(session);
});

test('바쁜 턴 — 정보 없는 onArrived(재제출·수 모드)는 이벤트함을 건드리지 않는다(undefined 폴백)', () => {
  let enqueued = 0;
  const onArrived = seatMailOnArrived({
    busy: () => true,
    injectKey: () => { throw new Error('busy 턴은 문을 두드리지 않는다'); },
    queueWake: wake,
    enqueueMidTurn: () => { enqueued += 1; return true; },
  });
  onArrived();
  onArrived([]);
  onArrived([{ text: '수 모드 노티스 문면', seat: 'TC-H-POOL-3' }]); // msgId 없음 — 세션 1회 계약 불가
  expect(enqueued).toBe(0);
});

test('④ idle arrival (mid-turn deps wired) still opens the next turn — no mid-turn enqueue', () => {
  const enqueued: Array<{ kind: string; id: string; text: string }> = [];
  const injectKeys: unknown[] = [];
  const onArrived = seatMailOnArrived({
    busy: () => false,
    injectKey: (key) => { injectKeys.push(key); },
    queueWake: wake,
    enqueueMidTurn: (event) => { enqueued.push(event); return true; },
  });
  onArrived([{ msgId: 7, seat: 'TC-H-POOL-3', text: 'mail 7 문면' }]);
  expect(injectKeys).toEqual([wake]); // idle = 노크로 새 턴
  expect(enqueued).toEqual([]); // 이벤트함에는 안 들어감
});

test('JUD security HOLD: no sender preempts a busy turn — OP decision mail rides the same mid-turn box in FIFO order', () => {
  const midturn: string[] = [];
  const onArrived = seatMailOnArrived({
    busy: () => true,
    injectKey: () => { throw new Error('busy turn must not open a new turn'); },
    queueWake: wake,
    enqueueMidTurn: (event) => { midturn.push(`${event.id}:${event.text}`); return true; },
  });
  onArrived([
    { msgId: 801, seat: 'TC-H-CX-13', sender: 'TC', origin: { kind: 'agent', seat: 'TC' }, intent: 'request', text: 'msg:801 · earlier' },
    { msgId: 802, seat: 'TC-H-CX-13', sender: 'OP', origin: { kind: 'agent', seat: 'OP' }, intent: 'decision', text: 'msg:802 · go' },
    { msgId: 803, seat: 'TC-H-CX-13', sender: 'TC', origin: { kind: 'agent', seat: 'TC' }, intent: 'request', text: 'msg:803 · later' },
  ]);
  expect(midturn).toEqual(['801:msg:801 · earlier', '802:msg:802 · go', '803:msg:803 · later']);
});
