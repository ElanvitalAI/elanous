/**
 * SIM — FEDERATION MAIL WATCH (CEO 11-26 23:xx). Today's shape on build 2307: TC broadcast a blanket hold to its hands
 * (#178978 «시험·원격·운영·자격 접근 금지», 01:10Z); the hands raised ✋ NEED HUMAN to TC from 01:14Z (TC-H-POOL-1 ×2 ·
 * TC-H-CX-2 ×3 · MOB-1 ×3); TC never answered; 13 h later TC had 52 unacked and every hand was idle. Seeds 1–5 vary the
 * hands, ✋ per hand and times. Expect: one escalation per ✋ cause to OP (P0 · coordinator-silent) · ten minutes later one
 * CEO card per cause · reruns change nothing · the hold shows as «N hands frozen by TC …» first in OP's plan · the unacked
 * line names TC with its oldest age.
 */
import { afterAll, afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HAND_ESCALATION_MAIL_CAP, MsgStore } from './msg-store.js';
import { buildFederationLadder, type CeoCard } from './hand-raise-ladder.js';
import { broadcastHolds, escalationStep, unackedBySeat, unackedLine } from './hand-escalation-step.js';
import { executeNextActions, planNextActions, renderNextActionBlock } from '../loops/op-next-action.js';

const root = mkdtempSync(join(tmpdir(), 'fed-mail-watch-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => { setSystemTime(); });
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const HANDS = ['TC-H-POOL-1', 'TC-H-CX-2', 'MOB-1', 'TC-H-CX-7'];
const ladder = buildFederationLadder({ hq: 'OP', spaces: [{ coordinator: 'TC', seats: ['TC', ...HANDS] }, { coordinator: 'OP', seats: ['OP'] }] });
const at = (iso: string) => { setSystemTime(new Date(iso)); return Date.parse(iso); };

describe('SIM ✋ escalation · broadcast hold · unacked — seeds 1–5', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: TC silent 13 h → OP (P0) → CEO card; hold surfaces first; reruns idempotent`, async () => {
      const r = rng(seed);
      const store = new MsgStore(join(root, `s${seed}.db`));
      const hands = HANDS.slice(0, 2 + Math.floor(r() * 3));
      at('2026-11-26T01:10:00.000Z');
      const hold = hands.map(h => store.append({ from: 'TC', to: h, kind: 'request', body: '시험·원격·운영·자격 접근 금지 — 지시 있을 때까지 대기' }));
      let raised = 0; const causes = new Set<string>();
      for (const h of hands) {
        const n = 1 + Math.floor(r() * 3);
        for (let i = 0; i < n; i++) {
          at(`2026-11-26T01:${String(14 + raised).padStart(2, '0')}:00.000Z`);
          store.append({ from: h, to: 'TC', kind: 'request', intent: 'decision', body: `[✋ NEED HUMAN · ${h}] blocked by the TC hold — may I run tests on minim5?`,
            refs: [`block:hold-${h}`, `seat:${h}`, 'reason:HUMAN_DECISION'] });
          raised++; causes.add(h);
        }
      }
      // 13 h later: one pass escalates every cause once to OP — P0 (intent alert), «coordinator silent», original quoted.
      const now1 = at('2026-11-26T14:14:00.000Z');
      const cards: CeoCard[] = [];
      const deps = { ladder, now: () => Date.now(), raiseDecision: (c: CeoCard) => { cards.push(c); }, live: true };
      const first = escalationStep(store, deps);
      const fresh1 = first.filter(e => e.fresh);
      expect(fresh1.every(e => e.hop === 'coordinator→OP')).toBe(true);
      const toOp = store.listCreatedBetween(new Date(now1 - 1000).toISOString(), new Date(now1 + 1000).toISOString()).filter(m => m.to === 'OP');
      // One mail per cause at OP, up to the store's escalation-flood cap per window; past it the mails fold into the newest
      // (a counted repeat — not lost). Every frozen hand is still named in OP's (z) action below.
      expect(toOp.length).toBe(new Set(fresh1.map(e => e.mailId)).size);
      expect(toOp.length).toBe(Math.min(causes.size, HAND_ESCALATION_MAIL_CAP));
      // Every raised ✋ is covered: a group lead or one of its members.
      expect(fresh1.reduce((a, e) => a + e.members, 0)).toBe(raised);
      expect(toOp.every(m => m.intent === 'alert' && (m.refs ?? []).includes('coordinator-silent') && m.body.includes('coordinator silent · ✋ #'))).toBe(true);
      expect(escalationStep(store, deps).some(e => e.fresh)).toBe(false); // idempotent per ✋ and hop
      // OP silent 11 more min → one CEO card per cause (copy to the CEO's proxy), then nothing more.
      at('2026-11-26T14:25:00.000Z');
      const second = escalationStep(store, deps);
      expect(second.filter(e => e.fresh && e.hop === 'OP→CEO').length).toBe(toOp.length);
      expect(cards.length).toBe(toOp.length);
      expect(cards.every(c => c.title.startsWith('[✋ NEED HUMAN · '))).toBe(true);
      expect(escalationStep(store, deps).some(e => e.fresh)).toBe(false);
      // The hold: hands frozen behind TC's broadcast, no cells · no expiry.
      const holds = broadcastHolds(store, { ladder, nowMs: Date.now() });
      expect(holds.map(h => [h.coordinator, h.msgId, h.frozen, h.scoped])).toEqual([['TC', hold[0]!.id, [...causes].sort(), false]]);
      // Unacked: TC holds every ✋ unacked, the oldest 13 h.
      const unacked = unackedBySeat(store, Date.now());
      expect(unacked.find(u => u.seat === 'TC')).toMatchObject({ count: raised, oldestMin: 13 * 60 + 11 });
      expect(unackedLine(unacked)).toContain(`TC ${raised} unacked · oldest 13h`);
      // OP's plan: the frozen-hands decision is OP's next action; the mail line heads the block.
      const plan = planNextActions({ now: new Date(Date.now()).toISOString(), version: '0.3.38', cells: [], hands: [], directives: [], handRaises: [], land: null, releases: [], bulletin: { ageMin: 5 },
        holds: holds.map(h => ({ coordinator: h.coordinator, msgId: h.msgId, at: h.at, frozen: h.frozen, scoped: h.scoped, body: h.body })), unacked });
      expect(plan.actions[0]).toMatchObject({ rule: 'z', actor: 'op', key: `z:${hold[0]!.id}` });
      const block = renderNextActionBlock(await executeNextActions(plan, {}, 'live'), plan.goals, plan.mail);
      expect(block).toContain(`NEXT ACTION (do it) — (z) ${causes.size} hands frozen by TC hold #${hold[0]!.id} for 13h — decide: narrow it to named cells ⊕ an expiry, or lift it`);
      expect(block.split('\n')[1]).toBe(`mail: TC ${raised} unacked · oldest 13h${unacked.length > 1 ? block.split('\n')[1]!.slice(`mail: TC ${raised} unacked · oldest 13h`.length) : ''}`);
      store.close();
    });
  }
  test('shadow reports what it would escalate and writes nothing; a scoped hold (cells: ⊕ until:) is marked scoped', () => {
    const store = new MsgStore(join(root, 'shadow.db'));
    at('2026-11-26T01:10:00.000Z');
    store.append({ from: 'TC', to: 'ALL', kind: 'request', body: 'hold on X-1 only', refs: ['cells:X-1', 'until:2026-11-26T03:00:00Z'] });
    at('2026-11-26T01:14:00.000Z');
    store.append({ from: 'MOB-1', to: 'TC', kind: 'request', intent: 'decision', body: '[✋ NEED HUMAN · MOB-1] x', refs: ['block:b1', 'seat:MOB-1', 'reason:HUMAN_DECISION'] });
    at('2026-11-26T02:00:00.000Z');
    const rows = escalationStep(store, { ladder, now: () => Date.now(), raiseDecision: () => { throw new Error('no card in shadow'); }, live: false });
    expect(rows.map(r => [r.hop, r.fresh, r.mailId])).toEqual([['coordinator→OP', true, null]]);
    expect(store.listCreatedBetween('2026-11-26T01:59:00.000Z', '2026-11-26T02:01:00.000Z')).toEqual([]);
    expect(broadcastHolds(store, { ladder, nowMs: Date.now() }).map(h => h.scoped)).toEqual([true]);
    store.close();
  });
});
