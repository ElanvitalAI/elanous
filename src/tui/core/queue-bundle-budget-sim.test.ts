/**
 * SIM — SEAT-MAIL-BUNDLE-BUDGET (OP-STRUCTURAL item 4 · 11-26 21:41 «✘ Could not process the request»). Today's shape:
 * the OP TUI released 49 queued items (1 wake + 47 retried seat mails) as ONE bundle turn; the bundle alone exceeded the
 * turn's history allowance (used 96 157 vs cap 71 650 tokens), the turn failed before the provider call and all 47 mails
 * gave up unread — every ~3 min from 19:55 to 21:45. Seeds 1–5 vary mail count and size. Each run drains the queue the
 * way the TUI does (one bundle per turn) and checks every bundle fits, nothing is lost, order is kept.
 */
import { describe, expect, test } from 'bun:test';
import { createNextTuiQueue, NOTICE_BUNDLE_MAX_CHARS } from './queue.js';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

describe('SIM bundle budget — seeds 1–5', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: 40–60 seat mails of 300–2 500 chars drain in bundles that each fit, none lost, order kept`, () => {
      const r = rng(seed);
      const n = 40 + Math.floor(r() * 21);
      const queue = createNextTuiQueue({ log: () => {} });
      const texts: string[] = [];
      for (let i = 0; i < n; i++) {
        const text = `[seat-mail #${184200 + i}] ${'가'.repeat(300 + Math.floor(r() * 2200))}`;
        texts.push(text); queue.enqueueNotice(text, 'seat-mail', { msgId: 184200 + i });
      }
      const total = texts.reduce((a, t) => a + t.length, 0);
      expect(total).toBeGreaterThan(NOTICE_BUNDLE_MAX_CHARS); // 출처: the shape under test — today's bundle was over the budget
      const delivered: string[] = []; let turns = 0;
      for (;;) {
        const d = queue.drainNotices();
        if (d.kind !== 'notices') break;
        turns += 1;
        const size = d.notices.reduce((a, x) => a + x.text.length, 0);
        expect(size <= NOTICE_BUNDLE_MAX_CHARS).toBe(true);
        delivered.push(...d.notices.map(x => x.text));
        expect(d.remaining).toBe(n - delivered.length);
      }
      expect(delivered).toEqual(texts);
      expect(turns).toBe(Math.max(2, turns)); // more than one turn: the old single bundle is gone
    });
  }
  test('one mail larger than the budget still goes (alone) — the queue never wedges', () => {
    const queue = createNextTuiQueue({ log: () => {} });
    queue.enqueueNotice('x'.repeat(NOTICE_BUNDLE_MAX_CHARS + 5), 'seat-mail', { msgId: 1 });
    queue.enqueueNotice('small', 'seat-mail', { msgId: 2 });
    const first = queue.drainNotices();
    expect(first.kind === 'notices' ? first.notices.map(x => x.msgId) : []).toEqual([1]);
    const second = queue.drainNotices();
    expect(second.kind === 'notices' ? second.notices.map(x => x.msgId) : []).toEqual([2]);
  });
  test('short mails (the old 50-in-one-turn case) still drain as ONE bundle', () => {
    const queue = createNextTuiQueue({ log: () => {} });
    for (let i = 1; i <= 50; i++) queue.enqueueNotice(`알림 ${i}`, 'seat-mail');
    const d = queue.drainNotices();
    expect(d.kind === 'notices' ? d.notices.length : 0).toBe(50);
  });
});
