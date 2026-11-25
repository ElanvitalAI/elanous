// STEWARD-SPACE node runner — fixture ledgers through r0…x. Shadow writes rows/ledger only (no effect call, no dispatch
// marker); live calls the effects; two unfinished ticks raise one degrade mail. Expected values are literals.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFederationLadder } from '../../msg/hand-raise-ladder.js';
import type { StewardSpaceConfig } from './config.js';
import type { SnapshotSources } from './sources.js';
import { inputFromGraphContext, ledgerPath, readScopeState, runStewardSpaceNode, STEWARD_SPACE_NODES, type StewardEffects, type StewardMail, type TickDeps } from './tick.js';

const NOW = Date.parse('2026-11-25T06:00:00.000Z');
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();
const agoMs = (min: number): number => NOW - min * 60_000;

function sources(): SnapshotSources {
  return {
    panes: () => ({ panes: [
      { seat: 'OP', activityState: 'working', lastEventAtMs: agoMs(1) },
      { seat: 'TC', activityState: 'working', lastEventAtMs: agoMs(1) },
      { seat: 'TC-H-CX-1', activityState: 'idle', lastEventAtMs: agoMs(30) },
      { seat: 'JUD', activityState: 'working', lastEventAtMs: agoMs(1) },
      { seat: 'JUD-B', activityState: 'idle', lastEventAtMs: agoMs(40) },
    ] }),
    checklist: () => ({ version: '0.3.36', items: [
      { id: 'CELL-T1', title: 't1', status: 'yellow', owner: 'TC', priority: 'P0', updatedAt: ago(200) },
      { id: 'CELL-T2', title: 't2', status: 'yellow', owner: 'TC', priority: 'P1', updatedAt: ago(300) },
    ] }),
    prs: () => ([
      { number: 301, headRefOid: '3'.repeat(40), headRefName: 'tc-h-cx-1/a', title: 'a', isDraft: false, updatedAt: ago(5), files: [{ path: 'src/a.ts' }] },
      { number: 302, headRefOid: '4'.repeat(40), headRefName: 'tc/b', title: 'b', isDraft: false, updatedAt: ago(5), files: [{ path: 'src/b.ts' }] },
    ]),
    merged: () => ([{ number: 299, headRefName: 'tc/x', mergedAt: ago(15) }]),
    receipts: () => [{ pr: 302, head12: '444444444444', host: 'minim5', status: 'LIGHT_PASS_NOT_FULL_GATE', atMs: agoMs(45) }],
    verdicts: () => [],
    util: () => ({ hosts: [{ host: 'minim5', load1: 3, ncpu: 18, stopped: false }, { host: 'node-c', load1: 2, ncpu: 14, stopped: false }], ageMs: 60_000 }),
    ladder: () => buildFederationLadder({ hq: 'OP', spaces: [{ coordinator: 'TC', seats: ['TC-H-CX-1'] }, { coordinator: 'JUD', seats: ['JUD-B'] }] }),
    openHands: () => [],
  };
}

interface Spy extends StewardEffects { mails: StewardMail[]; assigns: string[]; dispatches: string[]; releases: string[] }
function spy(): Spy {
  const s: Spy = {
    mails: [], assigns: [], dispatches: [], releases: [],
    releaseCell: (r) => { s.releases.push(`${r.cellId}<-${r.owner} by ${r.actor}`); return { ok: true }; },
    mail: (m) => { s.mails.push(m); },
    assignCell: (a) => { s.assigns.push(`${a.cellId}->${a.seat} by ${a.actor}`); return { ok: true, via: 'test' }; },
    dispatchPregate: (d) => { s.dispatches.push(`#${d.pr}@${d.head12} ${d.host}`); return { ok: true }; },
  };
  return s;
}

let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'steward-space-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const deps = (effects: Spy, config: StewardSpaceConfig): TickDeps => ({ root, now: () => new Date(NOW), config, sources: () => sources(), effects });
function runAll(d: TickDeps, input: { runId: string; scope?: string; shadow?: boolean }): Array<{ outcome: string }> {
  return STEWARD_SPACE_NODES.map((node) => runStewardSpaceNode(node, input, d));
}

describe('steward space tick', () => {
  test('shadow: every node ok, «would do» rows recorded, zero effects, no dispatch marker', () => {
    const effects = spy();
    const results = runAll(deps(effects, { pregateHosts: ['minim5', 'node-c'] }), { runId: 'run-shadow', shadow: true });
    expect(results.map((r) => r.outcome)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(effects.mails).toEqual([]);
    expect(effects.assigns).toEqual([]);
    expect(effects.dispatches).toEqual([]);
    expect(existsSync(join(root, 'steward', 'space', 'dispatch'))).toBe(false);
    const tc = readFileSync(ledgerPath(root, 'TC'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(tc.map((r) => [r.instance, r.node, r.action, r.target, r.seat ?? null, r.host ?? null, r.mode])).toEqual([
      ['steward:TC', 'r1', 'assign', 'CELL-T1', 'TC-H-CX-1', null, 'shadow'],
      // CELL-T2 is P1: PULL default — it stays on the board for `eln work next`, no push and no defer row.
      ['steward:TC', 'r2', 'dispatch', '#301', 'TC-H-CX-1', 'node-c', 'shadow'],
      ['steward:TC', 'r6', 'digest', 'TC', null, null, 'shadow'],
    ]);
    const jud = readFileSync(ledgerPath(root, 'JUD'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(jud.map((r) => [r.node, r.action, r.target, r.seat ?? null])).toEqual([
      ['r3', 'judge-assign', '#302', 'JUD-B'],
      ['r6', 'digest', 'JUD', null],
    ]);
    // Nothing pushable is left for HQ (the P1 cell waits on the board for a pull): no defer row, no OP card.
    const hq = readFileSync(ledgerPath(root, 'OP'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(hq.map((r) => [r.node, r.action, r.target, r.reason])).toEqual([
      ['r6', 'digest', 'OP', 'OP · landed/h 0 · idle 0 · blocked 0 · ✋ 0'],
    ]);
    expect(readScopeState(root, 'TC', 'shadow').lastTick?.counts).toEqual({ assign: 1, dispatch: 1, digest: 1 });
    expect(readScopeState(root, 'TC', 'shadow').lastTick?.wanting).toEqual([]);
    expect(readScopeState(root, 'OP', 'shadow').lastTick?.escalations).toEqual([]);
    expect(existsSync(join(root, 'steward', 'space', 'TC', 'state.live.json'))).toBe(false);
  });

  test('live for TC only: TC effects run, JUD/OP (off) are untouched, one TC digest and no TC card', () => {
    const effects = spy();
    const results = runAll(deps(effects, { scopes: { TC: { mode: 'live' } }, pregateHosts: ['minim5', 'node-c'] }), { runId: 'run-live' });
    expect(results.every((r) => r.outcome === 'ok')).toBe(true);
    expect(effects.assigns).toEqual(['CELL-T1->TC-H-CX-1 by TC']);
    expect(effects.dispatches).toEqual(['#301@333333333333 node-c']);
    expect(effects.mails.map((m) => [m.to, m.kind, m.body.split('\n')[0]])).toEqual([
      ['TC-H-CX-1', 'info', '[행정관 · TC] #301@333333333333 같은 head 영수 없음 → pregate --light 디스패치(node-c). 영수는 PREGATE-GREEN 에 생깁니다 · 회신 불필요'],
      ['TC', 'info', '[행정관 · TC] 30분 숫자 — TC · landed/h 1 · idle 1 · blocked 0 · ✋ 0'],
    ]);
    expect(existsSync(join(root, 'steward', 'space', 'dispatch', '301-333333333333.json'))).toBe(true);
    expect(existsSync(ledgerPath(root, 'JUD'))).toBe(false);
    // A second tick in the same 10 minutes: cooldowns hold, the marker blocks a second dispatch, the digest is not due.
    const again = spy();
    runAll(deps(again, { scopes: { TC: { mode: 'live' } }, pregateHosts: ['minim5', 'node-c'] }), { runId: 'run-live-2' });
    expect([again.assigns, again.dispatches, again.mails]).toEqual([[], [], []]);
  });

  test('live wake: an idle hand owning a yellow cell is woken via seat assign on its own cell, recorded, counted in the rollup', () => {
    const effects = spy();
    const whys: string[] = [];
    effects.assignCell = (a) => { effects.assigns.push(`${a.cellId}->${a.seat} by ${a.actor}`); whys.push(a.why); return { ok: true, via: 'test' }; };
    const withOwner = (): SnapshotSources => {
      const base = sources();
      return { ...base, checklist: () => ({ version: '0.3.36', items: [
        { id: 'CELL-T1', title: 't1', status: 'yellow', owner: 'TC', priority: 'P0', updatedAt: ago(200) },
        { id: 'CELL-W1', title: 'w1', status: 'yellow', owner: 'TC-H-CX-1', priority: 'P1', updatedAt: ago(45) },
      ] }) };
    };
    const d: TickDeps = { root, now: () => new Date(NOW), config: { scopes: { TC: { mode: 'live' } }, pregateHosts: ['minim5', 'node-c'] }, sources: () => withOwner(), effects };
    expect(runAll(d, { runId: 'run-wake', scope: 'TC' }).every((r) => r.outcome === 'ok')).toBe(true);
    // The owner is woken on CELL-W1 — it is not handed CELL-T1, which stays deferred for a free hand.
    expect(effects.assigns).toEqual(['CELL-W1->TC-H-CX-1 by TC']);
    expect(whys).toEqual(['wake: idle 30m on own cell']);
    const state = readScopeState(root, 'TC', 'live');
    expect(state.woken).toEqual({ 'TC-H-CX-1': { at: '2026-11-25T06:00:00.000Z', cell: 'CELL-W1', count: 1 } });
    expect(state.lastTick?.counts).toEqual({ wake: 1, defer: 1, dispatch: 1, digest: 1 });
    expect(state.lastTick?.rollup).toBe('TC · landed/h 1 · idle 1 · wake 1 · blocked 0 · ✋ 0');
    // 10 min later the hand is still idle (no turn since the wake): no second wake inside the 20-min window.
    const again = spy();
    runAll({ ...d, now: () => new Date(NOW + 10 * 60_000), effects: again }, { runId: 'run-wake-2', scope: 'TC' });
    expect(again.assigns).toEqual([]);
  });

  test('live reclaim: a hand idle past its 45-min lease loses the cell to the board (CAS on the owner), rollup «reclaimed 1»', () => {
    const effects = spy();
    const stale = (): SnapshotSources => ({ ...sources(),
      panes: () => ({ panes: [
        { seat: 'TC', activityState: 'working', lastEventAtMs: agoMs(1) },
        { seat: 'TC-H-CX-1', activityState: 'idle', status: { state: 'IDLE', since: agoMs(2) }, fgCommand: ['eln', '--resume', 'sess-cx1-0001'] },
      ] }),
      sessionActivity: () => agoMs(70),
      // No PR of this hand (a PR push 5 min ago would renew its lease).
      prs: () => [],
      checklist: () => ({ version: '0.3.36', items: [
        { id: 'CELL-OLD', title: 'old', status: 'yellow', owner: 'TC-H-CX-1', priority: 'P1', updatedAt: ago(90) },
      ] }) });
    const d: TickDeps = { root, now: () => new Date(NOW), config: { scopes: { TC: { mode: 'live' } }, pregateHosts: ['minim5', 'node-c'] }, sources: () => stale(), effects };
    expect(runAll(d, { runId: 'run-reclaim', scope: 'TC' }).every((r) => r.outcome === 'ok')).toBe(true);
    // els says idle 2 min; the session says 70 min → lease (max(90, 70) ago + 45) ran out 25 min ago.
    expect(effects.releases).toEqual(['CELL-OLD<-TC-H-CX-1 by TC']);
    expect(effects.assigns).toEqual([]);
    const state = readScopeState(root, 'TC', 'live');
    expect(state.lastTick?.rollup).toBe('TC · landed/h 1 · idle 1 · wake 1 · reclaimed 1 · blocked 0 · ✋ 0');
    expect(effects.mails.filter((m) => m.to === 'TC-H-CX-1').map((m) => m.body.split(' ').slice(0, 5).join(' '))).toEqual([
      '[행정관 · TC] CELL-OLD 임대',
      '[행정관 · TC] idle 70m',
    ]);
  });

  test('live refusal: seat assign refuses → one reject row on ONE card to the scope coordinator, nothing to HQ', () => {
    const effects = spy();
    effects.assignCell = (a) => { effects.assigns.push(`${a.cellId}->${a.seat} refused`); return { ok: false, error: 'live-writer:#301 writes src/a.ts' }; };
    runAll(deps(effects, { scopes: { TC: { mode: 'live' } }, pregateHosts: ['minim5', 'node-c'] }), { runId: 'run-refused' });
    expect(effects.assigns).toEqual(['CELL-T1->TC-H-CX-1 refused']);
    const cards = effects.mails.filter((m) => m.kind === 'steward-exception');
    expect(cards.map((m) => [m.to, m.body.split('\n').slice(0, 2)])).toEqual([
      ['TC', ['[행정관 · TC] 예외 카드 1건', '- reject CELL-T1 · TC-H-CX-1 — assign-failed:live-writer:#301 writes src/a.ts']],
    ]);
    expect(readScopeState(root, 'TC', 'live').lastTick?.escalations.map((r) => [r.action, r.target])).toEqual([['reject', 'CELL-T1']]);
  });

  test('scope input limits the run; an event seat resolves to its scope; unknown input is dropped', () => {
    expect(inputFromGraphContext({ runId: 'r', input: { scope: 'tc', shadow: true } })).toEqual({ runId: 'r', scope: 'TC', shadow: true });
    expect(inputFromGraphContext({ runId: 'r', input: { seat: 'JUD-B', shadow: 'yes' } })).toEqual({ runId: 'r', seat: 'JUD-B' });
    expect(inputFromGraphContext({ runId: 'r', input: { scope: '../etc' } })).toEqual({ runId: 'r' });
    const effects = spy();
    const r0 = runStewardSpaceNode('r0', { runId: 'run-seat', seat: 'JUD-B', shadow: true }, deps(effects, {}));
    expect(r0.scopes).toEqual(['steward:JUD:shadow:judge']);
  });

  test('degrade: two unfinished ticks with a live scope → one mail to HQ, then silence until a tick completes', () => {
    const config: StewardSpaceConfig = { scopes: { TC: { mode: 'live' } } };
    const effects = spy();
    runStewardSpaceNode('r0', { runId: 'a' }, deps(effects, config));
    runStewardSpaceNode('r0', { runId: 'b' }, deps(effects, config));
    expect(effects.mails).toEqual([]);
    runStewardSpaceNode('r0', { runId: 'c' }, deps(effects, config));
    expect(effects.mails.map((m) => [m.to, m.kind, m.body.split(' — ')[0]])).toEqual([['OP', 'alert', '[행정관] steward L1 stopped']]);
    runStewardSpaceNode('r0', { runId: 'd' }, deps(effects, config));
    expect(effects.mails.length).toBe(1);
    const shadowOnly = spy();
    rmSync(join(root, 'steward'), { recursive: true, force: true });
    for (const id of ['e', 'f', 'g']) runStewardSpaceNode('r0', { runId: id, shadow: true }, deps(shadowOnly, {}));
    expect(shadowOnly.mails).toEqual([]);
  });

  test('a node without its snapshot fails (r0 did not run)', () => {
    expect(runStewardSpaceNode('r1', { runId: 'nope' }, deps(spy(), {})).outcome).toBe('fail');
  });
});
