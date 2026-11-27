/**
 * SIM — THROTTLE-AUDIT (CEO 11-27 11:0x «랜딩 10 목표는 그만큼 많은 상류 공급이 필요한데 상한으로 막는 말도 안 되는 상황»).
 * 11-27 live: the next-action planner folded 42 wakes on «OP→hand budget 15/h spent» and hinted at most 8 cells per plan
 * while 25 hands sat idle in front of 39 stalled cells. The budget and the per-plan cap now scale with the pool.
 * Expected values below are literals (not computed from the product constants).
 */
import { describe, expect, test } from 'bun:test';
import { executeNextActions, opHandMailBudgetPerHour, planAssignCap, planNextActions, poolHandCount, type NaCell, type NaHand, type NextActionState } from './op-next-action.js';
import { readPushPolicy } from './op-next-action-live.js';

const T0 = Date.parse('2026-11-27T02:05:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function world(handCount: number, cellCount: number, extra: Partial<NextActionState> = {}): NextActionState {
  const hands: NaHand[] = Array.from({ length: handCount }, (_, i) => ({ seat: `TC-H-${i}`, home: 'TC', state: 'idle' as const, since: T0 - (10 + i) * 60_000 }));
  const cells: NaCell[] = Array.from({ length: cellCount }, (_, i) => ({ id: `STALL-${String(i).padStart(2, '0')}`, title: `stalled ${i}`, status: 'yellow' as const,
    priority: 'P0' as const, doneCriterion: `test ${i} passes`, updatedAt: iso(T0 - (60 + i) * 60_000) }));
  return { now: iso(T0), version: '0.3.38', released: '0.3.37', cells, hands, directives: [], handRaises: [],
    land: { readyToLand: 0, landedLastHour: 3, mode: 'live' }, releases: [], bulletin: { ageMin: 5 }, ...extra };
}

describe('THROTTLE-AUDIT — OP→hand push budget scales with the pool', () => {
  test('11-27 replay: 25 idle hands × 39 stalled cells, 14 OP→hand mails already this hour → every hand hinted and woken, 0 folded', async () => {
    const plan = planNextActions(world(25, 39));
    const pulls = plan.actions.filter(a => a.do === 'pull');
    expect(pulls.length).toBe(25);                    // was 8 (fixed per-plan cap)
    expect(plan.handMailsPerHour).toBe(50);           // 2 per hand × 25
    const sentThisHour = 14;
    const woke: string[] = [];
    const res = await executeNextActions(plan, {
      hint: (e) => `hints ${e.length}`,
      wake: (seat) => { woke.push(seat); return `mail #${woke.length}`; },
      handMailBudget: (cap) => cap - sentThisHour,
    }, 'live');
    expect(woke.length).toBe(25);                     // was 1 (15 − 14)
    expect(new Set(woke).size).toBe(25);              // still one wake per hand
    expect(res.filter(r => r.evidence.includes('wake folded')).length).toBe(0);
  });

  test('the budget still folds once the scaled hour is spent (oscillation/burst guard kept)', async () => {
    const plan = planNextActions(world(25, 39));
    const woke: string[] = [];
    const res = await executeNextActions(plan, { hint: () => 'h', wake: (s) => { woke.push(s); return 'x'; }, handMailBudget: (cap) => cap - 45 }, 'live');
    expect(woke.length).toBe(5);
    const folded = res.filter(r => r.evidence.includes('wake folded (OP→hand budget 50/h spent'));
    expect(folded.length).toBe(20);
  });

  test('a small pool keeps the 15/h and 8/plan floors', () => {
    expect(opHandMailBudgetPerHour(3)).toBe(15);
    expect(planAssignCap(3)).toBe(8);
    expect(opHandMailBudgetPerHour(0)).toBe(15);
    expect(planAssignCap(0)).toBe(8);
  });

  test('judges are not pool hands', () => {
    const hands: NaHand[] = [
      { seat: 'TC-H-1', home: 'TC', state: 'idle' }, { seat: 'JUD-B', home: 'JUD', state: 'idle', judge: true }, { seat: 'TC-H-2', home: 'TC', state: 'working' },
    ];
    expect(poolHandCount(hands)).toBe(2);
    expect(poolHandCount(null)).toBe(0);
  });

  test('policy from config overrides the scaled default; invalid values fall back to it', async () => {
    expect(opHandMailBudgetPerHour(25, { handMailsPerHour: 12 })).toBe(12);
    expect(opHandMailBudgetPerHour(25, { handMailsPerHand: 3 })).toBe(75);
    expect(opHandMailBudgetPerHour(25, { handMailsPerHour: -1, handMailsPerHand: 'x' })).toBe(50);
    expect(planAssignCap(25, { assignPerPlan: 4 })).toBe(4);
    expect(planAssignCap(25, { assignPerPlan: 0 })).toBe(25);
    const plan = planNextActions(world(25, 39, { pushPolicy: { assignPerPlan: 4, handMailsPerHour: 12 } }));
    expect(plan.actions.filter(a => a.do === 'pull').length).toBe(4);
    expect(plan.handMailsPerHour).toBe(12);
  });

  test('readPushPolicy reads config op.next and fails open to {}', () => {
    expect(readPushPolicy(() => ({ op: { next: { handMailsPerHour: 40 } } }))).toEqual({ handMailsPerHour: 40 });
    expect(readPushPolicy(() => ({}))).toEqual({});
    expect(readPushPolicy(() => { throw new Error('unreadable'); })).toEqual({});
  });
});
