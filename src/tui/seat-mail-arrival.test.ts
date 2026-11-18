import { expect, test } from 'bun:test';
import { createNextTuiQueue } from './core/queue.js';
import { seatMailNotice } from './core/notice-producers.js';
import { createSeatMailArrivalWatcher, DEFAULT_SEAT_MAIL_POLL_MS } from './seat-mail-arrival.js';
import type { SeatMailSnapshot } from './seat-mail-boot.js';

const SEAT = 'OP';
// 우편 수 픽스처 — 시작 시점 안 읽은 수, 도착 뒤 수, 다 읽은 뒤 수(0)는 여기서 유도한다(NUMGUARD).
const BOOT_UNREAD = 2;
const AFTER_ARRIVAL_UNREAD = BOOT_UNREAD + 1;
const ALL_READ_UNREAD = 0;

const quietQueue = () => createNextTuiQueue({ log: () => {} });

const fixture = (unreadByPoll: Array<number | null>) => {
  let calls = 0;
  const readSnapshot = (): SeatMailSnapshot | null => {
    const unread = unreadByPoll[Math.min(calls, unreadByPoll.length - 1)] ?? null;
    calls += 1;
    return unread === null ? null : { seat: SEAT, unread };
  };
  return { readSnapshot, pollCount: () => calls };
};

test('ELN-EXTERNAL-EVENTS ② — 새 도착만 onArrived; 기준선·중복·읽기 실패는 큐도 깨움도 없다', () => {
  const queue = quietQueue();
  const arrivals: number[] = [];
  const readErrors: string[] = [];
  const watcher = createSeatMailArrivalWatcher('/h', queue, {
    readSnapshot: (() => {
      const unread = [BOOT_UNREAD, AFTER_ARRIVAL_UNREAD, AFTER_ARRIVAL_UNREAD, null, AFTER_ARRIVAL_UNREAD + 1];
      let calls = 0;
      return () => {
        const value = unread[Math.min(calls, unread.length - 1)] ?? null;
        calls += 1;
        if (value === null) throw new Error('ledger down');
        return { seat: SEAT, unread: value };
      };
    })(),
    onArrived: () => { arrivals.push(queue.count); },
    onReadError: (error) => { readErrors.push(error instanceof Error ? error.message : String(error)); },
  });
  expect(watcher.poll().kind).toBe('baseline');
  expect(watcher.poll().kind).toBe('arrived');
  // Same unread text is still queued — not a second arrival, so the idle door is not woken again.
  expect(watcher.poll()).toEqual({ kind: 'quiet', unread: AFTER_ARRIVAL_UNREAD });
  expect(watcher.poll()).toEqual({ kind: 'read-error' });
  expect(readErrors).toEqual(['ledger down']);
  expect(watcher.poll().kind).toBe('arrived');
  expect(arrivals).toEqual([1, 2]);
  expect(queue.items.filter((item) => item.source === 'seat-mail')).toHaveLength(2);
});

test('REVIEW-1 — unread 5 stays queued, 4 is quiet, 5 again is the same text so onArrived is not called', () => {
  const queue = quietQueue();
  const arrivals: number[] = [];
  const FIVE = 5;
  const FOUR = FIVE - 1;
  const watcher = createSeatMailArrivalWatcher('/h', queue, {
    readSnapshot: (() => {
      const unread = [FIVE - 1, FIVE, FOUR, FIVE];
      let calls = 0;
      return (): SeatMailSnapshot => {
        const value = unread[Math.min(calls, unread.length - 1)] ?? FIVE;
        calls += 1;
        return { seat: SEAT, unread: value };
      };
    })(),
    onArrived: () => { arrivals.push(queue.count); },
  });
  expect(watcher.poll()).toEqual({ kind: 'baseline', unread: FOUR });
  const first = watcher.poll();
  expect(first).toEqual({ kind: 'arrived', unread: FIVE, noticeText: seatMailNotice({ seat: SEAT, unread: FIVE }) });
  expect(watcher.poll()).toEqual({ kind: 'quiet', unread: FOUR });
  // The "5" notice is still queued, so the second rise is item===null and must not wake.
  const again = watcher.poll();
  expect(again).toEqual({ kind: 'arrived', unread: FIVE, noticeText: null });
  expect(arrivals).toEqual([1]);
  expect(queue.items.filter((item) => item.source === 'seat-mail')).toHaveLength(1);
});

test('첫 관측은 기준선만 — 부팅 전 우편으로 큐를 채우지 않는다', () => {
  const queue = quietQueue();
  const f = fixture([BOOT_UNREAD]);
  const watcher = createSeatMailArrivalWatcher('/h', queue, { readSnapshot: f.readSnapshot });
  expect(watcher.poll()).toEqual({ kind: 'baseline', unread: BOOT_UNREAD });
  expect(queue.items).toEqual([]);
});

test('안 읽은 수 증가 → seat-mail notice 한 줄, 문구는 제품 함수에서 유도', () => {
  const queue = quietQueue();
  const f = fixture([BOOT_UNREAD, AFTER_ARRIVAL_UNREAD]);
  const watcher = createSeatMailArrivalWatcher('/h', queue, { readSnapshot: f.readSnapshot });
  watcher.poll();
  const outcome = watcher.poll();
  expect(outcome).toEqual({
    kind: 'arrived',
    unread: AFTER_ARRIVAL_UNREAD,
    noticeText: seatMailNotice({ seat: SEAT, unread: AFTER_ARRIVAL_UNREAD }),
  });
  expect(queue.items.map((item) => ({ kind: item.kind, source: item.source, text: item.text }))).toEqual([
    { kind: 'notice', source: 'seat-mail', text: seatMailNotice({ seat: SEAT, unread: AFTER_ARRIVAL_UNREAD }) },
  ]);
});

test('감소(다 읽음)·동일 → 조용; 스냅숏 불가(null) → no-seat', () => {
  const queue = quietQueue();
  const f = fixture([BOOT_UNREAD, ALL_READ_UNREAD, ALL_READ_UNREAD, null]);
  const watcher = createSeatMailArrivalWatcher('/h', queue, { readSnapshot: f.readSnapshot });
  watcher.poll();
  expect(watcher.poll()).toEqual({ kind: 'quiet', unread: ALL_READ_UNREAD });
  expect(watcher.poll()).toEqual({ kind: 'quiet', unread: ALL_READ_UNREAD });
  expect(watcher.poll()).toEqual({ kind: 'no-seat' });
  expect(queue.items).toEqual([]);
});

test('start/stop — 주기는 호출자가 준 값 그대로 타이머에, stop 은 같은 핸들을 정리', () => {
  const queue = quietQueue();
  // 시험용 짧은 주기(제품 기본 폴링 주기 아님) — 타이머 전달값 확인이 목적.
  const WATCH_MS = 1;
  const scheduled: Array<{ fn: () => void; ms: number; handle: string }> = [];
  const cleared: string[] = [];
  const timer = {
    set: (fn: () => void, ms: number) => {
      const handle = `timer-${scheduled.length + 1}`;
      scheduled.push({ fn, ms, handle });
      return handle;
    },
    clear: (handle: unknown) => { cleared.push(handle as string); },
  };
  const f = fixture([BOOT_UNREAD, AFTER_ARRIVAL_UNREAD]);
  const watcher = createSeatMailArrivalWatcher('/h', queue, { readSnapshot: f.readSnapshot, intervalMs: WATCH_MS, timer });
  watcher.start();
  watcher.start(); // 두 번째 start 는 새 타이머를 만들지 않는다.
  expect(scheduled.map((row) => ({ ms: row.ms, handle: row.handle }))).toEqual([{ ms: WATCH_MS, handle: 'timer-1' }]);
  scheduled[0]!.fn(); // 기준선
  scheduled[0]!.fn(); // 도착
  expect(queue.items.map((item) => item.source)).toEqual(['seat-mail']);
  watcher.stop();
  expect(cleared).toEqual(['timer-1']);
});

test('stop 뒤 폴링 0 — TUI 종료(finally)가 stop 하면 그 뒤로는 관측이 없다', () => {
  const queue = quietQueue();
  const scheduled: Array<{ fn: () => void; ms: number; handle: string }> = [];
  const cleared: string[] = [];
  const timer = {
    set: (fn: () => void, ms: number) => {
      const handle = `timer-${scheduled.length + 1}`;
      scheduled.push({ fn, ms, handle });
      return handle;
    },
    clear: (handle: unknown) => { cleared.push(handle as string); },
  };
  // 도착이 계속 늘어나는 상황이어도, stop 뒤에는 한 번도 관측하면 안 된다.
  const f = fixture([BOOT_UNREAD, AFTER_ARRIVAL_UNREAD, AFTER_ARRIVAL_UNREAD + 1]);
  const watcher = createSeatMailArrivalWatcher('/h', queue, { readSnapshot: f.readSnapshot, intervalMs: 1, timer });
  watcher.start();
  scheduled[0]!.fn(); // 기준선
  scheduled[0]!.fn(); // 도착 → notice 1줄
  watcher.stop(); // showNextTui finally 가 부르는 stop
  expect(cleared).toEqual(['timer-1']);
  // stop 뒤 새 스케줄 0 · 폴링 0 — 큐는 도착 1줄 그대로.
  expect(scheduled).toHaveLength(1);
  expect(f.pollCount()).toBe(2);
  expect(queue.items).toHaveLength(1);
});

test('defaults the idle mail poll to the one 15 second period', () => {
  expect(DEFAULT_SEAT_MAIL_POLL_MS).toBe(15_000);
  const queue = quietQueue();
  const scheduled: number[] = [];
  const watcher = createSeatMailArrivalWatcher('/h', queue, {
    readSnapshot: () => null,
    timer: {
      set: (_fn: () => void, ms: number) => { scheduled.push(ms); return 'timer-1'; },
      clear: () => {},
    },
  });
  watcher.start();
  watcher.stop();
  expect(scheduled).toEqual([DEFAULT_SEAT_MAIL_POLL_MS]);
});
