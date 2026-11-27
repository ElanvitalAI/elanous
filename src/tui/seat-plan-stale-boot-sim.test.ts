/**
 * SIM — PLAN-STALE-ON-BOOT (CEO 11-26 23:3x · `eln fed snapshot`). Tonight's shape: hand plans held ONE active item from
 * old mail — TC-H-POOL-2 #88550 (11-18) · TC-H-CX-3 #88540 · TC-H-CX-2 #89009 (11-26 00:04) — with 93–245 items queued
 * behind; each TUI boot (every few minutes) queued the active item again, the hand answered «this is a repeat notice»,
 * and the item never closed (it closes only on a finished update_plan). Seeds 1–5 vary the queue depth, mail ages and
 * boots. Expect: an item older than 48 h or already acked expires at the first boot; an answered item re-offered past
 * 2 boots expires; the next item is promoted; a fresh unanswered item is re-offered (a real task is not dropped).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '../msg/msg-store.js';
import { createNextTuiQueue } from './core/queue.js';
import { createSeatPlanFileStore, seatTaskQueueFromPromptQueue, wireSeatMailToPlan, type PlanRevisedEvent } from './seat-mail-boot.js';
import { PLAN_ITEM_MAX_BOOT_OFFERS } from './seat-mail-plan.js';

const SEAT = 'TC-H-POOL-2';
const NOW = Date.parse('2026-11-26T14:30:00.000Z');
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const mail = (id: number, at: number, body: string): Message => ({ id, from: 'TC', to: SEAT, body, createdAt: new Date(at).toISOString() } as unknown as Message);
const ledger = (messages: Message[], cursor = 0) => ({ list: (r: string, after = 0) => messages.filter(m => m.to === r && m.id > after), getCursor: () => cursor, getMessage: () => null });
const boot = (store: ReturnType<typeof createSeatPlanFileStore>, messages: Message[], now: number, cursor = 0, events: PlanRevisedEvent[] = []) => {
  const queue = createNextTuiQueue({ log: () => {} });
  const rt = wireSeatMailToPlan(seatTaskQueueFromPromptQueue(queue), { seat: SEAT, ledger: ledger(messages, cursor), store, now: () => now, onPlanEvent: (_e, d) => events.push(d) });
  return { rt, queue, notices: () => queue.items.filter(i => i.kind === 'notice') };
};

describe('SIM stale plan items at boot — seeds 1–5', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: an 8-day-old active item expires at the first boot and the next item is offered`, () => {
      const r = rng(seed); const root = mkdtempSync(join(tmpdir(), 'plan-stale-')); roots.push(root);
      const store = createSeatPlanFileStore(join(root, `${SEAT}.json`));
      const depth = 3 + Math.floor(r() * 8);
      const old = mail(88550, NOW - 8 * 86_400_000, '#38547 시험 다시 돌리고 보고');
      const fresh = Array.from({ length: depth }, (_, i) => mail(185000 + i, NOW - (60 + i) * 60_000, `#${40300 + i} 시험하고 보고`));
      // Boot 0 (11-18, when the mail was new): absorb, the old item becomes active.
      const b0 = boot(store, [old], NOW - 8 * 86_400_000 + 60_000); b0.rt.absorb();
      expect(b0.rt.plan().find(t => t.status === 'active')!.sourceRequestId).toBe('mail#88550');
      // Later mail is absorbed behind it (still at the old clock: the active item does not change).
      const b1 = boot(store, [old, ...fresh], NOW - 8 * 86_400_000 + 120_000); b1.rt.absorb();
      expect(b1.rt.plan().filter(t => t.status === 'queued').length).toBe(depth);
      // Tonight's boot: the 8-day-old active item expires, one fresh item is offered instead.
      const events: PlanRevisedEvent[] = [];
      const b2 = boot(store, [old, ...fresh], NOW, 0, events);
      const oldItem = b2.rt.plan().find(t => t.sourceRequestId === 'mail#88550')!;
      expect(oldItem).toMatchObject({ status: 'cancelled', doneEvidence: 'expired on boot: mail older than 48h' });
      expect(b2.notices().length).toBe(1);
      expect(b2.notices()[0]!.text).not.toContain('#38547');
      expect(events.map(e => e.reason)).toEqual(['stale-on-boot']);
    });
    test(`seed ${seed}: an answered item re-offered on boot expires after ${PLAN_ITEM_MAX_BOOT_OFFERS} boots; an unanswered one keeps coming back`, () => {
      const r = rng(seed + 50); const root = mkdtempSync(join(tmpdir(), 'plan-stale-')); roots.push(root);
      const store = createSeatPlanFileStore(join(root, `${SEAT}.json`));
      const m = [mail(89009, NOW - 3 * 3_600_000, '#40300 시험하고 보고'), mail(89010, NOW - 2 * 3_600_000, '#40301 시험하고 보고')];
      const first = boot(store, m, NOW - 3 * 3_600_000 + 1000); first.rt.absorb();
      // Never answered: boots keep re-offering it (a real task is not dropped).
      for (let i = 0; i < 2 + Math.floor(r() * 3); i++) {
        const b = boot(store, m, NOW + i * 300_000);
        expect(b.rt.plan().find(t => t.sourceRequestId === 'mail#89009')!.status).toBe('active');
      }
      // A turn answers it («this is a repeat notice») — then each boot re-offer counts; past the cap it expires.
      const answered = boot(store, m, NOW + 3_600_000);
      const notice = answered.notices()[0]!;
      answered.rt.noteTurnAnswered(notice.id);
      let status = 'active'; let boots = 0;
      while (status === 'active' && boots < 10) {
        boots++;
        const b = boot(store, m, NOW + 3_600_000 + boots * 300_000);
        status = b.rt.plan().find(t => t.sourceRequestId === 'mail#89009')!.status;
        if (status !== 'active') expect(b.rt.plan().find(t => t.sourceRequestId === 'mail#89010')!.status).toBe('active');
      }
      expect(status).toBe('cancelled');
      expect(boots).toBe(PLAN_ITEM_MAX_BOOT_OFFERS + 1);
    });
  }
  test('mail the seat already acked (id ≤ cursor) expires at boot', () => {
    const root = mkdtempSync(join(tmpdir(), 'plan-stale-')); roots.push(root);
    const store = createSeatPlanFileStore(join(root, `${SEAT}.json`));
    const m = [mail(88540, NOW - 3_600_000, '#40300 시험하고 보고')];
    boot(store, m, NOW - 3_600_000 + 1000).rt.absorb();
    const b = boot(store, m, NOW, 88540);
    expect(b.rt.plan()[0]).toMatchObject({ status: 'cancelled', doneEvidence: `expired on boot: mail #88540 already acked by ${SEAT}` });
    expect(b.notices()).toEqual([]);
  });
});
