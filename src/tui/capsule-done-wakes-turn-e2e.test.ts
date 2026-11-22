import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { CapsuleDoneEvent, CapsuleEvent } from '../turn-capsule/contract.js';
import { wireCapsuleDoneKnock } from './capsule-done-knock.js';
import { createChildNoticeProducers } from './core/notice-producers.js';
import { createNextTuiQueue } from './core/queue.js';
import { createQueueIdleWatchdog } from './core/queue-idle-watchdog.js';
import { dispatchQueuedExternalEventOne } from './entry.js';
import { createIdleWakeDoor } from './idle-wake-door.js';
import { resetExternalEventOneWire, type ExternalEventOneOpened } from './external-event-one-wire.js';

/**
 * OP #129087 ③ (JUD-B #129076 회신 · #39562 완료선) — 자식 완료 알림이 실제로 새 턴을 연다.
 * 실모듈 종단: wireCapsuleDoneKnock(구독→크노티스→knock) → createIdleWakeDoor(idle 문) →
 * queue.dequeue(노티스 인도) → dispatchQueuedExternalEventOne(entry 체인) → startChatTurn.
 * 각 조각의 단위 시험(capsule-done-knock.test.ts · idle-wake-door.test.ts ·
 * external-event-one-wire.test.ts)을 잇는 한 흐름 — 배선이 끊기면 이 시험이 문다.
 *
 * CAPSULE-DONE-KNOCK-PTY-E2E-FU (OP 11-22) — #39526 이후 완료 프레임 자체는 문을 두드리지 않는다(토큰 절약).
 * 대신 사람 없는 idle 좌석에서 결과가 2분(120 000ms) 기다리면 idle 감시가 같은 문으로 한 턴을 연다.
 */
afterEach(() => { setSystemTime(); });

/** 실제와 같은 도착 — occurredAt(=endedAt)가 receivedAt(Date.now())에서 15s 안이면 정시 영수. */
const NOW = Date.now();
const DONE: CapsuleDoneEvent = {
  type: 'capsule-done', capsuleId: 'c-wakes', kind: 'agent', sessionId: 's-wakes',
  startedAt: NOW - 60_000, // 출처: OP #129087 ③ 종단 시나리오 — 60s 실행 캡슐 관측값 문면과 같은 형태
  endedAt: NOW - 15_000, // 출처: external-event-one-wire.test.ts ON_TIME_WAIT_MS — 정시(한계 20s) 안쪽 도착
  status: 'ok', summary: 'scan · ok · 60s',
};

describe('③ capsule-done → idle door → entry 체인 → 새 턴 (실모듈 종단 · OP #129087)', () => {
  test('완료 알림 1건: 즉시 턴 0 · idle 2분 뒤 idle 감시가 문을 두드려 실제 startChatTurn 1건', async () => {
    setSystemTime(new Date(NOW));
    const book = resetExternalEventOneWire();
    const queue = createNextTuiQueue({ log: () => {} });
    const notices = createChildNoticeProducers(queue);
    const listeners: Array<(event: CapsuleEvent) => void> = [];
    const startedTurns: Array<[string, string]> = [];
    const knockLog: string[] = [];
    let busy = false;
    let drainPromise: Promise<void> | null = null;
    let openedKept: ExternalEventOneOpened | null = null;

    /** The idle door's one key: take the queued notice and run the real entry chain on it. */
    const drainQueue = async (): Promise<void> => {
      const handoff = queue.dequeue();
      if (handoff.kind !== 'submit') return;
      if (handoff.itemKind !== 'notice') throw new Error(`notice expected, got ${handoff.itemKind}`);
      await dispatchQueuedExternalEventOne({
        notice: {
          id: handoff.id,
          text: handoff.text,
          ...(handoff.source === undefined ? {} : { source: handoff.source }),
          ...(handoff.occurredAt === undefined ? {} : { occurredAt: handoff.occurredAt }),
          remaining: handoff.remaining,
        },
        injectKey: () => { door.knock('capsule-done'); },
        keepOpen: (opened) => { openedKept = opened; },
        startChatTurn: (text, status) => { startedTurns.push([text, status]); busy = true; },
        log: () => {},
      });
    };

    const door = createIdleWakeDoor({
      busy: () => busy,
      injectKey: () => { knockLog.push('injectKey'); drainPromise = drainQueue(); return true; },
      queueWake: { wake: 'queue-wake' },
      log: () => {},
    });
    door.register({ id: 'capsule-done' });

    const stop = wireCapsuleDoneKnock({
      sessionId: DONE.sessionId,
      subscribe: (sessionId, listener) => {
        expect(sessionId).toBe(DONE.sessionId);
        listeners.push(listener);
        return () => {};
      },
      enqueue: (event) => notices.capsuleDone(event, event.endedAt),
      knock: () => { door.knock('capsule-done'); },
    });
    expect(listeners).toHaveLength(1);

    const watchdog = createQueueIdleWatchdog({
      now: () => Date.now(), idle: () => !busy, queued: () => queue.autoDispatchCount,
      wake: () => { door.knock('capsule-done'); return true; }, log: () => {}, stallMs: 5_000,
    });
    const tickUntil = (fromMs: number, untilMs: number): void => {
      for (let t = fromMs; t <= untilMs; t += 500) { setSystemTime(new Date(NOW + t)); watchdog.tick(); }
    };

    // 자식 완료 — idle 좌석에서 일어나는 한 번의 사건. 그 자체로는 턴을 열지 않는다.
    listeners[0]!(DONE);
    tickUntil(0, 119_500);
    expect(knockLog).toEqual([]);
    expect(startedTurns).toHaveLength(0);

    // 2분이 지나면 idle 감시가 한 번 두드린다 → 노티스 1건 → 새 턴 1건. entry 체인은 동적 import로
    // 비동기라 첫 drain 을 붙잡아 기다린 뒤 단언한다.
    tickUntil(120_000, 125_000);
    const firstDrain = drainPromise;
    expect(knockLog).toEqual(['injectKey']);
    expect(firstDrain).not.toBeNull();
    await firstDrain;
    expect(startedTurns).toHaveLength(1);
    expect(startedTurns[0]![0]).toBe('캡슐 완료: agent scan · ok · 60s — ok · capsule:c-wakes');
    expect(startedTurns[0]![1]).toBe('[notice · capsule-done] auto-submitted');
    expect(busy).toBe(true);

    // 원장: 그 한 사건은 handled로 닫힌다(재전파 중복 억제 — «큐에 남아 있는 동안» 텍스트 중복
    // 0 — 은 capsule-done-knock.test.ts 단위 시험의 몫; 이 시험은 양성 종단 1건만 증명한다).
    expect(book.rows()).toHaveLength(1);
    const handled = await openedKept!.finish(true);
    expect(handled.phase).toBe('handled');
    stop();
  });
});
