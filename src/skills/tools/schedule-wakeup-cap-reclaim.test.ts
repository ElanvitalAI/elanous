// WAKE-CAP-RECLAIM (OP 11-25 12:03:57) — the OP seat held 40 wakes (cap 20 upcoming · total 40): 32 past-due one-shots
// (oldest 5.4h late, fireCount 0) that a busy seat never drained, plus 8 upcoming. A fresh 10-minute wake was refused,
// yet the tool call logged success:true. Expected values below are independent literals.
import { describe, expect, test } from 'bun:test';
import { isExplicitToolRefusal } from '../../core-turn/tool-refusal.js';
import {
  buildScheduleWakeupHostTool,
  createWakeupScheduler,
  type WakeupEntry,
  type WakeupPersistence,
} from './schedule-wakeup.js';

const START = new Date(2026, 10, 25, 6, 0, 0, 0).getTime();

function fakeClock(start = START) {
  let t = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (h: unknown) => { timers.delete(h as number); },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
  };
}

function memoryPersist(initial: WakeupEntry[]): WakeupPersistence & { saved: () => WakeupEntry[] } {
  let data = initial.map(e => ({ ...e }));
  return { load: () => data.map(e => ({ ...e })), save: (entries) => { data = entries.map(e => ({ ...e })); }, saved: () => data };
}

const busy = () => ({ opened: false as const, reason: 'NotIdle' as const, detail: 'turn-running' });

function rig(opts: { persist?: WakeupPersistence; open?: boolean; start?: number } = {}) {
  const clock = fakeClock(opts.start);
  const events: string[] = [];
  const bus: string[] = [];
  const lines: string[] = [];
  const s = createWakeupScheduler({
    startTurnIfIdle: () => (opts.open ? { opened: true, turnId: 'auto-1' } : busy()),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    log: (_c, e, d) => { events.push(`${e}:${String(d.id ?? d.reason ?? '')}`); },
    turnLifeLog: () => {},
    notify: (l) => { lines.push(l); },
    publishEvent: (ev) => { bus.push(ev.dedupeKey); },
    ...(opts.persist ? { persist: opts.persist } : {}),
  });
  return { s, clock, events, bus, lines };
}

describe('WAKE-CAP-RECLAIM — the OP field shape: 32 stale past-due + 8 upcoming = 40', () => {
  test('a fresh wake is accepted: the 32 stale one-shots fold into one digest wake once they pile up to the cap', () => {
    const r = rig();
    for (let i = 0; i < 16; i++) expect(r.s.schedule({ delaySeconds: 60 + i, reason: `old-${i}` }).ok).toBe(true);
    r.clock.advance(2 * 60_000); // the first 16 are past due — only upcoming ones count against 20
    for (let i = 16; i < 32; i++) expect(r.s.schedule({ delaySeconds: 60 + i, reason: `old-${i}` }).ok).toBe(true);
    r.clock.advance(5 * 60 * 60_000); // five hours of a busy seat — none of them could open
    expect(r.s.list()).toHaveLength(32);
    // WAKE-FOLD-IDEMPOTENT ② — past-due wakes never count toward the cap; 32 ≥ 20 past due folds them on the next call.
    const fresh = r.s.schedule({ delaySeconds: 600, reason: 'follow-up in 10 minutes' });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.folded?.count).toBe(32);
    expect(fresh.folded?.id).toBe('w33');
    expect(fresh.entry.id).toBe('w34');
    for (let i = 0; i < 8; i++) expect(r.s.schedule({ delaySeconds: 3600 + i, reason: `up-${i}` }).ok).toBe(true);
    expect(r.s.list()).toHaveLength(10); // 1 digest + 1 fresh + 8 upcoming
    const digest = r.s.list().find(e => e.id === 'w33')!;
    expect(digest.reason.startsWith('늦은 예약 32건 묶음(상한 회수)')).toBe(true);
    expect(digest.reason).toContain('w1@06:01 old-0');
    expect(digest.reason).toContain('w32@06:03 old-31');
    expect(r.events).toContain('folded:w33');
  });

  test('stale past-due one-shots publish a :late bus item so the idle boundary can deliver them', () => {
    const r = rig();
    r.s.schedule({ delaySeconds: 60, reason: 'check once' });
    r.clock.advance(40 * 60_000);
    expect(r.bus).toContain('wakeup:w1:0:late');
  });

  test('refusal is explicit: 20 upcoming → success:false with reason and the oldest five to cancel', async () => {
    const r = rig();
    for (let i = 0; i < 20; i++) expect(r.s.schedule({ delaySeconds: 600 + i * 60, reason: `slot-${i}` }).ok).toBe(true);
    const tool = buildScheduleWakeupHostTool(r.s);
    const out = await tool.handler({ delaySeconds: 600, reason: 'one more' }, {} as never) as Record<string, unknown>;
    expect(out.success).toBe(false);
    expect(out.refused).toBe('wake-cap');
    expect(String(out.error)).toContain('예약 상한 20개(앞으로 올 예약 20 · 전체 20)');
    expect((out.oldest as Array<{ id: string }>).map(e => e.id)).toEqual(['w1', 'w2', 'w3', 'w4', 'w5']);
    expect(isExplicitToolRefusal(out)).toBe(true);
    expect(isExplicitToolRefusal({ ok: true, result: out })).toBe(true);
    expect(isExplicitToolRefusal({ scheduled: { id: 'w9' } })).toBe(false);
    expect(isExplicitToolRefusal({ error: 'invalid' })).toBe(false);
    expect(r.s.list()).toHaveLength(20);
  });

  test('recent past-due wakes (nothing stale to fold) neither block a new wake nor get dropped', () => {
    const r = rig();
    for (let i = 0; i < 20; i++) r.s.schedule({ delaySeconds: 60, reason: `a-${i}` });
    r.clock.advance(61_000);
    for (let i = 0; i < 20; i++) r.s.schedule({ delaySeconds: 60, reason: `b-${i}` });
    r.clock.advance(61_000);
    const next = r.s.schedule({ delaySeconds: 300, reason: 'next' });
    expect(next.ok).toBe(true);
    expect(r.s.list()).toHaveLength(41);
  });
});

describe('WAKE-CAP-RECLAIM — duplicates merge, deferred wakes count once', () => {
  test('the same reason again re-times the existing wake instead of adding one', async () => {
    const r = rig();
    expect(r.s.schedule({ delaySeconds: 600, reason: '10분 뒤 TC 결과 확인' }).ok).toBe(true);
    r.clock.advance(5 * 60_000);
    const again = r.s.schedule({ delaySeconds: 600, reason: '10분 뒤 TC 결과 확인' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.merged).toBe('w1');
    expect(r.s.list()).toHaveLength(1);
    expect(r.s.list()[0]!.dueAt).toBe(START + 15 * 60_000);
    const tool = buildScheduleWakeupHostTool(r.s);
    const out = await tool.handler({ delaySeconds: 900, reason: '10분 뒤 TC 결과 확인' }, {} as never) as Record<string, unknown>;
    expect(out.merged).toBe('w1');
    expect(r.s.list()).toHaveLength(1);
    // a different reason, or a repeat with the same text, is not a duplicate
    expect(r.s.schedule({ delaySeconds: 600, reason: '다른 점검' }).ok).toBe(true);
    expect(r.s.schedule({ repeatMinutes: 60, reason: '10분 뒤 TC 결과 확인' }).ok).toBe(true);
    expect(r.s.list()).toHaveLength(3);
  });

  test('a wake deferred by a busy seat is one entry: 19 upcoming + 1 deferring still leaves the 20th slot', () => {
    const r = rig();
    r.s.schedule({ delaySeconds: 60, reason: 'deferring' });
    r.clock.advance(3 * 60_000); // rejected three times, retrying each minute
    for (let i = 0; i < 19; i++) expect(r.s.schedule({ delaySeconds: 600 + i, reason: `u-${i}` }).ok).toBe(true);
    expect(r.s.list()).toHaveLength(20);
    expect(r.s.schedule({ delaySeconds: 900, reason: 'u-19' }).ok).toBe(true);
    expect(r.s.list()).toHaveLength(21);
  });
});

describe('WAKE-CAP-RECLAIM — a force-killed TUI\'s wakes are re-owned and folded on restore', () => {
  test('restore drops one-shots overdue > 2 h (one line) and folds the remaining stale ones into one digest (RAIL30 ④)', () => {
    const late = (n: number, minutesLate: number): WakeupEntry => ({ id: `w${n}`, reason: `dead-${n}`, dueAt: START - minutesLate * 60_000, retried: true, fireCount: 0 });
    const persist = memoryPersist([
      late(140, 325), late(141, 250), late(151, 115), late(163, 100), late(200, 90),
      { id: 'w156', reason: 'hourly', dueAt: START + 10 * 60_000, repeatMs: 60 * 60_000, expiresAt: START + 6 * 24 * 60 * 60_000, retried: false, fireCount: 2 },
      { id: 'w246', reason: 'upcoming', dueAt: START + 9 * 60_000, retried: false, fireCount: 0 },
    ]);
    const r = rig({ persist });
    const ids = r.s.list().map(e => e.id).sort();
    expect(ids).toEqual(['w156', 'w246', 'w247']);
    expect(r.lines[0]).toBe('⏰ dropped 2 stale wakes (overdue > 2 h at restart): w140@00:35 · w141@01:50');
    const digest = r.s.list().find(e => e.id === 'w247')!;
    expect(digest.reason.startsWith('늦은 예약 3건 묶음(재기동 복원)')).toBe(true);
    expect(digest.reason).toContain('w151@04:05 dead-151');
    expect(digest.reason).toContain('w200@04:30 dead-200');
    expect(persist.saved().map(e => e.id).sort()).toEqual(['w156', 'w246', 'w247']);
    r.clock.advance(1);
    expect(r.bus).toContain('wakeup:w247:0'); // the digest tries at once
  });

  test('a single late one-shot inside 2 h is not folded (restored late as before) · one older than 2 h is dropped', () => {
    const persist = memoryPersist([{ id: 'w7', reason: 'only', dueAt: START - 110 * 60_000, retried: false, fireCount: 0 }]);
    const r = rig({ persist, open: true });
    expect(r.s.list().map(e => e.id)).toEqual(['w7']);
    r.clock.advance(1);
    expect(r.events).toContain('fired:w7');
    expect(r.s.list()).toHaveLength(0);
    const old = rig({ persist: memoryPersist([{ id: 'w8', reason: 'old', dueAt: START - 121 * 60_000, retried: false, fireCount: 0 }]), open: true });
    expect(old.s.list()).toHaveLength(0);
    expect(old.lines).toEqual(['⏰ dropped 1 stale wakes (overdue > 2 h at restart): w8@03:59']);
  });
});
