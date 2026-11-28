// STEWARD-HQ shadow — fixture snapshot / facts → expected rows. Expected values are literals (rule 11).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fact } from '../../fed-state/ledger.js';
import { hqShadowPath, hqShadowReport, loadHqPolicy, parseHqPolicy, planHqPairs, readHqShadow, recordHqShadow, replayHqShadow, type HqPolicy } from './hq-shadow.js';
import type { Snapshot } from './model.js';
import { checklistStatusArgs } from './sources.js';

const NOW = Date.parse('2026-11-28T00:30:00.000Z');
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();
const POLICY: HqPolicy = { mode: 'shadow', caps: { assign: 4, pregate: 3, judge: 2 }, idleMin: 2, priorities: ['P0', 'P1'], stallMin: 120, matchLeadMin: 10, agreementTarget: 0.9 };

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    nowMs: NOW, hq: 'OP', coordinators: ['JUD', 'MK', 'TC'],
    parent: { 'TC-H-1': 'TC', 'TC-H-2': 'TC', 'TC-H-3': 'TC', 'TC-H-4': 'TC', 'JUD-B': 'JUD', TC: 'OP', JUD: 'OP', MK: 'OP' },
    seats: [
      { seat: 'TC-H-1', activity: 'idle', idleForMs: 5 * 60_000 },
      { seat: 'TC-H-2', activity: 'idle', idleForMs: 30 * 60_000 },
      { seat: 'TC-H-3', activity: 'idle', idleForMs: 60_000 },
      { seat: 'TC-H-4', activity: 'idle', idleForMs: 20 * 60_000 },
      { seat: 'JUD-B', activity: 'idle', idleForMs: 90 * 60_000 },
      { seat: 'MK', activity: 'idle', idleForMs: 40 * 60_000 },
    ],
    version: '0.3.39',
    cells: [
      { id: 'HQ-OLD-P0', title: 'x', status: 'yellow', owner: 'OP', priority: 'P0', updatedAt: ago(300) },
      { id: 'HQ-P1', title: 'y', status: 'yellow', priority: 'P1', updatedAt: ago(500) },
      { id: 'TC-NEW-P0', title: 'z', status: 'yellow', owner: 'TC', priority: 'P0', updatedAt: ago(10) },
      { id: 'MINE', title: 'm', status: 'yellow', owner: 'TC-H-2', priority: 'P1', updatedAt: ago(10) },
      { id: 'LOW', title: 'l', status: 'yellow', priority: 'P2', updatedAt: ago(900) },
      { id: 'DONE', title: 'd', status: 'green', priority: 'P0', updatedAt: ago(900) },
    ],
    prs: [], merged: [], receipts: [], verdicts: [], hosts: [], utilAgeMs: null,
    openHands: [{ receiver: 'TC', waitedMs: 60_000, sender: 'TC-H-4' }],
    sourceErrors: [],
    ...over,
  };
}

let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hq-shadow-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('steward:hq shadow', () => {
  test('the shipped policy holds the §5a caps and starts in shadow', () => {
    const p = loadHqPolicy();
    expect(p.mode).toBe('shadow');
    expect(p.caps).toEqual({ assign: 4, pregate: 3, judge: 2 });
    expect(p.agreementTarget).toBe(0.9);
    expect(() => parseHqPolicy('mode: live\ncaps: {assign: 4, pregate: 3, judge: 2}\npriorities: [P0]\nidle_min: 2\nstall_min: 1\nmatch_lead_min: 1\nagreement_target: 0.9')).toThrow('mode must be shadow|off');
  });

  test('free = idle ≥ idle_min ∧ WIP 0 ∧ not waiting · best backlog cell (P0 · oldest) · maker ≠ judge', () => {
    const t = planHqPairs(snap(), POLICY, { at: ago(0), runId: 'r1', source: 'tick' });
    // idle ≥ 2 min: TC-H-1 · TC-H-2 · TC-H-4 · JUD-B (TC-H-3 is 1 min · MK is a coordinator, not a hand)
    expect(t.idle).toBe(4);
    // TC-H-2 owns MINE (WIP 1) · TC-H-4 waits on its ✋
    expect(t.free).toBe(2);
    expect(t.pairs).toEqual([{ hand: 'TC-H-1', from: 'TC', cell: 'HQ-OLD-P0', to: 'OP', priority: 'P0', side: 'maker', idleMin: 5 }]);
    expect(t.noCell).toBe(1); // JUD-B: no judge-side backlog
    expect(t.inScope).toBe(0);
    expect(t.backlog).toEqual({ OP: 2, TC: 1 });
    expect(t.coords).toEqual(['OP', 'JUD', 'MK', 'TC']);
  });

  test('the assign cap holds per tick', () => {
    const seats = ['A', 'B', 'C', 'D', 'E'].map((x) => ({ seat: `TC-H-${x}`, activity: 'idle', idleForMs: 10 * 60_000 }));
    const parent = Object.fromEntries(seats.map((s) => [s.seat, 'TC']));
    const cells = ['1', '2', '3', '4', '5'].map((n) => ({ id: `C${n}`, title: n, status: 'yellow', priority: 'P0', updatedAt: ago(Number(n)) }));
    const t = planHqPairs(snap({ seats, parent, cells, openHands: [] }), POLICY, { at: ago(0), runId: 'r', source: 'tick' });
    expect(t.pairs.length).toBe(4);
    expect(t.overCap).toBe(1);
  });

  test('shadow writes one line per tick under the HQ scope · off writes nothing', () => {
    expect(recordHqShadow(root, snap(), { at: ago(0), runId: 'r-off' }, { ...POLICY, mode: 'off' })).toBeNull();
    expect(existsSync(hqShadowPath(root, 'OP'))).toBe(false);
    recordHqShadow(root, snap(), { at: ago(0), runId: 'r-on' }, POLICY);
    expect(hqShadowPath(root, 'OP')).toBe(join(root, 'steward', 'space', 'OP', 'hq-shadow.jsonl'));
    expect(readFileSync(hqShadowPath(root, 'OP'), 'utf8').trim().split('\n').length).toBe(1);
    expect(readHqShadow(root, 'OP', new Date(NOW - 60_000), new Date(NOW + 60_000)).map((t) => t.runId)).toEqual(['r-on']);
    expect(readHqShadow(root, 'OP', new Date(NOW + 60_000), new Date(NOW + 120_000))).toEqual([]);
  });

  test('replay runs the same plan over the kept R0 snapshots', () => {
    mkdirSync(join(root, 'steward', 'space', 'runs'), { recursive: true });
    writeFileSync(join(root, 'steward', 'space', 'runs', 'run-a.json'), JSON.stringify({ runId: 'run-a', startedAt: ago(20), snapshot: snap() }));
    writeFileSync(join(root, 'steward', 'space', 'runs', 'torn.json'), '{');
    const ticks = replayHqShadow(root, new Date(NOW - 60 * 60_000), new Date(NOW), POLICY);
    expect(ticks.map((t) => [t.runId, t.source, t.pairs.length])).toEqual([['run-a', 'replay', 1]]);
  });

  test('report: same cell = match · OP to a coordinator seat is kept apart · steward-live vs tab', () => {
    const tick = planHqPairs(snap(), POLICY, { at: ago(30), runId: 'r', source: 'tick' });
    const facts: Fact[] = [
      { ts: ago(25), type: 'cell', state: 'assign', decidedBy: 'OP', cell: 'HQ-OLD-P0', to: 'TC-H-1', kind: '[steward RO-1] P0 stalled' },
      { ts: ago(24), type: 'cell', state: 'assign', decidedBy: 'OP', cell: 'HQ-P1', to: 'MK', kind: '[steward RO-2] P1 stalled' },
      { ts: ago(20), type: 'cell', state: 'assign', decidedBy: 'OP', cell: 'TC-NEW-P0', to: 'TC-H-9', kind: '[행정관 · OP] stalled-from:TC · lent from TC' },
      { ts: ago(10), type: 'work', state: 'claimed', seat: 'TC-H-4', cell: 'X' },
      { ts: ago(10), type: 'cell', state: 'assign', decidedBy: 'TC', cell: 'Y', to: 'TC-H-4' },
    ];
    const r = hqShadowReport({ hq: 'OP', since: new Date(NOW - 60 * 60_000), until: new Date(NOW), ticks: [tick], facts, policy: POLICY,
      ledgerRows: [{ action: 'reject', reason: 'assign-failed:wip1', target: 'Q' }, { action: 'defer', reason: 'tick-cap', target: 'R' }] });
    expect(r.wouldPair).toBe(1);
    expect(r.pairs[0]!.match).toBe('cell');
    expect(r.opAssigned).toEqual({ tab: 2, stewardLive: 1, claims: 1, toCoordinator: 1 });
    expect(r.acts.map((a) => [a.hand, a.predicted])).toEqual([['TC-H-1', true], ['MK', false], ['TC-H-9', false]]);
    expect(r.agreementRaw).toBe(0.5); // (1 pair + 1 act) / (1 + 3)
    expect(r.agreement).toBe(0.67); // (1 + 1) / (1 + 2) — the act to MK (coordinator) is not compared
    expect(r.exceptions).toEqual({ count: 1, top: ['reject:assign-failed 1'] });
    expect(r.idleNow).toEqual({ idle: 4, free: 2, inScope: 0, noCell: 1, overCap: 0 });
  });

  // STEWARD-HQ 11-28 22:10Z: the board read carried no --version → the installed eln read the published 0.3.38 board
  // (yellow 4 · all P2) while 0.3.39 was in play → backlog {} · «free 6 · no backlog 6» · would-pair 0.
  test('11-28 replay: the published board yields backlog 0 · the board in play yields a pair · the report names the board', () => {
    const idleHands = { seats: [{ seat: 'TC-H-REMOTE-1', activity: 'idle' as const, idleForMs: 140_132 }, { seat: 'JUD-3', activity: 'idle' as const, idleForMs: 547_919 }],
      parent: { 'TC-H-REMOTE-1': 'OP', 'JUD-3': 'JUD', TC: 'OP', JUD: 'OP', MK: 'OP' }, openHands: [] };
    const published = planHqPairs(snap({ ...idleHands, version: '0.3.38', cells: [
      { id: 'OLD-P2', title: 'p2', status: 'yellow', priority: 'P2', updatedAt: ago(900) },
      { id: 'OLD-GREEN', title: 'g', status: 'green', priority: 'P0', updatedAt: ago(900) },
    ] }), POLICY, { at: ago(0), runId: 'r38', source: 'replay' });
    expect([published.free, published.noCell, published.pairs.length, published.version]).toEqual([2, 2, 0, '0.3.38']);
    expect(published.backlog).toEqual({});
    const inPlay = planHqPairs(snap({ ...idleHands, version: '0.3.39', cells: [
      { id: 'THEME-UNTANGLE', title: 't', status: 'yellow', owner: 'OP', priority: 'P0', updatedAt: ago(60) },
      { id: 'YAML-FIRST-RATCHET', title: 'y', status: 'yellow', owner: 'TC', priority: 'P1', updatedAt: ago(60) },
    ] }), POLICY, { at: ago(0), runId: 'r39', source: 'replay' });
    expect(inPlay.pairs).toEqual([{ hand: 'TC-H-REMOTE-1', from: 'OP', cell: 'THEME-UNTANGLE', to: 'OP', priority: 'P0', side: 'maker', idleMin: 2 }]);
    expect(inPlay.backlog).toEqual({ OP: 1, TC: 1 });
    expect(inPlay.noCell).toBe(1); // JUD-3: no judge-side cell
    const r = hqShadowReport({ hq: 'OP', since: new Date(NOW - 60 * 60_000), until: new Date(NOW + 60_000), ticks: [inPlay], facts: [], policy: POLICY });
    expect(r.board).toBe('0.3.39');
  });

  test('the board read names its version (never the child package default)', () => {
    expect(checklistStatusArgs('0.3.39')).toEqual(['release', 'checklist', 'status', '--version', '0.3.39', '--json']);
  });
});
