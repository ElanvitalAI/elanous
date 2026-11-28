// STEWARD-HQ 11-28 — hand-steward «ready» = the `eln work next` board: unowned OR coordinator-held. 22:18Z the body
// said idle_hands_with_ready_cells 0 «충족» while the 0.3.39 roster sat under OP/TC (53 ready) and the 19 unowned cells
// had no done-when (filtered as needs-spec) — a false green. Expected values are literals (rule 11).
import { describe, expect, test } from 'bun:test';
import { coordinatorTest, createBody, isReady, pairs, type Cell, type HandStewardDeps } from './hand-steward.js';

const T0 = new Date('2026-11-28T22:18:00Z');
const cell = (id: string, over: Partial<Cell> = {}): Cell => ({ id, title: id, status: 'yellow', paths: [], ...over });

describe('hand-steward board-ready', () => {
  test('coordinatorTest: HQ and ladder depth 2 are coordinators · hands and an unreadable ladder are not', () => {
    const depth: Record<string, number> = { TC: 2, JUD: 2, RES: 2 };
    const is = coordinatorTest({ hq: 'OP', depthOf: (s) => depth[s] ?? 3 });
    expect(['OP', 'OP/claude', 'tc', 'RES', 'TC-H-CX-6', 'HAND-ELN-TA', ''].map(is)).toEqual([true, true, true, true, false, false, false]);
    expect(coordinatorTest(null)('OP')).toBe(false);
  });

  test('isReady: unowned · coordinator-held = ready · hand-held · umbrella · open predecessor = not', () => {
    const closed = new Set(['DONE-1']);
    expect([
      isReady(cell('U'), closed),
      isReady(cell('C', { owner: 'OP', coordinatorHeld: true }), closed),
      isReady(cell('H', { owner: 'TC-H-CX-1' }), closed),
      isReady(cell('UMB', { owner: 'OP', coordinatorHeld: true, dispatchKind: 'umbrella' }), closed),
      isReady(cell('P', { owner: 'TC', coordinatorHeld: true, predecessors: ['OPEN-1'] }), closed),
      isReady(cell('P2', { owner: 'TC', coordinatorHeld: true, predecessors: ['DONE-1'] }), closed),
      isReady(cell('G', { status: 'green' }), closed),
    ]).toEqual([true, true, false, false, false, true, false]);
  });

  test('pairs: idle maker hand ↔ coordinator-held P0 first · judge hand and hand-held cells left out', () => {
    const got = pairs(
      [{ seat: 'TC-H-REMOTE-1', state: 'idle', since: T0.getTime() - 3 * 60_000 }, { seat: 'JUD-3', state: 'idle', since: T0.getTime() - 9 * 60_000, judge: true }],
      [cell('YAML-FIRST-RATCHET', { owner: 'TC', coordinatorHeld: true, priority: 'P1' }), cell('THEME-UNTANGLE', { owner: 'OP', coordinatorHeld: true, priority: 'P0' }),
        cell('SMART-MERGE-UNIFY', { owner: 'TC-H-CX-2', priority: 'P0' })],
      {});
    expect(got.map((p) => `${p.cell.id}@${p.hand.seat}`)).toEqual(['THEME-UNTANGLE@TC-H-REMOTE-1']);
  });

  test('observe: the 11-28 board (coordinator-held only) is a breach, not «충족»', async () => {
    const deps: HandStewardDeps = {
      readHands: () => [{ seat: 'TC-H-REMOTE-1', state: 'idle', since: T0.getTime() - 2 * 60_000 }, { seat: 'TC-H-CX-6', state: 'working', cell: 'X' }],
      readCells: () => ({ version: '0.3.39', cells: [cell('THEME-UNTANGLE', { owner: 'OP', coordinatorHeld: true, priority: 'P0' }), cell('ELN-TEST-SANDBOX', { owner: 'TC', coordinatorHeld: true, priority: 'P1' })] }),
      readHints: () => ({}), hint: () => {}, unhint: () => false, modelFor: () => ({ line: 'model: easy', tier: 'easy' }), post: () => 1, wake: () => 'woke',
    };
    const body = createBody({ stateRoot: '/nonexistent', card: undefined } as never, deps);
    const obs = await body.observe({ now: T0 } as never);
    expect(obs.kpi).toBe(1);
    expect(obs.facts).toEqual(['판 0.3.39 · 놀고 있는 손 1(힌트 대기 0) · 준비 칸 2(조율자 보유 2 · 힌트 0) · 유휴 손-분 2']);
    expect(body.plan(obs, { now: T0 } as never).map((a) => [a.action, a.target])).toEqual([['assign', 'THEME-UNTANGLE@TC-H-REMOTE-1']]);
  });
});
