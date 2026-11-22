// ELS-SERVER-MAINLOOP-STARVATION — the els listing never queries the mail ledger on the request path.
// 실측(OP 11-22): els 서버 주 스레드 66% 가 sqlite3_step → pread(우편 원장 131MB · ~127k 줄) — 키 입력 왕복 ~200ms.
// 시험 기대값은 리터럴(제품 상수 재사용 없음): 2_500ms 시계 전진 · 5ms 목록 상한 · 100_000 줄 원장.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createElsCore } from './core.js';
import { emptyJournal, type SpaceJournal } from './space.js';
import { EventEmitter } from 'node:events';
import { createMailBadgeCache, workerCompute, type MailBadgeCompute, type MailBadgeWorkerLike } from './mail-badge-cache.js';
import { createMailBadgeReader } from './mail-badge-worker.js';
import { openMsgStore } from '../msg/msg-store.js';

function fakePty(id: string) {
  return { id, isAlive: () => true, write: () => {}, renderScreen: () => Promise.resolve(`${id} ready\n`), onExit: () => {}, kill: () => {} };
}

function coreWith(dir: string, mailBadges: (seats: readonly string[]) => ReadonlyMap<string, { count: number; oldestCreatedAt: string | null } | null>, seats: readonly string[]) {
  let stored: SpaceJournal = emptyJournal();
  const core = createElsCore({ load: () => stored, save: (journal) => { stored = journal; }, spawn: () => fakePty('pty1') as never, mailBadges });
  seats.forEach((seat, i) => core.newPane({ ws: 'main', name: `p${i}`, command: ['bash'], cwd: join(dir, 'seats', seat) } as never));
  core.start();
  return core;
}

const badgesOf = (core: ReturnType<typeof createElsCore>) =>
  (JSON.parse(core.list().message) as { panes: Array<{ seat: string | null; unreadMail: { count: number } | null }> })
    .panes.map((p) => [p.seat, p.unreadMail?.count ?? null]);

describe('els mail badge cache (ELS-SERVER-MAINLOOP-STARVATION)', () => {
  test('(a) a slow ledger reader is never called on the list path — list answers at once, badges arrive after', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'els-badge-slow-'));
    try {
      let calls = 0;
      // A synchronous 300 ms read: if the listing called it, list() would take ≥ 300 ms.
      const compute: MailBadgeCompute = (request) => {
        calls += 1;
        const until = performance.now() + 300;
        while (performance.now() < until) { /* busy */ }
        return Promise.resolve({ ok: true, changed: true, badges: request.seats.map((seat) => [seat, { count: 7, oldestCreatedAt: '2026-11-22T00:00:00.000Z' }] as const) });
      };
      const cache = createMailBadgeCache({ compute, path: () => join(dir, 'none.db'), log: () => {} });
      const core = coreWith(dir, (seats) => cache.snapshot(seats), ['SEAT-A']);
      const started = performance.now();
      const first = badgesOf(core);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(50);
      expect(calls).toBe(0);
      expect(first).toEqual([['SEAT-A', null]]); // unknown before the first refresh — never «0»
      await cache.settled();
      expect(calls).toBe(1);
      expect(badgesOf(core)).toEqual([['SEAT-A', 7]]);
      cache.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('(b) real worker: a new message shows after the next refresh; within 2 s no second refresh starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'els-badge-worker-'));
    const path = join(dir, 'msg', 'messages.db');
    mkdirSync(join(dir, 'msg'), { recursive: true });
    let clock = 1_000_000;
    const cache = createMailBadgeCache({ path: () => path, now: () => clock, log: () => {} });
    try {
      const store = openMsgStore(path);
      store.post({ from: 'OP', to: 'SEAT-B', body: 'one', kind: 'info' });
      const core = coreWith(dir, (seats) => cache.snapshot(seats), ['SEAT-B']);
      expect(badgesOf(core)).toEqual([['SEAT-B', null]]);
      await cache.settled();
      expect(badgesOf(core)).toEqual([['SEAT-B', 1]]);
      store.post({ from: 'OP', to: 'SEAT-B', body: 'two', kind: 'info' });
      clock += 1_000; // inside the 2 s window: cached value, no refresh
      expect(badgesOf(core)).toEqual([['SEAT-B', 1]]);
      await cache.settled();
      expect(badgesOf(core)).toEqual([['SEAT-B', 1]]);
      clock += 2_500;
      badgesOf(core); // schedules the refresh
      await cache.settled();
      expect(badgesOf(core)).toEqual([['SEAT-B', 2]]);
      store.ack('SEAT-B', 2);
      clock += 2_500;
      badgesOf(core);
      await cache.settled();
      expect(badgesOf(core)).toEqual([['SEAT-B', 0]]);
      store.close();
    } finally {
      cache.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('worker failure keeps the last badges and logs one line per failure streak', async () => {
    let clock = 0;
    let mode: 'ok' | 'crash' = 'ok';
    const lines: string[] = [];
    const compute: MailBadgeCompute = (request) => mode === 'crash'
      ? Promise.reject(new Error('worker exited (1)'))
      : Promise.resolve({ ok: true, changed: true, badges: request.seats.map((seat) => [seat, { count: 3, oldestCreatedAt: null }] as const) });
    const cache = createMailBadgeCache({ compute, now: () => clock, path: () => '/nonexistent/messages.db', log: (line) => lines.push(line) });
    cache.snapshot(['SEAT-C']);
    await cache.settled();
    expect(cache.snapshot(['SEAT-C']).get('SEAT-C')?.count).toBe(3);
    mode = 'crash';
    for (let i = 0; i < 3; i += 1) {
      clock += 2_500;
      cache.snapshot(['SEAT-C']);
      await cache.settled();
    }
    expect(cache.snapshot(['SEAT-C']).get('SEAT-C')?.count).toBe(3);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('worker exited (1)');
    cache.dispose();
  });

  test('a locked ledger: the worker answers busy, the cache keeps the last badges', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'els-badge-lock-'));
    const path = join(dir, 'messages.db');
    let clock = 0;
    const lines: string[] = [];
    const cache = createMailBadgeCache({ path: () => path, now: () => clock, log: (line) => lines.push(line) });
    let lock: Database | undefined;
    try {
      const store = openMsgStore(path);
      store.post({ from: 'OP', to: 'SEAT-D', body: 'one', kind: 'info' });
      store.close();
      cache.snapshot(['SEAT-D']);
      await cache.settled();
      expect(cache.snapshot(['SEAT-D']).get('SEAT-D')?.count).toBe(1);
      lock = new Database(path);
      lock.exec('BEGIN EXCLUSIVE');
      lock.exec("INSERT INTO msg_messages (sender, recipient, body, kind, created_at) VALUES ('OP', 'SEAT-D', 'two', 'info', '2026-11-22T00:00:00.000Z')");
      clock += 61_000; // a forced recount, so the worker must read
      cache.snapshot(['SEAT-D']);
      await cache.settled();
      expect(cache.snapshot(['SEAT-D']).get('SEAT-D')?.count).toBe(1);
      expect(lines.length).toBe(1);
      lock.exec('COMMIT');
      clock += 2_500;
      cache.snapshot(['SEAT-D']);
      await cache.settled();
      expect(cache.snapshot(['SEAT-D']).get('SEAT-D')?.count).toBe(2);
    } finally {
      lock?.close();
      cache.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('(d) 100_000-row ledger, 17 seat panes: list stays under 5 ms once the cache is warm', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'els-badge-big-'));
    const path = join(dir, 'messages.db');
    let clock = 0;
    const cache = createMailBadgeCache({ path: () => path, now: () => clock, log: () => {} });
    try {
      const store = openMsgStore(path);
      store.post({ from: 'OP', to: 'S0', body: 'seed', kind: 'info' });
      store.close();
      const db = new Database(path);
      db.exec(`INSERT INTO msg_messages (sender, recipient, body, kind, created_at)
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
        SELECT 'OP', 'S' || (i % 17), 'body ' || i, 'info', '2026-11-22T00:00:00.000Z' FROM n`);
      db.close();
      const seats = Array.from({ length: 17 }, (_, i) => `S${i}`);
      const core = coreWith(dir, (s) => cache.snapshot(s), seats);
      badgesOf(core);
      await cache.settled();
      const warm = badgesOf(core);
      expect(warm.length).toBe(17);
      expect(warm.find(([seat]) => seat === 'S1')?.[1]).toBe(5883); // 100_000 rows over 17 seats: i % 17 = 1 → 5883
      const times: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        clock += 2_500; // every listing may schedule a refresh — none may run on the list path
        const started = performance.now();
        core.list();
        times.push(performance.now() - started);
        await cache.settled();
      }
      times.sort((a, b) => a - b);
      expect(times[10]!).toBeLessThan(5);
    } finally {
      cache.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('JUD-B #39546 must ①: a late exit of a dropped worker does not fail the request waiting on its replacement', async () => {
    class FakeWorker extends EventEmitter {
      readonly posted: Array<{ id: number }> = [];
      terminated = 0;
      postMessage(message: unknown): void { this.posted.push(message as { id: number }); }
      terminate(): Promise<number> { this.terminated += 1; return Promise.resolve(1); }
    }
    const fakes: FakeWorker[] = [];
    const compute = workerCompute(() => { const w = new FakeWorker(); fakes.push(w); return w as unknown as MailBadgeWorkerLike; });
    const request = { path: '/x/messages.db', seats: ['SEAT-E'], force: false };
    const first = compute(request);
    expect(fakes.length).toBe(1);
    fakes[0]!.emit('error', new Error('boom'));
    await expect(first).rejects.toThrow('boom');
    const second = compute(request);
    expect(fakes.length).toBe(2);              // a new generation took the request
    fakes[0]!.emit('exit', 1);                 // the old worker's exit arrives late
    fakes[0]!.emit('error', new Error('late'));
    fakes[1]!.emit('message', { id: fakes[1]!.posted[0]!.id, ok: true, changed: true, badges: [['SEAT-E', { count: 4, oldestCreatedAt: null }]] });
    expect(await second).toEqual({ ok: true, changed: true, badges: [['SEAT-E', { count: 4, oldestCreatedAt: null }]] });
    const third = compute(request);            // the replacement is still the current worker
    expect(fakes.length).toBe(2);
    fakes[1]!.emit('message', { id: fakes[1]!.posted[1]!.id, ok: true, changed: false });
    expect(await third).toEqual({ ok: true, changed: false });
    compute.dispose?.();
  });

  test('JUD-B #39546 must ②: a non-busy SQL error is a failure — last badges kept, retried with no new write, recovers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'els-badge-schema-'));
    const path = join(dir, 'messages.db');
    let clock = 0;
    const lines: string[] = [];
    const reader = createMailBadgeReader();
    const answers: string[] = [];
    const compute: MailBadgeCompute = (request) => {
      const answer = reader.read(request);
      answers.push(answer.ok ? (answer.changed ? 'changed' : 'unchanged') : `failed:${answer.error}`);
      return Promise.resolve(answer);
    };
    const cache = createMailBadgeCache({ compute, path: () => path, now: () => clock, log: (line) => lines.push(line) });
    const tick = async () => { clock += 2_500; cache.snapshot(['SEAT-F']); await cache.settled(); return cache.snapshot(['SEAT-F']).get('SEAT-F')?.count ?? null; };
    try {
      const store = openMsgStore(path);
      store.post({ from: 'OP', to: 'SEAT-F', body: 'one', kind: 'info' });
      store.close();
      expect(await tick()).toBe(1);
      const db = new Database(path);
      db.exec('ALTER TABLE msg_cursors RENAME TO msg_cursors_away'); // the unread read now fails: no such table
      expect(await tick()).toBe(1);
      expect(await tick()).toBe(1);                // no write in between: read again, not «unchanged»
      expect(answers.slice(1, 3).every((a) => a.startsWith('failed:') && a.includes('msg_cursors'))).toBe(true);
      expect(lines.length).toBe(1);
      db.exec('ALTER TABLE msg_cursors_away RENAME TO msg_cursors');
      db.exec("INSERT INTO msg_messages (sender, recipient, body, kind, created_at) VALUES ('OP', 'SEAT-F', 'two', 'info', '2026-11-22T00:00:00.000Z')");
      db.close();
      expect(await tick()).toBe(2);
      expect(answers[answers.length - 1]).toBe('changed');
    } finally {
      reader.close();
      cache.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
