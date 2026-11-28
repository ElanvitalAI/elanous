// STEWARD-HQ-LIVE-ALIGN — live R1 on the shadow's numbers (graphs/policies/steward-hq.yaml `live`). Fixture = the 11-28
// 22:25Z shape: shadow paired 3 idle TC hands to OP-held roster P0 cells while live R1 wrote 3 × «no-idle-hand-anywhere».
// Expected values are literals (rule 11).
import { describe, expect, test } from 'bun:test';
import { buildFederationLadder } from '../../msg/hand-raise-ladder.js';
import { resolveScope } from './config.js';
import { hqShadowReport, loadHqPolicy, loadLiveR1Policy, parseHqPolicy, parseLiveR1, planHqPairs, type HqPolicy } from './hq-shadow.js';
import { DEFAULT_LIVE_R1, emptyScopeState, planMatch, type Snapshot } from './model.js';
import { buildSnapshot, type SnapshotSources } from './sources.js';
import { recheckAssign } from './tick.js';

const NOW = Date.parse('2026-11-27T22:25:00.000Z');
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();
const live = (scope: string) => resolveScope(scope, 'OP', { scopes: { [scope]: { mode: 'live' } } });

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    nowMs: NOW, hq: 'OP', coordinators: ['JUD', 'TC'],
    parent: { 'TC-H-CC-2': 'TC', 'HAND-TUI-D': 'TC', 'TC-H-CX-1': 'TC', 'TC-H-CX-2': 'TC', 'JUD-3': 'JUD', 'HAND-ELN-TA': 'OP', TC: 'OP', JUD: 'OP' },
    seats: [
      { seat: 'TC-H-CC-2', activity: 'idle', idleForMs: 11 * 60_000 },
      { seat: 'HAND-TUI-D', activity: 'idle', idleForMs: 2 * 60_000 },
      { seat: 'TC-H-CX-1', activity: 'idle', idleForMs: 3 * 60_000 },
      { seat: 'TC-H-CX-2', activity: 'idle', idleForMs: 4 * 60_000 },
      { seat: 'JUD-3', activity: 'idle', idleForMs: 9 * 60_000 },
      { seat: 'HAND-ELN-TA', activity: 'no-pane', idleForMs: null },
    ],
    version: '0.3.39',
    cells: [
      { id: 'THEME-UNTANGLE', title: 't', status: 'yellow', owner: 'OP/claude', priority: 'P0', updatedAt: ago(30) },
      { id: 'JEV-DECIDE-KIT', title: 'j', status: 'yellow', owner: 'OP/claude', priority: 'P0', updatedAt: ago(60) },
      { id: 'RESERVE-P0', title: 'r', status: 'yellow', owner: 'OP', priority: 'P0', updatedAt: ago(30), evidenceHead: '[예비 0.3.39] CEO 11-28 05:4x 로스터 60 밖 예비 20' },
      { id: 'UMB-P0', title: 'u', status: 'yellow', owner: 'OP', priority: 'P0', updatedAt: ago(300), dispatchKind: 'umbrella' },
      { id: 'SMART-MERGE-UNIFY', title: 's', status: 'yellow', owner: 'TC-H-CX-2', priority: 'P0', updatedAt: ago(10) },
    ],
    prs: [], merged: [], receipts: [], verdicts: [], hosts: [], utilAgeMs: null, openHands: [], sourceErrors: [],
    ...over,
  };
}
const assigns = (rows: readonly { action: string; target: string; seat?: string; lentFrom?: string }[]) =>
  rows.filter((r) => r.action === 'assign').map((r) => `${r.target}→${r.seat}${r.lentFrom ? ` (lent ${r.lentFrom})` : ''}`);

describe('live R1 = the shadow numbers', () => {
  test('before (no policy): HQ live assigns nothing — the 2 h clock holds the roster cells, TC hands are not lendable', () => {
    const plan = planMatch(snap(), { scope: live('OP'), state: emptyScopeState() });
    expect(assigns(plan.rows)).toEqual([]);
  });

  test('after: roster P0 cells (oldest first) go to directly lent free hands · reserve · umbrella · hand-held cells stay', () => {
    const plan = planMatch(snap(), { scope: live('OP'), state: emptyScopeState(), r1: DEFAULT_LIVE_R1 });
    expect(assigns(plan.rows)).toEqual(['JEV-DECIDE-KIT→TC-H-CC-2 (lent TC)', 'THEME-UNTANGLE→TC-H-CX-1 (lent TC)']);
  });

  test('a seat another scope acted on this run is not lent again', () => {
    const plan = planMatch(snap(), { scope: live('OP'), state: emptyScopeState(), r1: DEFAULT_LIVE_R1, busySeats: new Set(['TC-H-CC-2']) });
    expect(assigns(plan.rows)).toEqual(['JEV-DECIDE-KIT→TC-H-CX-1 (lent TC)', 'THEME-UNTANGLE→HAND-TUI-D (lent TC)']);
  });

  test('an owner idle 4 min (< 10) is neither woken nor lent · the cap holds', () => {
    const tc = planMatch(snap(), { scope: live('TC'), state: emptyScopeState(), r1: DEFAULT_LIVE_R1 });
    expect(tc.rows.filter((r) => r.seat === 'TC-H-CX-2')).toEqual([]);
    const capped = planMatch(snap(), { scope: resolveScope('OP', 'OP', { scopes: { OP: { mode: 'live', caps: { assign: 1 } } } }), state: emptyScopeState(), r1: DEFAULT_LIVE_R1 });
    expect(capped.rows.map((r) => [r.action, r.target, r.reason])).toEqual([
      ['assign', 'JEV-DECIDE-KIT', 'stalled-from:OP'], ['defer', 'THEME-UNTANGLE', 'tick-cap']]);
  });

  test('the shadow plan uses the same backlog: reserve and umbrella out · no-pane hands listed, never paired', () => {
    const policy: HqPolicy = { ...loadHqPolicy() };
    const t = planHqPairs(snap(), policy, { at: ago(0), runId: 'r', source: 'tick' });
    expect(t.backlog).toEqual({ OP: 2 });
    expect(t.pairs.map((p) => `${p.cell}→${p.hand}`)).toEqual(['JEV-DECIDE-KIT→TC-H-CC-2', 'THEME-UNTANGLE→TC-H-CX-1']);
    expect(t.noPane).toEqual(['HAND-ELN-TA']);
  });
});

describe('op-tab-first re-check', () => {
  const board = [
    { id: 'A', status: 'yellow', owner: 'OP/claude' },
    { id: 'B', status: 'yellow', owner: 'TC-H-POOL-1' },
    { id: 'C', status: 'green', owner: 'OP' },
    { id: 'D', status: 'yellow', owner: 'TC-H-CX-1' },
  ];
  test('owner moved · status moved · gone · hand got a cell since the snapshot → skip; unchanged · a cell it already held (waiting) → go', () => {
    expect([
      recheckAssign(board, { cellId: 'A', expectedOwner: 'OP', seat: 'TC-H-CC-2' }),
      recheckAssign(board, { cellId: 'B', expectedOwner: 'OP', seat: 'TC-H-CC-2' }),
      recheckAssign(board, { cellId: 'C', expectedOwner: 'OP', seat: 'TC-H-CC-2' }),
      recheckAssign(board, { cellId: 'Z', expectedOwner: 'OP', seat: 'TC-H-CC-2' }),
      recheckAssign(board, { cellId: 'A', expectedOwner: 'OP/claude', seat: 'TC-H-CX-1' }),
      recheckAssign(board, { cellId: 'A', expectedOwner: 'OP/claude', seat: 'TC-H-CX-1', heldAtSnapshot: ['D'] }),
    ]).toEqual([null, 'owner-now:TC-H-POOL-1', 'status-now:green', 'cell-gone', 'hand-holds:D', null]);
  });
});

describe('policy pack', () => {
  test('the shipped live block · defaults · a wrong type throws · an unreadable file falls back', () => {
    expect(loadHqPolicy().live).toEqual({ idleMin: 2, rosterStallExempt: true, directLend: true, notRosterMarkers: ['[예비 ', '[WIP 잔류 '] });
    expect(parseLiveR1(undefined)).toEqual({ idleMin: 2, rosterStallExempt: true, directLend: true, notRosterMarkers: ['[예비 ', '[WIP 잔류 '] });
    expect(parseLiveR1({ idle_min: 5, direct_lend: false })).toEqual({ idleMin: 5, rosterStallExempt: true, directLend: false, notRosterMarkers: ['[예비 ', '[WIP 잔류 '] });
    expect(() => parseLiveR1({ direct_lend: 'yes' })).toThrow('live.direct_lend must be true|false');
    expect(() => parseHqPolicy('mode: shadow\ncaps: {assign: 4, pregate: 3, judge: 2}\npriorities: [P0]\nidle_min: 2\nstall_min: 1\nmatch_lead_min: 1\nagreement_target: 0.9\nlive: [1]')).toThrow('live must be a mapping');
    const missing = loadLiveR1Policy('/nonexistent/steward-hq.yaml');
    expect([missing.source, missing.policy.idleMin, missing.policy.directLend]).toEqual(['default', 2, true]);
  });
});

describe('hand source: declared hands with no pane', () => {
  test('a declared hand missing from els panes joins as no-pane (never idle) · coordinators and pane seats are not duplicated', () => {
    const sources: SnapshotSources = {
      panes: () => ({ panes: [{ seat: 'TC-H-CX-1', activityState: 'idle', lastEventAtMs: NOW - 5 * 60_000 }] }),
      checklist: () => ({ version: '0.3.39', items: [{ id: 'X', title: 'x', status: 'yellow', owner: 'OP', priority: 'P0', updatedAt: ago(5), dispatchKind: 'code', evidence: '[WIP 잔류 0.3.39] keep\nmore' }] }),
      prs: () => [], merged: () => [], receipts: () => [], verdicts: () => [], util: () => ({ hosts: [], ageMs: null }),
      ladder: () => buildFederationLadder({ hq: 'OP', spaces: [{ coordinator: 'TC', seats: ['TC-H-CX-1'] }] }),
      openHands: () => [],
      declaredSeats: () => ['TC-H-CX-1', 'HAND-ELN-TA', 'tc', 'OP', 'hand-vm-golden'],
    };
    const s = buildSnapshot(sources, NOW);
    expect(s.seats.map((x) => [x.seat, x.activity, x.idleForMs === null ? null : 'ms'])).toEqual([
      ['TC-H-CX-1', 'idle', 'ms'], ['HAND-ELN-TA', 'no-pane', null], ['HAND-VM-GOLDEN', 'no-pane', null]]);
    expect(s.cells.map((c) => [c.id, c.dispatchKind, c.evidenceHead])).toEqual([['X', 'code', '[WIP 잔류 0.3.39] keep']]);
  });

  test('report: OP tab → a no-pane hand is kept apart and does not count against the hands-only agreement', () => {
    const tick = planHqPairs(snap(), loadHqPolicy(), { at: ago(30), runId: 'r', source: 'tick' });
    const r = hqShadowReport({ hq: 'OP', since: new Date(NOW - 60 * 60_000), until: new Date(NOW + 60_000), ticks: [tick], policy: loadHqPolicy(), facts: [
      { ts: ago(25), type: 'cell', state: 'assign', decidedBy: 'OP', cell: 'JEV-DECIDE-KIT', to: 'TC-H-CC-2', kind: 'tab' },
      { ts: ago(25), type: 'cell', state: 'assign', decidedBy: 'OP', cell: 'YAML-BOOTSTRAP-FROM-BUNDLE', to: 'HAND-ELN-TA', kind: 'tab' },
    ] });
    expect(r.opAssigned).toEqual({ tab: 2, stewardLive: 0, claims: 0, toCoordinator: 0, toNoPane: 1 });
    expect([r.agreementRaw, r.agreement]).toEqual([0.5, 0.67]); // (1 + 1) / (2 + 2) · (1 + 1) / (2 + 1)
  });
});
