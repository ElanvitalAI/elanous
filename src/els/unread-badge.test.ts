// OP #100208 · 칸 6 ELS-UNREAD-MAIL-BADGE — els ls 목록에 자리별 미ack 수·최장 대기 결합 리터럴.
// 원장은 ELANOUS_STATE_DIR 로 격리 우주(tmpdir)에 만든다: 3건 우편 → 1건 ack → 미ack 2건.
// env 전환은 시험 콜백 안에서만(동기) — 병렬 파일 시험(post-office 등) 오염 방지.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElsCore } from './core.js';
import { emptyJournal } from './space.js';
import { openMsgStore } from '../msg/msg-store.js';
import { Database } from 'bun:sqlite';
import type { SpaceJournal } from './space.js';

const SEAT = 'HAND-ELN-ELS-MCP';

function fakePty(id: string) {
  return {
    id,
    isAlive: () => true,
    write: () => {},
    renderScreen: () => Promise.resolve(`${id} ready\n`),
    onExit: () => {},
    kill: () => {},
  };
}

describe('els ls unread mail badge', () => {
  test('seat pane carries unreadMail count + oldest unacked wait, non-seat pane stays null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'els-unread-badge-'));
    const prevEnv = process.env.ELANOUS_STATE_DIR;
    try {
      process.env.ELANOUS_STATE_DIR = dir;
      mkdirSync(join(dir, 'msg'), { recursive: true });
      const store = openMsgStore();
      const m1 = store.post({ from: 'OP', to: SEAT, body: 'first', kind: 'info' })!;
      store.post({ from: 'OP', to: SEAT, body: 'second', kind: 'info' });
      store.post({ from: 'OP', to: SEAT, body: 'third', kind: 'info' });
      store.ack(SEAT, m1.id); // 커서를 첫 메시지까지 → 미ack 2건(second, third)

      let stored: SpaceJournal = emptyJournal();
      const core = createElsCore({
        load: () => stored,
        save: (journal) => { stored = journal; },
        spawn: () => fakePty('pty1') as never,
      });
      const rSeat = core.newPane({ ws: 'main', name: 'seatpane', command: ['bash'], cwd: join(dir, 'seats', SEAT) } as never);
      const rPlain = core.newPane({ ws: 'main', name: 'plainpane', command: ['bash'], cwd: join(dir, 'plain') } as never);
      expect(rSeat).not.toMatchObject({ exitCode: 1 });
      expect(rPlain).not.toMatchObject({ exitCode: 1 });
      core.start();
      const listResult = core.list();
      const parsed = JSON.parse((listResult as { exitCode: number; message: string }).message) as { panes: Array<{ cwd: string; seat: string | null; unreadMail: { count: number; oldestCreatedAt: string | null } | null }> };
      const panes = parsed.panes;
      const seatPane = panes.find((p) => p.cwd.endsWith(join('seats', SEAT)));
      const plainPane = panes.find((p) => p.cwd === join(dir, 'plain'));
      expect(seatPane?.seat).toBe(SEAT);
      expect(seatPane?.unreadMail?.count).toBe(2);
      expect(typeof seatPane?.unreadMail?.oldestCreatedAt).toBe('string');
      expect(seatPane?.unreadMail?.oldestCreatedAt).not.toBeNull();
      expect(plainPane?.seat).toBeNull();
      expect(plainPane?.unreadMail).toBeNull();
    } finally {
      if (prevEnv === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = prevEnv;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('JUD #39000 FU: a locked mail ledger does not stall ls — one short read for all seat panes, badges come back after', () => {
    const dir = mkdtempSync(join(tmpdir(), 'els-unread-badge-lock-'));
    const prevEnv = process.env.ELANOUS_STATE_DIR;
    let lock: Database | undefined;
    try {
      process.env.ELANOUS_STATE_DIR = dir;
      mkdirSync(join(dir, 'msg'), { recursive: true });
      const store = openMsgStore();
      store.post({ from: 'OP', to: SEAT, body: 'one', kind: 'info' });
      store.post({ from: 'OP', to: 'OTHER-SEAT', body: 'two', kind: 'info' });
      let stored: SpaceJournal = emptyJournal();
      const core = createElsCore({ load: () => stored, save: (journal) => { stored = journal; }, spawn: () => fakePty('pty1') as never });
      // three seat panes: two share a seat, one is another seat (before: one 5 s busy wait per pane on a locked ledger)
      for (const [name, seat] of [['a', SEAT], ['b', SEAT], ['c', 'OTHER-SEAT']] as const)
        core.newPane({ ws: 'main', name, command: ['bash'], cwd: join(dir, 'seats', seat) } as never);
      core.start();
      const badgesOf = () => (JSON.parse((core.list() as { message: string }).message) as { panes: Array<{ seat: string | null; unreadMail: { count: number } | null }> })
        .panes.map((p) => [p.seat, p.unreadMail?.count ?? null]);
      // a writer holds the ledger (rollback journal: readers wait out busy_timeout)
      lock = new Database(join(dir, 'msg', 'messages.db'));
      lock.exec('BEGIN EXCLUSIVE');
      const started = performance.now();
      const locked = badgesOf();
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(1_000);   // 출처: JUD #39000 FU — ls 는 잠긴 원장에 수 초씩 막히지 않는다(짧은 대기 100ms 한 번)
      expect(locked).toEqual([[SEAT, null], [SEAT, null], ['OTHER-SEAT', null]]);
      lock.exec('ROLLBACK');
      expect(badgesOf()).toEqual([[SEAT, 1], [SEAT, 1], ['OTHER-SEAT', 1]]);
    } finally {
      lock?.close();
      if (prevEnv === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = prevEnv;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
