// WAKE-FOLD-IDEMPOTENT (P0 · OP 11-25 19:43 · retro #40133): `tui.wakeup folded {"id":"w473","why":"cap","ids":["w471","w438"]}`
// re-folded its own bundle every 30 s (w475…w489, then 20:05 w505 ⊃ w503), truncated the original texts and refused with
// «예약 상한 20개 … 시각 지난 대기 29개». Expected values are independent literals (no product constants or renderers).
import { describe, expect, test } from 'bun:test';
import { createWakeupScheduler, type WakeupEntry, type WakeupPersistence } from './schedule-wakeup.js';

const START = new Date(2026, 10, 25, 19, 0, 0, 0).getTime();

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

/** A reason long enough that 29 of them far exceed the old 2,000-character fold limit. */
const longReason = (i: number) => `retro-step-${i} `.padEnd(180, 'x') + `END-${i}`;

function rig(opts: { inbox?: boolean; persist?: WakeupPersistence } = {}) {
  const clock = fakeClock();
  let open = false;
  const opened: string[] = [];
  const inbox: Array<{ text: string; count: number }> = [];
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const s = createWakeupScheduler({
    startTurnIfIdle: (text) => {
      if (!open) return { opened: false, reason: 'NotIdle', detail: 'turn-running' };
      opened.push(text);
      return { opened: true, turnId: `auto-${opened.length}` };
    },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    log: (_c, event, data) => { logs.push({ event, data }); },
    turnLifeLog: () => {},
    notify: () => {},
    ...(opts.inbox ? { deliverQueued: (text: string, meta: { ids: string[]; count: number }) => { inbox.push({ text, count: meta.count }); return true; } } : {}),
    ...(opts.persist ? { persist: opts.persist } : {}),
  });
  return { s, clock, opened, inbox, logs, setOpen: (v: boolean) => { open = v; } };
}

/** 29 one-shots, all past due by 2–4 minutes on a busy seat. */
function pile29(r: ReturnType<typeof rig>) {
  for (let i = 0; i < 20; i++) expect(r.s.schedule({ delaySeconds: 60, reason: longReason(i) }).ok).toBe(true);
  r.clock.advance(2 * 60_000);
  for (let i = 20; i < 29; i++) expect(r.s.schedule({ delaySeconds: 60, reason: longReason(i) }).ok).toBe(true);
  r.clock.advance(2 * 60_000);
}

describe('WAKE-FOLD-IDEMPOTENT ② — overdue wakes never count toward the cap 20', () => {
  test('29 past-due + 20 upcoming are all accepted; the 21st upcoming is refused', () => {
    const r = rig();
    pile29(r);
    expect(r.s.list()).toHaveLength(29);
    for (let i = 0; i < 20; i++) expect(r.s.schedule({ delaySeconds: 3600 + i, reason: `up-${i}` }).ok).toBe(true);
    expect(r.s.list()).toHaveLength(49);
    const over = r.s.schedule({ delaySeconds: 7200, reason: 'up-20' });
    expect(over.ok).toBe(false);
    expect(over.ok ? '' : over.error).toContain('앞으로 올 예약 20');
  });
});

describe('WAKE-FOLD-IDEMPOTENT ① — 29 overdue → ONE delivery with 29 full reasons at the idle boundary', () => {
  test('the first idle fire carries all 29; no second turn; every reason untruncated; one delivered log line', () => {
    const r = rig();
    pile29(r);
    r.setOpen(true);
    r.clock.advance(60_000); // the next busy retry finds the seat idle
    expect(r.opened).toHaveLength(1);
    const text = r.opened[0]!;
    expect(text).toContain('29건');
    for (let i = 0; i < 29; i++) expect(text).toContain(longReason(i));
    expect(text.length).toBeGreaterThan(29 * 180);
    expect(r.s.list()).toHaveLength(0);
    r.clock.advance(3 * 60 * 60_000);
    expect(r.opened).toHaveLength(1);
    const delivered = r.logs.filter(l => l.event === 'delivered');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.data.count).toBe(29);
    expect(delivered[0]!.data.via).toBe('turn');
  });
});

describe('WAKE-FOLD-IDEMPOTENT ③ — busy past 10 minutes → one queued notice on the next turn\'s inbox', () => {
  test('a seat busy for hours gets exactly one inbox notice with all 29 reasons; nothing is re-scheduled or dropped', () => {
    const r = rig({ inbox: true });
    pile29(r);
    expect(r.inbox).toHaveLength(0); // 2–4 minutes late: still trying the door
    r.clock.advance(10 * 60_000);
    expect(r.inbox).toHaveLength(1);
    expect(r.inbox[0]!.count).toBe(29);
    for (let i = 0; i < 29; i++) expect(r.inbox[0]!.text).toContain(longReason(i));
    expect(r.s.list()).toHaveLength(0);
    r.clock.advance(5 * 60 * 60_000);
    expect(r.inbox).toHaveLength(1);
    expect(r.opened).toHaveLength(0);
    const delivered = r.logs.filter(l => l.event === 'delivered');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.data).toMatchObject({ via: 'turn-inbox', count: 29 });
  });

  test('an inbox that refuses keeps the wakes (never dropped) and the door path continues', () => {
    const clock = fakeClock();
    const s = createWakeupScheduler({
      startTurnIfIdle: () => ({ opened: false, reason: 'NotIdle', detail: 'turn-running' }),
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      log: () => {}, turnLifeLog: () => {}, notify: () => {},
      deliverQueued: () => false,
    });
    s.schedule({ delaySeconds: 60, reason: 'keep me' });
    clock.advance(45 * 60_000);
    expect(s.list().map(e => e.reason)).toEqual(['keep me']);
  });
});

describe('WAKE-FOLD-IDEMPOTENT ① — folding is idempotent (a bundle is never re-folded)', () => {
  test('a later stale wake merges into the same bundle id; a refold attempt with nothing new is a no-op', () => {
    const r = rig();
    for (let i = 0; i < 20; i++) r.s.schedule({ delaySeconds: 60, reason: longReason(i) });
    r.clock.advance(35 * 60_000); // all 20 are stale (> 30 min late)
    const first = r.s.schedule({ delaySeconds: 60, reason: 'x-stale-later' });
    expect(first.ok).toBe(true);
    expect(first.ok ? first.folded : null).toEqual({ id: 'w21', count: 20 });
    expect(first.ok ? first.entry.id : '').toBe('w22');
    r.clock.advance(40 * 60_000); // the bundle and x are now 40 min late — the old code re-wrapped w21 here
    for (let i = 0; i < 20; i++) expect(r.s.schedule({ delaySeconds: 3600 + i, reason: `up-${i}` }).ok).toBe(true);
    const merge = r.s.schedule({ delaySeconds: 7200, reason: 'over-1' }); // cap hit → fold attempt merges x into w21
    expect(merge.ok).toBe(false);
    const bundles = r.s.list().filter(e => e.bundle);
    expect(bundles.map(e => e.id)).toEqual(['w21']);
    expect(bundles[0]!.bundle!.map(b => b.id)).toContain('w22');
    expect(bundles[0]!.bundle).toHaveLength(21);
    for (let i = 0; i < 20; i++) expect(bundles[0]!.reason).toContain(longReason(i));
    const foldsBefore = r.logs.filter(l => l.event === 'folded').length;
    const again = r.s.schedule({ delaySeconds: 7300, reason: 'over-2' }); // refold attempt: nothing stale → no-op
    expect(again.ok).toBe(false);
    expect(r.logs.filter(l => l.event === 'folded').length).toBe(foldsBefore);
    expect(r.s.list().filter(e => e.bundle).map(e => e.id)).toEqual(['w21']);
    expect(r.s.list().find(e => e.id === 'w21')!.bundle).toHaveLength(21);
  });

  test('a persisted bundle survives restart with its items and is not wrapped into a new bundle', () => {
    let data: WakeupEntry[] = [
      { id: 'w473', reason: 'bundle', dueAt: START - 40 * 60_000, retried: true, fireCount: 0,
        bundle: [{ id: 'w438', dueAt: START - 90 * 60_000, reason: 'retro instruction A' }, { id: 'w471', dueAt: START - 50 * 60_000, reason: 'retro instruction B' }] },
      { id: 'w480', reason: 'stale single', dueAt: START - 45 * 60_000, retried: true, fireCount: 0 },
    ];
    const persist: WakeupPersistence = { load: () => data.map(e => ({ ...e })), save: (e) => { data = e.map(x => ({ ...x })); } };
    const r = rig({ persist });
    const ids = r.s.list().map(e => e.id);
    expect(ids).toEqual(['w473']);
    const b = r.s.list()[0]!;
    expect(b.bundle!.map(i => i.id)).toEqual(['w438', 'w471', 'w480']);
    expect(b.reason).toContain('retro instruction A');
    expect(b.reason).toContain('stale single');
    expect(data.map(e => e.id)).toEqual(['w473']);
  });
});
