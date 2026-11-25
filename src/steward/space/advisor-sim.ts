// SPACE-ADVISOR sim — replays a ✋ mix against a real temp ledger with a moving clock and reports how many reach the
// coordinator (cards) and OP (escalations). The default mix is TC's 11-25 evening: 55 ✋ (writer/handover 30 · worktree
// path 10 · slot/isolation 8 · scope 5 · cap/criteria 2). `bun scripts/sim-space-advisor.ts` prints the table.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setSystemTime } from 'bun:test';
import { MsgStore } from '../../msg/msg-store.js';
import { buildFederationLadder } from '../../msg/hand-raise-ladder.js';
import { adviseTick, appendPrecedent, SEED_PRECEDENTS, type StewardResolver } from './advisor.js';
export { SEED_PRECEDENTS };

export interface SimHand { readonly reason: string; readonly ctx: Record<string, string>; readonly stewardComputable: boolean }
export interface SimResult { total: number; steward: number; resolved: number; recommended: number; picked: number; auto: number; escalated: number; reachTcPer30m: number; reachOp: number }


export function tcEvening(): SimHand[] {
  const out: SimHand[] = [];
  const add = (n: number, reason: string, computable: number) => { for (let i = 0; i < n; i++) out.push({ reason, ctx: { pr: String(40100 + out.length) }, stewardComputable: i < computable }); };
  add(30, 'writer-conflict', 18); // the steward resolver closes the writer cases the ledger can compute (idle writer / dead lease)
  add(10, 'worktree-path', 0);
  add(8, 'slot', 0);
  add(5, 'scope', 0);
  add(2, 'cap', 0);
  // interleave deterministically (stride 7 over 55 is a permutation) — the evening mixed causes, not blocks
  return out.map((_, i) => out[(i * 7) % out.length]!);
}

/** Interleave the hands over `spanMin` minutes; the coordinator picks `tcPickRate` of cards within 5 min, else stays silent. */
export function runAdvisorSim(hands: readonly SimHand[], opts: { spanMin?: number; tcPickRate?: number } = {}): SimResult {
  const spanMin = opts.spanMin ?? 180;
  const pickEvery = opts.tcPickRate && opts.tcPickRate > 0 ? Math.round(1 / opts.tcPickRate) : 0;
  const dir = mkdtempSync(join(tmpdir(), 'advisor-sim-'));
  try {
    const store = new MsgStore(join(dir, 'm.db'));
    const precedentsPath = join(dir, 'precedents.jsonl');
    for (const p of SEED_PRECEDENTS) appendPrecedent(precedentsPath, p);
    const ladder = buildFederationLadder({ spaces: [{ coordinator: 'TC', seats: ['TC', 'TC-ADV', 'TC-H-1', 'TC-H-2'] }, { coordinator: 'OP', seats: ['OP'] }] });
    const T0 = Date.parse('2026-11-25T11:00:00.000Z');
    let now = T0;
    const computable = new Map<number, boolean>();
    const steward: StewardResolver = (h) => {
      if (!computable.get(h.id)) return { resolved: false };
      store.append({ from: 'TC', to: h.blockedSeat, kind: 'reply', intent: 'decision', replyTo: h.id, refs: ['hand-outcome:resolve', `hand-of:${h.rootId}`, `hand-msg:${h.id}`], body: '[✋ RESOLVED · steward] writer lease expired — take it' });
      return { resolved: true };
    };
    const deps = { ladder, now: () => now, raiseDecision: () => {}, advisor: 'TC-ADV', coordinator: 'TC', precedentsPath, eventsPath: join(dir, 'events.jsonl'), steward, live: true };
    const counts = { steward: 0, resolved: 0, recommended: 0, picked: 0, auto: 0, escalated: 0 };
    const cardsPerWindow = new Map<number, number>();
    const gap = (spanMin * 60_000) / hands.length;
    let cardSeq = 0;
    const tick = () => {
      setSystemTime(new Date(now));
      for (const s of adviseTick(store, deps)) {
        if (s.kind === 'waiting') continue;
        counts[s.kind] += 1;
        if (s.kind === 'recommended') {
          const w = Math.floor((now - T0) / (30 * 60_000));
          cardsPerWindow.set(w, (cardsPerWindow.get(w) ?? 0) + 1);
          cardSeq += 1;
          if (pickEvery && cardSeq % pickEvery === 0) store.append({ from: 'TC', to: 'TC-ADV', kind: 'reply', intent: 'decision', refs: [`advisor-pick:${s.handId}:2`], body: '2' });
        }
      }
    };
    for (let i = 0; i < hands.length; i++) {
      const h = hands[i]!;
      setSystemTime(new Date(now));
      const m = store.append({ from: `TC-H-${(i % 2) + 1}`, to: 'TC', kind: 'request', intent: 'decision', body: `[✋ NEED HUMAN] sim ${i}`,
        refs: [`block:sim-${i}`, `seat:TC-H-${(i % 2) + 1}`, `reason:${h.reason}`, ...Object.entries(h.ctx).map(([k, v]) => `ctx:${k}=${v}`)] });
      computable.set(m.id, h.stewardComputable);
      tick();
      now += gap;
    }
    for (let k = 0; k < 15; k++) { now += 60_000; tick(); }
    setSystemTime();
    store.close();
    return { total: hands.length, ...counts, reachTcPer30m: Math.max(0, ...cardsPerWindow.values()), reachOp: counts.escalated };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
