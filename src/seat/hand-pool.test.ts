// FEDERATION HAND POOL — derived view (no ledger of its own) · POOL borrowing · pool.lend · judge hands excluded.
// Independent literals; fake ledgers; no dynamic imports in test bodies.
import { describe, expect, test } from 'bun:test';
import type { ChecklistItem } from '../release-loop/checklist.js';
import { buildFederationLadder } from '../msg/hand-raise-ladder.js';
import { buildHandPool, handPoolBoardLine, handPoolLines, isJudgeHand, pickPoolHand, poolHands, type HandPoolInput } from './hand-pool.js';
import { landedPrsFromSubjects, paneStatesOf } from './hand-pool-live.js';
import { seatAssign, type SeatAssignDeps } from './seat-assign.js';

const NOW = Date.parse('2026-11-25T08:00:00.000Z');
const H = 3_600_000;
const ladder = buildFederationLadder({ hq: 'OP', spaces: [
  { coordinator: 'OP', seats: ['OP'] },
  { coordinator: 'TC', seats: ['TC', 'TC-H-1', 'TC-H-2', 'TC-H-3'] },
  { coordinator: 'UX', seats: ['UX', 'UX-H-1'] },
  { coordinator: 'JUD', seats: ['JUD', 'JUD-3', 'REVIEW-2'] },
] });
const SEATS = new Set(['OP', 'TC', 'UX', 'JUD', 'TC-H-1', 'TC-H-2', 'TC-H-3', 'UX-H-1', 'JUD-3', 'REVIEW-2', 'CEO']);

const cell = (id: string, owner: string, status: ChecklistItem['status'], updatedAt: string, evidence?: string) =>
  ({ id, owner, status, updatedAt, ...(evidence ? { evidence } : {}) });

function input(over: Partial<HandPoolInput> = {}): HandPoolInput {
  return {
    now: NOW, seats: SEATS, ladder,
    cells: [
      cell('A-1', 'TC-H-1', 'yellow', '2026-11-25T07:00:00.000Z'),
      cell('B-2', 'TC-H-2', 'green', '2026-11-25T06:00:00.000Z'),
      cell('C-3', 'UX-H-1', 'yellow', '2026-11-25T07:30:00.000Z', 'PR #40080 open'),
      cell('D-4', 'TC-H-3', 'yellow', '2026-11-24T20:00:00.000Z', 'landed #40066'),
    ],
    history: [
      { at: '2026-11-25T06:50:00.000Z', by: 'UX', id: 'A-1', field: 'claim', to: 'TC-H-1' },
      { at: '2026-11-25T07:30:00.000Z', by: 'UX', id: 'C-3', field: 'claim', to: { owner: 'UX-H-1', force: true } },
    ],
    landedPrs: new Set([40066]),
    ...over,
  };
}

describe('hand pool view', () => {
  test('hands = declared seats minus HQ, space coordinators, judges and people', () => {
    expect(poolHands(SEATS, ladder)).toEqual(['TC-H-1', 'TC-H-2', 'TC-H-3', 'UX-H-1']);
    expect(isJudgeHand('JUD-3')).toBe(true);
    expect(isJudgeHand('review-2')).toBe(true);
    expect(isJudgeHand('JUDY-1')).toBe(false);
  });

  test('working(scope, cell) from owner ⊕ claim; green cell and landed PR return the hand to idle; lent when scope ≠ home', () => {
    const pool = buildHandPool(input());
    expect(pool.map((e) => [e.seat, e.home, e.state, e.scope ?? null, e.cell ?? null, e.lent])).toEqual([
      ['TC-H-1', 'TC', 'working', 'UX', 'A-1', true],
      ['TC-H-2', 'TC', 'idle', null, null, false],
      ['TC-H-3', 'TC', 'idle', null, null, false],
      ['UX-H-1', 'UX', 'working', 'UX', 'C-3', false],
    ]);
    expect(pool[0]!.since).toBe(Date.parse('2026-11-25T06:50:00.000Z'));
    expect(pool[1]!.since).toBe(Date.parse('2026-11-25T06:00:00.000Z'));
  });

  test('idle longer than N hours = close candidate; a busy pane without a cell is working at home', () => {
    const pool = buildHandPool(input({ idleCloseHours: 6, panes: new Map([['TC-H-2', { state: 'WORKING', since: NOW - 5 * 60_000 }]]) }));
    const byId = Object.fromEntries(pool.map((e) => [e.seat, e]));
    expect(byId['TC-H-3']!.closeCandidate).toBe(true);
    expect(byId['TC-H-2']!.state).toBe('working');
    expect(byId['TC-H-2']!.scope).toBe('TC');
    expect(byId['TC-H-2']!.closeCandidate).toBe(false);
  });

  test('pick: own scope first, then borrow the longest-idle hand of another scope; exited panes are skipped', () => {
    const pool = buildHandPool(input());
    expect(pickPoolHand(pool, 'TC')?.seat).toBe('TC-H-3');
    expect(pickPoolHand(pool, 'UX')?.seat).toBe('TC-H-3');
    // OWNER-IDLE-WAKE: with a pane list read, only hands with a live pane are borrowable (TC-H-2 has an IDLE pane).
    const exited = buildHandPool(input({ panes: new Map([['TC-H-3', { state: 'EXITED', since: NOW - H }], ['TC-H-2', { state: 'IDLE', since: NOW - 2 * H }]]) }));
    expect(pickPoolHand(exited, 'UX')?.seat).toBe('TC-H-2');
  });

  test('no pane / owner idle → wake: registry-only hands are not idle; an owner idle ≥ 10 min on its cell gets the continue line', () => {
    const panes = new Map([
      ['TC-H-1', { state: 'IDLE', since: NOW - 25 * 60_000 }],
      ['UX-H-1', { state: 'IDLE', since: NOW - 3 * 60_000 }],
      ['TC-H-3', { state: 'EXITED', since: NOW - H }],
    ]);
    const pool = buildHandPool(input({ panes }));
    expect(pool.map((e) => [e.seat, e.state, e.ownerIdle ?? false])).toEqual([
      ['TC-H-1', 'working', true],
      ['TC-H-2', 'no-pane', false],
      ['TC-H-3', 'no-pane', false],
      ['UX-H-1', 'working', false],
    ]);
    expect(handPoolBoardLine(pool, NOW)).toBe('🤝 Hand pool — idle 0 · working 2 (lent 1: TC-H-1 TC→UX) · owner idle→wake 1 · no pane 2');
    const lines = handPoolLines(pool, NOW);
    expect(lines).toContain('no pane (2, registry only — not borrowable): TC-H-2 TC-H-3');
    expect(lines).toContain('owner idle → wake (1) — the owner continues its own cell; do not reassign:');
    expect(lines).toContain('  eln seat assign TC-H-1 A-1 --why "owner idle 1h — continue your cell"');
    expect(pickPoolHand(pool, 'TC')).toBeUndefined();
  });

  test('board line', () => {
    expect(handPoolBoardLine(buildHandPool(input({ idleCloseHours: 6 })), NOW))
      .toBe('🤝 Hand pool — idle 2 · working 2 (lent 1: TC-H-1 TC→UX) · close? 1: TC-H-3 12h');
  });

  test('live helpers: landed PR numbers from main subjects · pane states by seat (busiest wins)', () => {
    expect([...landedPrsFromSubjects('fix(x): a (#40038)\nfeat(y): b (#40036)\nchore: no number\n')]).toEqual([40038, 40036]);
    const panes = paneStatesOf([
      { seat: 'TC-H-1', status: { state: 'IDLE', since: 100 } },
      { seat: 'TC-H-1', status: { state: 'WORKING', since: 200 } },
      { seat: 'UX-H-1', status: { state: 'EXITED', since: 300 } },
      { seat: null, status: { state: 'IDLE', since: 1 } },
    ]);
    expect([...panes.entries()]).toEqual([['TC-H-1', { state: 'WORKING', since: 200 }], ['UX-H-1', { state: 'EXITED', since: 300 }]]);
  });
});

describe('seat assign with the pool', () => {
  const CELL: ChecklistItem = { id: 'POOL-1', title: 'pool cell', status: 'yellow', owner: 'UX', doneCriterion: 'green', updatedAt: '2026-11-25T07:00:00.000Z', updatedBy: 'OP' };
  function harness() {
    const calls = { assign: [] as unknown[], post: [] as { to: string; body: string }[], logs: [] as [string, Record<string, unknown>][] };
    const deps: SeatAssignDeps = {
      now: () => new Date(NOW),
      coordinators: () => ({ hq: 'OP', spaces: ['TC', 'UX', 'JUD'] }),
      federationSeats: () => SEATS,
      findCell: (id) => (id === 'POOL-1' ? { version: '0.3.36', item: CELL } : undefined),
      writers: () => [],
      assign: (version, id, seat, options) => { calls.assign.push([version, id, seat, options]); return { from: 'UX', outcome: 'assigned' }; },
      post: (mail) => { calls.post.push(mail); return { id: 501 }; },
      wake: async () => ({ result: 'injected' }),
      pool: () => ({ hosts: ['minim5'], scope: 'read-only test-universe runs', source: 'code-default' }),
      handPool: () => buildHandPool(input()),
      hq: 'OP',
      log: (event, data) => { calls.logs.push([event, data]); },
    };
    return { deps, calls };
  }

  test('POOL from UX borrows the longest-idle TC hand and logs pool.lend via the HQ steward', async () => {
    const { deps, calls } = harness();
    const result = await seatAssign({ seat: 'pool', cellId: 'POOL-1', actor: 'ux' }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seat).toBe('TC-H-3');
    expect(result.lend).toEqual({ from: 'TC', to: 'UX', via: 'steward:OP' });
    expect(calls.assign).toEqual([['0.3.36', 'POOL-1', 'TC-H-3', { actor: 'UX', reason: 'seat assign by UX · pool.lend TC→UX' }]]);
    expect(calls.logs.find(([e]) => e === 'pool.lend')?.[1]).toEqual({ from: 'TC', to: 'UX', via: 'steward:OP', seat: 'TC-H-3', cell: 'POOL-1', version: '0.3.36' });
    expect(calls.post[0]!.to).toBe('TC-H-3');
    expect(calls.post[0]!.body).toContain('borrowed from the TC pool — you return to the pool when this cell is green/done or its PR lands');
  });

  test('a named hand of the actor\'s own scope is not a lend', async () => {
    const { deps, calls } = harness();
    const result = await seatAssign({ seat: 'TC-H-2', cellId: 'POOL-1', actor: 'TC' }, deps);
    expect(result.ok && result.lend).toBe(undefined);
    expect(calls.logs.some(([e]) => e === 'pool.lend')).toBe(false);
  });

  test('judge hands are refused outside the judiciary; POOL with no idle hand is refused', async () => {
    const { deps } = harness();
    const judge = await seatAssign({ seat: 'JUD-3', cellId: 'POOL-1', actor: 'OP' }, deps);
    expect(judge.ok).toBe(false);
    if (!judge.ok) expect(judge.code).toBe('judge-hand');
    const busy = await seatAssign({ seat: 'POOL', cellId: 'POOL-1', actor: 'OP' }, { ...deps, handPool: () => buildHandPool(input({ cells: [
      cell('A-1', 'TC-H-1', 'yellow', '2026-11-25T07:00:00.000Z'), cell('B-2', 'TC-H-2', 'red', '2026-11-25T07:00:00.000Z'),
      cell('E-5', 'TC-H-3', 'yellow', '2026-11-25T07:00:00.000Z'), cell('C-3', 'UX-H-1', 'yellow', '2026-11-25T07:00:00.000Z'),
    ] })) });
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.reason).toBe('seat assign: no idle hand in the federation pool (4 hands, all working) — eln seat pool');
  });
});
