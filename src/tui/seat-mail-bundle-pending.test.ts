// 출처: OP #129667(필수·중대 — JUD-B #129661/#129660 원장 probe CONFIRMED) — 상한 밖 우편 pending 재제공(②③),
// 50통 전부 결국 전달·확인·재시작 0(④), 가이드 항목 msgId 하이재크·미전달 우편 false seen 회귀(①).
// probe 원문: mbp /tmp/judb39570-ledger.test.ts — 진짜 원장(MsgStore)·진짜 큐·진짜 감시자, 가집 없음.
// 묶음 한 턴 = poll → drainNotices → noteTurnFinished(responded).
import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../msg/msg-store.js';
import { createNextTuiQueue } from './core/queue.js';
import { createSeatMailArrivalWatcher, type SeatMailArrivalWatcher } from './seat-mail-arrival.js';
import { createLedgerReceiptWriter, readSeatMailMessages } from './seat-message-receipts.js';

function seatMailWorld(mailCount: number): {
  store: MsgStore;
  makeWatcher: () => { queue: ReturnType<typeof createNextTuiQueue>; watcher: SeatMailArrivalWatcher };
  unread: () => number[];
  receipts: () => Array<{ message_id: number; state: string }>;
  close: () => void;
} {
  const home = mkdtempSync(join(tmpdir(), 'mvpb39570-fix-'));
  mkdirSync(join(home, 'elanous-hq', 'seat-state', 'TEST'), { recursive: true });
  const msgPath = join(home, 'messages.db');
  const store = new MsgStore(msgPath);
  for (let i = 1; i <= mailCount; i += 1) store.post({ from: 'OP', to: 'TEST', body: `literal body ${i}` });
  const makeWatcher = () => {
    const queue = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
    const watcher = createSeatMailArrivalWatcher(join(home, 'seats', 'TEST'), queue, {
      messages: {
        read: (cwd: string, after: number) => readSeatMailMessages(cwd, after, { home, msgPath }),
        receipts: createLedgerReceiptWriter(msgPath),
      },
      log: () => {},
      turnLifeLog: () => {},
    });
    return { queue, watcher };
  };
  return {
    store,
    makeWatcher,
    unread: () => store.listByRecipient('TEST', 0, 1000).map((m) => m.id),
    receipts: () => {
      // 영수 표가 아직 없으면(한 통도 기록 안 된 격리 세계) 빈 배열 — 표 없음 오류가 아니다.
      const table = store.db
        .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'msg_receipts'")
        .get();
      if (!table) return [] as Array<{ message_id: number; state: string }>;
      return store.db
        .query('SELECT message_id, state FROM msg_receipts WHERE recipient = ? ORDER BY message_id, state')
        .all('TEST') as Array<{ message_id: number; state: string }>;
    },
    close: () => store.close(),
  };
}

test('mixed sources fill the cap — real mail stays pending: no receipts until it is actually queued (JUD-B #129661)', () => {
  const world = seatMailWorld(20);
  try {
    const { queue, watcher } = world.makeWatcher();
    // 타 출처 알림 100건이 큐 상한(100 · SEAT-QUEUE-CAPACITY CEO 11-25 · 옛 20)을 채운다(감시자 room 계산이 seat-mail만 세면 우편을 다 집어들어 가이드로 접힌다).
    for (let i = 1; i <= 100; i += 1) queue.enqueueNotice(`other ${i}`, 'event-watch');
    watcher.poll();
    queue.drainNotices();
    watcher.noteTurnFinished(true, 'responded');
    // 수리 전(RED): 우편 1~20이 가이드로 접혀 delivered 영수 20건 + false seen(#20).
    // OP #130050 — receipts 표 전체가 아니라 delivered 영수가 기준이다: 읽기(poll)가 seen 영수를
    // 정상적으로 남기는 관측 기록이라, 배달 영수(delivered)만이 실제 배달의 증거다.
    // 수리 후(GREEN): 우편은 한 통도 큐 항목이 못 됐다 → delivered 영수 0건(가이드 msgId 하이재크 없음), 원장 20통 그대로.
    expect(world.receipts().filter((row) => row.state === 'delivered')).toEqual([]);
    expect(world.unread()).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    // 다음 poll: 방이 난 뒤 우편 20통이 실제 큐 항목으로 재제공 — 묶음으로 열려 확인까지.
    watcher.poll();
    const drained = queue.drainNotices();
    expect(drained.kind).toBe('notices');
    if (drained.kind !== 'notices') return;
    const mailIds = drained.notices.flatMap((n) => (n.source === 'seat-mail' && n.msgId !== undefined ? [n.msgId] : []));
    expect(mailIds).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    watcher.noteTurnFinished(true, 'responded');
    expect(world.unread()).toEqual([]);
    // OP #130050 — 후속 재배달: 실제 큐 항목으로 지나간 우편만 delivered 영수를 남긴다(20건 — seen 은 별도 관측).
    expect(world.receipts().filter((row) => row.state === 'delivered').length).toBe(20);
  } finally {
    world.close();
  }
});

test('250 mail — over-cap stays pending, re-offered on every next poll: all 250 delivered+seen, restart 0 (OP #129667 ②③④ · cap 100)', () => {
  const world = seatMailWorld(250);
  try {
    const { queue, watcher } = world.makeWatcher();
    const delivered: number[] = [];
    // 출처: 칸 원문 SEAT-NOTICE-BUNDLE-DRAIN(완수선 «알림 50통 주입 시뮬에서 턴 ≤3» · 근거 DIAG-ELN-OP-COORDINATOR-1122) — 주기 1회 = 턴 1회.
    let turns = 0;
    for (let cycle = 0; cycle < 10 && world.unread().length > 0; cycle += 1) {
      watcher.poll();
      const drained = queue.drainNotices();
      if (drained.kind !== 'notices') break;
      // #129635 — 묶음 drain이 큐를 비운다: 두 번째 drain은 none.
      expect(queue.drainNotices().kind).toBe('none');
      for (const notice of drained.notices) {
        if (notice.source === 'seat-mail' && notice.msgId !== undefined) delivered.push(notice.msgId);
      }
      watcher.noteTurnFinished(true, 'responded');
      turns += 1;
      if (cycle === 0) {
        // OP #130050 — 상한(100) 밖 101~250은 이번 턴에 큐로 못 들어가 pending(우편 유실 0) — 다음 poll 이 재제공한다.
        expect(world.unread().length).toBe(150);
      }
    }
    // 완수선 직접 단얨(칸 원문 SEAT-NOTICE-BUNDLE-DRAIN): 상한 100 에서 250통 주입 시뮬의 턴 수는 3 이하(100+100+50).
    expect(turns).toBeLessThanOrEqual(3);
    // 250통 전부 실제 큐 항목으로 지나갔고(가이드 msgId 하이재크 없음), 중복 배달 0.
    expect(new Set(delivered).size).toBe(delivered.length);
    expect([...delivered].sort((a, b) => a - b)).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
    // 250통 전부 확인(seen) — 재시작 재제공 0.
    expect(world.unread()).toEqual([]);
    const restart = world.makeWatcher();
    expect(['baseline', 'quiet']).toContain(restart.watcher.poll().kind);
  } finally {
    world.close();
  }
});