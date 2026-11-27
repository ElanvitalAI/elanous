// `eln work next` — PULL claim on the real checklist ledger (temp config dir). Expected values are literals.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { addItem, listChecklist, swapOwnerIf } from '../../release-loop/checklist.js';
import { workNext, type BoardCell, type WorkNextDeps } from './work-next.js';

const V = '9.9.9';
const NOW = Date.parse('2026-11-25T08:00:00.000Z');
const dirs: string[] = [];
afterEach(() => { resetElanousConfigDir(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function ledger(): void { const d = mkdtempSync(join(tmpdir(), 'work-next-')); dirs.push(d); setElanousConfigDir(d); }

const SCOPE: Record<string, string> = { 'TC-1': 'TC', 'TC-2': 'TC', 'TC-3': 'TC', 'UX-1': 'UX' };
function deps(over: Partial<WorkNextDeps> = {}, rows: Record<string, unknown>[] = []): WorkNextDeps {
  return {
    now: () => NOW, version: V,
    cells: () => listChecklist(V).items as readonly BoardCell[],
    scopeOf: (s) => SCOPE[s] ?? 'OP',
    lastActiveMs: () => undefined,
    swap: (id, input) => swapOwnerIf(V, id, input),
    record: (row) => { rows.push(row); },
    ...over,
  };
}

describe('eln work next', () => {
  test('two seats claim concurrently → one wins, the other gets the next cell or exit 3', () => {
    ledger();
    addItem(V, { id: 'ONLY-1', title: 'the one ready cell', priority: 'P1' });
    // Both seats ranked the board BEFORE either wrote: B's view still shows ONLY-1 unowned.
    const before = listChecklist(V).items as readonly BoardCell[];
    const a = workNext('TC-1', deps({ cells: () => before }));
    const b = workNext('TC-2', deps({ cells: () => before }));
    expect([a.code, b.code]).toEqual([0, 3]);
    expect(a.code === 0 && a.cell.id).toBe('ONLY-1');
    expect(listChecklist(V).items.find((i) => i.id === 'ONLY-1')?.owner).toBe('TC-1');
  });

  test('rank = priority, then deadline version, then oldest; the claim prints cell · title · done-when', () => {
    ledger();
    addItem(V, { id: 'LOW', title: 'p2 cell', priority: 'P2' });
    addItem(V, { id: 'HIGH-LATE', title: 'p1 later deadline', priority: 'P1', deadlineVersion: '9.9.12' });
    addItem(V, { id: 'HIGH-SOON', title: 'p1 sooner deadline', priority: 'P1', deadlineVersion: '9.9.10', doneCriterion: 'focused test green' });
    addItem(V, { id: 'DECIDE', title: 'a decision', priority: 'P0', dispatchKind: 'decision' });
    const r = workNext('TC-1', deps());
    expect(r).toMatchObject({ code: 0, line: 'HIGH-SOON · p1 sooner deadline · done-when: focused test green' });
  });

  test('WIP 1: a seat holding a cell is refused (exit 4) and told its cell; nothing else changes', () => {
    ledger();
    addItem(V, { id: 'MINE', title: 'my cell', priority: 'P1', owner: 'TC-1' });
    addItem(V, { id: 'FREE', title: 'free cell', priority: 'P0' });
    const rows: Record<string, unknown>[] = [];
    const r = workNext('TC-1', deps({}, rows));
    expect([r.code, r.line]).toEqual([4, 'WIP 1 — continue your own cell MINE · my cell · done-when: my cell']);
    expect(listChecklist(V).items.find((i) => i.id === 'FREE')?.owner).toBeUndefined();
    expect(rows.map((x) => [x.seat, x.outcome, x.cell])).toEqual([['TC-1', 'wip', 'MINE']]);
  });

  test('empty board → exit 3 «일감 0»; a cell with an open predecessor or another scope\'s live owner is not READY', () => {
    ledger();
    addItem(V, { id: 'PRE', title: 'predecessor', priority: 'P1', owner: 'UX-1' });
    addItem(V, { id: 'AFTER', title: 'after pre', priority: 'P0', predecessors: ['PRE'] });
    const r = workNext('TC-2', deps({ lastActiveMs: () => NOW - 5 * 60_000 }));
    expect([r.code, r.line]).toEqual([3, '일감 0 — no READY cell in TC or the pool (9.9.9)']);
  });

  test('lease expiry: an owner of the same scope idle past 45 min loses the cell to the puller; an active owner keeps it', () => {
    ledger();
    addItem(V, { id: 'STALE', title: 'stale owned cell', priority: 'P1', owner: 'TC-3' });
    // The cell changed just now (addItem); the owner's activity decides only through max(change, activity).
    const changedAt = Date.parse(listChecklist(V).items[0]!.updatedAt);
    const later = changedAt + 50 * 60_000;
    const active = workNext('TC-1', deps({ now: () => later, lastActiveMs: () => later - 10 * 60_000 }));
    expect(active.code).toBe(3);
    const idle = workNext('TC-1', deps({ now: () => later, lastActiveMs: () => changedAt - 60 * 60_000 }));
    expect(idle).toMatchObject({ code: 0, from: 'TC-3' });
    expect(listChecklist(V).items[0]!.owner).toBe('TC-1');
    // A UX owner never loses a cell to a TC puller, however idle.
    addItem(V, { id: 'UX-STALE', title: 'ux owned', priority: 'P0', owner: 'UX-1' });
    const other = workNext('TC-2', deps({ now: () => later + 60 * 60_000, lastActiveMs: (seat) => (seat === 'TC-1' ? later + 59 * 60_000 : changedAt - 60 * 60_000) }));
    expect(other.code).toBe(3);
  });

  test('rail 30 · a coordinator-held yellow cell is the board: the scope\'s hand claims it, the history keeps «assignedBy»', () => {
    ledger();
    addItem(V, { id: 'LEAD', title: 'leader held', priority: 'P1', owner: 'TC' });
    addItem(V, { id: 'OTHER-LEAD', title: 'another leader', priority: 'P0', owner: 'UX' });
    const r = workNext('TC-1', deps({ lastActiveMs: () => NOW }));
    expect(r).toMatchObject({ code: 0, from: 'TC', line: 'LEAD · leader held · done-when: leader held' });
    const list = listChecklist(V);
    expect(list.items.find((i) => i.id === 'LEAD')?.owner).toBe('TC-1');
    expect(list.items.find((i) => i.id === 'OTHER-LEAD')?.owner).toBe('UX');
    expect(list.history.filter((h) => h.field === 'claim').map((h) => [h.id, h.from, h.reason])).toEqual([['LEAD', 'TC', 'work next · board cell (assignedBy: TC)']]);
  });

  test('rail 30 · WIP counts active cells only: a cell waiting on JUD does not block; an active own cell is handed back first', () => {
    ledger();
    addItem(V, { id: 'WAITS', title: 'waits on jud', priority: 'P1', owner: 'TC-1' });
    addItem(V, { id: 'FREE', title: 'free cell', priority: 'P1' });
    addItem(V, { id: 'FREE-WAITING', title: 'unowned but its PR waits', priority: 'P0' });
    const waitOf = (c: BoardCell) => (c.id === 'WAITS' || c.id === 'FREE-WAITING' ? 'awaiting-verdict' as const : null);
    const rows: Record<string, unknown>[] = [];
    const r = workNext('TC-1', deps({ waitOf }, rows));
    expect(r).toMatchObject({ code: 0, line: 'FREE · free cell · done-when: free cell', waiting: ['WAITS:awaiting-verdict'] });
    expect(rows.map((x) => [x.outcome, x.cell])).toEqual([['claimed', 'FREE']]);
    // Now TC-1 holds FREE (active) and WAITS (waiting) → exit 4 on FREE, nothing new claimed.
    addItem(V, { id: 'MORE', title: 'more', priority: 'P0' });
    const again = workNext('TC-1', deps({ waitOf }));
    expect([again.code, again.line]).toEqual([4, 'WIP 1 — continue your own cell FREE · free cell · done-when: free cell']);
    expect(listChecklist(V).items.find((i) => i.id === 'MORE')?.owner).toBeUndefined();
  });

  describe('federation hand pool [B]', () => {
    const COORD = new Set(['TC', 'UX', 'JUD']);
    const pool = (over: Partial<WorkNextDeps> = {}, rows: Record<string, unknown>[] = [], lends: unknown[] = []): WorkNextDeps =>
      deps({ isCoordinator: (s) => COORD.has(s), scopeOf: (s) => ({ 'TC-1': 'TC', 'TC-2': 'TC', 'UX-1': 'UX', 'JUD-1': 'JUD', 'REVIEW-1': 'JUD' } as Record<string, string>)[s] ?? 'OP',
        lend: (row) => { lends.push(row); }, ...over }, rows);

    test('order: P0 in another space before the home board; the claim is a pool.lend row and a history reason', () => {
      ledger();
      addItem(V, { id: 'HOME-P1', title: 'tc board cell', priority: 'P1', owner: 'TC' });
      addItem(V, { id: 'UX-DEMO', title: 'ux demo cell', priority: 'P0', owner: 'UX' });
      const rows: Record<string, unknown>[] = []; const lends: unknown[] = [];
      const r = workNext('TC-1', pool({}, rows, lends));
      expect(r).toMatchObject({ code: 0, from: 'UX', lentTo: 'UX', line: 'UX-DEMO · ux demo cell · done-when: ux demo cell' });
      expect(lends).toEqual([{ from: 'TC', to: 'UX', seat: 'TC-1', cell: 'UX-DEMO', via: 'work-next' }]);
      expect(rows.map((x) => [x.outcome, x.cell, x.tier, x.event])).toEqual([['claimed', 'UX-DEMO', 'pool-p0', 'pool.lend']]);
      expect(listChecklist(V).history.filter((h) => h.field === 'claim').map((h) => h.reason))
        .toEqual(['work next · board cell (assignedBy: UX) · pool.lend TC→UX (pool-p0)']);
    });

    test('home board before borrowing; borrow only when home is empty; another space\'s live hand keeps its cell', () => {
      ledger();
      addItem(V, { id: 'UX-P1', title: 'ux board', priority: 'P1', owner: 'UX' });
      addItem(V, { id: 'UX-HELD', title: 'ux hand cell', priority: 'P1', owner: 'UX-1' });
      addItem(V, { id: 'TC-P2', title: 'tc board', priority: 'P2', owner: 'TC' });
      const a = workNext('TC-1', pool());
      expect(a).toMatchObject({ code: 0, line: 'TC-P2 · tc board · done-when: tc board' });
      const b = workNext('TC-2', pool());
      expect(b).toMatchObject({ code: 0, from: 'UX', lentTo: 'UX', line: 'UX-P1 · ux board · done-when: ux board' });
      const owners = Object.fromEntries(listChecklist(V).items.map((i) => [i.id, i.owner]));
      expect(owners).toEqual({ 'UX-P1': 'TC-2', 'UX-HELD': 'UX-1', 'TC-P2': 'TC-1' });
    });

    test('priorityOrder ranks pool cells: main red before demo when OP says so; default = P0 by version then age', () => {
      ledger();
      addItem(V, { id: 'DEMO-A', title: 'demo slide', priority: 'P0', owner: 'UX', deadlineVersion: '9.9.9' });
      addItem(V, { id: 'RED-B', title: 'main red typecheck', priority: 'P0', owner: 'TC', deadlineVersion: '9.9.12' });
      expect(workNext('TC-1', pool({ priorityOrder: () => ['main red', 'demo'] }))).toMatchObject({ code: 0, line: 'RED-B · main red typecheck · done-when: main red typecheck' });
      expect(workNext('TC-2', pool())).toMatchObject({ code: 0, line: 'DEMO-A · demo slide · done-when: demo slide' });
    });

    test('maker ≠ judge: makers never take JUD cells, JUD/REVIEW hands never take maker cells → exit 3', () => {
      ledger();
      addItem(V, { id: 'VERDICT', title: 'judge a PR', priority: 'P0', owner: 'JUD' });
      expect(workNext('TC-1', pool()).code).toBe(3);
      expect(workNext('REVIEW-1', pool())).toMatchObject({ code: 0, line: 'VERDICT · judge a PR · done-when: judge a PR' });
      ledger();
      addItem(V, { id: 'MAKE', title: 'build a thing', priority: 'P0', owner: 'UX' });
      addItem(V, { id: 'FREE', title: 'unowned build', priority: 'P0' });
      expect(workNext('JUD-1', pool())).toMatchObject({ code: 3, line: '일감 0 — no READY cell in JUD or the pool (9.9.9)' });
    });

    test('skill tags: a tagged cell is skipped by a hand lacking the tag and taken by one that has it', () => {
      ledger();
      addItem(V, { id: 'ANDROID', title: 'android build', priority: 'P0', owner: 'UX' });
      const tagged = (): readonly BoardCell[] => listChecklist(V).items.map((i) => (i.id === 'ANDROID' ? { ...i, skills: ['android'] } : i)) as readonly BoardCell[];
      expect(workNext('TC-1', pool({ cells: tagged })).code).toBe(3);
      expect(workNext('TC-2', pool({ cells: tagged, skillsOf: () => ['Android', 'ts'] }))).toMatchObject({ code: 0, from: 'UX' });
    });

    test('no home lock: after the borrowed cell closes the hand claims again from the pool', () => {
      ledger();
      addItem(V, { id: 'UX-ONE', title: 'ux one', priority: 'P1', owner: 'UX' });
      addItem(V, { id: 'JUD-ONE', title: 'jud one', priority: 'P1', owner: 'JUD' });
      expect(workNext('TC-1', pool())).toMatchObject({ code: 0, line: 'UX-ONE · ux one · done-when: ux one' });
      expect(workNext('TC-1', pool()).code).toBe(4);
      // The cell closes (green) — the view below is the board after the close; no home lock pins TC-1 to TC.
      const closed = (): readonly BoardCell[] => listChecklist(V).items.map((i) => (i.id === 'UX-ONE' ? { ...i, status: 'green' } : i)) as readonly BoardCell[];
      addItem(V, { id: 'UX-TWO', title: 'ux two', priority: 'P2', owner: 'UX' });
      expect(workNext('TC-1', pool({ cells: closed }))).toMatchObject({ code: 0, line: 'UX-TWO · ux two · done-when: ux two' });
    });
  });

  test('maker ≠ judge (RX-1..4 literals): JUD-B / JUD-3 never claim the four implementation cells; a seat whose federation.yaml role is judge neither', () => {
    ledger();
    addItem(V, { id: 'DEMO-INVEST-ORCH-PIN', title: 'pin the invest orchestration demo', priority: 'P0', owner: 'UX' });
    addItem(V, { id: 'CHECKLIST-OWNER-HAND-SEATS', title: 'checklist owner = hand seats', priority: 'P0' });
    addItem(V, { id: 'ELS-SERVER-COLOR-ENV', title: 'els server color env', priority: 'P1', owner: 'TC' });
    addItem(V, { id: 'WAIT-CYCLE-DETECTOR', title: 'wait cycle detector', priority: 'P1', owner: 'UX' });
    const ladder: Record<string, string> = { 'JUD-B': 'JUD', 'JUD-3': 'JUD', 'ARBITER-1': 'UX', 'TC-1': 'TC' };
    const roles: Record<string, string> = { 'ARBITER-1': 'judge' };
    const d = deps({ scopeOf: (s) => ladder[s] ?? 'OP', isCoordinator: (s) => ['TC', 'UX', 'JUD'].includes(s),
      isJudge: (s) => s.startsWith('JUD') || roles[s] === 'judge' || (ladder[s] ?? '').startsWith('JUD') });
    expect(workNext('JUD-B', d)).toMatchObject({ code: 3 });
    expect(workNext('JUD-3', d)).toMatchObject({ code: 3 });
    expect(workNext('ARBITER-1', d)).toMatchObject({ code: 3 });
    expect(workNext('TC-1', d)).toMatchObject({ code: 0, line: 'DEMO-INVEST-ORCH-PIN · pin the invest orchestration demo · done-when: pin the invest orchestration demo' });
    expect(listChecklist(V).items.map((i) => [i.id, i.owner ?? null])).toEqual([
      ['DEMO-INVEST-ORCH-PIN', 'TC-1'], ['CHECKLIST-OWNER-HAND-SEATS', null], ['ELS-SERVER-COLOR-ENV', 'TC'], ['WAIT-CYCLE-DETECTOR', 'UX'],
    ]);
  });
});

describe('POOL-PULL-NEEDS-SPEC — pull.requireDoneWhen', () => {
  test('a cell without done-when is not offered; a cell with one is; the ledger row names the skipped cell', () => {
    ledger();
    addItem(V, { id: 'NO-SPEC', title: 'kpi contract unknown', priority: 'P0' });
    addItem(V, { id: 'HAS-SPEC', title: 'measurable cell', priority: 'P2', doneCriterion: 'focused test green' });
    const rows: Record<string, unknown>[] = [];
    const r = workNext('TC-1', deps({ requireDoneWhen: () => true }, rows));
    expect(r).toMatchObject({ code: 0, line: 'HAS-SPEC · measurable cell · done-when: focused test green' });
    expect(rows.at(-1)).toMatchObject({ outcome: 'claimed', cell: 'HAS-SPEC', skipped: { 'needs-spec': ['NO-SPEC'] } });
    expect(listChecklist(V).items.map((i) => [i.id, i.owner ?? null])).toEqual([['NO-SPEC', null], ['HAS-SPEC', 'TC-1']]);
  });

  test('only cells without done-when → exit 3 and the breakdown says needs-spec', () => {
    ledger();
    addItem(V, { id: 'NO-SPEC', title: 'kpi contract unknown', priority: 'P0' });
    addItem(V, { id: 'BLANK-SPEC', title: 'blank done line', priority: 'P1', doneCriterion: '   ' });
    const rows: Record<string, unknown>[] = [];
    const r = workNext('TC-1', deps({ requireDoneWhen: () => true }, rows));
    expect(r.code).toBe(3);
    expect(r.code === 3 && r.breakdown?.endsWith(' · needs-spec 2 (no done-when — OP sets one)')).toBe(true);
    expect(rows.at(-1)).toMatchObject({ outcome: 'empty', skipped: { 'needs-spec': ['NO-SPEC', 'BLANK-SPEC'] } });
  });

  test('policy false (and absent) → the cell without done-when is offered as before', () => {
    ledger();
    addItem(V, { id: 'NO-SPEC', title: 'kpi contract unknown', priority: 'P0' });
    const off = workNext('TC-1', deps({ requireDoneWhen: () => false }));
    expect(off).toMatchObject({ code: 0, line: 'NO-SPEC · kpi contract unknown · done-when: kpi contract unknown' });
    ledger();
    addItem(V, { id: 'NO-SPEC', title: 'kpi contract unknown', priority: 'P0' });
    expect(workNext('TC-2', deps()).code).toBe(0);
  });
});
